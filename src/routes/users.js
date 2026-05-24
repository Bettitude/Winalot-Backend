const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');

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

module.exports = router;
