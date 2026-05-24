const axios = require('axios');

const apiFootballClient = axios.create({
  baseURL: process.env.APIFOOTBALL_BASE || 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': process.env.APISPORTS_KEY || process.env.APIFOOTBALL_KEY },
  timeout: 10000,
});

apiFootballClient.interceptors.response.use(res => {
  const rem = res.headers['x-ratelimit-requests-remaining'];
  if (rem !== undefined) console.log(`[API-Football] quota remaining: ${rem}`);
  return res;
});

const footballDataOrgClient = axios.create({
  baseURL: process.env.FOOTBALLDATAORG_BASE || 'https://api.football-data.org/v4',
  headers: { 'X-Auth-Token': process.env.FOOTBALLDATAORG_KEY },
  timeout: 10000,
});

const oddsClient = axios.create({
  baseURL: process.env.ODDS_API_BASE || 'https://api.the-odds-api.com/v4',
  timeout: 10000,
});

const sportsDBClient = axios.create({
  baseURL: process.env.SPORTSDB_BASE || 'https://www.thesportsdb.com/api/v1/json/3',
  timeout: 10000,
});

const newsClient = axios.create({
  baseURL: process.env.NEWS_API_URL || 'https://api.thenewsapi.com/v1',
  timeout: 10000,
});

module.exports = {
  apiFootballClient,
  footballDataOrgClient,
  oddsClient,
  sportsDBClient,
  newsClient,
};
