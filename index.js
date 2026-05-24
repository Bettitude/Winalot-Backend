require('dotenv').config();

const express    = require('express');
const http       = require('http');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');

const { initSocket }       = require('./socket');
const { generalLimiter }   = require('./middleware/rateLimiter');

// ── Routes ────────────────────────────────────────────────────────────────────
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

// ── App setup ─────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

initSocket(server);

// ── Security & parsing ────────────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.ADMIN_URL,
  'http://localhost:5173',
  'http://localhost:5174',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

// Raw body for Stripe webhook — must come BEFORE express.json()
app.use('/api/transactions/webhook/stripe', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', generalLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
  });
});

// ── API Routes ────────────────────────────────────────────────────────────────
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

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    error:   process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀  WinALot API running on port ${PORT}`);
  console.log(`    Health: http://localhost:${PORT}/health`);
  console.log(`    Env:    ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = { app, server };
