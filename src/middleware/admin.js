const { authMiddleware, auditLog } = require('./auth');

/**
 * Admin-only middleware — runs authMiddleware first, then checks role.
 * Re-exported from auth.js for backwards-compatibility with all routes.
 */
async function adminMiddleware(req, res, next) {
  await new Promise(resolve => authMiddleware(req, res, resolve));
  if (res.headersSent) return;
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required', code: 403 });
  }
  next();
}

module.exports = { adminMiddleware, auditLog };
