const axios = require('axios');
const { parse } = require('csv-parse/sync');
const { getCached, setCache } = require('../lib/redis');

// Football-data.co.uk league codes (API-Football league ID → CSV code)
const LEAGUE_CSV_CODES = {
  39:  'E0',   // Premier League
  140: 'SP1',  // La Liga
  78:  'D1',   // Bundesliga
  135: 'I1',   // Serie A
  61:  'F1',   // Ligue 1
};

async function getHistoricalResults(leagueId, season = '2324') {
  const code = LEAGUE_CSV_CODES[leagueId];
  if (!code) return [];

  const cacheKey = `historical:${leagueId}:${season}`;
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const url = `https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`;
  const res = await axios.get(url, {
    headers: process.env.FOOTBALLDATA_CO_KEY
      ? { Authorization: `Bearer ${process.env.FOOTBALLDATA_CO_KEY}` }
      : {},
    responseType: 'text',
    timeout: 15000,
  });

  const records = parse(res.data, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const data = records.map(r => ({
    date:         r.Date,
    homeTeam:     r.HomeTeam,
    awayTeam:     r.AwayTeam,
    homeGoals:    parseInt(r.FTHG) || 0,
    awayGoals:    parseInt(r.FTAG) || 0,
    result:       r.FTR,   // H, D, or A
    homeCorners:  r.HC,
    awayCorners:  r.AC,
    homeShots:    r.HS,
    awayShots:    r.AS,
    homeFouls:    r.HF,
    awayFouls:    r.AF,
    homeYellow:   r.HY,
    awayYellow:   r.AY,
  }));

  await setCache(cacheKey, data, 86400);
  return data;
}

async function getH2HHistorical(team1, team2, leagueId) {
  const results = await getHistoricalResults(leagueId);
  return results.filter(r =>
    (r.homeTeam && r.homeTeam.includes(team1) && r.awayTeam && r.awayTeam.includes(team2)) ||
    (r.homeTeam && r.homeTeam.includes(team2) && r.awayTeam && r.awayTeam.includes(team1))
  ).slice(0, 10);
}

module.exports = { getHistoricalResults, getH2HHistorical };
