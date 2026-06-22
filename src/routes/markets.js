const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { cacheMiddleware }           = require('../middleware/cache');
const { IS_MOCK, fixtureToMatch }   = require('../lib/mockMode');
const { getFixtureById, getFixturePredictions } = require('../services/footballService');
const { generateOptions, identifyCorrectOption } = require('../services/marketOptions');
const { supabaseAdmin }             = require('../lib/supabase');
const { createChangeRequest }       = require('../services/changeRequests');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);
const TIER_ORDER = ['silver', 'gold', 'platinum'];

// Entry-fee bounds per tier, in BTP/dollars (1 BTP = $1 USD)
const TIER_PRICE_RANGE = {
  silver:   { min: 0.10, max: 49  },
  gold:     { min: 49,   max: 249 },
  platinum: { min: 250,  max: 499 },
};

function validateTierFee(tier, feeDollars) {
  const range = TIER_PRICE_RANGE[tier];
  if (!range) return null; // free tier or unknown — no bound
  if (feeDollars < range.min || feeDollars > range.max) {
    return `${tier} entry fee must be between $${range.min} and $${range.max}`;
  }
  return null;
}

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

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      // Map 'open' → 'active' (admin settle page sends status=open)
      const sbStatus = status === 'open' ? 'active' : status;

      let q = supabaseAdmin
        .from('btwin_markets')
        .select(`
          id, match_id, name, description, type, tier, ticket_price,
          options, correct_prediction, status, winner_count, admin_pick,
          staking_opens_at, staking_closes_at, prize_pool, created_at,
          min_entries, max_entries,
          btwin_matches!inner (id, team_home, team_away, league, api_football_id, match_date)
        `, { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (sbStatus && sbStatus !== 'all') q = q.eq('status', sbStatus);
      if (match_id)   q = q.eq('match_id', match_id);
      if (tier)       q = q.eq('tier', tier);
      if (prediction_type) q = q.eq('type', prediction_type);

      const { data: rows, count, error } = await q;
      if (error) throw error;

      // Group by market so each market shows all its tiers
      const marketIds = (rows || []).map(r => r.id);
      let ticketCounts = {};
      if (marketIds.length) {
        const { data: tix } = await supabaseAdmin
          .from('btwin_tickets')
          .select('market_id')
          .in('market_id', marketIds)
          .neq('status', 'voided');
        for (const t of (tix || [])) {
          ticketCounts[t.market_id] = (ticketCounts[t.market_id] || 0) + 1;
        }
      }

      const markets = (rows || []).map(r => {
        const match = r.btwin_matches || {};
        return {
          id:               r.id,
          match_id:         r.match_id,
          market_type:      r.name,
          prediction_type:  r.type,
          admin_pick:       r.admin_pick,
          tier:             r.tier,
          entry_fee:        r.ticket_price,
          winner_count:     r.winner_count || 1,
          correct_outcome:  r.correct_prediction,
          status:           r.status,
          auto_options:     Array.isArray(r.options) ? r.options : (r.options ? r.options : null),
          tier_pools:       [],
          total_entries:    ticketCounts[r.id] || 0,
          min_entries:      r.min_entries,
          max_entries:      r.max_entries,
          team_home:        match.team_home,
          team_away:        match.team_away,
          league:           match.league,
          match_date:       match.match_date,
        };
      });

      return res.json({ success: true, data: { markets, total: count || 0 } });
    } catch (err) {
      console.error('[markets/list/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    const results = { created: 0, skipped: 0, errors: [] };

    for (const fx of fixtures) {
      try {
        const fixtureId = fx.fixture_id || null;
        const teamHome  = fx.team_home || 'Home';
        const teamAway  = fx.team_away || 'Away';
        const matchDate = fx.match_date || new Date().toISOString();

        // Reuse existing btwin_matches row if already imported
        let { data: match } = fixtureId
          ? await supabaseAdmin.from('btwin_matches').select('id, team_home, team_away').eq('api_football_id', Number(fixtureId)).maybeSingle()
          : { data: null };

        if (!match) {
          const { data: newMatch, error: nErr } = await supabaseAdmin.from('btwin_matches').insert({
            title:           `${teamHome} vs ${teamAway}`,
            team_home:       teamHome,
            team_away:       teamAway,
            league:          fx.league || null,
            match_date:      matchDate,
            ticket_sales_close: matchDate,
            status:          'active',
            api_football_id: fixtureId ? Number(fixtureId) : null,
            home_logo:       fx.home_logo || null,
            away_logo:       fx.away_logo || null,
            author_id:       req.user.id,
          }).select().single();
          if (nErr) throw nErr;
          match = newMatch;
        }

        let autoOptions = null;
        if (prediction_type === 'market_type') autoOptions = generateOptions(market_type, teamHome, teamAway);

        let apiPick = null;
        if (prediction_type === 'api_pick' && fixtureId) {
          try {
            const pred = await getFixturePredictions(fixtureId);
            apiPick = pred?.predictions?.advice || (pred?.predictions?.winner?.name ? `${pred.predictions.winner.name} to win` : null);
          } catch { /* continue */ }
        }

        const pickToStore = (prediction_type === 'market_pick' || prediction_type === 'api_pick') ? apiPick : null;

        for (const tp of tiers) {
          if (!tp.tier) continue;

          const feeDollars = parseFloat(tp.entry_fee_points || tp.entry_fee || 0.5);
          const feeError = validateTierFee(tp.tier, feeDollars);
          if (feeError) { results.errors.push({ fixture_id: fx.fixture_id, error: feeError }); continue; }

          const { data: existing } = await supabaseAdmin
            .from('btwin_markets')
            .select('id')
            .eq('match_id', match.id)
            .eq('name', market_type)
            .eq('tier', tp.tier)
            .maybeSingle();
          if (existing) continue;

          await supabaseAdmin.from('btwin_markets').insert({
            match_id:          match.id,
            name:              market_type,
            description:       pickToStore || market_type,
            type:              prediction_type,
            tier:              tp.tier,
            ticket_price:      Math.round(feeDollars * 100),
            options:           autoOptions || null,
            admin_pick:        pickToStore,
            winner_count:      parseInt(tp.winner_count || 1),
            status:            'active',
            staking_opens_at:  staking_opens_at || null,
            staking_closes_at: staking_closes_at || null,
            prize_pool:        0,
            min_entries:       tp.min_entries != null && tp.min_entries !== '' ? parseInt(tp.min_entries) : null,
            max_entries:       tp.max_entries != null && tp.max_entries !== '' ? parseInt(tp.max_entries) : null,
          });
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
router.get('/fixture/:fixtureId', async (req, res) => {
  const { fixtureId } = req.params;

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: match } = await supabaseAdmin
        .from('btwin_matches')
        .select('id, team_home, team_away')
        .eq('api_football_id', Number(fixtureId))
        .maybeSingle();

      if (!match) return res.json({ success: true, data: { markets: [], total: 0 } });

      const { data: markets } = await supabaseAdmin
        .from('btwin_markets')
        .select('*')
        .eq('match_id', match.id)
        .eq('status', 'active');

      if (!markets?.length) return res.json({ success: true, data: { markets: [], total: 0 } });

      // Count tickets per market in one query
      const { data: ticketRows } = await supabaseAdmin
        .from('btwin_tickets')
        .select('market_id')
        .in('market_id', markets.map(m => m.id))
        .neq('status', 'voided');

      const countMap = {};
      (ticketRows || []).forEach(t => { countMap[t.market_id] = (countMap[t.market_id] || 0) + 1; });

      const result = markets
        .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier))
        .map(m => ({
          ...m,
          entry_fee:     m.ticket_price,
          market_type:   m.type,
          team_home:     match.team_home,
          team_away:     match.team_away,
          auto_options:  Array.isArray(m.options) ? m.options
                         : (m.options ? JSON.parse(m.options) : []),
          total_entries: countMap[m.id] || 0,
        }));

      return res.json({ success: true, data: { markets: result, total: result.length } });
    } catch (err) {
      console.error('[markets/fixture/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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

// ── GET /api/markets/:id/activity — live "who's entering" feed for a pool ─────
router.get('/:id/activity', async (req, res) => {
  if (IS_MOCK) return res.json({ success: true, data: { entry_count: 0, recent: [] } });

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: tickets, count, error } = await supabaseAdmin
        .from('btwin_tickets')
        .select('user_id, user_prediction, created_at', { count: 'exact' })
        .eq('market_id', req.params.id)
        .neq('status', 'voided')
        .order('created_at', { ascending: false })
        .limit(15);
      if (error) throw error;

      const userIds = [...new Set((tickets || []).map(t => t.user_id).filter(Boolean))];
      const { data: users } = userIds.length
        ? await supabaseAdmin.from('btwin_users').select('id, username').in('id', userIds)
        : { data: [] };
      const uMap = Object.fromEntries((users || []).map(u => [u.id, u.username]));

      const recent = (tickets || []).map(t => ({
        username:   uMap[t.user_id] || 'player',
        prediction: t.user_prediction,
        created_at: t.created_at,
      }));

      return res.json({ success: true, data: { entry_count: count || 0, recent } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { entry_count: 0, recent: [] } });

  try {
    const recent = await query(
      `SELECT u.username, t.user_prediction AS prediction, t.purchased_at AS created_at
       FROM tickets t JOIN users u ON u.id = t.user_id
       WHERE t.market_id = ? AND t.status NOT IN ('voided')
       ORDER BY t.purchased_at DESC LIMIT 15`,
      [req.params.id]
    );
    const [{ cnt } = { cnt: 0 }] = await query(
      `SELECT COUNT(*) AS cnt FROM tickets WHERE market_id = ? AND status NOT IN ('voided')`,
      [req.params.id]
    );
    return res.json({ success: true, data: { entry_count: cnt || 0, recent } });
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

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: match, error: mErr } = await supabaseAdmin
        .from('btwin_matches')
        .select('id, team_home, team_away, api_football_id')
        .eq('id', match_id)
        .single();
      if (mErr || !match) return res.status(404).json({ success: false, error: 'Match not found' });

      let autoOptions = null;
      if (prediction_type === 'market_type') {
        autoOptions = generateOptions(market_type, match.team_home, match.team_away);
      }

      let resolvedAdminPick = admin_pick || null;
      if (prediction_type === 'api_pick' && match.api_football_id) {
        try {
          const pred = await getFixturePredictions(match.api_football_id);
          if (pred?.predictions?.advice) resolvedAdminPick = pred.predictions.advice;
          else if (pred?.predictions?.winner?.name) resolvedAdminPick = `${pred.predictions.winner.name} to win`;
        } catch { /* keep admin_pick */ }
      }

      const pickToStore = (prediction_type === 'market_pick' || prediction_type === 'api_pick')
        ? resolvedAdminPick : null;

      const tierList = (tiers && tiers.length > 0)
        ? tiers
        : [{ tier: tier || 'silver', entry_fee_points: entry_fee || 100, winner_count: winner_count || 1 }];

      const created = [];
      const tierErrors = [];
      for (const tp of tierList) {
        if (!tp.tier) continue;

        const feeDollars = parseFloat(tp.entry_fee_points || tp.entry_fee || 0.5);
        const feeError = validateTierFee(tp.tier, feeDollars);
        if (feeError) { tierErrors.push(feeError); continue; }

        const { data: mkt, error: mkErr } = await supabaseAdmin
          .from('btwin_markets')
          .insert({
            match_id,
            name:               market_type,
            description:        pickToStore || market_type,
            type:               prediction_type,
            tier:               tp.tier,
            ticket_price:       Math.round(feeDollars * 100),
            options:            autoOptions || null,
            admin_pick:         pickToStore,
            winner_count:       parseInt(tp.winner_count || 1),
            status:             'active',
            staking_opens_at:   staking_opens_at || null,
            staking_closes_at:  staking_closes_at || null,
            prize_pool:         0,
            min_entries:        tp.min_entries != null && tp.min_entries !== '' ? parseInt(tp.min_entries) : null,
            max_entries:        tp.max_entries != null && tp.max_entries !== '' ? parseInt(tp.max_entries) : null,
          })
          .select()
          .single();
        if (mkErr) { console.error('[markets/post/supabase tier]', mkErr.message); continue; }
        created.push(mkt);
      }

      if (!created.length) {
        const error = tierErrors.length
          ? tierErrors.join('; ')
          : 'No markets could be created — check btwin_markets schema has required columns';
        return res.status(400).json({ success: false, error });
      }
      auditLog(req.user.id, 'CREATE_MARKET', created.map(m => m.id).join(','));
      return res.status(201).json({
        success: true,
        data: { markets: created, market: created[0] },
        message: `${created.length} market tier${created.length !== 1 ? 's' : ''} created`,
      });
    } catch (err) {
      console.error('[markets/post/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
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
  // Regular admins can't change ticket price directly — it goes to a super
  // admin for approval. (Other fields in the same request still apply below.)
  if (!req.user?.is_super_admin && req.body.entry_fee !== undefined) {
    try {
      const cr = await createChangeRequest({
        type:         'market_price_change',
        target_id:    req.params.id,
        payload:      { market_id: req.params.id, updates: { ticket_price: Math.round(parseFloat(req.body.entry_fee) * 100) } },
        summary:      `Change ticket price for market ${req.params.id} to $${req.body.entry_fee}`,
        requested_by: req.user?.id,
      });
      delete req.body.entry_fee; // strip so the rest of this request can still apply other fields directly
      if (Object.keys(req.body).length === 0) {
        return res.status(202).json({ success: true, pending: true, data: cr, message: 'Price change submitted for super admin approval' });
      }
      res.locals.priceChangePending = cr;
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  const allowed = [
    'market_type', 'prediction_type', 'admin_pick', 'auto_options',
    'tier', 'entry_fee', 'winner_count', 'status', 'correct_outcome',
    'actual_result', 'staking_opens_at', 'staking_closes_at',
    'min_entries', 'max_entries',
  ];
  const updates = {};
  allowed.forEach(k => {
    if (req.body[k] !== undefined) {
      updates[k] = k === 'auto_options' && typeof req.body[k] === 'object'
        ? JSON.stringify(req.body[k])
        : req.body[k];
    }
  });

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      // Map MySQL field names → Supabase btwin_markets column names
      const sbUpdates = {};
      if (updates.market_type)      sbUpdates.name              = updates.market_type;
      if (updates.prediction_type)  sbUpdates.type              = updates.prediction_type;
      if (updates.admin_pick)       sbUpdates.admin_pick        = updates.admin_pick;
      if (updates.auto_options)     sbUpdates.options           = typeof updates.auto_options === 'string' ? JSON.parse(updates.auto_options) : updates.auto_options;
      if (updates.tier)             sbUpdates.tier              = updates.tier;
      if (updates.entry_fee !== undefined) sbUpdates.ticket_price = parseInt(updates.entry_fee) * 100;
      if (updates.winner_count !== undefined) sbUpdates.winner_count = parseInt(updates.winner_count);
      if (updates.status)           sbUpdates.status            = updates.status;
      if (updates.correct_outcome)  sbUpdates.correct_prediction = updates.correct_outcome;
      if (updates.actual_result)    sbUpdates.description       = updates.actual_result;
      if (updates.staking_opens_at) sbUpdates.staking_opens_at  = updates.staking_opens_at;
      if (updates.staking_closes_at) sbUpdates.staking_closes_at = updates.staking_closes_at;
      if (updates.min_entries !== undefined) sbUpdates.min_entries = updates.min_entries === '' || updates.min_entries == null ? null : parseInt(updates.min_entries);
      if (updates.max_entries !== undefined) sbUpdates.max_entries = updates.max_entries === '' || updates.max_entries == null ? null : parseInt(updates.max_entries);

      if (Object.keys(sbUpdates).length > 0) {
        const { error } = await supabaseAdmin.from('btwin_markets').update(sbUpdates).eq('id', req.params.id);
        if (error) throw error;
      }

      const { data: market } = await supabaseAdmin.from('btwin_markets').select('*').eq('id', req.params.id).single();
      auditLog(req.user.id, 'UPDATE_MARKET', req.params.id);
      return res.json({
        success: true,
        data: { market: { ...market, tier_pools: [] } },
        ...(res.locals.priceChangePending ? { pending: true, pendingRequest: res.locals.priceChangePending } : {}),
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: market, error: mErr } = await supabaseAdmin.from('btwin_markets').select('*').eq('id', req.params.id).single();
      if (mErr || !market) return res.status(404).json({ success: false, error: 'Market not found' });
      if (market.status === 'settled') return res.status(400).json({ success: false, error: 'Market already settled' });

      await supabaseAdmin.from('btwin_markets').update({
        correct_prediction: correct_option,
        description:        actual_result || market.description,
        status:             'active',   // keep active until draw runs
      }).eq('id', req.params.id);

      const { data: tickets } = await supabaseAdmin
        .from('btwin_tickets')
        .select('user_prediction, status')
        .eq('market_id', req.params.id)
        .neq('status', 'voided');

      const total   = (tickets || []).length;
      const correct = (tickets || []).filter(t => t.user_prediction === correct_option).length;
      const pools   = { [market.tier || 'silver']: { correct, total, winner_count: market.winner_count || 1 } };

      auditLog(req.user.id, 'SETTLE_MARKET', req.params.id, { correct_option });
      return res.json({ success: true, data: { correct_option, actual_result, pools }, message: `Market settled — correct: ${correct_option}` });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
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
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { error } = await supabaseAdmin.from('btwin_markets').delete().eq('id', req.params.id);
      if (error) throw error;
      auditLog(req.user.id, 'DELETE_MARKET', req.params.id);
      return res.json({ success: true, message: 'Market deleted' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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
