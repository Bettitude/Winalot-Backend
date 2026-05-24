require('dotenv').config();

const http    = require('http');
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const helmet  = require('helmet');

const { generalLimiter, authLimiter } = require('./middleware/rateLimiter');
const { initSocket } = require('./socket');

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

const app    = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production';

const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:5173',
  process.env.ADMIN_URL  || 'http://localhost:5174',
  // Space-separated list of extra production origins, e.g. Vercel preview URLs
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

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api', generalLimiter);
app.use('/api/auth', authLimiter);

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

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
});

initSocket(server);

module.exports = { app, server };
