const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { apiFootball }     = require('../services/apiFootball');
const { adminMiddleware } = require('../middleware/admin');
const { authMiddleware }  = require('../middleware/auth');
const { emailService }    = require('../services/email');
const { supabaseAdmin }   = require('../lib/supabase');

const IS_DB = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

// In-memory fallback when Supabase is not configured (dev/demo)
const wcGames = new Map();

// In-memory ticker — populated from finished mock fixtures and from settle calls
const mockTicker = [];

const TICKER_NAMES   = ['mike23','james99','sarah','emma05','chris','tom','olivia','jack11',
                        'amy','liam','sophie','harry','ben','zoe','ryan07','charlotte',
                        'nathan','mia','dylan','grace','ethan','chloe','luke','anna',
                        'josh','jessica','adam','hannah','daniel','katie'];
const TICKER_PRIZES  = [5, 10, 10, 10, 15, 15, 20, 25];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildMockTicker() {
  if (mockTicker.length > 0) return; // already seeded
  const finished = MOCK_WC_FIXTURES.filter(f => ['FT','AET','PEN'].includes(f.fixture.status.short));
  for (const f of finished) {
    const count = Math.floor(Math.random() * 4) + 3; // 3–6 per finished game
    for (let i = 0; i < count; i++) {
      mockTicker.push({
        id:         `mt-${f.fixture.id}-${i}`,
        home_team:  f.teams.home.name,
        away_team:  f.teams.away.name,
        question:   '',
        username:   pickRandom(TICKER_NAMES),
        prize_type: 'cash',
        prize_usd:  pickRandom(TICKER_PRIZES),
        prize_description: null,
        is_dummy:   true,
        created_at: new Date(Date.now() - (finished.indexOf(f) * 3600000 + i * 300000)).toISOString(),
      });
    }
  }
  // Sort newest first
  mockTicker.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function addMockDummies(game) {
  const count = Math.floor(Math.random() * 4) + 3;
  for (let i = 0; i < count; i++) {
    mockTicker.unshift({
      id:                `mt-settle-${game.fixture_id}-${i}`,
      home_team:         game.home_team  || '',
      away_team:         game.away_team  || '',
      question:          game.question   || '',
      username:          pickRandom(TICKER_NAMES),
      prize_type:        game.prize_type || 'cash',
      prize_usd:         game.prize_type === 'cash' ? pickRandom(TICKER_PRIZES) : null,
      prize_description: game.prize_description || null,
      is_dummy:          true,
      created_at:        new Date().toISOString(),
    });
  }
}

// ── Mock WC 2026 fixtures ─────────────────────────────────────────────────────
const F = cc => `https://flagcdn.com/w80/${cc}.png`;
const MOCK_WC_FIXTURES = [
  { fixture: { id: 1100001, date: '2026-06-11T19:00:00+00:00', status: { short: 'FT',  long: 'Match Finished',  elapsed: null }, venue: { name: 'Estadio Azteca',          city: 'Mexico City'   } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 16,   name: 'Mexico',      logo: F('mx')     }, away: { id: 24,   name: 'Poland',      logo: F('pl')     } }, goals: { home: 2, away: 0 } },
  { fixture: { id: 1100002, date: '2026-06-11T22:00:00+00:00', status: { short: '2H',  long: 'Second Half',     elapsed: 67   }, venue: { name: 'SoFi Stadium',            city: 'Los Angeles'   } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 2,    name: 'USA',         logo: F('us')     }, away: { id: 101,  name: 'Jamaica',     logo: F('jm')     } }, goals: { home: 1, away: 0 } },
  { fixture: { id: 1100003, date: '2026-06-12T16:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'Estadio Guadalajara',     city: 'Guadalajara'   } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 6,    name: 'Brazil',      logo: F('br')     }, away: { id: 70,   name: 'Venezuela',   logo: F('ve')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100004, date: '2026-06-12T19:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'MetLife Stadium',         city: 'New York'      } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 26,   name: 'Argentina',   logo: F('ar')     }, away: { id: 15,   name: 'Peru',        logo: F('pe')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100005, date: '2026-06-12T22:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'AT&T Stadium',            city: 'Dallas'        } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 10,   name: 'England',     logo: F('gb-eng') }, away: { id: 14,   name: 'Serbia',      logo: F('rs')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100006, date: '2026-06-13T16:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: "Levi's Stadium",          city: 'San Francisco' } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 2,    name: 'France',      logo: F('fr')     }, away: { id: 94,   name: 'Morocco',     logo: F('ma')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100007, date: '2026-06-13T19:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'Arrowhead Stadium',       city: 'Kansas City'   } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 9,    name: 'Spain',       logo: F('es')     }, away: { id: 85,   name: 'Croatia',     logo: F('hr')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100008, date: '2026-06-13T22:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'NRG Stadium',             city: 'Houston'       } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 25,   name: 'Germany',     logo: F('de')     }, away: { id: 1178, name: 'Scotland',    logo: F('gb-sct') } }, goals: { home: null, away: null } },
  { fixture: { id: 1100009, date: '2026-06-14T16:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'BC Place',                city: 'Vancouver'     } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 21,   name: 'Portugal',    logo: F('pt')     }, away: { id: 63,   name: 'Czechia',     logo: F('cz')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100010, date: '2026-06-14T19:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'BMO Field',               city: 'Toronto'       } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 18,   name: 'Netherlands', logo: F('nl')     }, away: { id: 68,   name: 'Senegal',     logo: F('sn')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100011, date: '2026-06-14T22:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'Estadio BBVA',            city: 'Monterrey'     } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 3,    name: 'Canada',      logo: F('ca')     }, away: { id: 71,   name: 'Colombia',    logo: F('co')     } }, goals: { home: null, away: null } },
  { fixture: { id: 1100012, date: '2026-06-15T16:00:00+00:00', status: { short: 'NS',  long: 'Not Started',     elapsed: null }, venue: { name: 'Lincoln Financial Field', city: 'Philadelphia'  } }, league: { id: 1, name: 'FIFA World Cup', season: 2026, round: 'Group Stage - 1' }, teams: { home: { id: 1,    name: 'Belgium',     logo: F('be')     }, away: { id: 92,   name: 'Egypt',       logo: F('eg')     } }, goals: { home: null, away: null } },
];

// ── DB helpers ────────────────────────────────────────────────────────────────

async function dbEnrichWithCounts(games) {
  if (!games?.length) return games || [];
  const gameIds = games.map(g => g.id);
  const { data: entries } = await supabaseAdmin
    .from('btwin_wc_entries')
    .select('game_id')
    .in('game_id', gameIds);
  const countMap = {};
  for (const e of (entries || [])) {
    countMap[e.game_id] = (countMap[e.game_id] || 0) + 1;
  }
  return games.map(g => ({ ...g, entry_count: countMap[g.id] || 0 }));
}

async function dbGetGamesMap() {
  const { data, error } = await supabaseAdmin
    .from('btwin_wc_games')
    .select('id, fixture_id, question, options, correct_option, prize_type, prize_usd, prize_cents, prize_description, winner_count, status');
  if (error) throw error;
  const enriched = await dbEnrichWithCounts(data || []);
  const map = new Map();
  for (const g of enriched) {
    map.set(String(g.fixture_id), g);
  }
  return map;
}

async function dbGetGame(fixtureId) {
  const { data, error } = await supabaseAdmin
    .from('btwin_wc_games')
    .select('*')
    .eq('fixture_id', String(fixtureId))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { data: entries } = await supabaseAdmin
    .from('btwin_wc_entries')
    .select('id, user_id, username, email, option_key')
    .eq('game_id', data.id);
  return { ...data, entries: entries || [] };
}

async function dbGetAllGames() {
  const { data, error } = await supabaseAdmin
    .from('btwin_wc_games')
    .select('*')
    .order('match_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return dbEnrichWithCounts(data || []);
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function sanitizeGame(game) {
  const entries = Array.isArray(game.entries) ? game.entries : [];
  const { entries: _e, btwin_wc_entries: _b, ...rest } = game;
  return {
    ...rest,
    entry_count:   game.entry_count   ?? entries.length,
    correct_count: game.correct_count ?? entries.filter(e => e.option_key === game.correct_option).length,
  };
}

async function attachGames(fixtures) {
  let gamesMap;
  if (IS_DB) {
    gamesMap = await dbGetGamesMap();
  } else {
    gamesMap = wcGames;
  }
  return fixtures.map(f => {
    // Primary: match by fixture ID
    let game = gamesMap.get(String(f.fixture.id));

    // Fallback: match by home + away team name (handles mock→real ID switch)
    if (!game && f.teams) {
      const home = f.teams.home?.name?.toLowerCase().trim();
      const away = f.teams.away?.name?.toLowerCase().trim();
      for (const g of gamesMap.values()) {
        if (
          g.home_team?.toLowerCase().trim() === home &&
          g.away_team?.toLowerCase().trim() === away
        ) {
          game = g;
          break;
        }
      }
    }

    return { ...f, freeGame: game ? sanitizeGame(game) : null };
  });
}

// ── GET /api/worldcup/fixtures ────────────────────────────────────────────────
router.get('/fixtures', async (req, res) => {
  const { date } = req.query;
  let fixtures;
  let source = 'mock';
  let apiError = null;

  if (!process.env.APIFOOTBALL_KEY) {
    fixtures = date ? MOCK_WC_FIXTURES.filter(f => f.fixture.date.startsWith(date)) : MOCK_WC_FIXTURES;
    source = 'mock_no_key';
  } else {
    try {
      const result = date ? await apiFootball.getWorldCupByDate(date) : await apiFootball.getWorldCupFixtures();
      const rows = result?.response || [];

      if (rows.length > 0) {
        fixtures = rows;
        source = 'api';
      } else {
        // API returned 0 results — might be wrong season/league or plan limitation
        apiError = result?.errors?.length
          ? JSON.stringify(result.errors)
          : `API returned 0 fixtures (results: ${result?.results ?? 'unknown'}, errors: ${JSON.stringify(result?.errors ?? [])})`;
        console.warn('[worldcup/fixtures] API-Football returned empty:', apiError);
        fixtures = date ? MOCK_WC_FIXTURES.filter(f => f.fixture.date.startsWith(date)) : MOCK_WC_FIXTURES;
        source = 'mock_empty_api';
      }
    } catch (err) {
      apiError = err.message;
      console.error('[worldcup/fixtures] API-Football error:', err.message);
      fixtures = date ? MOCK_WC_FIXTURES.filter(f => f.fixture.date.startsWith(date)) : MOCK_WC_FIXTURES;
      source = 'mock_api_error';
    }
  }

  try {
    const data = await attachGames(fixtures);
    return res.json({ success: true, data, source, apiError });
  } catch (err) {
    console.error('[worldcup/fixtures] attachGames error:', err.message);
    return res.json({ success: true, data: fixtures.map(f => ({ ...f, freeGame: null })), source: 'mock_fallback', apiError: err.message });
  }
});

// ── GET /api/worldcup/sync — admin: force-fetch fresh fixtures from API-Football ──
router.get('/sync', adminMiddleware, async (req, res) => {
  if (!process.env.APIFOOTBALL_KEY) {
    return res.status(400).json({ success: false, error: 'APIFOOTBALL_KEY is not configured in .env' });
  }
  try {
    // Use a direct HTTPS request, bypass Redis cache
    const https = require('https');
    const fetchDirect = (path) => new Promise((resolve, reject) => {
      const options = {
        hostname: 'v3.football.api-sports.io',
        path,
        method: 'GET',
        headers: { 'x-apisports-key': process.env.APIFOOTBALL_KEY },
        timeout: 15000,
      };
      const req2 = https.request(options, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('API-Football request timed out')); });
      req2.end();
    });

    const result = await fetchDirect('/fixtures?league=1&season=2026');
    return res.json({
      success: true,
      results: result?.results ?? 0,
      errors: result?.errors ?? [],
      sample: (result?.response || []).slice(0, 2),
      message: result?.results > 0
        ? `API-Football returned ${result.results} WC 2026 fixtures. Data is live.`
        : 'API-Football returned 0 fixtures — check your plan or the league/season ID.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/live ────────────────────────────────────────────────────
router.get('/live', async (_req, res) => {
  const liveStatuses = ['1H', 'HT', '2H', 'ET', 'BT', 'P'];

  if (!process.env.APIFOOTBALL_KEY) {
    const live = MOCK_WC_FIXTURES.filter(f => liveStatuses.includes(f.fixture.status.short));
    const data = await attachGames(live).catch(() => live.map(f => ({ ...f, freeGame: null })));
    return res.json({ success: true, data, source: 'mock' });
  }

  try {
    const result   = await apiFootball.getWorldCupLive();
    const fixtures = result?.response || [];
    const data     = await attachGames(fixtures);
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/games — admin: list all games ───────────────────────────
router.get('/games', authMiddleware, async (_req, res) => {
  try {
    if (IS_DB) {
      const games = await dbGetAllGames();
      return res.json({ success: true, data: games });
    }
    const games = Array.from(wcGames.values())
      .map(sanitizeGame)
      .sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
    return res.json({ success: true, data: games });
  } catch (err) {
    console.error('[worldcup/games GET]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/worldcup/games — admin creates a free prediction game ───────────
router.post('/games', adminMiddleware, async (req, res) => {
  const {
    fixture_id, home_team, away_team, match_date,
    question, options,
    prize_type = 'cash', prize_usd, prize_description,
    winner_count,
  } = req.body;

  if (!fixture_id)         return res.status(400).json({ success: false, error: 'fixture_id is required' });
  if (!question)           return res.status(400).json({ success: false, error: 'question is required' });
  if (!options?.length)    return res.status(400).json({ success: false, error: 'options are required' });
  if (!winner_count)       return res.status(400).json({ success: false, error: 'winner_count is required' });
  if (prize_type === 'cash'  && !prize_usd)         return res.status(400).json({ success: false, error: 'prize_usd required for cash prizes' });
  if (prize_type === 'merch' && !prize_description) return res.status(400).json({ success: false, error: 'prize_description required for merch prizes' });

  const key  = String(fixture_id);
  const game = {
    id:                `wcg-${key}`,
    fixture_id:        key,
    home_team:         home_team  || '',
    away_team:         away_team  || '',
    match_date:        match_date ? match_date.replace(' ', '+') : null,
    question,
    options,
    correct_option:    null,
    prize_type,
    prize_usd:         prize_usd         ? Number(prize_usd)                  : null,
    prize_cents:       prize_usd         ? Math.round(Number(prize_usd) * 100) : null,
    prize_description: prize_description || null,
    winner_count:      Number(winner_count),
    status:            'open',
    created_at:        new Date().toISOString(),
    created_by:        req.user?.id || 'admin',
  };

  try {
    if (IS_DB) {
      const { data: existing } = await supabaseAdmin
        .from('btwin_wc_games')
        .select('id')
        .eq('fixture_id', key)
        .maybeSingle();
      if (existing) return res.status(409).json({ success: false, error: 'A free game already exists for this fixture' });

      // Always supply a UUID so the insert works even if the column has no DEFAULT
      const { created_by: _cb, created_at: _ca, ...dbPayload } = game;
      dbPayload.id = crypto.randomUUID();
      const { data: inserted, error } = await supabaseAdmin
        .from('btwin_wc_games')
        .insert(dbPayload)
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ success: true, data: sanitizeGame(inserted) });
    } else {
      if (wcGames.has(key)) return res.status(409).json({ success: false, error: 'A free game already exists for this fixture' });
      wcGames.set(key, { ...game, entries: [], winners: null });
    }

    return res.status(201).json({ success: true, data: sanitizeGame(game) });
  } catch (err) {
    console.error('[worldcup/games POST]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /api/worldcup/games/:fixtureId — admin updates a game ───────────────
router.patch('/games/:fixtureId', adminMiddleware, async (req, res) => {
  const key = req.params.fixtureId;
  const {
    prize_usd, winner_count, status, correct_option,
    question, options, prize_description, prize_type,
  } = req.body;

  const updates = {};
  if (prize_usd        != null) { updates.prize_usd = Number(prize_usd); updates.prize_cents = Math.round(Number(prize_usd) * 100); }
  if (winner_count     != null) { updates.winner_count = Number(winner_count); }
  if (status)                   { updates.status = status; }
  if (correct_option   !== undefined) { updates.correct_option = correct_option || null; }
  if (question)                 { updates.question = question; }
  if (options)                  { updates.options = options; }
  if (prize_description !== undefined) { updates.prize_description = prize_description || null; }
  if (prize_type)               { updates.prize_type = prize_type; }

  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_wc_games')
        .update(updates)
        .eq('fixture_id', key)
        .select()
        .single();
      if (error) {
        if (error.code === 'PGRST116') return res.status(404).json({ success: false, error: 'Free game not found' });
        throw error;
      }
      return res.json({ success: true, data: sanitizeGame(data) });
    } else {
      const game = wcGames.get(key);
      if (!game) return res.status(404).json({ success: false, error: 'Free game not found' });
      Object.assign(game, updates);
      wcGames.set(key, game);
      return res.json({ success: true, data: sanitizeGame(game) });
    }
  } catch (err) {
    console.error('[worldcup/games PATCH]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/worldcup/games/:fixtureId/predict — user submits prediction ────
router.post('/games/:fixtureId/predict', authMiddleware, async (req, res) => {
  const key        = req.params.fixtureId;
  const { option_key } = req.body;

  if (!option_key) return res.status(400).json({ success: false, error: 'option_key is required' });

  try {
    let game;
    if (IS_DB) {
      const { data } = await supabaseAdmin
        .from('btwin_wc_games')
        .select('id, status, options')
        .eq('fixture_id', key)
        .maybeSingle();
      game = data;
    } else {
      game = wcGames.get(key);
    }

    if (!game)                   return res.status(404).json({ success: false, error: 'Free game not found' });
    if (game.status !== 'open') return res.status(400).json({ success: false, error: 'Predictions are closed for this game' });

    const validOption = Array.isArray(game.options) && game.options.find(o => o.key === option_key);
    if (!validOption) return res.status(400).json({ success: false, error: 'Invalid option' });

    if (IS_DB) {
      const { error } = await supabaseAdmin.from('btwin_wc_entries').insert({
        game_id:    game.id,
        fixture_id: key,
        user_id:    req.user.id,
        username:   req.user.username || '',
        email:      req.user.email    || '',
        option_key,
      });
      if (error) {
        if (error.code === '23505') return res.status(409).json({ success: false, error: 'You have already predicted for this game' });
        throw error;
      }
    } else {
      if (!game.entries) game.entries = [];
      if (game.entries.find(e => e.user_id === req.user.id)) {
        return res.status(409).json({ success: false, error: 'You have already predicted for this game' });
      }
      game.entries.push({ user_id: req.user.id, username: req.user.username, email: req.user.email, option_key, entered_at: new Date().toISOString() });
      wcGames.set(key, game);
    }

    return res.status(201).json({ success: true, message: 'Prediction submitted! You will be entered into the draw if correct.' });
  } catch (err) {
    console.error('[worldcup/predict]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/worldcup/games/:fixtureId/settle ────────────────────────────────
router.post('/games/:fixtureId/settle', adminMiddleware, async (req, res) => {
  const key = req.params.fixtureId;

  try {
    let game, entries;

    if (IS_DB) {
      const { data: g, error: ge } = await supabaseAdmin
        .from('btwin_wc_games')
        .select('*')
        .eq('fixture_id', key)
        .single();
      if (ge || !g) return res.status(404).json({ success: false, error: 'Free game not found' });
      if (g.status === 'settled') return res.status(400).json({ success: false, error: 'Already settled' });
      if (!g.correct_option)     return res.status(400).json({ success: false, error: 'Set the correct answer before settling' });

      const { data: entryRows } = await supabaseAdmin
        .from('btwin_wc_entries')
        .select('user_id, username, email, option_key')
        .eq('game_id', g.id);

      game    = g;
      entries = entryRows || [];
    } else {
      game = wcGames.get(key);
      if (!game)                       return res.status(404).json({ success: false, error: 'Free game not found' });
      if (game.status === 'settled')   return res.status(400).json({ success: false, error: 'Already settled' });
      if (!game.correct_option)        return res.status(400).json({ success: false, error: 'Set the correct answer before settling' });
      entries = game.entries || [];
    }

    const correctPool = entries.filter(e => e.option_key === game.correct_option);

    if (!correctPool.length) {
      const upd = { status: 'settled', settled_at: new Date().toISOString() };
      if (IS_DB) {
        await supabaseAdmin.from('btwin_wc_games').update(upd).eq('fixture_id', key);
      } else {
        Object.assign(game, upd, { winners: [] });
        wcGames.set(key, game);
      }
      return res.json({ success: true, data: { winners: [], winner_count: 0 }, message: 'No correct predictions — settled with no winners' });
    }

    // Provably fair shuffle (HMAC-SHA256)
    const serverSeed     = crypto.randomBytes(32).toString('hex');
    const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const clientSeed     = req.body.client_seed || `wc-${Date.now()}`;
    const hmac           = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');

    const shuffled = [...correctPool].sort((a, b) => {
      const ai = correctPool.indexOf(a);
      const bi = correctPool.indexOf(b);
      return parseInt(hmac.slice((ai * 2) % 56, (ai * 2) % 56 + 8), 16)
           - parseInt(hmac.slice((bi * 2) % 56, (bi * 2) % 56 + 8), 16);
    });

    const selected = shuffled.slice(0, game.winner_count);
    const winners  = selected.map(e => ({
      user_id:           e.user_id,
      username:          e.username,
      email:             e.email,
      prize_type:        game.prize_type,
      prize_usd:         game.prize_usd,
      prize_description: game.prize_description,
    }));

    if (IS_DB) {
      await supabaseAdmin.from('btwin_wc_games').update({
        status:           'settled',
        settled_at:       new Date().toISOString(),
        server_seed:      serverSeed,
        server_seed_hash: serverSeedHash,
        client_seed:      clientSeed,
      }).eq('fixture_id', key);

      for (const w of winners) {
        // Insert winner record
        await supabaseAdmin.from('btwin_wc_winners').insert({
          game_id:           game.id,
          user_id:           w.user_id,
          username:          w.username,
          email:             w.email,
          prize_type:        w.prize_type,
          prize_usd:         w.prize_usd,
          prize_description: w.prize_description,
        }).catch(() => {});

        // Credit wallet for cash prizes
        if (game.prize_type === 'cash' && game.prize_cents) {
          await supabaseAdmin.rpc('btwin_credit_wallet', {
            p_user_id: w.user_id,
            p_amount:  game.prize_cents,
          }).catch(() => {});

          await supabaseAdmin.from('btwin_transactions').insert({
            user_id:     w.user_id,
            type:        'prize_payout',
            amount:      game.prize_cents,
            status:      'completed',
            reference:   `WCG-${game.id}-${w.user_id}`,
            description: `World Cup free game win — ${game.home_team} vs ${game.away_team}`,
          }).catch(() => {});
        }
      }
    } else {
      Object.assign(game, {
        status: 'settled', settled_at: new Date().toISOString(),
        server_seed: serverSeed, server_seed_hash: serverSeedHash, client_seed: clientSeed,
        winners,
      });
      wcGames.set(key, game);
    }

    // Auto-seed winner ticker with dummy entries for social proof
    if (IS_DB) {
      supabaseAdmin.rpc('btwin_wc_insert_dummies', { p_game_id: game.id }).catch(() => {});
    } else {
      addMockDummies(game);
    }

    // Non-blocking: email merch winners asking for address
    for (const w of winners) {
      if (game.prize_type === 'merch') {
        const subject = `You won ${game.prize_description} — World Cup 2026!`;
        const text    = `Congratulations ${w.username}!\n\nYou won "${game.prize_description}" from the free World Cup prediction game (${game.home_team} vs ${game.away_team}).\n\nPlease reply to this email with your full delivery address and we will ship your prize.\n\nTeam WinALott`;
        emailService.sendRaw?.({ to: w.email, subject, text }).catch(() => {});
      }
    }

    return res.json({
      success: true,
      data: {
        winners,
        winner_count:      winners.length,
        correct_pool_size: correctPool.length,
        prize_type:        game.prize_type,
        prize_usd:         game.prize_usd,
        prize_description: game.prize_description,
        server_seed_hash:  serverSeedHash,
        client_seed:       clientSeed,
      },
      message: `Settled — ${winners.length} winner(s) selected`,
    });
  } catch (err) {
    console.error('[worldcup/settle]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/games/:fixtureId/winners ───────────────────────────────
// Returns real winners (not dummies) for a settled game — used by admin history view.
router.get('/games/:fixtureId/winners', adminMiddleware, async (req, res) => {
  const key = req.params.fixtureId;
  try {
    if (IS_DB) {
      const { data: g } = await supabaseAdmin
        .from('btwin_wc_games').select('id').eq('fixture_id', key).maybeSingle();
      if (!g) return res.json({ success: true, data: [] });

      const { data, error } = await supabaseAdmin
        .from('btwin_wc_winners')
        .select('username, email, prize_type, prize_usd, prize_description, created_at')
        .eq('game_id', g.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return res.json({ success: true, data: data || [] });
    }

    // Mock mode — return winners stored on the in-memory game
    const game = wcGames.get(key);
    return res.json({ success: true, data: game?.winners || [] });
  } catch (err) {
    console.error('[worldcup/winners]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/ticker ──────────────────────────────────────────────────
// Returns recent WC winner events (real + dummy) for the scrolling ticker.
router.get('/ticker', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 40, 100);
  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_wc_ticker')
        .select('id, home_team, away_team, question, username, prize_type, prize_usd, prize_description, is_dummy, created_at')
        .or('prize_usd.is.null,prize_usd.lte.50')  // cap: WC prizes never exceed $50
        .not('game_id', 'is', null)                 // must belong to a real WC game
        .order('created_at', { ascending: false })
        .limit(limit);
      // If DB has entries, use them; otherwise fall through to mock below
      if (!error && data && data.length >= 4) {
        return res.json({ success: true, data });
      }
    }

    // Mock mode (no DB, or DB table is still empty) — seed from finished fixtures
    buildMockTicker();
    return res.json({ success: true, data: mockTicker.slice(0, limit) });
  } catch (err) {
    console.error('[worldcup/ticker]', err.message);
    buildMockTicker();
    return res.json({ success: true, data: mockTicker.slice(0, limit) });
  }
});

// ── GET /api/worldcup/leaderboard ─────────────────────────────────────────────
// Returns per-username win/prize totals for the WC leaderboard section.
router.get('/leaderboard', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_wc_leaderboard')
        .select('username, wins, total_usd')
        .limit(limit);
      // Use DB data only if it has real entries
      if (!error && data && data.length >= 3) {
        return res.json({ success: true, data });
      }
    }

    // Mock mode (no DB, or DB is still empty) — derive from in-memory ticker
    buildMockTicker();
    const grouped = {};
    for (const t of mockTicker) {
      if (!t.prize_usd) continue;
      if (!grouped[t.username]) grouped[t.username] = { username: t.username, wins: 0, total_usd: 0 };
      grouped[t.username].wins      += 1;
      grouped[t.username].total_usd += Number(t.prize_usd);
    }
    const data = Object.values(grouped)
      .sort((a, b) => b.total_usd - a.total_usd)
      .slice(0, limit);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[worldcup/leaderboard]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/games/:fixtureId/my-entry — check if authed user already entered ──
router.get('/games/:fixtureId/my-entry', authMiddleware, async (req, res) => {
  const key = req.params.fixtureId;
  try {
    if (IS_DB) {
      const { data: g } = await supabaseAdmin
        .from('btwin_wc_games').select('id').eq('fixture_id', key).maybeSingle();
      if (!g) return res.json({ success: true, data: null });

      const { data } = await supabaseAdmin
        .from('btwin_wc_entries')
        .select('option_key, entered_at')
        .eq('game_id', g.id)
        .eq('user_id', req.user.id)
        .maybeSingle();
      return res.json({ success: true, data: data || null });
    }

    const game = wcGames.get(key);
    const entry = game?.entries?.find(e => e.user_id === req.user.id) || null;
    return res.json({ success: true, data: entry ? { option_key: entry.option_key, entered_at: entry.entered_at } : null });
  } catch (err) {
    console.error('[worldcup/my-entry]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/my-entries — all entries for current user ────────────────
router.get('/my-entries', authMiddleware, async (req, res) => {
  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_wc_entries')
        .select(`
          option_key, entered_at,
          btwin_wc_games (
            fixture_id, home_team, away_team, question, status,
            prize_type, prize_usd, prize_description, winner_count,
            correct_option, options
          )
        `)
        .eq('user_id', req.user.id)
        .order('entered_at', { ascending: false });
      if (error) throw error;
      return res.json({ success: true, data: (data || []).map(e => ({
        option_key:  e.option_key,
        entered_at:  e.entered_at,
        fixture_id:  e.btwin_wc_games?.fixture_id,
        home_team:   e.btwin_wc_games?.home_team,
        away_team:   e.btwin_wc_games?.away_team,
        question:    e.btwin_wc_games?.question,
        status:      e.btwin_wc_games?.status,
        prize_type:  e.btwin_wc_games?.prize_type,
        prize_usd:   e.btwin_wc_games?.prize_usd,
        prize_description: e.btwin_wc_games?.prize_description,
        winner_count: e.btwin_wc_games?.winner_count,
        correct_option: e.btwin_wc_games?.correct_option,
        options:     e.btwin_wc_games?.options,
      })) });
    }

    // Mock mode — gather from in-memory store
    const entries = [];
    for (const [fixtureId, game] of wcGames.entries()) {
      const e = game.entries?.find(en => en.user_id === req.user.id);
      if (e) entries.push({
        option_key: e.option_key, entered_at: e.entered_at,
        fixture_id: fixtureId, home_team: game.home_team, away_team: game.away_team,
        question: game.question, status: game.status,
        prize_type: game.prize_type, prize_usd: game.prize_usd,
        prize_description: game.prize_description, winner_count: game.winner_count,
        correct_option: game.correct_option, options: game.options,
      });
    }
    entries.sort((a, b) => new Date(b.entered_at) - new Date(a.entered_at));
    return res.json({ success: true, data: entries });
  } catch (err) {
    console.error('[worldcup/my-entries]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/worldcup/games/:fixtureId/pool — public pool stats ───────────────
router.get('/games/:fixtureId/pool', async (req, res) => {
  const key = req.params.fixtureId;
  try {
    let game, entries = [];

    if (IS_DB) {
      const { data: g } = await supabaseAdmin
        .from('btwin_wc_games')
        .select('id, home_team, away_team, question, status, prize_type, prize_usd, prize_description, winner_count, options, correct_option, entry_count')
        .eq('fixture_id', key).maybeSingle();
      if (!g) return res.status(404).json({ success: false, error: 'Game not found' });
      game = g;

      const { data: rawEntries } = await supabaseAdmin
        .from('btwin_wc_entries')
        .select('option_key, username, entered_at')
        .eq('game_id', g.id)
        .order('entered_at', { ascending: false })
        .limit(200);
      entries = rawEntries || [];
    } else {
      game = wcGames.get(key);
      if (!game) return res.status(404).json({ success: false, error: 'Game not found' });
      entries = game.entries || [];
    }

    // Build option breakdown counts
    const breakdown = {};
    for (const opt of (game.options || [])) breakdown[opt.key] = { key: opt.key, label: opt.label, count: 0 };
    for (const e of entries) {
      if (breakdown[e.option_key]) breakdown[e.option_key].count++;
    }

    // Recent entrants — show username with last 3 chars masked
    const recent = entries.slice(0, 20).map(e => ({
      username: e.username ? e.username.slice(0, -2).replace(/.(?=.{0,2}$)/g, '*').padStart(e.username.length, e.username[0]) : 'user***',
      option_key: e.option_key,
      entered_at: e.entered_at,
    }));

    return res.json({
      success: true,
      data: {
        fixture_id:   key,
        home_team:    game.home_team,
        away_team:    game.away_team,
        question:     game.question,
        status:       game.status,
        prize_type:   game.prize_type,
        prize_usd:    game.prize_usd,
        prize_description: game.prize_description,
        winner_count: game.winner_count,
        total_entries: entries.length || game.entry_count || 0,
        breakdown:    Object.values(breakdown),
        recent,
      },
    });
  } catch (err) {
    console.error('[worldcup/pool]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/worldcup/games/:fixtureId ─────────────────────────────────────
router.delete('/games/:fixtureId', adminMiddleware, async (req, res) => {
  const key = req.params.fixtureId;
  try {
    if (IS_DB) {
      const { error } = await supabaseAdmin.from('btwin_wc_games').delete().eq('fixture_id', key);
      if (error) throw error;
    } else {
      if (!wcGames.has(key)) return res.status(404).json({ success: false, error: 'Free game not found' });
      wcGames.delete(key);
    }
    return res.json({ success: true, message: 'Free game deleted' });
  } catch (err) {
    console.error('[worldcup/games DELETE]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
