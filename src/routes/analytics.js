const express = require('express');
const router  = express.Router();
const { query, queryOne, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware } = require('../middleware/admin');

// POST /api/analytics/page-view  (public — no auth, just log)
router.post('/page-view', (req, res) => {
  // Silently accept and discard — avoids 404 noise in console
  res.json({ success: true });
});

// GET /api/analytics/overview  (admin)
router.get('/overview', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, data: { total_users: 387, total_tickets: 1243, total_revenue: 248600, active_matches: 8 } });
  }
  try {
    const [users, tickets, matches] = await Promise.all([
      queryOne('SELECT COUNT(*) AS cnt FROM users'),
      queryOne('SELECT COUNT(*) AS cnt FROM tickets'),
      queryOne("SELECT COUNT(*) AS cnt FROM matches WHERE status IN ('active','live')"),
    ]);
    return res.json({ success: true, data: {
      total_users:    users?.cnt    || 0,
      total_tickets:  tickets?.cnt  || 0,
      active_matches: matches?.cnt  || 0,
    }});
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Stub remaining analytics endpoints
['top-pages', 'top-markets', 'btp-chart', 'top-spenders', 'tier-stats', 'devices', 'reg-sources', 'activity']
  .forEach(path => router.get(`/${path}`, adminMiddleware, (_req, res) => res.json({ success: true, data: [] })));

module.exports = router;
