const express        = require('express');
const router         = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { adminMiddleware } = require('../middleware/admin');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

// POST /api/analytics/page-view  (public — no auth, just log)
router.post('/page-view', (req, res) => {
  res.json({ success: true });
});

// GET /api/analytics/overview  (admin)
router.get('/overview', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) {
    return res.json({ success: true, data: { total_users: 0, total_tickets: 0, total_revenue: 0, active_matches: 0 } });
  }
  try {
    const [usersRes, ticketsRes, matchesRes, revenueRes] = await Promise.all([
      supabaseAdmin.from('btwin_users').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('btwin_tickets').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('btwin_matches').select('*', { count: 'exact', head: true }).in('status', ['active', 'live']),
      supabaseAdmin.from('btwin_transactions').select('amount').eq('type', 'ticket_purchase').eq('status', 'completed'),
    ]);

    const totalRevenue = (revenueRes.data || []).reduce((s, t) => s + Math.abs(t.amount || 0), 0);

    return res.json({ success: true, data: {
      total_users:    usersRes.count   || 0,
      total_tickets:  ticketsRes.count || 0,
      active_matches: matchesRes.count || 0,
      total_revenue:  totalRevenue,
    }});
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/top-spenders  (admin)
router.get('/top-spenders', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  try {
    const { data: txns } = await supabaseAdmin
      .from('btwin_transactions')
      .select('user_id, amount')
      .eq('type', 'ticket_purchase');

    const totals = {};
    for (const t of (txns || [])) {
      if (!totals[t.user_id]) totals[t.user_id] = 0;
      totals[t.user_id] += Math.abs(t.amount || 0);
    }
    const topIds = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
    if (!topIds.length) return res.json({ success: true, data: [] });

    const { data: users } = await supabaseAdmin.from('btwin_users').select('id, username').in('id', topIds);
    const userMap = Object.fromEntries((users || []).map(u => [u.id, u.username]));
    const result  = topIds.map(id => ({ user_id: id, username: userMap[id] || id, total_spent: totals[id] }));
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// Stub remaining analytics endpoints
['top-pages', 'top-markets', 'btp-chart', 'tier-stats', 'devices', 'reg-sources', 'activity']
  .forEach(path => router.get(`/${path}`, adminMiddleware, (_req, res) => res.json({ success: true, data: [] })));

module.exports = router;
