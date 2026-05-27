const jwt  = require('jsonwebtoken');
const { queryOne, IS_DB_CONFIGURED } = require('../lib/db');

const JWT_SECRET = process.env.JWT_SECRET || 'winalott_dev_secret_change_in_prod';

// Demo accounts: client-side sessions that bypass JWT verification.
// Only these specific tokens are accepted (not any arbitrary demo_token_ prefix).
const DEMO_USERS = {
  'demo_token_demo-user-001': { id: 'demo-user-001', email: 'demo@winalott.com',  role: 'user', username: 'demo_user',    wallet_balance: 50000 },
  'demo_token_demo-user-002': { id: 'demo-user-002', email: 'test@example.com',   role: 'user', username: 'test_player',  wallet_balance: 12500 },
};

/**
 * Verify our own JWT and attach user row to req.user
 */
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing authorization header', code: 401 });
  }

  const token = header.split(' ')[1];

  // Accept known demo tokens without JWT verification
  if (DEMO_USERS[token]) {
    req.user  = DEMO_USERS[token];
    req.token = token;
    return next();
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    if (!IS_DB_CONFIGURED) {
      // Dev/mock mode — accept any valid JWT and fake a user
      req.user  = { id: payload.sub, email: payload.email, role: payload.role || 'user', username: payload.username };
      req.token = token;
      return next();
    }

    const user = await queryOne('SELECT * FROM users WHERE id = ? AND status = "enabled"', [payload.sub]);
    if (!user) return res.status(401).json({ success: false, error: 'User not found or suspended', code: 401 });

    req.user  = user;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token', code: 401 });
  }
}

/**
 * Middleware that only allows admin users through
 */
async function adminMiddleware(req, res, next) {
  await authMiddleware(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required', code: 403 });
    }
    next();
  });
}

/**
 * Log an admin action to the audit_log table
 */
async function auditLog(adminId, action, targetTable, targetId, meta = {}) {
  if (!IS_DB_CONFIGURED) return;
  try {
    const { execute } = require('../lib/db');
    await execute(
      'INSERT INTO audit_log (id, admin_id, action, target_table, target_id, metadata) VALUES (UUID(), ?, ?, ?, ?, ?)',
      [adminId, action, targetTable || null, targetId || null, JSON.stringify(meta)]
    );
  } catch { /* non-blocking */ }
}

module.exports = { authMiddleware, adminMiddleware, auditLog, JWT_SECRET };
