const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { cacheMiddleware }           = require('../middleware/cache');
const { IS_MOCK, fixtureToMatch }   = require('../lib/mockMode');
const { getFixtureById, getFixturePredictions } = require('../services/footballService');
const { generateOptions, identifyCorrectOption } = require('../services/marketOptions');

// ── GET /api/markets ───────────────────────────────────────────────────────────
router.get('/', cacheMiddleware(60), async (req, res) => {
  if (IS_MOCK) {
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

  const { match_id, status, tier, prediction_type, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (match_id)        { where += ' AND m.match_id = ?';         params.push(match_id); }
    if (status)          { where += ' AND m.status = ?';            params.push(status); }
    if (tier)            { where += ' AND m.tier = ?';              params.push(tier); }
    if (prediction_type) { where += ' AND m.prediction_type = ?';   params.push(prediction_type); }

    const [markets, totals] = await Promise.all([
      query(
        `SELECT m.*,
          (SELECT COUNT(*) FROM tickets t WHERE t.market_id = m.id AND t.status NOT IN ('voided')) AS total_entries
         FROM markets m ${where}
         ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]
      ),
      query(`SELECT COUNT(*) AS total FROM markets m ${where}`, params),
    ]);

    // Attach tier pools if they exist
    const marketIds = markets.map(m => m.id);
    let tierPools = [];
    if (marketIds.length > 0) {
      const placeholders = marketIds.map(() => '?').join(',');
      tierPools = await query(
        `SELECT * FROM market_tier_pools WHERE market_id IN (${placeholders})`,
        marketIds
      );
    }

    const marketsWithPools = markets.map(m => ({
      ...m,
      auto_options: m.auto_options ? (typeof m.auto_options === 'string' ? JSON.parse(m.auto_options) : m.auto_options) : null,
      tier_pools: tierPools.filter(p => p.market_id === m.id),
    }));

    return res.json({ success: true, data: { markets: marketsWithPools, total: totals[0]?.total || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/markets/predictions?fixture_id=:id ───────────────────────────────
// Must be before /:id to avoid Express matching "predictions" as an ID
router.get('/predictions', async (req, res) => {
  const { fixture_id } = req.query;
  if (!fixture_id) return res.status(400).json({ success: false, error: 'fixture_id is required' });

  try {
    const pred = await getFixturePredictions(fixture_id);
    if (!pred) return res.json({ success: true, data: { pick: null } });

    const advice  = pred.predictions?.advice || null;
    const winner  = pred.predictions?.winner?.name || null;
    const percent = pred.predictions?.percent || null;
    const pick    = advice || (winner ? `${winner} to win` : null);

    return res.json({ success: true, data: { pick, advice, winner, percent } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/markets/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  if (IS_MOCK) return res.status(404).json({ success: false, error: 'No market found in mock mode' });

  try {
    const market = await queryOne('SELECT * FROM markets WHERE id = ?', [req.params.id]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found' });

    const tierPools = await query('SELECT * FROM market_tier_pools WHERE market_id = ?', [req.params.id]);

    return res.json({
      success: true,
      data: {
        market: {
          ...market,
          auto_options: market.auto_options ? (typeof market.auto_options === 'string' ? JSON.parse(market.auto_options) : market.auto_options) : null,
          tier_pools: tierPools,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/markets/:id/options ───────────────────────────────────────────────
router.get('/:id/options', async (req, res) => {
  if (IS_MOCK) {
    return res.json({ success: true, data: { options: [] } });
  }

  try {
    const market = await queryOne(
      `SELECT m.*, ma.team_home, ma.team_away
       FROM markets m
       JOIN matches ma ON ma.id = m.match_id
       WHERE m.id = ?`,
      [req.params.id]
    );
    if (!market) return res.status(404).json({ success: false, error: 'Market not found' });

    if (market.prediction_type !== 'market_type') {
      return res.status(400).json({ success: false, error: 'Market is not market_type' });
    }

    // Use stored auto_options if available, otherwise generate
    let options = market.auto_options
      ? (typeof market.auto_options === 'string' ? JSON.parse(market.auto_options) : market.auto_options)
      : generateOptions(market.market_type, market.team_home, market.team_away);

    return res.json({ success: true, data: { options } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/markets ──────────────────────────────────────────────────────────
router.post('/', adminMiddleware, async (req, res) => {
  const {
    match_id, market_type, prediction_type = 'market_pick', admin_pick,
    tier, entry_fee, winner_count,
    tiers,                  // array: [{tier, entry_fee_points, winner_count}]
    staking_opens_at, staking_closes_at,
  } = req.body;

  if (!match_id || !market_type) {
    return res.status(400).json({ success: false, error: 'match_id and market_type are required' });
  }

  if (!IS_DB_CONFIGURED) {
    return res.status(201).json({
      success: true,
      data: { market: { id: `mock-mkt-${Date.now()}`, ...req.body } },
    });
  }

  try {
    const match = await queryOne('SELECT * FROM matches WHERE id = ?', [match_id]);
    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });

    // Generate auto_options for market_type
    let autoOptions = null;
    if (prediction_type === 'market_type') {
      autoOptions = generateOptions(market_type, match.team_home, match.team_away);
    }

    // For api_pick: auto-fetch API-Football's suggested prediction
    let resolvedAdminPick = admin_pick || null;
    if (prediction_type === 'api_pick' && match.api_fixture_id) {
      try {
        const pred = await getFixturePredictions(match.api_fixture_id);
        if (pred?.predictions?.advice) {
          resolvedAdminPick = pred.predictions.advice;
        } else if (pred?.predictions?.winner?.name) {
          resolvedAdminPick = `${pred.predictions.winner.name} to win`;
        }
      } catch { /* use manual admin_pick if provided */ }
    }

    // Determine base tier/entry_fee for backward compatibility
    const baseTier    = tier || (tiers && tiers[0]?.tier) || 'silver';
    const baseEntryFee = entry_fee || (tiers && tiers[0]?.entry_fee_points) || 100;
    const baseWinnerCount = winner_count || (tiers && tiers[0]?.winner_count) || 1;

    await execute(
      `INSERT INTO markets
        (id, match_id, market_type, prediction_type, admin_pick, auto_options, tier, entry_fee, winner_count,
         staking_opens_at, staking_closes_at, status, created_at)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NOW())`,
      [
        match_id, market_type, prediction_type,
        (prediction_type === 'market_pick' || prediction_type === 'api_pick') ? resolvedAdminPick : null,
        autoOptions ? JSON.stringify(autoOptions) : null,
        baseTier, parseInt(baseEntryFee), parseInt(baseWinnerCount),
        staking_opens_at || null, staking_closes_at || null,
      ]
    );

    const market = await queryOne('SELECT * FROM markets ORDER BY created_at DESC LIMIT 1');

    // Create tier pools if tiers array provided
    if (tiers && tiers.length > 0 && market) {
      for (const tp of tiers) {
        if (!tp.tier || !tp.entry_fee_points) continue;
        await execute(
          `INSERT INTO market_tier_pools (id, market_id, tier, entry_fee_points, winner_count, status)
           VALUES (UUID(), ?, ?, ?, ?, 'open')
           ON DUPLICATE KEY UPDATE entry_fee_points = VALUES(entry_fee_points), winner_count = VALUES(winner_count)`,
          [market.id, tp.tier, parseInt(tp.entry_fee_points), parseInt(tp.winner_count) || 1]
        );
      }
    } else if (market) {
      // Create single tier pool from base values
      await execute(
        `INSERT INTO market_tier_pools (id, market_id, tier, entry_fee_points, winner_count, status)
         VALUES (UUID(), ?, ?, ?, ?, 'open')
         ON DUPLICATE KEY UPDATE entry_fee_points = VALUES(entry_fee_points)`,
        [market.id, baseTier, parseInt(baseEntryFee), parseInt(baseWinnerCount)]
      );
    }

    const tierPools = await query('SELECT * FROM market_tier_pools WHERE market_id = ?', [market.id]);

    auditLog(req.user.id, 'CREATE_MARKET', market.id);
    return res.status(201).json({
      success: true,
      data: { market: { ...market, tier_pools: tierPools } },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/markets/:id ───────────────────────────────────────────────────────
router.put('/:id', adminMiddleware, async (req, res) => {
  const allowed = [
    'market_type', 'prediction_type', 'admin_pick', 'auto_options',
    'tier', 'entry_fee', 'winner_count', 'status', 'correct_outcome',
    'actual_result', 'staking_opens_at', 'staking_closes_at',
  ];
  const updates = {};
  allowed.forEach(k => {
    if (req.body[k] !== undefined) {
      updates[k] = k === 'auto_options' && typeof req.body[k] === 'object'
        ? JSON.stringify(req.body[k])
        : req.body[k];
    }
  });

  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, data: { market: { id: req.params.id, ...updates } } });
  }

  try {
    if (Object.keys(updates).length > 0) {
      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await execute(`UPDATE markets SET ${setClauses} WHERE id = ?`, [...Object.values(updates), req.params.id]);
    }

    // Update tier pools if provided
    if (req.body.tier_pools) {
      for (const tp of req.body.tier_pools) {
        if (!tp.tier) continue;
        await execute(
          `INSERT INTO market_tier_pools (id, market_id, tier, entry_fee_points, winner_count)
           VALUES (UUID(), ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE entry_fee_points = VALUES(entry_fee_points), winner_count = VALUES(winner_count)`,
          [req.params.id, tp.tier, parseInt(tp.entry_fee_points), parseInt(tp.winner_count) || 1]
        );
      }
    }

    const market    = await queryOne('SELECT * FROM markets WHERE id = ?', [req.params.id]);
    const tierPools = await query('SELECT * FROM market_tier_pools WHERE market_id = ?', [req.params.id]);

    auditLog(req.user.id, 'UPDATE_MARKET', req.params.id);
    return res.json({ success: true, data: { market: { ...market, tier_pools: tierPools } } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/markets/:id/settle ───────────────────────────────────────────────
router.post('/:id/settle', adminMiddleware, async (req, res) => {
  const { actual_result, correct_option } = req.body;

  if (!correct_option) {
    return res.status(400).json({ success: false, error: 'correct_option is required' });
  }

  if (!IS_DB_CONFIGURED) {
    return res.json({
      success: true,
      data: { correct_option, pools: { silver: { correct: 10, total: 20 }, gold: { correct: 5, total: 10 }, platinum: { correct: 2, total: 4 } } },
    });
  }

  try {
    const market = await queryOne('SELECT * FROM markets WHERE id = ?', [req.params.id]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found' });
    if (market.status === 'settled') return res.status(400).json({ success: false, error: 'Market already settled' });

    // Store the actual result and correct option
    await execute(
      'UPDATE markets SET actual_result = ?, correct_outcome = ?, status = "closed" WHERE id = ?',
      [actual_result || null, correct_option, req.params.id]
    );

    // Count correct vs total per tier from tickets
    const tierPools = await query('SELECT * FROM market_tier_pools WHERE market_id = ?', [req.params.id]);
    const pools = {};

    for (const pool of tierPools) {
      const [totalRow]   = await query(
        'SELECT COUNT(*) AS cnt FROM tickets WHERE market_id = ? AND status = "active" OR (market_id = ? AND status = "pending")',
        [req.params.id, req.params.id]
      );
      const [correctRow] = await query(
        'SELECT COUNT(*) AS cnt FROM tickets WHERE market_id = ? AND (user_prediction = ? OR option_picked = ?)',
        [req.params.id, correct_option, correct_option]
      );
      pools[pool.tier] = {
        correct: correctRow?.cnt || 0,
        total:   totalRow?.cnt   || 0,
        winner_count: pool.winner_count,
      };
      await execute(
        'UPDATE market_tier_pools SET correct_pool_size = ?, status = "closed" WHERE market_id = ? AND tier = ?',
        [correctRow?.cnt || 0, req.params.id, pool.tier]
      );
    }

    auditLog(req.user.id, 'SETTLE_MARKET', req.params.id, { correct_option });

    return res.json({
      success: true,
      data: { correct_option, actual_result, pools },
      message: `Market settled — correct option: ${correct_option}`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/markets/:id ────────────────────────────────────────────────────
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
