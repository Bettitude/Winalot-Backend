require('dotenv').config();

const express = require('express');
const http    = require('http');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');

const { initSocket }     = require('./src/socket');
const { generalLimiter, authLimiter } = require('./src/middleware/rateLimiter');

const authRoutes         = require('./src/routes/auth');
const matchRoutes        = require('./src/routes/matches');
const marketRoutes       = require('./src/routes/markets');
const ticketRoutes       = require('./src/routes/tickets');
const drawRoutes         = require('./src/routes/draws');
const transactionRoutes  = require('./src/routes/transactions');
const userRoutes         = require('./src/routes/users');
const notificationRoutes = require('./src/routes/notifications');
const liveRoutes         = require('./src/routes/live');
const footballRoutes     = require('./src/routes/football');
const adminStatsRoutes   = require('./src/routes/adminStats');
const analyticsRoutes    = require('./src/routes/analytics');

const app    = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://win-a-lott.vercel.app',
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  ...(process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(',').map(o => o.trim()) : []),
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (!isProd)  return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Security & parsing ────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan(isProd ? 'combined' : 'dev'));

// Raw body for webhook — must come BEFORE express.json()
app.use('/api/transactions/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', generalLimiter);
app.use('/api/auth', authLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok',
  ts:     new Date().toISOString(),
  env:    process.env.NODE_ENV || 'development',
}));

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
app.use('/api/admin/stats',   adminStatsRoutes);
app.use('/api/analytics',    analyticsRoutes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'Route not found' }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({
    success: false,
    error: isProd ? 'Internal server error' : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);
server.listen(PORT, () => {
  console.log(`[server] bWinALOTT API running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  console.log(`[server] Health: http://localhost:${PORT}/health`);
});

initSocket(server);

module.exports = { app, server };
