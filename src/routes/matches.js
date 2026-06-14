const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { cacheMiddleware }           = require('../middleware/cache');
const { apiFootball }               = require('../services/apiFootball');
const { IS_MOCK, fixtureToMatch }   = require('../lib/mockMode');
const { getTodayFixtures, getUpcomingFixtures, getFixtureById } = require('../services/footballService');
const { supabaseAdmin }             = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

const POPULAR_LEAGUE_IDS = new Set([
  2, 3, 848, 1, 4, 9,
  39, 61, 78, 88, 94, 135, 140, 179,
  203, 253, 307, 13, 71,
]);

// GET /api/matches
router.get('/', cacheMiddleware(60), async (req, res) => {
  // Always use API-Football fixtures when DB not configured
  if (IS_MOCK) {
    try {
      const [todayRes, upcomingRes] = await Promise.allSettled([
        getTodayFixtures(),
        getUpcomingFixtures(100),
      ]);
      const raw = [
        ...(todayRes.status    === 'fulfilled' ? todayRes.value    : []),
        ...(upcomingRes.status === 'fulfilled' ? upcomingRes.value : []),
      ];
      const seen = new Set();
      const deduped = raw.filter(f => { const id = f.fixture?.id; return id && !seen.has(id) && seen.add(id); });
      const popular = deduped.filter(f => POPULAR_LEAGUE_IDS.has(f.league?.id));
      const source  = popular.length >= 10 ? popular : deduped;
      source.sort((a, b) => new Date(a.fixture?.date || 0) - new Date(b.fixture?.date || 0));
      const matches = source.map(fixtureToMatch);
      return res.json({ success: true, data: { matches, total: matches.length, page: 1, limit: matches.length } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  const { status = 'active', league, page = 1, limit = 20 } = req.query;

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    const offset = (parseInt(page) - 1) * parseInt(limit);
    try {
      let q = supabaseAdmin
        .from('btwin_matches')
        .select('id, title, team_home, team_away, league, stadium, match_date, status, api_football_id', { count: 'exact' })
        .order('match_date', { ascending: true })
        .range(offset, offset + parseInt(limit) - 1);

      if (status !== 'all') q = q.eq('status', status);
      if (league)           q = q.eq('league', league);

      const { data: rawMatches, count, error } = await q;
      if (error) throw error;

      const matchIds = (rawMatches || []).map(m => m.id);
      let marketsMap = {};
      if (matchIds.length) {
        const { data: mkData } = await supabaseAdmin
          .from('btwin_markets')
          .select('id, match_id, name, type, tier, ticket_price, status, options, correct_prediction')
          .in('match_id', matchIds);

        // Count tickets per market for fill_percent / total_entries
        const marketIdList = (mkData || []).map(m => m.id);
        let ticketCounts = {};
        if (marketIdList.length) {
          const { data: tcData } = await supabaseAdmin
            .from('btwin_tickets')
            .select('market_id')
            .in('market_id', marketIdList);
          for (const t of (tcData || [])) {
            ticketCounts[t.market_id] = (ticketCounts[t.market_id] || 0) + 1;
          }
        }

        for (const mk of (mkData || [])) {
          if (!marketsMap[mk.match_id]) marketsMap[mk.match_id] = [];
          marketsMap[mk.match_id].push({
            ...mk,
            total_entries: ticketCounts[mk.id] || 0,
          });
        }
      }

      const matches = (rawMatches || []).map(m => ({
        ...m,
        markets:       marketsMap[m.id] || [],
        total_entries: (marketsMap[m.id] || []).reduce((s, mk) => s + (mk.total_entries || 0), 0),
      }));

      return res.json({ success: true, data: { matches, total: count || 0, page: parseInt(page), limit: parseInt(limit) } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (status !== 'all') { where += ' AND m.status = ?'; params.push(status); }
    if (league)           { where += ' AND m.league = ?'; params.push(league); }

    const matches = await query(
      `SELECT m.*,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', mk.id, 'tier', mk.tier, 'ticket_price', mk.entry_fee,
            'max_tickets', 200, 'fill_percent', 0,
            'correct_prediction', mk.correct_outcome,
            'status', mk.status, 'name', mk.market_type, 'type', mk.market_type,
            'max_winners', mk.winner_count, 'prize_pool', mk.prize_pool,
            'prediction_type', mk.prediction_type,
            'admin_pick', mk.admin_pick,
            'auto_options', mk.auto_options,
            'options', JSON_ARRAY(
              JSON_OBJECT('label', m.team_home, 'value', 'home'),
              JSON_OBJECT('label', 'Draw', 'value', 'draw'),
              JSON_OBJECT('label', m.team_away, 'value', 'away')
            )
          )
        ) AS markets
      FROM matches m
      LEFT JOIN markets mk ON mk.match_id = m.id
      ${where}
      GROUP BY m.id
      ORDER BY m.match_date ASC
      LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const totals = await query(`SELECT COUNT(DISTINCT m.id) AS total FROM matches m ${where}`, params);

    return res.json({ success: true, data: { matches, total: totals[0]?.total || 0, page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/matches/live
router.get('/live', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await apiFootball.getLiveMatches();
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/matches/:id
router.get('/:id', async (req, res) => {
  if (IS_MOCK) {
    try {
      const fixture = await getFixtureById(req.params.id);
      if (!fixture) return res.status(404).json({ success: false, error: 'Match not found' });
      return res.json({ success: true, data: { match: fixtureToMatch(fixture) } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  try {
    const match = await queryOne('SELECT * FROM matches WHERE id = ?', [req.params.id]);
    if (!match) return res.status(404).json({ success: false, error: 'Match not found' });

    const markets = await query('SELECT * FROM markets WHERE match_id = ?', [req.params.id]);
    return res.json({ success: true, data: { match: { ...match, markets } } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/matches  (admin)
router.post('/', adminMiddleware, async (req, res) => {
  const {
    title, team_home, team_away, team_home_id, team_away_id,
    league, league_id, stadium, match_date, ticket_sales_close,
    api_fixture_id, home_logo, away_logo,
    status: reqStatus,   // admin may pass 'draft' or 'active'
  } = req.body;

  if (!team_home || !team_away) {
    return res.status(400).json({ success: false, error: 'team_home and team_away are required' });
  }

  const resolvedTitle  = title || `${team_home} vs ${team_away}`;
  const resolvedStatus = ['draft', 'active'].includes(reqStatus) ? reqStatus : 'draft';

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: match, error } = await supabaseAdmin
        .from('btwin_matches')
        .insert({
          title:           resolvedTitle,
          team_home,
          team_away,
          league:          league || null,
          stadium:         stadium || null,
          match_date:      match_date || null,
          ticket_sales_close: match_date || null,
          status:          resolvedStatus,
          api_football_id: api_fixture_id ? Number(api_fixture_id) : null,
          home_logo:       home_logo || null,
          away_logo:       away_logo || null,
          author_id:       req.user.id,
        })
        .select()
        .single();
      if (error) throw error;
      auditLog(req.user.id, 'CREATE_MATCH', match.id);
      return res.status(201).json({ success: true, data: { match }, message: 'Match created' });
    } catch (err) {
      console.error('[matches/post/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) {
    return res.status(201).json({
      success: true,
      data: { match: { id: `mock-${Date.now()}`, ...req.body, title: resolvedTitle } },
    });
  }

  try {
    await execute(
      `INSERT INTO matches
        (id, title, team_home, team_away, team_home_id, team_away_id, league, league_id,
         stadium, match_date, ticket_sales_close, status, api_fixture_id, home_logo, away_logo, author_id)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolvedTitle, team_home, team_away,
        team_home_id || null, team_away_id || null,
        league || null, league_id || null, stadium || null,
        match_date, ticket_sales_close || match_date,
        resolvedStatus, api_fixture_id || null,
        home_logo || null, away_logo || null,
        req.user.id,
      ]
    );

    const match = await queryOne('SELECT * FROM matches ORDER BY created_at DESC LIMIT 1');
    auditLog(req.user.id, 'CREATE_MATCH', match.id);
    return res.status(201).json({ success: true, data: { match }, message: 'Match created' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/matches/:id  (admin)
router.put('/:id', adminMiddleware, async (req, res) => {
  const allowed = ['title', 'team_home', 'team_away', 'league', 'stadium', 'match_date',
                   'ticket_sales_close', 'status', 'api_fixture_id', 'home_logo', 'away_logo'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'Nothing to update' });
      // Remap api_fixture_id → api_football_id for Supabase
      if (updates.api_fixture_id !== undefined) {
        updates.api_football_id = updates.api_fixture_id ? Number(updates.api_fixture_id) : null;
        delete updates.api_fixture_id;
      }
      const { data: match, error } = await supabaseAdmin
        .from('btwin_matches')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw error;
      auditLog(req.user.id, 'UPDATE_MATCH', req.params.id);
      return res.json({ success: true, data: { match } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { match: { id: req.params.id, ...updates } } });

  try {
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    await execute(`UPDATE matches SET ${setClauses} WHERE id = ?`, [...Object.values(updates), req.params.id]);
    const match = await queryOne('SELECT * FROM matches WHERE id = ?', [req.params.id]);
    auditLog(req.user.id, 'UPDATE_MATCH', req.params.id);
    return res.json({ success: true, data: { match } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/matches/:id  (admin)
router.delete('/:id', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { error } = await supabaseAdmin.from('btwin_matches').delete().eq('id', req.params.id);
      if (error) throw error;
      auditLog(req.user.id, 'DELETE_MATCH', req.params.id);
      return res.json({ success: true, message: 'Match deleted' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Match deleted (mock)' });

  try {
    await execute('DELETE FROM matches WHERE id = ?', [req.params.id]);
    auditLog(req.user.id, 'DELETE_MATCH', req.params.id);
    return res.json({ success: true, message: 'Match deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/matches/:id/sync  (admin)
router.post('/:id/sync', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Sync skipped in mock mode' });

  try {
    const match = await queryOne('SELECT api_fixture_id FROM matches WHERE id = ?', [req.params.id]);
    if (!match?.api_fixture_id) return res.status(400).json({ success: false, error: 'No API-Football ID set' });
    const fixtureData = await apiFootball.getFixture(match.api_fixture_id);
    return res.json({ success: true, data: fixtureData, message: 'Synced from API-Football' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
