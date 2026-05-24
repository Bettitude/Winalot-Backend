const axios = require('axios');

const apiSports = axios.create({
  baseURL: process.env.APIFOOTBALL_BASE || 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': process.env.APISPORTS_KEY || process.env.APIFOOTBALL_KEY },
  timeout: 10000,
});

apiSports.interceptors.response.use(res => {
  const rem = res.headers['x-ratelimit-requests-remaining'];
  if (rem !== undefined) console.log(`[API-Sports] quota remaining: ${rem}`);
  return res;
});

module.exports = { apiSports };
