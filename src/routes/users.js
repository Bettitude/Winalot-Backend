const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');

// GET /api/users/me — current authenticated user
router.get('/me', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { user: req.user } });
  try {
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

// PUT /api/users/me — update own profile
router.put('/me', authMiddleware, async (req, res) => {
  const allowed  = ['full_name', 'phone', 'avatar_url'];
  const updates  = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'No valid fields to update' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { user: { ...req.user, ...updates } } });

  try {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await execute(`UPDATE users SET ${setClauses} WHERE id = ?`, [...Object.values(updates), req.user.id]);
    const user = await queryOne('SELECT id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, created_at FROM users WHERE id = ?', [req.user.id]);
    return res.json({ success: true, data: { user } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users/me/self-exclusion — request self-exclusion
router.post('/me/self-exclusion', authMiddleware, async (req, res) => {
  const { duration, reason } = req.body;
  if (!duration) return res.status(400).json({ success: false, error: 'duration required (1m|3m|6m|perm)' });

  const durationMap = { '1m': 30, '3m': 90, '6m': 180, 'perm': null };
  if (!(duration in durationMap)) return res.status(400).json({ success: false, error: 'Invalid duration' });

  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, message: 'Self-exclusion requested (mock)' });
  }

  try {
    const days = durationMap[duration];
    const exclusionUntil = days
      ? new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
      : '9999-12-31';

    await execute(
      'UPDATE users SET status = "suspended", self_excluded_until = ? WHERE id = ?',
      [exclusionUntil, req.user.id]
    );
    await execute(
      'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "self_exclusion", 0, ?, "successful", ?)',
      [req.user.id, `SE-${Date.now()}`, JSON.stringify({ duration, reason, until: exclusionUntil })]
    );

    auditLog(req.user.id, 'SELF_EXCLUSION', req.user.id, { duration, exclusionUntil });
    return res.json({ success: true, message: `Self-exclusion set until ${exclusionUntil}` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users  (admin)
router.get('/', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { users: [], total: 0 } });

  try {
    const { page = 1, limit = 20, search, status, role } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    if (search) { where += ' AND (username LIKE ? OR email LIKE ? OR full_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (role)   { where += ' AND role = ?'; params.push(role); }

    const [users, totals] = await Promise.all([
      query(`SELECT id, username, full_name, email, phone, role, status, wallet_balance, email_verified, last_login, created_at FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]),
      query(`SELECT COUNT(*) AS total FROM users ${where}`, params),
    ]);

    return res.json({ success: true, data: { users, total: totals[0]?.total || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users/:id
router.get('/:id', authMiddleware, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const isSelf  = req.user.id === req.params.id;
  if (!isAdmin && !isSelf) return res.status(403).json({ success: false, error: 'Forbidden' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { user: req.user } });

  try {
    const user = await queryOne(
      'SELECT id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, email_verified, last_login, created_at FROM users WHERE id = ?',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: { user } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/users/:id
router.patch('/:id', authMiddleware, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const isSelf  = req.user.id === req.params.id;
  if (!isAdmin && !isSelf) return res.status(403).json({ success: false, error: 'Forbidden' });

  const allowed = isAdmin
    ? ['status', 'role', 'full_name', 'phone', 'avatar_url']
    : ['full_name', 'phone', 'avatar_url'];

  const updates = {};
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'No valid fields to update' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { user: { ...req.user, ...updates } } });

  try {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await execute(`UPDATE users SET ${setClauses} WHERE id = ?`, [...Object.values(updates), req.params.id]);
    if (isAdmin) auditLog(req.user.id, 'UPDATE_USER', req.params.id, updates);

    const user = await queryOne('SELECT id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, created_at FROM users WHERE id = ?', [req.params.id]);
    return res.json({ success: true, data: { user } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users/:id/wallet-adjust  (admin)
router.post('/:id/wallet-adjust', adminMiddleware, async (req, res) => {
  const { amount, description, type = 'manual_credit' } = req.body;
  if (amount === undefined) return res.status(400).json({ success: false, error: 'amount required (in cents)' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { new_balance: 0 }, message: 'Wallet adjusted (mock)' });

  try {
    await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [parseInt(amount), req.params.id]);
    await execute('INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, ?, ?, ?, "successful", ?)',
      [req.params.id, type, parseInt(amount), `ADMIN-ADJ-${Date.now()}`, JSON.stringify({ admin_id: req.user.id, description })]);

    const user = await queryOne('SELECT wallet_balance FROM users WHERE id = ?', [req.params.id]);
    auditLog(req.user.id, 'WALLET_ADJUST', req.params.id, { amount, description });
    return res.json({ success: true, data: { new_balance: user.wallet_balance } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users/:id/stats
router.get('/:id/stats', authMiddleware, async (req, res) => {
  if (req.user.id !== req.params.id && req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Forbidden' });
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { total_tickets: 0, total_wins: 0, total_spent: 0, total_won: 0 } });

  try {
    const stats = await queryOne(
      `SELECT COUNT(*) AS total_tickets,
        SUM(CASE WHEN status = 'winner' THEN 1 ELSE 0 END) AS total_wins,
        COALESCE(SUM(amount_paid), 0) AS total_spent
      FROM tickets WHERE user_id = ?`,
      [req.params.id]
    );
    const won = await queryOne('SELECT COALESCE(SUM(prize_amount), 0) AS total_won FROM winners WHERE user_id = ?', [req.params.id]);
    return res.json({ success: true, data: { ...stats, total_won: won?.total_won || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users/me/payment-methods
router.get('/me/payment-methods', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { methods: [] } });
  try {
    const methods = await query(
      'SELECT id, type, label, details, is_default, created_at FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at DESC',
      [req.user.id]
    );
    return res.json({ success: true, data: { methods: methods.map(m => ({ ...m, details: JSON.parse(m.details || '{}') })) } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/users/me/payment-methods
router.post('/me/payment-methods', authMiddleware, async (req, res) => {
  const { type, label, details, is_default } = req.body;
  if (!type || !details) return res.status(400).json({ success: false, error: 'type and details required' });
  if (!['paypal', 'bank'].includes(type)) return res.status(400).json({ success: false, error: 'type must be paypal or bank' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { method: { id: `mock-${Date.now()}`, type, label, details, is_default: !!is_default } } });

  try {
    if (is_default) {
      await execute('UPDATE payment_methods SET is_default = 0 WHERE user_id = ?', [req.user.id]);
    }
    await execute(
      'INSERT INTO payment_methods (id, user_id, type, label, details, is_default) VALUES (UUID(), ?, ?, ?, ?, ?)',
      [req.user.id, type, label || (type === 'paypal' ? 'PayPal' : 'Bank Account'), JSON.stringify(details), is_default ? 1 : 0]
    );
    const method = await queryOne('SELECT id, type, label, details, is_default FROM payment_methods WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    return res.json({ success: true, data: { method: { ...method, details: JSON.parse(method.details || '{}') } } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/users/me/payment-methods/:id
router.delete('/me/payment-methods/:id', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Deleted (mock)' });
  try {
    await execute('DELETE FROM payment_methods WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    return res.json({ success: true, message: 'Payment method removed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/users/leaderboard — public
router.get('/leaderboard', async (req, res) => {
  const period = req.query.period || 'weekly';
  if (!IS_DB_CONFIGURED) {
    const mock = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      username: `player_${i + 1}`,
      total_wins: 10 - i,
      total_won:  (10 - i) * 250,
    }));
    return res.json({ success: true, data: { leaderboard: mock } });
  }

  try {
    const dateFilter = period === 'monthly'
      ? "AND t.updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)"
      : "AND t.updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)";

    const leaderboard = await query(
      `SELECT u.username,
              COUNT(t.id) AS total_wins,
              COALESCE(SUM(t.prize_amount), 0) AS total_won
       FROM tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.status = 'won' ${dateFilter}
       GROUP BY u.id, u.username
       ORDER BY total_won DESC
       LIMIT 50`
    );
    return res.json({ success: true, data: { leaderboard: leaderboard.map((r, i) => ({ ...r, rank: i + 1 })) } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
