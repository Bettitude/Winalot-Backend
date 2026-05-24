const https  = require('https');
const { getRedis } = require('../lib/redis');

const BASE_URL = 'https://v3.football.api-sports.io';

/**
 * Make a cached GET request to API-Football
 * @param {string} endpoint - e.g. '/fixtures?date=2024-04-18'
 * @param {number} ttl      - cache TTL in seconds
 */
async function apiFetch(endpoint, ttl = 60) {
  const cacheKey = `apifootball:${endpoint}`;

  try {
    const redis  = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Redis unavailable — proceed without cache
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'v3.football.api-sports.io',
      path:     endpoint,
      method:   'GET',
      headers:  { 'x-apisports-key': process.env.APIFOOTBALL_KEY },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', async () => {
        try {
          const parsed = JSON.parse(data);
          try {
            const redis = getRedis();
            await redis.setex(cacheKey, ttl, JSON.stringify(parsed));
          } catch { /* ignore redis errors */ }
          resolve(parsed);
        } catch {
          reject(new Error('Failed to parse API-Football response'));
        }
      });
    });

    req.on('error', (err) => {
      // Attempt to serve stale cache on error
      getRedis().get(cacheKey)
        .then(stale => stale ? resolve(JSON.parse(stale)) : reject(err))
        .catch(() => reject(err));
    });

    req.end();
  });
}

const apiFootball = {
  getLiveMatches:    ()          => apiFetch('/fixtures?live=all',                30),
  getTodayFixtures:  ()          => apiFetch(`/fixtures?date=${today()}`,         60),
  getFixture:        (id)        => apiFetch(`/fixtures?id=${id}`,                30),
  getStats:          (fixtureId) => apiFetch(`/fixtures/statistics?fixture=${fixtureId}`, 60),
  getLineups:        (fixtureId) => apiFetch(`/fixtures/lineups?fixture=${fixtureId}`,    300),
  getOdds:           (fixtureId) => apiFetch(`/odds?fixture=${fixtureId}`,               300),
  getStandings:      (leagueId)  => apiFetch(`/standings?league=${leagueId}&season=2024`, 300),
  getLeagues:        ()          => apiFetch('/leagues',                          600),
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = { apiFootball };
