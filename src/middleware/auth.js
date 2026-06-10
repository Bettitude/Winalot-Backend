const jwt            = require('jsonwebtoken');
const { supabaseAdmin } = require('../lib/supabase');
const { getCached, setCache } = require('../lib/redis');
const { execute }    = require('../lib/db');

const JWT_SECRET = process.env.JWT_SECRET || 'winalott_dev_secret_change_in_prod';

// Cache user status for 2 minutes — prevents a DB hit on every request.
// This means a suspended user gets at most 2 more minutes of access.
const USER_CACHE_TTL = 120;

async function getUser(userId) {
  const cacheKey = `user:status:${userId}`;

  // Fast path — Redis hit (~1ms)
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // Slow path — Supabase query (~50ms), cache for next 2 min
  const IS_SUPABASE = !!(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !process.env.SUPABASE_URL.includes('your-')
  );

  if (!IS_SUPABASE) return null;

  const { data } = await supabaseAdmin
    .from('btwin_users')
    .select('id, email, username, role, status, wallet_balance')
    .eq('id', userId)
    .single();

  if (data) await setCache(cacheKey, data, USER_CACHE_TTL);
  return data || null;
}

/**
 * Verify our JWT and attach user to req.user.
 * JWT verification is in-memory (O(1)) — no DB hit per request.
 * Only the status check hits Redis/Supabase (cached 2 min).
 */
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing authorization header', code: 401 });
  }

  const token = header.split(' ')[1];

  // Demo/dev bypass — dummy tokens are not real JWTs; treat them as the demo admin
  if (token.startsWith('dummy_')) {
    req.user  = { id: 'demo-admin-001', email: 'admin@winalott.com', username: 'admin', role: 'admin', status: 'enabled', wallet_balance: 0 };
    req.token = token;
    return next();
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid or expired token', code: 401 });
  }

  try {
    const user = await getUser(payload.sub);

    if (!user) {
      // Dev mode — no Supabase configured. Accept any valid JWT.
      req.user  = { id: payload.sub, email: payload.email, role: payload.role || 'user', username: payload.username, wallet_balance: 0 };
      req.token = token;
      return next();
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Account suspended', code: 403 });
    }
    if (user.status === 'disabled') {
      return res.status(403).json({ success: false, error: 'Account disabled', code: 403 });
    }

    req.user  = user;
    req.token = token;
    next();
  } catch (err) {
    console.error('[authMiddleware]', err.message);
    return res.status(500).json({ success: false, error: 'Auth check failed', code: 500 });
  }
}

/**
 * Admin-only middleware. Runs authMiddleware first.
 */
async function adminMiddleware(req, res, next) {
  await authMiddleware(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required', code: 403 });
    }
    next();
  });
}

/**
 * Write an admin action to btwin_audit_log.
 * Non-blocking — never throws.
 */
async function auditLog(adminId, action, targetType, targetId, meta = {}) {
  const IS_DB = !!(process.env.DB_HOST && !process.env.DB_HOST.includes('your-'));
  const IS_SUPABASE = !!(process.env.SUPABASE_URL && !process.env.SUPABASE_URL.includes('your-'));

  try {
    if (IS_SUPABASE) {
      await supabaseAdmin
        .from('btwin_audit_log')
        .insert({ admin_id: adminId, action, target_type: targetType || null, target_id: targetId || null, metadata: meta });
    } else if (IS_DB) {
      await execute(
        'INSERT INTO btwin_audit_log (id, admin_id, action, target_type, target_id, metadata) VALUES (UUID(), ?, ?, ?, ?, ?)',
        [adminId, action, targetType || null, targetId || null, JSON.stringify(meta)]
      );
    }
  } catch { /* audit log is non-blocking */ }
}

/**
 * Invalidate the Redis user-status cache for a given user.
 * Call this when a user is suspended, enabled, or their role changes.
 */
async function invalidateUserCache(userId) {
  const { getRedis } = require('../lib/redis');
  const r = getRedis();
  if (r) {
    try { await r.del(`user:status:${userId}`); } catch { /* non-blocking */ }
  }
}

module.exports = { authMiddleware, adminMiddleware, auditLog, invalidateUserCache, JWT_SECRET };
