const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { supabaseAdmin }             = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

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

// GET /api/users/leaderboard-stats — public, aggregated numbers for the stats bar
router.get('/leaderboard-stats', async (req, res) => {
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      const [usersRes, allTicketsRes, wonTicketsRes, weekWonRes] = await Promise.all([
        supabaseAdmin.from('btwin_users').select('*', { count: 'exact', head: true }),
        supabaseAdmin.from('btwin_tickets').select('*', { count: 'exact', head: true }),
        supabaseAdmin.from('btwin_tickets').select('prize_amount').eq('status', 'won').gt('prize_amount', 0),
        supabaseAdmin.from('btwin_tickets').select('user_id').eq('status', 'won').gte('created_at', weekAgo),
      ]);

      const totalPlayers   = usersRes.count  || 0;
      const totalTickets   = allTicketsRes.count || 0;
      const totalPaidOut   = (wonTicketsRes.data || []).reduce((s, t) => s + (t.prize_amount || 0), 0);
      const weekWinners    = new Set((weekWonRes.data || []).map(t => t.user_id)).size;
      const wonCount       = (wonTicketsRes.data || []).length;
      const avgWinRate     = totalTickets > 0 ? Math.round((wonCount / totalTickets) * 100) : 0;

      return res.json({ success: true, data: { total_players: totalPlayers, total_paid_out: totalPaidOut, winners_this_week: weekWinners, avg_win_rate: avgWinRate } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  // MySQL fallback
  if (IS_DB_CONFIGURED) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      const [[{ total_players }], [{ total_paid_out }], [{ winners_this_week }], [{ total_tickets }], [{ won_tickets }]] = await Promise.all([
        query('SELECT COUNT(*) AS total_players FROM users'),
        query("SELECT COALESCE(SUM(prize_amount),0) AS total_paid_out FROM tickets WHERE status='won'"),
        query(`SELECT COUNT(DISTINCT user_id) AS winners_this_week FROM tickets WHERE status='won' AND created_at >= ?`, [weekAgo]),
        query('SELECT COUNT(*) AS total_tickets FROM tickets'),
        query("SELECT COUNT(*) AS won_tickets FROM tickets WHERE status='won'"),
      ]);
      const avg_win_rate = total_tickets > 0 ? Math.round((won_tickets / total_tickets) * 100) : 0;
      return res.json({ success: true, data: { total_players, total_paid_out, winners_this_week, avg_win_rate } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  return res.json({ success: true, data: { total_players: 0, total_paid_out: 0, winners_this_week: 0, avg_win_rate: 0 } });
});

// GET /api/users/leaderboard — public
router.get('/leaderboard', async (req, res) => {
  const period = req.query.period || 'weekly';

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      let q = supabaseAdmin
        .from('btwin_tickets')
        .select('user_id, prize_amount, created_at')
        .eq('status', 'won')
        .gt('prize_amount', 0);

      if (period !== 'alltime') {
        const days = period === 'monthly' ? 30 : 7;
        const since = new Date(Date.now() - days * 86400000).toISOString();
        q = q.gte('created_at', since);
      }

      const { data: tickets, error: tErr } = await q;
      if (tErr) throw tErr;

      if (!tickets || tickets.length === 0) {
        return res.json({ success: true, data: { leaderboard: [] } });
      }

      // Aggregate by user_id
      const userMap = new Map();
      for (const t of tickets) {
        if (!userMap.has(t.user_id)) userMap.set(t.user_id, { total_wins: 0, total_won: 0 });
        const e = userMap.get(t.user_id);
        e.total_wins++;
        e.total_won += t.prize_amount || 0;
      }

      // Fetch usernames
      const userIds = Array.from(userMap.keys());
      const { data: users, error: uErr } = await supabaseAdmin
        .from('btwin_users')
        .select('id, username')
        .in('id', userIds);
      if (uErr) throw uErr;

      const usernameMap = Object.fromEntries((users || []).map(u => [u.id, u.username]));

      const leaderboard = Array.from(userMap.entries())
        .map(([uid, stats]) => ({ username: usernameMap[uid] || 'Unknown', ...stats }))
        .sort((a, b) => b.total_won - a.total_won)
        .slice(0, 50)
        .map((r, i) => ({ ...r, rank: i + 1 }));

      return res.json({ success: true, data: { leaderboard } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) {
    const mock = Array.from({ length: 10 }, (_, i) => ({
      rank: i + 1,
      username: `player_${i + 1}`,
      total_wins: 10 - i,
      total_won:  (10 - i) * 25000, // cents
    }));
    return res.json({ success: true, data: { leaderboard: mock } });
  }

  try {
    const dateFilter = period === 'alltime' ? '' : period === 'monthly'
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

// GET /api/users/me/payout-details
router.get('/me/payout-details', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    const { data, error } = await supabaseAdmin
      .from('btwin_payout_details')
      .select('*')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: { details: data || null } });
  }
  return res.json({ success: true, data: { details: null } });
});

// PUT /api/users/me/payout-details
router.put('/me/payout-details', authMiddleware, async (req, res) => {
  const { bank_name, account_name, account_number, bank_code, currency } = req.body;
  if (!bank_name || !account_name || !account_number) {
    return res.status(400).json({ success: false, error: 'bank_name, account_name, and account_number are required' });
  }
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    const { data, error } = await supabaseAdmin
      .from('btwin_payout_details')
      .upsert({
        user_id:        req.user.id,
        bank_name,
        account_name,
        account_number,
        bank_code:      bank_code  || null,
        currency:       currency   || 'NGN',
        updated_at:     new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select()
      .single();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: { details: data } });
  }
  return res.json({ success: true, data: { details: { bank_name, account_name, account_number, bank_code, currency } } });
});

// GET /api/users/:id/payout-details — admin only
router.get('/:id/payout-details', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    const { data, error } = await supabaseAdmin
      .from('btwin_payout_details')
      .select('*')
      .eq('user_id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: error.message });
    return res.json({ success: true, data: { details: data || null } });
  }
  return res.json({ success: true, data: { details: null } });
});

// GET /api/users  (admin)
router.get('/', adminMiddleware, async (req, res) => {
  const { page = 1, limit = 20, search, status, role } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      let q = supabaseAdmin
        .from('btwin_users')
        .select('id, username, full_name, email, phone, role, status, wallet_balance, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (status) q = q.eq('status', status);
      if (role)   q = q.eq('role', role);
      if (search) q = q.or(`username.ilike.%${search}%,email.ilike.%${search}%,full_name.ilike.%${search}%`);

      const { data: users, count, error } = await q;
      if (error) throw error;

      return res.json({ success: true, data: { users: users || [], total: count || 0 } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { users: [], total: 0 } });

  try {
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

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: user, error } = await supabaseAdmin
        .from('btwin_users')
        .select('id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, created_at')
        .eq('id', req.params.id)
        .single();
      if (error || !user) return res.status(404).json({ success: false, error: 'User not found' });
      return res.json({ success: true, data: { user } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
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

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: user, error } = await supabaseAdmin
        .from('btwin_users')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, username, full_name, email, phone, role, status, wallet_balance, created_at')
        .single();
      if (error) throw error;
      if (isAdmin) auditLog(req.user.id, 'UPDATE_USER', 'user', req.params.id, updates);
      return res.json({ success: true, data: { user } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
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
