const express        = require('express');
const router         = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { adminMiddleware } = require('../middleware/admin');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

function rangeToSince(range) {
  const days = { 'Last 7 days': 7, 'Last 30 days': 30, 'Last 90 days': 90 }[range];
  if (!days) return null; // 'All Time' or unrecognized — no lower bound
  return new Date(Date.now() - days * 86400000).toISOString();
}

function deviceFromUA(ua = '') {
  if (/tablet|ipad/i.test(ua))                          return 'tablet';
  if (/mobile|android|iphone|ipod/i.test(ua))           return 'mobile';
  return 'desktop';
}

// POST /api/analytics/page-view  (public — fired on every route change by the frontend)
router.post('/page-view', async (req, res) => {
  res.json({ success: true }); // never block the page for analytics
  if (!IS_SUPABASE) return;
  const path   = String(req.body?.path || '/').slice(0, 200);
  const device = deviceFromUA(req.headers['user-agent']);
  try {
    await supabaseAdmin.from('btwin_page_views').insert({ path, device });
  } catch { /* non-blocking */ }
});

// GET /api/analytics/overview  (admin)
router.get('/overview', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) {
    return res.json({ success: true, data: { users: 0, tickets: 0, btp_deposited: 0, active_matches: 0 } });
  }
  const since = rangeToSince(req.query.range);
  try {
    let usersQ   = supabaseAdmin.from('btwin_users').select('*', { count: 'exact', head: true });
    let ticketsQ = supabaseAdmin.from('btwin_tickets').select('*', { count: 'exact', head: true });
    let depositsQ = supabaseAdmin.from('btwin_transactions').select('amount').eq('type', 'deposit').eq('status', 'completed');
    if (since) { usersQ = usersQ.gte('created_at', since); ticketsQ = ticketsQ.gte('created_at', since); depositsQ = depositsQ.gte('created_at', since); }

    const [usersRes, ticketsRes, matchesRes, depositsRes] = await Promise.all([
      usersQ,
      ticketsQ,
      supabaseAdmin.from('btwin_matches').select('*', { count: 'exact', head: true }).in('status', ['active', 'live']),
      depositsQ,
    ]);

    const btpDeposited = (depositsRes.data || []).reduce((s, t) => s + Math.abs(t.amount || 0), 0);

    return res.json({ success: true, data: {
      users:          usersRes.count   || 0,
      tickets:        ticketsRes.count || 0,
      active_matches: matchesRes.count || 0,
      btp_deposited:  btpDeposited,
    }});
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/top-spenders  (admin)
router.get('/top-spenders', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range);
  try {
    let q = supabaseAdmin.from('btwin_tickets').select('user_id, amount_paid');
    if (since) q = q.gte('created_at', since);
    const { data: tickets } = await q;

    const totals = {};
    const counts  = {};
    for (const t of (tickets || [])) {
      totals[t.user_id] = (totals[t.user_id] || 0) + Math.abs(t.amount_paid || 0);
      counts[t.user_id]  = (counts[t.user_id]  || 0) + 1;
    }
    const topIds = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);
    if (!topIds.length) return res.json({ success: true, data: [] });

    const { data: users } = await supabaseAdmin.from('btwin_users').select('id, username').in('id', topIds);
    const userMap = Object.fromEntries((users || []).map(u => [u.id, u.username]));
    const result  = topIds.map(id => ({ user_id: id, username: userMap[id] || id, total_spent: totals[id], tickets: counts[id] }));
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/top-markets  (admin)
router.get('/top-markets', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range);
  try {
    let q = supabaseAdmin.from('btwin_tickets').select('market_id, user_prediction');
    if (since) q = q.gte('created_at', since);
    const { data: tickets } = await q;

    const byMarket = {};
    for (const t of (tickets || [])) {
      if (!t.market_id) continue;
      if (!byMarket[t.market_id]) byMarket[t.market_id] = { entries: 0, yes: 0 };
      byMarket[t.market_id].entries += 1;
      if (String(t.user_prediction).toLowerCase() === 'yes') byMarket[t.market_id].yes += 1;
    }
    const topIds = Object.entries(byMarket).sort((a, b) => b[1].entries - a[1].entries).slice(0, 8).map(e => e[0]);
    if (!topIds.length) return res.json({ success: true, data: [] });

    const { data: markets } = await supabaseAdmin.from('btwin_markets').select('id, name, type').in('id', topIds);
    const marketMap = Object.fromEntries((markets || []).map(m => [m.id, m]));

    const result = topIds.map(id => {
      const m = marketMap[id] || {};
      const stat = byMarket[id];
      return {
        market_type: m.name || 'Market',
        entries:     stat.entries,
        yes_pct:     m.type === 'yes_no' ? Math.round((stat.yes / stat.entries) * 100) : null,
      };
    });
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/tier-stats  (admin)
router.get('/tier-stats', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range);
  try {
    const { data: markets } = await supabaseAdmin.from('btwin_markets').select('id, tier');
    const tierByMarket = Object.fromEntries((markets || []).map(m => [m.id, m.tier]));

    let q = supabaseAdmin.from('btwin_tickets').select('market_id, amount_paid');
    if (since) q = q.gte('created_at', since);
    const { data: tickets } = await q;

    const stats = {};
    const marketsSeen = {};
    for (const t of (tickets || [])) {
      const tier = tierByMarket[t.market_id] || 'silver';
      if (!stats[tier]) { stats[tier] = { tier, btp: 0, entries: 0 }; marketsSeen[tier] = new Set(); }
      stats[tier].btp     += Math.abs(t.amount_paid || 0);
      stats[tier].entries += 1;
      marketsSeen[tier].add(t.market_id);
    }
    const order = ['platinum', 'gold', 'silver', 'free'];
    const result = Object.values(stats)
      .map(s => ({ ...s, markets: marketsSeen[s.tier].size }))
      .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/btp-chart  (admin) — deposits grouped by day
router.get('/btp-chart', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range) || new Date(Date.now() - 30 * 86400000).toISOString();
  try {
    const { data } = await supabaseAdmin
      .from('btwin_transactions')
      .select('amount, created_at')
      .eq('type', 'deposit').eq('status', 'completed')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    const byDay = {};
    for (const t of (data || [])) {
      const day = t.created_at.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + Math.abs(t.amount || 0);
    }
    const result = Object.entries(byDay).map(([day, amount]) => ({
      label:  new Date(day + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      amount,
    }));
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/top-pages  (admin) — from btwin_page_views
router.get('/top-pages', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range);
  try {
    let q = supabaseAdmin.from('btwin_page_views').select('path');
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q;
    if (error) throw error; // table may not exist yet

    const counts = {};
    for (const r of (data || [])) counts[r.path] = (counts[r.path] || 0) + 1;
    const result = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, views]) => ({ path, views }));
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/devices  (admin) — from btwin_page_views
router.get('/devices', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range);
  try {
    let q = supabaseAdmin.from('btwin_page_views').select('device');
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q;
    if (error) throw error;

    const counts = {};
    for (const r of (data || [])) counts[r.device] = (counts[r.device] || 0) + 1;
    const total = Object.values(counts).reduce((s, c) => s + c, 0);
    const result = Object.entries(counts).map(([device, count]) => ({
      device, count, pct: total ? Math.round((count / total) * 100) : 0,
    })).sort((a, b) => b.count - a.count);
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/reg-sources  (admin) — direct signup vs referred, from btwin_users.referred_by
router.get('/reg-sources', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  const since = rangeToSince(req.query.range);
  try {
    let q = supabaseAdmin.from('btwin_users').select('referred_by');
    if (since) q = q.gte('created_at', since);
    const { data } = await q;

    const referred = (data || []).filter(u => u.referred_by).length;
    const direct   = (data || []).length - referred;
    const result = [
      { source: 'Direct',   count: direct },
      { source: 'Referral', count: referred },
    ].filter(r => r.count > 0);
    return res.json({ success: true, data: result });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

// GET /api/analytics/activity  (admin) — recent tickets + prize payouts merged
router.get('/activity', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) return res.json({ success: true, data: [] });
  try {
    const [ticketsRes, payoutsRes] = await Promise.all([
      supabaseAdmin.from('btwin_tickets').select('user_id, amount_paid, created_at').order('created_at', { ascending: false }).limit(10),
      supabaseAdmin.from('btwin_transactions').select('user_id, amount, created_at').eq('type', 'prize_payout').order('created_at', { ascending: false }).limit(10),
    ]);

    const userIds = [...new Set([...(ticketsRes.data || []).map(t => t.user_id), ...(payoutsRes.data || []).map(p => p.user_id)].filter(Boolean))];
    const { data: users } = userIds.length
      ? await supabaseAdmin.from('btwin_users').select('id, username').in('id', userIds)
      : { data: [] };
    const userMap = Object.fromEntries((users || []).map(u => [u.id, u.username]));

    const events = [
      ...(ticketsRes.data || []).map(t => ({
        username:    userMap[t.user_id] || 'unknown',
        description: `bought a ticket for ${((t.amount_paid || 0) / 100).toFixed(2)} BTP`,
        created_at:  t.created_at,
      })),
      ...(payoutsRes.data || []).map(p => ({
        username:    userMap[p.user_id] || 'unknown',
        description: `won ${((p.amount || 0) / 100).toFixed(2)} BTP`,
        created_at:  p.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 15);

    return res.json({ success: true, data: events });
  } catch {
    return res.json({ success: true, data: [] });
  }
});

module.exports = router;
