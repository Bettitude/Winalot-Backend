const { apiSports } = require('../lib/apiSports');
const { getCached, setCache } = require('../lib/redis');

const TTL = {
  LIVE:      30,
  FIXTURES:  300,
  STANDINGS: 1800,
  LINEUPS:   600,
  STATS:     30,
  EVENTS:    30,
  H2H:       3600,
  LEAGUES:   86400,
  TEAMS:     86400,
  ODDS:      60,
};

// In-memory fallback cache so repeated polls don't hammer API when Redis is absent
const _mem = new Map();
function memGet(key) {
  const e = _mem.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { _mem.delete(key); return null; }
  return e.val;
}
function memSet(key, val, ttl) {
  _mem.set(key, { val, exp: Date.now() + ttl * 1000 });
}

async function cached(key, ttl, fetcher, fallback = null) {
  const hit = (await getCached(key)) ?? memGet(key);
  if (hit !== null && hit !== undefined) return hit;
  try {
    const data = await fetcher();
    memSet(key, data, ttl);
    await setCache(key, data, ttl);
    return data;
  } catch (err) {
    console.error(`[footballService] ${key} failed:`, err.message);
    return fallback;
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const getLiveFixtures = () =>
  cached('fs:fixtures:live', TTL.LIVE, async () => {
    const res = await apiSports.get('/fixtures', { params: { live: 'all' } });
    return res.data.response || [];
  }, []);

const getTodayFixtures = () => {
  const date = new Date().toISOString().split('T')[0];
  return cached(`fs:fixtures:today:${date}`, TTL.FIXTURES, async () => {
    const res = await apiSports.get('/fixtures', { params: { date, timezone: 'UTC' } });
    return res.data.response || [];
  }, []);
};

const getUpcomingFixtures = (next = 50) =>
  cached(`fs:fixtures:upcoming:${next}`, TTL.FIXTURES, async () => {
    const res = await apiSports.get('/fixtures', { params: { next, timezone: 'UTC' } });
    return res.data.response || [];
  }, []);

const getFixtureById = (id) =>
  cached(`fs:fixture:${id}`, TTL.LIVE, async () => {
    const res = await apiSports.get('/fixtures', { params: { id } });
    return res.data.response?.[0] || null;
  }, null);

const getFixturesByLeague = (leagueId, season = new Date().getFullYear()) =>
  cached(`fs:fixtures:league:${leagueId}:${season}`, TTL.FIXTURES, async () => {
    const res = await apiSports.get('/fixtures', {
      params: { league: leagueId, season, next: 20 },
    });
    return res.data.response || [];
  }, []);

// ── Match detail ──────────────────────────────────────────────────────────────

const getMatchStats = (fixtureId) =>
  cached(`fs:stats:${fixtureId}`, TTL.STATS, async () => {
    const res = await apiSports.get('/fixtures/statistics', { params: { fixture: fixtureId } });
    return res.data.response;
  });

const getMatchLineups = (fixtureId) =>
  cached(`fs:lineups:${fixtureId}`, TTL.LINEUPS, async () => {
    const res = await apiSports.get('/fixtures/lineups', { params: { fixture: fixtureId } });
    return res.data.response;
  });

const getMatchEvents = (fixtureId) =>
  cached(`fs:events:${fixtureId}`, TTL.EVENTS, async () => {
    const res = await apiSports.get('/fixtures/events', { params: { fixture: fixtureId } });
    return res.data.response;
  });

const getH2H = (team1, team2) =>
  cached(`fs:h2h:${team1}:${team2}`, TTL.H2H, async () => {
    const res = await apiSports.get('/fixtures/headtohead', {
      params: { h2h: `${team1}-${team2}`, last: 10 },
    });
    return res.data.response;
  });

const getPlayerRatings = (fixtureId, teamId) =>
  cached(`fs:ratings:${fixtureId}:${teamId}`, TTL.STATS, async () => {
    const res = await apiSports.get('/fixtures/players', {
      params: { fixture: fixtureId, team: teamId },
    });
    return res.data.response;
  });

// ── Standings & Leagues ───────────────────────────────────────────────────────

const TOP_LEAGUE_IDS = [39, 140, 78, 135, 61, 2, 3, 1, 9, 6, 253, 4];

const getStandings = (leagueId, season = new Date().getFullYear()) =>
  cached(`fs:standings:${leagueId}:${season}`, TTL.STANDINGS, async () => {
    const res = await apiSports.get('/standings', { params: { league: leagueId, season } });
    return res.data.response[0]?.league?.standings[0] || [];
  });

const getAllLeagues = () =>
  cached('fs:leagues:all', TTL.LEAGUES, async () => {
    const res = await apiSports.get('/leagues', { params: { current: true, type: 'League' } });
    return res.data.response;
  });

const getTopLeagues = async () => {
  const results = await Promise.allSettled(TOP_LEAGUE_IDS.map(id => getStandings(id)));
  return TOP_LEAGUE_IDS.map((id, i) => ({
    leagueId:  id,
    standings: results[i].status === 'fulfilled' ? results[i].value : [],
  }));
};

// ── Teams ─────────────────────────────────────────────────────────────────────

const getTeamInfo = (teamId) =>
  cached(`fs:team:${teamId}`, TTL.TEAMS, async () => {
    const res = await apiSports.get('/teams', { params: { id: teamId } });
    return res.data.response[0] || null;
  });

const getTeamStats = (teamId, leagueId, season = new Date().getFullYear()) =>
  cached(`fs:team:stats:${teamId}:${leagueId}`, TTL.TEAMS, async () => {
    const res = await apiSports.get('/teams/statistics', {
      params: { team: teamId, league: leagueId, season },
    });
    return res.data.response;
  });

const getTeamSquad = (teamId) =>
  cached(`fs:squad:${teamId}`, TTL.TEAMS, async () => {
    const res = await apiSports.get('/players/squads', { params: { team: teamId } });
    return res.data.response[0]?.players || [];
  });

const searchTeam = (name) =>
  cached(`fs:team:search:${name.toLowerCase().replace(/\s/g, '_')}`, TTL.TEAMS, async () => {
    const res = await apiSports.get('/teams', { params: { search: name } });
    return res.data.response;
  });

// Finds upcoming fixtures for any team whose name matches the query — used by
// the admin "search a match" box. Searching the global next-50 fixtures missed
// almost everything since it isn't scoped to a league; this looks up the team
// first, then pulls that team's own upcoming fixtures.
const searchFixturesByTeam = (query) =>
  cached(`fs:fixtures:search:${query.toLowerCase().replace(/\s/g, '_')}`, TTL.FIXTURES, async () => {
    const teams = (await searchTeam(query)) || [];
    const top   = teams.slice(0, 5);

    const fixtureLists = await Promise.all(
      top.map(t =>
        apiSports
          .get('/fixtures', { params: { team: t.team.id, next: 8 } })
          .then(res => res.data.response || [])
          .catch(() => [])
      )
    );

    const seen = new Set();
    const merged = [];
    for (const list of fixtureLists) {
      for (const f of list) {
        if (seen.has(f.fixture.id)) continue;
        seen.add(f.fixture.id);
        merged.push(f);
      }
    }
    merged.sort((a, b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    return merged.slice(0, 20);
  }, []);

// ── Odds ──────────────────────────────────────────────────────────────────────

const getFixtureOdds = (fixtureId) =>
  cached(`fs:odds:${fixtureId}`, TTL.ODDS, async () => {
    const res = await apiSports.get('/odds', { params: { fixture: fixtureId } });
    return res.data.response;
  });

// ── Predictions (API-Football suggested picks) ────────────────────────────────

const getFixturePredictions = (fixtureId) =>
  cached(`fs:predictions:${fixtureId}`, TTL.FIXTURES, async () => {
    const res = await apiSports.get('/predictions', { params: { fixture: fixtureId } });
    return res.data.response?.[0] || null;
  }, null);

// ── Players ───────────────────────────────────────────────────────────────────

const getPlayer = (playerId, season = new Date().getFullYear()) =>
  cached(`fs:player:${playerId}:${season}`, TTL.TEAMS, async () => {
    const res = await apiSports.get('/players', { params: { id: playerId, season } });
    return res.data.response[0] || null;
  });

module.exports = {
  getLiveFixtures,
  getTodayFixtures,
  getUpcomingFixtures,
  getFixtureById,
  getFixturesByLeague,
  searchFixturesByTeam,
  getMatchStats,
  getMatchLineups,
  getMatchEvents,
  getH2H,
  getPlayerRatings,
  getStandings,
  getAllLeagues,
  getTopLeagues,
  getTeamInfo,
  getTeamStats,
  getTeamSquad,
  searchTeam,
  getFixtureOdds,
  getFixturePredictions,
  getPlayer,
};
