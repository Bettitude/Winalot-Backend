const { Redis } = require('@upstash/redis');

const REDIS_CONFIGURED = (
  process.env.UPSTASH_REDIS_URL &&
  !process.env.UPSTASH_REDIS_URL.includes('your-upstash')
);

let redis = null;

function getRedis() {
  if (!REDIS_CONFIGURED) return null;
  if (!redis) {
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  }
  return redis;
}

async function getCached(key) {
  const r = getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    if (!val) return null;
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch {
    return null;
  }
}

async function setCache(key, data, ttlSeconds) {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(data), { ex: ttlSeconds });
  } catch {
    // cache is optional — fail silently
  }
}

module.exports = { getRedis, getCached, setCache };
