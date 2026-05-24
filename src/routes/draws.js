const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { drawLimiter }    = require('../middleware/rateLimiter');
const { emailService }   = require('../services/email');
const { smsService }     = require('../services/sms');

function genServerSeed() {
  const seed = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return { serverSeed: seed, serverSeedHash: hash };
}

function platinumShuffle(pool, serverSeed, clientSeed) {
  const hmac = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
  return [...pool].sort((a, b) => {
    const ai = pool.indexOf(a);
    const bi = pool.indexOf(b);
    const aScore = parseInt(hmac.slice((ai * 2) % 56, (ai * 2) % 56 + 8), 16);
    const bScore = parseInt(hmac.slice((bi * 2) % 56, (bi * 2) % 56 + 8), 16);
    return aScore - bScore;
  });
}

function verifyServerSeed(serverSeed, serverSeedHash) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex') === serverSeedHash;
}

// POST /api/draws/prepare/:marketId  (admin)
router.post('/prepare/:marketId', adminMiddleware, async (req, res) => {
  const { marketId } = req.params;
  if (!IS_DB_CONFIGURED) {
    return res.status(201).json({
      success: true,
      data: { draw_id: `mock-draw-${Date.now()}`, server_seed_hash: 'mock_hash_abc123' },
      message: 'Draw prepared (mock)',
    });
  }

  try {
    const market = await queryOne('SELECT * FROM markets WHERE id = ?', [marketId]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found' });
    if (market.status === 'settled') return res.status(400).json({ success: false, error: 'Market already settled' });

    const { serverSeed, serverSeedHash } = genServerSeed();

    await execute(
      'INSERT INTO draws (id, market_id, server_seed, server_seed_hash, status, created_at) VALUES (UUID(), ?, ?, ?, "pending", NOW())',
      [marketId, serverSeed, serverSeedHash]
    );

    // Close the market so no new tickets can be purchased
    await execute('UPDATE markets SET status = "closed" WHERE id = ?', [marketId]);

    const draw = await queryOne('SELECT id, server_seed_hash FROM draws WHERE market_id = ? ORDER BY created_at DESC LIMIT 1', [marketId]);

    auditLog(req.user.id, 'PREPARE_DRAW', draw.id);

    return res.status(201).json({
      success: true,
      data: { draw_id: draw.id, server_seed_hash: serverSeedHash },
      message: 'Draw prepared — share the server_seed_hash with participants before the draw',
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/draws/run/:marketId  (admin)
router.post('/run/:marketId', adminMiddleware, drawLimiter, async (req, res) => {
  const { marketId } = req.params;
  const { client_seed } = req.body;
  if (!client_seed) return res.status(400).json({ success: false, error: 'client_seed required' });

  if (!IS_DB_CONFIGURED) {
    return res.json({
      success: true,
      data: { winners: [{ username: 'mock_winner', ticket_number: 'WAL-20260514-00001', prize: 9000 }], prize_pool: 10000, platform_fee: 1000, prize_each: 9000 },
      message: 'Draw run (mock)',
    });
  }

  try {
    const draw = await queryOne(
      'SELECT d.*, m.tier, m.winner_count, m.correct_outcome, m.prize_pool AS market_prize_pool FROM draws d JOIN markets m ON m.id = d.market_id WHERE d.market_id = ? AND d.status = "pending" ORDER BY d.created_at DESC LIMIT 1',
      [marketId]
    );
    if (!draw) return res.status(404).json({ success: false, error: 'No pending draw found for this market' });

    if (!draw.correct_outcome) {
      return res.status(400).json({ success: false, error: 'Market has no correct_outcome set. Update the market before running the draw.' });
    }

    // Fetch all tickets for the market
    const tickets = await query(
      'SELECT t.*, u.id AS u_id, u.username, u.full_name, u.email, u.phone, u.wallet_balance FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.market_id = ? AND t.status = "pending"',
      [marketId]
    );

    if (!tickets.length) return res.status(400).json({ success: false, error: 'No eligible tickets for this draw' });

    const correctPool = tickets.filter(t => t.user_prediction === draw.correct_outcome);

    // No correct predictors — settle with no winners
    if (correctPool.length === 0) {
      await execute('UPDATE draws SET client_seed = ?, status = "complete", winner_count = 0, completed_at = NOW() WHERE id = ?', [client_seed, draw.id]);
      await execute('UPDATE markets SET status = "settled" WHERE id = ?', [marketId]);
      await execute('UPDATE tickets SET status = "incorrect" WHERE market_id = ? AND status = "pending"', [marketId]);
      auditLog(req.user.id, 'RUN_DRAW_NO_WINNERS', draw.id);
      return res.json({ success: true, data: { winners: [], draw_id: draw.id }, message: 'Draw complete — no correct predictions' });
    }

    const tier       = draw.tier || 'silver';
    const maxWinners = draw.winner_count || 1;

    // Tier-based winner selection
    let selectedTickets;
    if (correctPool.length <= maxWinners) {
      selectedTickets = correctPool;
    } else if (tier === 'platinum') {
      const shuffled = platinumShuffle(correctPool, draw.server_seed, client_seed);
      selectedTickets = shuffled.slice(0, maxWinners);
    } else {
      // Silver/Gold: Fisher-Yates shuffle
      const shuffled = [...correctPool].sort(() => Math.random() - 0.5);
      selectedTickets = shuffled.slice(0, maxWinners);
    }

    // Prize math (all integers in cents)
    const prizePool   = tickets.reduce((sum, t) => sum + (t.amount_paid || 0), 0);
    const platformFee = Math.floor(prizePool * 0.10);
    const netPool     = prizePool - platformFee;
    const prizeEach   = Math.floor(netPool / selectedTickets.length);

    const winners = [];
    const winningIds = selectedTickets.map(t => t.id);

    // Use a transaction for atomicity
    await transaction(async (conn) => {
      for (const ticket of selectedTickets) {
        // Credit wallet
        await conn.execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [prizeEach, ticket.u_id]);
        // Mark ticket as won
        await conn.execute('UPDATE tickets SET status = "won", prize_amount = ? WHERE id = ?', [prizeEach, ticket.id]);
        // Log payout transaction
        await conn.execute(
          'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "prize_payout", ?, ?, "successful", ?)',
          [ticket.u_id, prizeEach, ticket.ticket_number, JSON.stringify({ draw_id: draw.id, market_id: marketId })]
        );
        // In-app notification
        await conn.execute(
          'INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at) VALUES (UUID(), ?, "You Won!", ?, "prize", 0, NOW())',
          [ticket.u_id, `Congratulations! You won ${(prizeEach / 100).toFixed(2)} BTP in the draw.`]
        );
        winners.push({ user_id: ticket.u_id, username: ticket.username, ticket_number: ticket.ticket_number, prize: prizeEach });
      }

      // Mark all non-winning tickets
      const placeholders = winningIds.map(() => '?').join(',');
      if (winningIds.length > 0) {
        await conn.execute(
          `UPDATE tickets SET status = "incorrect" WHERE market_id = ? AND status = "pending" AND id NOT IN (${placeholders})`,
          [marketId, ...winningIds]
        );
      } else {
        await conn.execute('UPDATE tickets SET status = "incorrect" WHERE market_id = ? AND status = "pending"', [marketId]);
      }

      // Mark correct-but-not-selected as "correct" (for Platinum — they get refunds separately)
      const correctNotWon = correctPool.filter(t => !winningIds.includes(t.id));
      for (const t of correctNotWon) {
        await conn.execute('UPDATE tickets SET status = "correct" WHERE id = ?', [t.id]);
        if (tier === 'platinum') {
          // Refund stake for Platinum correct non-winners
          await conn.execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [t.amount_paid, t.u_id]);
          await conn.execute(
            'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "refund", ?, ?, "successful", ?)',
            [t.u_id, t.amount_paid, `REFUND-${t.ticket_number}`, JSON.stringify({ reason: 'platinum_correct_not_selected' })]
          );
        }
      }

      // Finalise draw
      await conn.execute(
        'UPDATE draws SET client_seed = ?, status = "complete", winner_count = ?, prize_pool = ?, platform_fee = ?, prize_each = ?, completed_at = NOW() WHERE id = ?',
        [client_seed, selectedTickets.length, prizePool, platformFee, prizeEach, draw.id]
      );

      // Settle market
      await conn.execute('UPDATE markets SET status = "settled" WHERE id = ?', [marketId]);
    });

    // Send winner notifications (non-blocking)
    for (const ticket of selectedTickets) {
      emailService.sendWinnerEmail({ email: ticket.email, username: ticket.username }, 'the match', prizeEach).catch(() => {});
      if (ticket.phone) smsService.sendWinnerSMS(ticket.phone, 'the match', prizeEach).catch(() => {});
    }

    auditLog(req.user.id, 'RUN_DRAW', draw.id, { tier, winner_count: selectedTickets.length, prize_each: prizeEach });

    const finalDraw = await queryOne('SELECT * FROM draws WHERE id = ?', [draw.id]);

    return res.json({
      success: true,
      data: {
        draw: finalDraw,
        winners,
        prize_pool:   prizePool,
        platform_fee: platformFee,
        prize_each:   prizeEach,
        server_seed:  draw.server_seed, // revealed now that draw is complete
        client_seed,
        verification_info: `Verify fairness at GET /api/draws/verify/${draw.id}`,
      },
      message: `Draw complete — ${selectedTickets.length} winner(s)`,
    });
  } catch (err) {
    console.error('[draws/run]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/draws/verify/:drawId  (public — provably fair verification)
router.get('/verify/:drawId', async (req, res) => {
  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, data: { valid: true }, message: 'Verification (mock)' });
  }

  try {
    const draw = await queryOne(
      'SELECT d.id, d.server_seed, d.server_seed_hash, d.client_seed, d.status, d.winner_count, d.prize_each, m.tier, m.correct_outcome FROM draws d JOIN markets m ON m.id = d.market_id WHERE d.id = ?',
      [req.params.drawId]
    );
    if (!draw) return res.status(404).json({ success: false, error: 'Draw not found' });
    if (draw.status !== 'complete') return res.status(400).json({ success: false, error: 'Draw not yet complete' });

    const isValid = verifyServerSeed(draw.server_seed, draw.server_seed_hash);
    return res.json({
      success: true,
      data: {
        valid:             isValid,
        draw_id:           draw.id,
        server_seed:       draw.server_seed,
        server_seed_hash:  draw.server_seed_hash,
        client_seed:       draw.client_seed,
        tier:              draw.tier,
        winner_count:      draw.winner_count,
        prize_each:        draw.prize_each,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
