const { apiFootballClient } = require('../lib/httpClient');
const { getCached, setCache } = require('../lib/redis');

async function getMatchStats(fixtureId) {
  const cacheKey = `stats:${fixtureId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/fixtures/statistics', {
    params: { fixture: fixtureId },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 30);
  return data;
}

async function getMatchLineups(fixtureId) {
  const cacheKey = `lineups:${fixtureId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/fixtures/lineups', {
    params: { fixture: fixtureId },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 600);
  return data;
}

async function getMatchEvents(fixtureId) {
  const cacheKey = `events:${fixtureId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/fixtures/events', {
    params: { fixture: fixtureId },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 30);
  return data;
}

async function getH2H(team1Id, team2Id) {
  const cacheKey = `h2h:${team1Id}:${team2Id}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/fixtures/headtohead', {
    params: { h2h: `${team1Id}-${team2Id}`, last: 10 },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 3600);
  return data;
}

async function getPlayerRatings(fixtureId, teamId) {
  const cacheKey = `ratings:${fixtureId}:${teamId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/fixtures/players', {
    params: { fixture: fixtureId, team: teamId },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 300);
  return data;
}

module.exports = {
  getMatchStats,
  getMatchLineups,
  getMatchEvents,
  getH2H,
  getPlayerRatings,
};
