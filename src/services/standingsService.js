const { apiFootballClient, footballDataOrgClient } = require('../lib/httpClient');
const { getCached, setCache } = require('../lib/redis');

const TOP_LEAGUE_IDS = [39, 140, 78, 135, 61, 2, 3, 1, 9, 6, 253, 4];

async function getStandings(leagueId, season = new Date().getFullYear()) {
  const cacheKey = `standings:${leagueId}:${season}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await apiFootballClient.get('/standings', {
      params: { league: leagueId, season },
    });
    const data = res.data.response[0]?.league?.standings[0] || [];
    await setCache(cacheKey, data, 1800);
    return data;
  } catch {
    const res = await footballDataOrgClient.get(`/competitions/${leagueId}/standings`);
    return res.data.standings?.[0]?.table || [];
  }
}

async function getAllLeagues() {
  const cacheKey = 'leagues:all';
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/leagues', {
    params: { current: true, type: 'League' },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 86400);
  return data;
}

async function getTopLeagues() {
  const results = await Promise.allSettled(
    TOP_LEAGUE_IDS.map(id => getStandings(id))
  );

  return TOP_LEAGUE_IDS.map((id, i) => ({
    leagueId: id,
    standings: results[i].status === 'fulfilled' ? results[i].value : [],
  }));
}

module.exports = { getStandings, getAllLeagues, getTopLeagues };
