const { apiFootballClient, footballDataOrgClient } = require('../lib/httpClient');
const { getCached, setCache } = require('../lib/redis');

function today() {
  return new Date().toISOString().slice(0, 10);
}

// In-memory fallback cache for when Redis is not configured
const memCache = new Map();
function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { memCache.delete(key); return null; }
  return entry.value;
}
function memSet(key, value, ttlSeconds) {
  memCache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

async function getCache(key) {
  return (await getCached(key)) ?? memGet(key);
}
async function putCache(key, value, ttl) {
  memSet(key, value, ttl);
  await setCache(key, value, ttl);
}

async function getTodayFixtures() {
  const date = today();
  const cacheKey = `fixtures:today:${date}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await apiFootballClient.get('/fixtures', {
      params: { date, timezone: 'UTC' },
    });
    const data = res.data.response || [];
    await putCache(cacheKey, data, 300);
    return data;
  } catch (err) {
    console.error('[fixturesService] getTodayFixtures failed:', err.message);
    try {
      const res = await footballDataOrgClient.get('/matches', {
        params: { dateFrom: date, dateTo: date },
      });
      return res.data.matches || [];
    } catch {
      return [];
    }
  }
}

async function getLiveFixtures() {
  const cacheKey = 'fixtures:live';
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await apiFootballClient.get('/fixtures', { params: { live: 'all' } });
    const data = res.data.response || [];
    await putCache(cacheKey, data, 30);
    return data;
  } catch (err) {
    console.error('[fixturesService] getLiveFixtures failed:', err.message);
    return [];
  }
}

async function getFixtureById(fixtureId) {
  const cacheKey = `fixture:${fixtureId}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await apiFootballClient.get('/fixtures', { params: { id: fixtureId } });
    const data = res.data.response?.[0] || null;
    if (data) await putCache(cacheKey, data, 60);
    return data;
  } catch (err) {
    console.error('[fixturesService] getFixtureById failed:', err.message);
    return null;
  }
}

async function getFixturesByLeague(leagueId, season = new Date().getFullYear()) {
  const cacheKey = `fixtures:league:${leagueId}:${season}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await apiFootballClient.get('/fixtures', {
      params: { league: leagueId, season, next: 20 },
    });
    const data = res.data.response || [];
    await putCache(cacheKey, data, 600);
    return data;
  } catch (err) {
    console.error('[fixturesService] getFixturesByLeague failed:', err.message);
    return [];
  }
}

async function getUpcomingFixtures(next = 50) {
  const cacheKey = `fixtures:upcoming:${next}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const res = await apiFootballClient.get('/fixtures', {
      params: { next, timezone: 'UTC' },
    });
    const data = res.data.response || [];
    await putCache(cacheKey, data, 300);
    return data;
  } catch (err) {
    console.error('[fixturesService] getUpcomingFixtures failed:', err.message);
    return [];
  }
}

module.exports = {
  getTodayFixtures,
  getLiveFixtures,
  getFixtureById,
  getFixturesByLeague,
  getUpcomingFixtures,
};
