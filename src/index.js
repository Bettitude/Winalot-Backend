require('dotenv').config();

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const helmet  = require('helmet');

const { generalLimiter, authLimiter } = require('./middleware/rateLimiter');
const { initSocket }   = require('./socket');
const { runAndStore, getLastStatus } = require('./lib/startup');

const authRoutes          = require('./routes/auth');
const matchRoutes         = require('./routes/matches');
const marketRoutes        = require('./routes/markets');
const ticketRoutes        = require('./routes/tickets');
const drawRoutes          = require('./routes/draws');
const transactionRoutes   = require('./routes/transactions');
const userRoutes          = require('./routes/users');
const notificationRoutes  = require('./routes/notifications');
const liveRoutes          = require('./routes/live');
const footballRoutes      = require('./routes/football');
const giveawayRoutes      = require('./routes/giveaways');
const worldcupRoutes      = require('./routes/worldcup');
const analyticsRoutes     = require('./routes/analytics');
const adminStatsRoutes    = require('./routes/adminStats');
const referralRoutes      = require('./routes/referrals');
const btpSettingsRoutes   = require('./routes/btpSettings');
const adsRoutes           = require('./routes/ads');

const app    = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';

const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  process.env.ADMIN_URL  || 'http://localhost:5174',
  'https://www.bwinalott.com',
  'https://bwinalott.com',
  'https://admin.bwinalott.com',
  'https://win-a-lott.vercel.app',
  'https://win-a-lott-admin.vercel.app',
  ...(process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(',').map(o => o.trim()) : []),
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                           // server-to-server / curl
    if (!isProd) return cb(null, true);                          // allow all origins in dev
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Core middleware ────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Dev request logger ────────────────────────────────────────────────────────
// Logs every request body/query in development so you can see inputs while testing
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    const body = req.body ? { ...req.body } : {};
    if (body.password)         body.password         = '●●●●●●●●';
    if (body.new_password)     body.new_password     = '●●●●●●●●';
    if (body.current_password) body.current_password = '●●●●●●●●';
    const parts = [`\x1b[36m${req.method}\x1b[0m ${req.path}`];
    if (Object.keys(req.query).length) parts.push(`query=${JSON.stringify(req.query)}`);
    if (Object.keys(body).length)      parts.push(`body=${JSON.stringify(body)}`);
    const auth = req.headers.authorization;
    if (auth) parts.push(`auth=Bearer …${auth.slice(-6)}`);
    console.log('\x1b[90m[request]\x1b[0m', parts.join(' | '));
    next();
  });
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', generalLimiter);
app.use('/api/auth', authLimiter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const s = getLastStatus();
  res.json({
    status:   s.supabase ? 'ok' : 'degraded',
    supabase: s.supabase  ? 'connected'     : 'not connected',
    redis:    s.redis     ? 'connected'     : 'not connected',
    details:  s.details,
    checkedAt: s.checkedAt,
    ts: new Date().toISOString(),
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/matches',       matchRoutes);
app.use('/api/markets',       marketRoutes);
app.use('/api/tickets',       ticketRoutes);
app.use('/api/draws',         drawRoutes);
app.use('/api/transactions',  transactionRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/live',          liveRoutes);
app.use('/api/football',      footballRoutes);
app.use('/api/giveaways',     giveawayRoutes);
app.use('/api/worldcup',     worldcupRoutes);
app.use('/api/analytics',    analyticsRoutes);
app.use('/api/admin/stats',  adminStatsRoutes);
app.use('/api/referrals',   referralRoutes);
app.use('/api/btp-settings', btpSettingsRoutes);
app.use('/api/ads',         adsRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  console.error('[error]', err.message);
  res.status(status).json({ success: false, error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);
server.listen(PORT, () => {
  console.log(`[server] bWinALOTT backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  // Run connection checks after the server is up (non-blocking)
  runAndStore().catch(err => console.error('[startup] check failed:', err.message));
});

initSocket(server);

module.exports = { app, server };
