const express = require('express');
const router  = express.Router();

const { getTodayFixtures, getLiveFixtures, getUpcomingFixtures, getFixtureById, getFixturesByLeague } = require('../services/fixturesService');
const { getMatchStats, getMatchLineups, getMatchEvents, getH2H, getPlayerRatings } = require('../services/matchService');
const { getStandings, getAllLeagues, getTopLeagues } = require('../services/standingsService');
const { getMatchOdds, getLiveOdds } = require('../services/oddsService');
const { getTeamByName, getTeamStats, getTeamSquad } = require('../services/teamService');
const { getSoccerNews, getNewsForTeam } = require('../services/newsService');
const { getH2HHistorical } = require('../services/historicalService');
const { query, IS_DB_CONFIGURED } = require('../lib/db');
const { cacheMiddleware } = require('../middleware/cache');
const { IS_MOCK, fixtureToMatch } = require('../lib/mockMode');

// ── Fixtures ──────────────────────────────────────────────────────────────────

router.get('/fixtures/today', cacheMiddleware(300), async (req, res) => {
  try {
    const data = await getTodayFixtures();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/fixtures/live', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await getLiveFixtures();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/fixtures/upcoming', cacheMiddleware(300), async (req, res) => {
  try {
    const data = await getUpcomingFixtures();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Must come BEFORE /fixtures/:id to avoid param capture
router.get('/fixtures/league/:leagueId', cacheMiddleware(600), async (req, res) => {
  try {
    const data = await getFixturesByLeague(req.params.leagueId, req.query.season);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/fixtures/:id', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await getFixtureById(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Match detail ──────────────────────────────────────────────────────────────

router.get('/match/:id/stats', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await getMatchStats(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/match/:id/lineups', cacheMiddleware(600), async (req, res) => {
  try {
    const data = await getMatchLineups(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/match/:id/events', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await getMatchEvents(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/match/:id/ratings', cacheMiddleware(300), async (req, res) => {
  try {
    const data = await getPlayerRatings(req.params.id, req.query.teamId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/match/:id/odds', cacheMiddleware(60), async (req, res) => {
  try {
    const { homeTeam, awayTeam } = req.query;
    const data = await getMatchOdds(homeTeam, awayTeam);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── H2H — merge live API + historical CSV ────────────────────────────────────

router.get('/h2h', cacheMiddleware(3600), async (req, res) => {
  const { team1Id, team2Id, team1Name, team2Name, leagueId } = req.query;

  const [apiH2H, historicalH2H] = await Promise.allSettled([
    getH2H(team1Id, team2Id),
    getH2HHistorical(team1Name, team2Name, leagueId),
  ]);

  res.json({
    success: true,
    data: {
      recent:     apiH2H.status      === 'fulfilled' ? apiH2H.value      : [],
      historical: historicalH2H.status === 'fulfilled' ? historicalH2H.value : [],
    },
  });
});

// ── Standings ─────────────────────────────────────────────────────────────────

router.get('/standings/:leagueId', cacheMiddleware(1800), async (req, res) => {
  try {
    const data = await getStandings(req.params.leagueId, req.query.season);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/leagues/top', cacheMiddleware(1800), async (req, res) => {
  try {
    const data = await getTopLeagues();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/leagues', cacheMiddleware(86400), async (req, res) => {
  try {
    const data = await getAllLeagues();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Teams ─────────────────────────────────────────────────────────────────────

router.get('/team/search', cacheMiddleware(86400), async (req, res) => {
  try {
    const data = await getTeamByName(req.query.name);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/team/:id/stats', cacheMiddleware(3600), async (req, res) => {
  try {
    const data = await getTeamStats(req.params.id, req.query.leagueId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/team/:id/squad', cacheMiddleware(86400), async (req, res) => {
  try {
    const data = await getTeamSquad(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Odds ──────────────────────────────────────────────────────────────────────

router.get('/odds/live', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await getLiveOdds();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── News ──────────────────────────────────────────────────────────────────────

router.get('/news', cacheMiddleware(900), async (req, res) => {
  try {
    const data = await getSoccerNews(parseInt(req.query.limit) || 10);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/news/team', cacheMiddleware(900), async (req, res) => {
  try {
    const data = await getNewsForTeam(req.query.team);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Radio ─────────────────────────────────────────────────────────────────────

router.get('/radio/stream', (req, res) => {
  res.json({
    success: true,
    data: {
      url:  process.env.RADIO_STREAM_URL,
      name: 'WinALott Match Day Radio',
    },
  });
});

// ── Ticker (Supabase — active matches + ticket counts) ────────────────────────

router.get('/ticker', cacheMiddleware(60), async (req, res) => {
  if (IS_MOCK) {
    try {
      const { getLiveFixtures, getTodayFixtures } = require('../services/footballService');
      const [liveRes, todayRes] = await Promise.allSettled([getLiveFixtures(), getTodayFixtures()]);
      const raw = [
        ...(liveRes.status  === 'fulfilled' ? liveRes.value  : []),
        ...(todayRes.status === 'fulfilled' ? todayRes.value : []),
      ];
      const seen = new Set();
      const matches = raw
        .filter(f => { const id = f.fixture?.id; return id && !seen.has(id) && seen.add(id); })
        .slice(0, 10)
        .map(f => {
          const m = fixtureToMatch(f);
          return {
            id:         m.id,
            title:      m.title,
            team_home:  m.team_home,
            team_away:  m.team_away,
            league:     m.league,
            match_date: m.match_date,
            status:     m.status,
            markets:    m.markets.map(mk => ({ ...mk, ticket_count: 0 })),
          };
        });
      return res.json({ success: true, data: { matches } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, data: { matches: [] } });
  }

  try {
    const matches = await query(
      `SELECT ma.id, ma.team_home, ma.team_away, ma.league, ma.match_date, ma.status,
              JSON_ARRAYAGG(JSON_OBJECT('id', mk.id, 'market_type', mk.market_type, 'status', mk.status, 'tier', mk.tier)) AS markets
       FROM matches ma
       LEFT JOIN markets mk ON mk.match_id = ma.id
       WHERE ma.status IN ('active','live')
       GROUP BY ma.id
       ORDER BY ma.match_date ASC
       LIMIT 10`
    );

    // Attach ticket counts per market
    const marketIds = matches.flatMap(m => {
      try { return (JSON.parse(m.markets) || []).map(mk => mk.id).filter(Boolean); } catch { return []; }
    });

    let ticketCounts = {};
    if (marketIds.length > 0) {
      const placeholders = marketIds.map(() => '?').join(',');
      const counts = await query(
        `SELECT market_id, COUNT(*) AS n FROM tickets WHERE market_id IN (${placeholders}) AND status = "pending" GROUP BY market_id`,
        marketIds
      );
      counts.forEach(r => { ticketCounts[r.market_id] = r.n; });
    }

    const enriched = matches.map(m => {
      let mkts = [];
      try { mkts = JSON.parse(m.markets) || []; } catch { mkts = []; }
      return {
        ...m,
        markets: mkts.filter(mk => mk && mk.id).map(mk => ({ ...mk, ticket_count: ticketCounts[mk.id] || 0 })),
      };
    });

    res.json({ success: true, data: { matches: enriched } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Legacy aliases (keep old routes working) ─────────────────────────────────

router.get('/scores', cacheMiddleware(30), async (req, res) => {
  try {
    const data = await getLiveFixtures();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
