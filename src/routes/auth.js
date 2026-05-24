const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const { emailService } = require('../services/email');

const TOKEN_TTL = '7d';

function makeToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// ─── REGISTER ────────────────────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  const { username, full_name, email, password, phone } = req.body;

  if (!email || !password || !username) {
    return res.status(400).json({ success: false, error: 'email, password, and username are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
  }

  if (!IS_DB_CONFIGURED) {
    // Mock mode — return a fake user so frontend can continue working
    const mock = { id: uuidv4(), username: username.toLowerCase(), full_name, email, role: 'user', wallet_balance: 0 };
    return res.status(201).json({ success: true, data: { user: mock, token: makeToken(mock) }, message: 'Account created (mock)' });
  }

  try {
    // Check duplicates
    const existing = await queryOne('SELECT id FROM users WHERE email = ? OR username = ?', [email, username.toLowerCase()]);
    if (existing) return res.status(409).json({ success: false, error: 'Email or username already taken' });

    const hash = await bcrypt.hash(password, 12);
    const id   = uuidv4();

    await execute(
      'INSERT INTO users (id, username, full_name, email, password_hash, phone, role, status, wallet_balance) VALUES (?, ?, ?, ?, ?, ?, "user", "enabled", 0)',
      [id, username.toLowerCase(), full_name || '', email, hash, phone || null]
    );

    const user = await queryOne('SELECT id, username, full_name, email, phone, role, status, wallet_balance, created_at FROM users WHERE id = ?', [id]);

    emailService.sendWelcomeEmail(user).catch(() => {});

    return res.status(201).json({ success: true, data: { user, token: makeToken(user) }, message: 'Account created successfully' });
  } catch (err) {
    console.error('[auth/register]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }

  if (!IS_DB_CONFIGURED) {
    const mock = { id: uuidv4(), username: email.split('@')[0], email, role: 'user', wallet_balance: 7443 };
    return res.json({ success: true, data: { user: mock, token: makeToken(mock) } });
  }

  try {
    const user = await queryOne('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Your account has been suspended' });
    }
    if (user.status === 'disabled') {
      return res.status(403).json({ success: false, error: 'Your account has been disabled' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    // Update last login
    await execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // Strip sensitive fields
    const { password_hash, ...safeUser } = user;

    return res.json({ success: true, data: { user: safeUser, token: makeToken(user) } });
  } catch (err) {
    console.error('[auth/login]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LOGOUT ──────────────────────────────────────────────────────────────────
// JWT is stateless — client discards the token. This endpoint exists for analytics.

router.post('/logout', authMiddleware, (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});

// ─── ME ───────────────────────────────────────────────────────────────────────

router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!IS_DB_CONFIGURED) {
      return res.json({ success: true, data: { user: req.user } });
    }
    const user = await queryOne(
      'SELECT id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, email_verified, last_login, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: { user } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── FORGOT PASSWORD ─────────────────────────────────────────────────────────

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Email required' });

  // Always return success to prevent email enumeration
  if (IS_DB_CONFIGURED) {
    try {
      const user = await queryOne('SELECT id, email, username FROM users WHERE email = ?', [email]);
      if (user) {
        // Generate a short-lived reset token
        const resetToken = jwt.sign({ sub: user.id, type: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
        const resetUrl   = `${process.env.CLIENT_URL || 'https://winalott.com'}/auth/reset-password?token=${resetToken}`;
        emailService.sendPasswordResetEmail(user, resetUrl).catch(() => {});
      }
    } catch { /* non-blocking */ }
  }

  return res.json({ success: true, message: 'If that email exists, a reset link has been sent' });
});

// ─── RESET PASSWORD ───────────────────────────────────────────────────────────

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ success: false, error: 'Token and new password required' });
  if (password.length < 6) return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'reset') return res.status(400).json({ success: false, error: 'Invalid reset token' });

    if (IS_DB_CONFIGURED) {
      const hash = await bcrypt.hash(password, 12);
      await execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, payload.sub]);
    }

    return res.json({ success: true, message: 'Password reset successfully' });
  } catch (err) {
    return res.status(400).json({ success: false, error: 'Invalid or expired token' });
  }
});

// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

router.post('/change-password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ success: false, error: 'current_password and new_password required' });
  }
  if (new_password.length < 6) return res.status(400).json({ success: false, error: 'New password must be at least 6 characters' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Password updated (mock)' });

  try {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(new_password, 12);
    await execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
