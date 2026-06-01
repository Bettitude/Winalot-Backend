const express = require('express');
const router  = express.Router();

const {
  getLiveFixtures, getTodayFixtures, getUpcomingFixtures,
  getFixtureById, getFixturesByLeague,
  getMatchStats, getMatchLineups, getMatchEvents, getH2H, getPlayerRatings,
  getStandings, getAllLeagues, getTopLeagues,
  getTeamInfo, getTeamStats, getTeamSquad, searchTeam,
  getFixtureOdds, getPlayer,
} = require('../services/footballService');

const h = fn => (req, res) =>
  fn(req, res).catch(err => {
    console.error('[football]', err.message);
    res.status(500).json({ success: false, error: err.message });
  });

// ── Fixtures ──────────────────────────────────────────────────────────────────

router.get('/fixtures/search', h(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ success: true, data: [] });
  // Search upcoming fixtures by team name
  const upcoming = await getUpcomingFixtures(50);
  const term = q.toLowerCase();
  const matches = (upcoming || []).filter(f => {
    const home = (f.teams?.home?.name || '').toLowerCase();
    const away = (f.teams?.away?.name || '').toLowerCase();
    return home.includes(term) || away.includes(term);
  }).slice(0, 10);
  res.json({ success: true, data: matches });
}));

router.get('/fixtures/live', h(async (_, res) => {
  res.json({ success: true, data: await getLiveFixtures() });
}));

router.get('/fixtures/today', h(async (_, res) => {
  res.json({ success: true, data: await getTodayFixtures() });
}));

router.get('/fixtures/upcoming', h(async (req, res) => {
  res.json({ success: true, data: await getUpcomingFixtures(req.query.next) });
}));

router.get('/fixtures/league/:leagueId', h(async (req, res) => {
  res.json({
    success: true,
    data: await getFixturesByLeague(req.params.leagueId, req.query.season),
  });
}));

router.get('/fixtures/:id', h(async (req, res) => {
  res.json({ success: true, data: await getFixtureById(req.params.id) });
}));

// ── Match detail ──────────────────────────────────────────────────────────────

router.get('/match/:id/stats', h(async (req, res) => {
  res.json({ success: true, data: await getMatchStats(req.params.id) });
}));

router.get('/match/:id/lineups', h(async (req, res) => {
  res.json({ success: true, data: await getMatchLineups(req.params.id) });
}));

router.get('/match/:id/events', h(async (req, res) => {
  res.json({ success: true, data: await getMatchEvents(req.params.id) });
}));

router.get('/match/:id/ratings', h(async (req, res) => {
  res.json({
    success: true,
    data: await getPlayerRatings(req.params.id, req.query.teamId),
  });
}));

router.get('/match/:id/odds', h(async (req, res) => {
  res.json({ success: true, data: await getFixtureOdds(req.params.id) });
}));

// ── H2H ───────────────────────────────────────────────────────────────────────

router.get('/h2h', h(async (req, res) => {
  const { team1, team2 } = req.query;
  res.json({ success: true, data: await getH2H(team1, team2) });
}));

// ── Standings & Leagues ───────────────────────────────────────────────────────

router.get('/standings/:leagueId', h(async (req, res) => {
  res.json({
    success: true,
    data: await getStandings(req.params.leagueId, req.query.season),
  });
}));

router.get('/leagues/top', h(async (_, res) => {
  res.json({ success: true, data: await getTopLeagues() });
}));

router.get('/leagues', h(async (_, res) => {
  res.json({ success: true, data: await getAllLeagues() });
}));

// ── Teams ─────────────────────────────────────────────────────────────────────

router.get('/team/search', h(async (req, res) => {
  res.json({ success: true, data: await searchTeam(req.query.name) });
}));

router.get('/team/:id/stats', h(async (req, res) => {
  res.json({
    success: true,
    data: await getTeamStats(req.params.id, req.query.leagueId, req.query.season),
  });
}));

router.get('/team/:id/squad', h(async (req, res) => {
  res.json({ success: true, data: await getTeamSquad(req.params.id) });
}));

router.get('/team/:id', h(async (req, res) => {
  res.json({ success: true, data: await getTeamInfo(req.params.id) });
}));

// ── Players ───────────────────────────────────────────────────────────────────

router.get('/player/:id', h(async (req, res) => {
  res.json({ success: true, data: await getPlayer(req.params.id, req.query.season) });
}));

// ── Radio ─────────────────────────────────────────────────────────────────────

router.get('/radio', (_, res) => {
  res.json({
    success: true,
    data: { url: process.env.RADIO_STREAM_URL, name: 'WinALott Match Day Radio' },
  });
});

module.exports = router;
