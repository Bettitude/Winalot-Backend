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

async function dbGetGamesMap() {
  const { data, error } = await supabaseAdmin
    .from('btwin_wc_games')
    .select('fixture_id, id, question, options, correct_option, prize_type, prize_usd, prize_cents, prize_description, winner_count, status, entry_count:btwin_wc_entries(count)');
  if (error) throw error;
  const map = new Map();
  for (const g of (data || [])) {
    const entry_count = parseInt(g.entry_count?.[0]?.count || 0);
    map.set(String(g.fixture_id), { ...g, entry_count, btwin_wc_entries: undefined });
  }
  return map;
}

async function dbGetGame(fixtureId) {
  const { data, error } = await supabaseAdmin
    .from('btwin_wc_games')
    .select('*, entries:btwin_wc_entries(id, user_id, username, email, option_key)')
    .eq('fixture_id', String(fixtureId))
    .maybeSingle();
  if (error) throw error;
  return data ? { ...data, entries: data.entries || [] } : null;
}

async function dbGetAllGames() {
  const { data, error } = await supabaseAdmin
    .from('btwin_wc_games')
    .select('*, entry_count:btwin_wc_entries(count)')
    .order('match_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data || []).map(g => ({
    ...g,
    entry_count:       parseInt(g.entry_count?.[0]?.count || 0),
    entry_count_alias: undefined,
  }));
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
    const game = gamesMap.get(String(f.fixture.id));
    return { ...f, freeGame: game ? sanitizeGame(game) : null };
  });
}

// ── GET /api/worldcup/fixtures ────────────────────────────────────────────────
router.get('/fixtures', async (req, res) => {
  const { date } = req.query;
  let fixtures;

  if (!process.env.APIFOOTBALL_KEY) {
    fixtures = date ? MOCK_WC_FIXTURES.filter(f => f.fixture.date.startsWith(date)) : MOCK_WC_FIXTURES;
  } else {
    try {
      const result = date ? await apiFootball.getWorldCupByDate(date) : await apiFootball.getWorldCupFixtures();
      fixtures = result?.response || [];
    } catch {
      fixtures = MOCK_WC_FIXTURES;
    }
  }

  try {
    const data = await attachGames(fixtures);
    return res.json({ success: true, data, source: process.env.APIFOOTBALL_KEY ? 'api' : 'mock' });
  } catch (err) {
    console.error('[worldcup/fixtures] attachGames error:', err.message);
    return res.json({ success: true, data: fixtures.map(f => ({ ...f, freeGame: null })), source: 'mock_fallback' });
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
    match_date:        match_date || null,
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

      const { error } = await supabaseAdmin.from('btwin_wc_games').insert(game);
      if (error) throw error;
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
