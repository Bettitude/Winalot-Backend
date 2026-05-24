const { Server } = require('socket.io');
const { getLiveFixtures } = require('../services/fixturesService');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin:      process.env.CLIENT_URL || '*',
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Join a match room to receive live score updates
    socket.on('join:match', (matchId) => {
      socket.join(`match:${matchId}`);
      console.log(`[Socket] ${socket.id} joined match:${matchId}`);
    });

    socket.on('leave:match', (matchId) => {
      socket.leave(`match:${matchId}`);
    });

    // Join a draw room to receive draw progress events
    socket.on('join:draw', (drawId) => {
      socket.join(`draw:${drawId}`);
    });

    socket.on('leave:draw', (drawId) => {
      socket.leave(`draw:${drawId}`);
    });

    // Join a user-specific room for personal notifications
    socket.on('join:user', (userId) => {
      socket.join(`user:${userId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
    });
  });

  // Broadcast live scores every 30 seconds (only when API key is configured)
  const apiKey = process.env.APISPORTS_KEY || process.env.APIFOOTBALL_KEY;
  if (apiKey && !apiKey.startsWith('your-')) {
    let failCount = 0;
    const liveInterval = setInterval(async () => {
      try {
        const liveFixtures = await getLiveFixtures();
        failCount = 0;
        if (liveFixtures.length > 0) {
          io.emit('live:scores', liveFixtures);
        }
      } catch (err) {
        failCount++;
        if (failCount === 1) {
          console.error('[Socket] Live score broadcast failed:', err.message);
        }
        if (failCount >= 5) {
          console.warn('[Socket] Live scores paused after 5 consecutive failures. Check APISPORTS_KEY.');
          clearInterval(liveInterval);
        }
      }
    }, 30000);
  } else {
    console.warn('[Socket] Live score broadcast skipped — APISPORTS_KEY not configured.');
  }

  console.log('[Socket] Socket.io initialized');
  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized — call initSocket(httpServer) first');
  return io;
}

// ── Emitters ─────────────────────────────────────────────────────────────────

/** Broadcast live score update to a match room */
function emitScoreUpdate(matchId, scoreData) {
  getIO().to(`match:${matchId}`).emit('match:score_update', { matchId, ...scoreData });
}

/** Broadcast ticket count update for a match room */
function emitTicketCount(matchId, marketId, count) {
  getIO().to(`match:${matchId}`).emit('match:ticket_count', { matchId, marketId, count });
}

/** Broadcast draw running status (progress percentage 0–100) */
function emitDrawRunning(drawId, progress) {
  getIO().to(`draw:${drawId}`).emit('draw:running', { drawId, progress });
}

/** Broadcast draw complete with winner info */
function emitDrawComplete(drawId, result) {
  getIO().to(`draw:${drawId}`).emit('draw:complete', { drawId, ...result });
}

/** Send a personal notification to a specific user */
function emitUserNotification(userId, notification) {
  getIO().to(`user:${userId}`).emit('notification:new', notification);
}

/** Broadcast a system-wide announcement to all connected clients */
function emitAnnouncement(message) {
  getIO().emit('announcement', { message, timestamp: new Date().toISOString() });
}

module.exports = {
  initSocket,
  getIO,
  emitScoreUpdate,
  emitTicketCount,
  emitDrawRunning,
  emitDrawComplete,
  emitUserNotification,
  emitAnnouncement,
};
