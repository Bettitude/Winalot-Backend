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

// ── POST /api/markets/bulk ────────────────────────────────────────────────────
// Bulk-create markets for multiple fixtures at once (Mode 2 or Mode 3).
// Body: { fixtures: [{fixture_id, team_home, team_away, match_date, league, home_logo, away_logo}],
//         market_type, prediction_type, tiers }
//
// For each fixture:
//   - Creates (or reuses) a match row
//   - Creates one market row per tier
//   - Mode 3: auto-fetches API-Football prediction per fixture (best-effort)
//
router.post('/bulk', adminMiddleware, async (req, res) => {
  const {
    fixtures = [],
    market_type,
    prediction_type = 'market_type',
    tiers = [{ tier: 'silver', entry_fee_points: 100, winner_count: 5 }],
    staking_opens_at, staking_closes_at,
  } = req.body;

  if (!market_type || !fixtures.length) {
    return res.status(400).json({ success: false, error: 'market_type and fixtures[] are required' });
  }

  if (!IS_DB_CONFIGURED) {
    return res.status(201).json({
      success: true,
      data: { created: fixtures.length, skipped: 0, errors: [] },
      message: `Bulk create skipped (mock mode)`,
    });
  }

  const results = { created: 0, skipped: 0, errors: [] };

  for (const fx of fixtures) {
    try {
      const fixtureId  = fx.fixture_id || null;
      const teamHome   = fx.team_home || 'Home';
      const teamAway   = fx.team_away || 'Away';
      const matchDate  = fx.match_date || new Date().toISOString();

      // Reuse existing match if already imported, otherwise create it
      let match = fixtureId
        ? await queryOne('SELECT * FROM matches WHERE api_fixture_id = ?', [fixtureId])
        : null;

      if (!match) {
        await execute(
          `INSERT INTO matches
            (id, title, team_home, team_away, league, match_date, ticket_sales_close,
             status, api_fixture_id, home_logo, away_logo, author_id)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
          [
            `${teamHome} vs ${teamAway}`,
            teamHome, teamAway,
            fx.league || null,
            matchDate, matchDate,
            fixtureId || null,
            fx.home_logo || null, fx.away_logo || null,
            req.user.id,
          ]
        );
        match = await queryOne('SELECT * FROM matches ORDER BY created_at DESC LIMIT 1');
      }

      // Mode 2: generate options from market category
      let autoOptions = null;
      if (prediction_type === 'market_type') {
        autoOptions = generateOptions(market_type, teamHome, teamAway);
      }

      // Mode 3: fetch API-Football suggestion (best-effort, don't fail the whole batch)
      let apiPick = null;
      if (prediction_type === 'api_pick' && fixtureId) {
        try {
          const pred = await getFixturePredictions(fixtureId);
          apiPick = pred?.predictions?.advice
            || (pred?.predictions?.winner?.name ? `${pred.predictions.winner.name} to win` : null);
        } catch { /* continue without pick */ }
      }

      const pickToStore = (prediction_type === 'market_pick' || prediction_type === 'api_pick')
        ? apiPick
        : null;

      // Create one market row per tier
      for (const tp of tiers) {
        if (!tp.tier) continue;
        // Skip if this tier already exists for this match+market_type
        const existing = await queryOne(
          'SELECT id FROM markets WHERE match_id = ? AND market_type = ? AND tier = ?',
          [match.id, market_type, tp.tier]
        );
        if (existing) continue;

        await execute(
          `INSERT INTO markets
            (id, match_id, market_type, prediction_type, admin_pick, auto_options,
             tier, entry_fee, winner_count, staking_opens_at, staking_closes_at, status, created_at)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NOW())`,
          [
            match.id, market_type, prediction_type,
            pickToStore,
            autoOptions ? JSON.stringify(autoOptions) : null,
            tp.tier,
            parseInt(tp.entry_fee_points || 100),
            parseInt(tp.winner_count || 1),
            staking_opens_at || null,
            staking_closes_at || null,
          ]
        );
      }

      results.created++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ fixture_id: fx.fixture_id, error: err.message });
    }
  }

  auditLog(req.user.id, 'BULK_CREATE_MARKETS', null, { market_type, prediction_type, count: results.created });
  return res.status(201).json({
    success: true,
    data: results,
    message: `Bulk created ${results.created} match${results.created !== 1 ? 'es' : ''}, ${results.skipped} skipped`,
  });
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

// ── GET /api/markets/fixture/:fixtureId — by API-Football fixture ID ──────────
// Returns all markets whose parent match has api_fixture_id = fixtureId
router.get('/fixture/:fixtureId', async (req, res) => {
  const { fixtureId } = req.params;

  if (IS_MOCK || !IS_DB_CONFIGURED) {
    return res.json({ success: true, data: { markets: [], total: 0 } });
  }

  try {
    const match = await queryOne('SELECT * FROM matches WHERE api_fixture_id = ?', [fixtureId]);
    if (!match) return res.json({ success: true, data: { markets: [], total: 0 } });

    const markets = await query(
      `SELECT m.*,
         (SELECT COUNT(*) FROM tickets t
          WHERE t.market_id = m.id AND t.status NOT IN ('voided','refunded')) AS total_entries
       FROM markets m
       WHERE m.match_id = ?
       ORDER BY FIELD(m.tier, 'silver', 'gold', 'platinum'), m.created_at ASC`,
      [match.id]
    );

    const result = markets.map(m => ({
      ...m,
      auto_options: m.auto_options
        ? (typeof m.auto_options === 'string' ? JSON.parse(m.auto_options) : m.auto_options)
        : null,
    }));

    return res.json({ success: true, data: { markets: result, total: result.length } });
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
//
// prediction_type controls which of the 3 modes is used:
//   market_pick  (Mode 1) — analyst writes a specific pick; users vote YES or NO
//   market_type  (Mode 2) — system auto-generates all standard options for the market
//   api_pick     (Mode 3) — API-Football's suggested pick is fetched automatically;
//                           users vote YES or NO against it
//
// When `tiers` array is provided, ONE market row is created per tier so the
// frontend StakeModal can show exactly one card per tier (Silver / Gold / Platinum).
//
router.post('/', adminMiddleware, async (req, res) => {
  const {
    match_id, market_type, prediction_type = 'market_pick', admin_pick,
    tier, entry_fee, winner_count,
    tiers,               // [{tier, entry_fee_points, winner_count}]
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

    // ── Mode 2: generate all standard options for the chosen market category ──
    let autoOptions = null;
    if (prediction_type === 'market_type') {
      autoOptions = generateOptions(market_type, match.team_home, match.team_away);
    }

    // ── Mode 3: auto-fetch API-Football's suggested prediction ────────────────
    let resolvedAdminPick = admin_pick || null;
    if (prediction_type === 'api_pick' && match.api_fixture_id) {
      try {
        const pred = await getFixturePredictions(match.api_fixture_id);
        if (pred?.predictions?.advice) {
          resolvedAdminPick = pred.predictions.advice;
        } else if (pred?.predictions?.winner?.name) {
          resolvedAdminPick = `${pred.predictions.winner.name} to win`;
        }
      } catch { /* fall back to manual admin_pick */ }
    }

    // admin_pick is only stored for modes that use YES/NO binary voting
    const pickToStore = (prediction_type === 'market_pick' || prediction_type === 'api_pick')
      ? resolvedAdminPick
      : null;

    // ── Build tier list ────────────────────────────────────────────────────────
    // If `tiers` array provided, create one market row per tier.
    // Otherwise fall back to a single market using the flat tier/entry_fee fields.
    const tierList = (tiers && tiers.length > 0)
      ? tiers
      : [{ tier: tier || 'silver', entry_fee_points: entry_fee || 100, winner_count: winner_count || 1 }];

    const createdIds = [];

    for (const tp of tierList) {
      if (!tp.tier) continue;
      await execute(
        `INSERT INTO markets
          (id, match_id, market_type, prediction_type, admin_pick, auto_options,
           tier, entry_fee, winner_count, staking_opens_at, staking_closes_at, status, created_at)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NOW())`,
        [
          match_id, market_type, prediction_type,
          pickToStore,
          autoOptions ? JSON.stringify(autoOptions) : null,
          tp.tier,
          parseInt(tp.entry_fee_points || tp.entry_fee || 100),
          parseInt(tp.winner_count || 1),
          staking_opens_at || null,
          staking_closes_at || null,
        ]
      );

      // Capture the UUID just inserted so we can return it
      const inserted = await queryOne(
        'SELECT id FROM markets WHERE match_id = ? AND tier = ? ORDER BY created_at DESC LIMIT 1',
        [match_id, tp.tier]
      );
      if (inserted?.id) createdIds.push(inserted.id);
    }

    const markets = createdIds.length
      ? await query(`SELECT * FROM markets WHERE id IN (${createdIds.map(() => '?').join(',')})`, createdIds)
      : [];

    auditLog(req.user.id, 'CREATE_MARKET', createdIds.join(','));
    return res.status(201).json({
      success: true,
      data: { markets, market: markets[0] || null },
      message: `${markets.length} market tier${markets.length !== 1 ? 's' : ''} created`,
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
