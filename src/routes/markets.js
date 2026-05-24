const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { cacheMiddleware }           = require('../middleware/cache');
const { IS_MOCK, fixtureToMatch }   = require('../lib/mockMode');
const { getFixtureById }            = require('../services/footballService');

// GET /api/markets
router.get('/', cacheMiddleware(60), async (req, res) => {
  if (IS_MOCK) {
    // In mock mode, return markets derived from a live fixture if match_id looks like an API-Football ID
    const { match_id } = req.query;
    if (match_id) {
      try {
        const fixture = await getFixtureById(match_id);
        if (fixture) {
          const m = fixtureToMatch(fixture);
          return res.json({ success: true, data: { markets: m.markets, total: m.markets.length } });
        }
      } catch { /* fall through */ }
    }
    return res.json({ success: true, data: { markets: [], total: 0 } });
  }

  const { match_id, status, tier, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (match_id) { where += ' AND match_id = ?'; params.push(match_id); }
    if (status)   { where += ' AND status = ?'; params.push(status); }
    if (tier)     { where += ' AND tier = ?'; params.push(tier); }

    const [markets, totals] = await Promise.all([
      query(`SELECT * FROM markets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]),
      query(`SELECT COUNT(*) AS total FROM markets ${where}`, params),
    ]);

    return res.json({ success: true, data: { markets, total: totals[0]?.total || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/markets/:id
router.get('/:id', async (req, res) => {
  if (IS_MOCK) return res.status(404).json({ success: false, error: 'No market found in mock mode' });

  try {
    const market = await queryOne('SELECT * FROM markets WHERE id = ?', [req.params.id]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found' });
    return res.json({ success: true, data: { market } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/markets  (admin)
router.post('/', adminMiddleware, async (req, res) => {
  const { match_id, market_type, admin_pick, tier, entry_fee, winner_count } = req.body;
  if (!match_id || !market_type || !tier || entry_fee === undefined) {
    return res.status(400).json({ success: false, error: 'match_id, market_type, tier, entry_fee required' });
  }
  if (!IS_DB_CONFIGURED) return res.status(201).json({ success: true, data: { market: { id: `mock-mkt-${Date.now()}`, ...req.body } } });

  try {
    await execute(
      'INSERT INTO markets (id, match_id, market_type, admin_pick, tier, entry_fee, winner_count, status) VALUES (UUID(), ?, ?, ?, ?, ?, ?, "open")',
      [match_id, market_type, admin_pick || null, tier, parseInt(entry_fee), parseInt(winner_count) || 1]
    );
    const market = await queryOne('SELECT * FROM markets ORDER BY created_at DESC LIMIT 1');
    auditLog(req.user.id, 'CREATE_MARKET', market.id);
    return res.status(201).json({ success: true, data: { market } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/markets/:id  (admin)
router.put('/:id', adminMiddleware, async (req, res) => {
  const allowed = ['market_type', 'admin_pick', 'tier', 'entry_fee', 'winner_count', 'status', 'correct_outcome'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { market: { id: req.params.id, ...updates } } });

  try {
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await execute(`UPDATE markets SET ${setClauses} WHERE id = ?`, [...Object.values(updates), req.params.id]);
    const market = await queryOne('SELECT * FROM markets WHERE id = ?', [req.params.id]);
    auditLog(req.user.id, 'UPDATE_MARKET', req.params.id);
    return res.json({ success: true, data: { market } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/markets/:id  (admin)
router.delete('/:id', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Market deleted (mock)' });

  try {
    await execute('DELETE FROM markets WHERE id = ?', [req.params.id]);
    auditLog(req.user.id, 'DELETE_MARKET', req.params.id);
    return res.json({ success: true, message: 'Market deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
