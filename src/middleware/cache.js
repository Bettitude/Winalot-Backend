const { getRedis } = require('../lib/redis');

/**
 * Redis cache middleware
 * @param {number} ttlSeconds - cache TTL in seconds
 */
function cacheMiddleware(ttlSeconds = 60) {
  return async (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();

    const key = `cache:${req.originalUrl}`;

    try {
      const redis  = getRedis();
      const cached = await redis.get(key);

      if (cached) {
        return res.json(JSON.parse(cached));
      }

      // Monkey-patch res.json to cache the response
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        redis.setex(key, ttlSeconds, JSON.stringify(body)).catch(() => {});
        return originalJson(body);
      };

      next();
    } catch {
      // Redis unavailable — proceed without cache
      next();
    }
  };
}

module.exports = { cacheMiddleware };
