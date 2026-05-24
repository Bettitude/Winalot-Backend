const rateLimit = require('express-rate-limit');

// Skip rate limiting for localhost (dev) — only enforce in production
const skipLocal = (req) => {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

// General API: 500 req / 15 min (production only)
const generalLimiter = rateLimit({
  windowMs:   15 * 60 * 1000,
  max:        500,
  skip:       skipLocal,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many requests, please try again later', code: 429 },
});

// Auth endpoints: 20 req / 15 min (production only)
const authLimiter = rateLimit({
  windowMs:   15 * 60 * 1000,
  max:        20,
  skip:       skipLocal,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many authentication attempts', code: 429 },
});

// Draw endpoint: 10 req / min (production only)
const drawLimiter = rateLimit({
  windowMs:   60 * 1000,
  max:        10,
  skip:       skipLocal,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Draw rate limit exceeded', code: 429 },
});

module.exports = { generalLimiter, authLimiter, drawLimiter };
