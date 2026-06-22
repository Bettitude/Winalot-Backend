const { sportsDBClient, apiFootballClient } = require('../lib/httpClient');
const { getCached, setCache } = require('../lib/redis');

async function getTeamByName(teamName) {
  const cacheKey = `team:name:${teamName.toLowerCase().replace(/\s/g, '_')}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await sportsDBClient.get('/searchteams.php', {
    params: { t: teamName },
  });
  const team = res.data.teams?.[0] || null;
  await setCache(cacheKey, team, 86400);
  return team;
}

async function getTeamById(teamId) {
  const cacheKey = `team:sportsdb:${teamId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await sportsDBClient.get('/lookupteam.php', {
    params: { id: teamId },
  });
  const team = res.data.teams?.[0] || null;
  await setCache(cacheKey, team, 86400);
  return team;
}

async function getTeamInfo(teamId) {
  const cacheKey = `team:info:${teamId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res  = await apiFootballClient.get('/teams', { params: { id: teamId } });
  const data = res.data.response?.[0] || null;
  await setCache(cacheKey, data, 86400);
  return data;
}

async function getTeamStats(teamId, leagueId, season = new Date().getFullYear()) {
  const cacheKey = `team:stats:${teamId}:${leagueId}:${season}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/teams/statistics', {
    params: { team: teamId, league: leagueId, season },
  });
  const data = res.data.response;
  await setCache(cacheKey, data, 3600);
  return data;
}

async function getTeamSquad(teamId) {
  const cacheKey = `team:squad:${teamId}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await apiFootballClient.get('/players/squads', {
    params: { team: teamId },
  });
  const data = res.data.response[0]?.players || [];
  await setCache(cacheKey, data, 86400);
  return data;
}

async function getLeagueLogo(leagueName) {
  const cacheKey = `league:logo:${leagueName.toLowerCase().replace(/\s/g, '_')}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const res = await sportsDBClient.get('/search_all_leagues.php', {
    params: { s: 'Soccer', c: '' },
  });
  const league = (res.data.countrys || []).find(l =>
    l.strLeague.toLowerCase().includes(leagueName.toLowerCase())
  ) || null;
  await setCache(cacheKey, league, 86400);
  return league;
}

module.exports = {
  getTeamByName,
  getTeamById,
  getTeamInfo,
  getTeamStats,
  getTeamSquad,
  getLeagueLogo,
};
