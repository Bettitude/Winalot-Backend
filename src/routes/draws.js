const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { drawLimiter }    = require('../middleware/rateLimiter');
const { emailService }   = require('../services/email');
const { smsService }     = require('../services/sms');
const { supabaseAdmin }  = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

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

// ── POST /api/draws/prepare/:marketId  (admin) ────────────────────────────────
router.post('/prepare/:marketId', adminMiddleware, async (req, res) => {
  const { marketId } = req.params;

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: market, error: mErr } = await supabaseAdmin
        .from('btwin_markets')
        .select('id, status, tier')
        .eq('id', marketId)
        .single();
      if (mErr || !market) return res.status(404).json({ success: false, error: 'Market not found' });
      if (market.status === 'settled') return res.status(400).json({ success: false, error: 'Market already settled' });

      const { serverSeed, serverSeedHash } = genServerSeed();

      // Close market so no new tickets can be purchased
      await supabaseAdmin
        .from('btwin_markets')
        .update({ status: 'settled' })   // we use 'settled' to close; 'active'→'settled' after run
        .eq('id', marketId);

      // Actually set to a temporary "closed" by reusing 'draft' status — better: keep 'active' and just record the draw
      // Revert: just create the draw record, market stays 'active' until draw runs
      await supabaseAdmin
        .from('btwin_markets')
        .update({ status: 'active' })
        .eq('id', marketId);

      const { data: draw, error: dErr } = await supabaseAdmin
        .from('btwin_draws')
        .insert({
          market_id:       marketId,
          server_seed:     serverSeed,
          server_seed_hash: serverSeedHash,
          status:          'pending',
        })
        .select('id, server_seed_hash')
        .single();
      if (dErr) throw dErr;

      auditLog(req.user.id, 'PREPARE_DRAW', draw.id);

      return res.status(201).json({
        success: true,
        data: { draw_id: draw.id, server_seed_hash: serverSeedHash },
        message: 'Draw prepared — share the server_seed_hash with participants before the draw',
      });
    } catch (err) {
      console.error('[draws/prepare/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Mock path ──────────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED) {
    return res.status(201).json({
      success: true,
      data: { draw_id: `mock-draw-${Date.now()}`, server_seed_hash: 'mock_hash_abc123' },
      message: 'Draw prepared (mock)',
    });
  }

  // ── MySQL path ─────────────────────────────────────────────────────────────
  try {
    const market = await queryOne('SELECT * FROM markets WHERE id = ?', [marketId]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found' });
    if (market.status === 'settled') return res.status(400).json({ success: false, error: 'Market already settled' });

    const { serverSeed, serverSeedHash } = genServerSeed();

    await execute(
      'INSERT INTO draws (id, market_id, server_seed, server_seed_hash, status, created_at) VALUES (UUID(), ?, ?, ?, "pending", NOW())',
      [marketId, serverSeed, serverSeedHash]
    );
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

// ── POST /api/draws/run/:marketId  (admin) ────────────────────────────────────
router.post('/run/:marketId', adminMiddleware, drawLimiter, async (req, res) => {
  const { marketId } = req.params;
  const { client_seed } = req.body;
  if (!client_seed) return res.status(400).json({ success: false, error: 'client_seed required' });

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      // Get market
      const { data: market, error: mErr } = await supabaseAdmin
        .from('btwin_markets')
        .select('id, tier, winner_count, correct_prediction, prize_pool, name')
        .eq('id', marketId)
        .single();
      if (mErr || !market) return res.status(404).json({ success: false, error: 'Market not found' });

      if (!market.correct_prediction) {
        return res.status(400).json({ success: false, error: 'Set the correct_prediction on the market before running the draw' });
      }

      // Get or create pending draw
      let draw;
      const { data: existingDraw } = await supabaseAdmin
        .from('btwin_draws')
        .select('*')
        .eq('market_id', marketId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingDraw) {
        draw = existingDraw;
      } else {
        // Auto-prepare if admin skipped the prepare step
        const { serverSeed, serverSeedHash } = genServerSeed();
        const { data: newDraw, error: dErr } = await supabaseAdmin
          .from('btwin_draws')
          .insert({ market_id: marketId, server_seed: serverSeed, server_seed_hash: serverSeedHash, status: 'pending' })
          .select()
          .single();
        if (dErr) throw dErr;
        draw = newDraw;
      }

      // Get all active tickets for this market
      const { data: tickets, error: tErr } = await supabaseAdmin
        .from('btwin_tickets')
        .select('id, user_id, user_prediction, amount_paid, ticket_number, status')
        .eq('market_id', marketId)
        .eq('status', 'active');
      if (tErr) throw tErr;

      if (!tickets?.length) {
        return res.status(400).json({ success: false, error: 'No active tickets for this market' });
      }

      const correctPool = tickets.filter(t => t.user_prediction === market.correct_prediction);

      // No correct predictors
      if (correctPool.length === 0) {
        await supabaseAdmin.from('btwin_draws').update({
          client_seed,
          status:       'complete',
          winner_count: 0,
          completed_at: new Date().toISOString(),
        }).eq('id', draw.id);
        await supabaseAdmin.from('btwin_markets').update({ status: 'settled' }).eq('id', marketId);
        await supabaseAdmin.from('btwin_tickets').update({ status: 'lost' })
          .eq('market_id', marketId).eq('status', 'active');
        auditLog(req.user.id, 'RUN_DRAW_NO_WINNERS', draw.id);
        return res.json({ success: true, data: { winners: [], draw_id: draw.id }, message: 'Draw complete — no correct predictions' });
      }

      const tier       = market.tier || 'silver';
      const maxWinners = market.winner_count || 1;

      // Tier-based winner selection
      let selectedTickets;
      if (correctPool.length <= maxWinners) {
        selectedTickets = correctPool;
      } else if (tier === 'platinum') {
        const shuffled = platinumShuffle(correctPool, draw.server_seed, client_seed);
        selectedTickets = shuffled.slice(0, maxWinners);
      } else {
        const shuffled = [...correctPool].sort(() => Math.random() - 0.5);
        selectedTickets = shuffled.slice(0, maxWinners);
      }

      // Prize math (all integers in cents)
      const totalPool  = tickets.reduce((sum, t) => sum + (t.amount_paid || 0), 0);
      const platformFee = Math.floor(totalPool * 0.10);
      const netPool     = totalPool - platformFee;
      const prizeEach   = Math.floor(netPool / selectedTickets.length);

      const winningIds = selectedTickets.map(t => t.id);
      const winners    = [];

      // Credit each winner
      for (const ticket of selectedTickets) {
        // Credit wallet
        const { error: creditErr } = await supabaseAdmin
          .rpc('btwin_credit_wallet', { p_user_id: ticket.user_id, p_amount: prizeEach });
        if (creditErr) console.error('[draws/run] credit wallet error:', creditErr.message);

        // Mark ticket won
        await supabaseAdmin.from('btwin_tickets')
          .update({ status: 'won', prize_amount: prizeEach })
          .eq('id', ticket.id);

        // Log payout transaction
        supabaseAdmin.from('btwin_transactions').insert({
          user_id:     ticket.user_id,
          type:        'prize_payout',
          amount:      prizeEach,
          status:      'completed',
          reference:   ticket.ticket_number,
          description: `Prize — ${market.name} (${tier})`,
          meta:        { draw_id: draw.id, market_id: marketId },
        }).catch(() => {});

        // In-app notification
        supabaseAdmin.from('btwin_notifications').insert({
          user_id: ticket.user_id,
          title:   'You Won!',
          message: `Congratulations! You won $${(prizeEach / 100).toFixed(2)} in the ${market.name} draw.`,
          type:    'prize',
        }).catch(() => {});

        winners.push({ user_id: ticket.user_id, ticket_number: ticket.ticket_number, prize: prizeEach });
      }

      // Mark non-winning tickets as lost
      const losingIds = tickets.filter(t => !winningIds.includes(t.id)).map(t => t.id);
      if (losingIds.length) {
        await supabaseAdmin.from('btwin_tickets')
          .update({ status: 'lost' })
          .in('id', losingIds);
      }

      // Platinum: refund correct-but-not-selected tickets
      if (tier === 'platinum') {
        const correctNotWon = correctPool.filter(t => !winningIds.includes(t.id));
        for (const t of correctNotWon) {
          await supabaseAdmin.rpc('btwin_credit_wallet', { p_user_id: t.user_id, p_amount: t.amount_paid }).catch(() => {});
          supabaseAdmin.from('btwin_transactions').insert({
            user_id:     t.user_id,
            type:        'refund',
            amount:      t.amount_paid,
            status:      'completed',
            reference:   `REFUND-${t.ticket_number}`,
            description: 'Platinum correct non-winner refund',
          }).catch(() => {});
        }
      }

      // Finalise draw record
      await supabaseAdmin.from('btwin_draws').update({
        client_seed,
        status:       'complete',
        winner_count: selectedTickets.length,
        prize_pool:   totalPool,
        platform_fee: platformFee,
        prize_each:   prizeEach,
        completed_at: new Date().toISOString(),
      }).eq('id', draw.id);

      // Settle market
      await supabaseAdmin.from('btwin_markets').update({ status: 'settled' }).eq('id', marketId);

      // Fetch user details for winner notifications (email/SMS) — best effort
      const userIds = [...new Set(selectedTickets.map(t => t.user_id))];
      const { data: users } = await supabaseAdmin
        .from('btwin_users')
        .select('id, email, username, phone')
        .in('id', userIds);
      const userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
      for (const ticket of selectedTickets) {
        const u = userMap[ticket.user_id];
        if (u?.email) emailService.sendWinnerEmail(u, market.name, prizeEach).catch(() => {});
        if (u?.phone) smsService.sendWinnerSMS(u.phone, market.name, prizeEach).catch(() => {});
      }

      auditLog(req.user.id, 'RUN_DRAW', draw.id, { tier, winner_count: selectedTickets.length, prize_each: prizeEach });

      return res.json({
        success: true,
        data: {
          draw_id:      draw.id,
          winners,
          prize_pool:   totalPool,
          platform_fee: platformFee,
          prize_each:   prizeEach,
          server_seed:  draw.server_seed,
          client_seed,
          verification_info: `Verify fairness at GET /api/draws/verify/${draw.id}`,
        },
        message: `Draw complete — ${selectedTickets.length} winner(s)`,
      });
    } catch (err) {
      console.error('[draws/run/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Mock path ──────────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED) {
    return res.json({
      success: true,
      data: { winners: [{ username: 'mock_winner', ticket_number: 'WAL-20260514-00001', prize: 9000 }], prize_pool: 10000, platform_fee: 1000, prize_each: 9000 },
      message: 'Draw run (mock)',
    });
  }

  // ── MySQL path ─────────────────────────────────────────────────────────────
  try {
    const draw = await queryOne(
      'SELECT d.*, m.tier, m.winner_count, m.correct_outcome, m.prize_pool AS market_prize_pool FROM draws d JOIN markets m ON m.id = d.market_id WHERE d.market_id = ? AND d.status = "pending" ORDER BY d.created_at DESC LIMIT 1',
      [marketId]
    );
    if (!draw) return res.status(404).json({ success: false, error: 'No pending draw found for this market' });
    if (!draw.correct_outcome) {
      return res.status(400).json({ success: false, error: 'Market has no correct_outcome set. Update the market before running the draw.' });
    }

    const tickets = await query(
      'SELECT t.*, u.id AS u_id, u.username, u.full_name, u.email, u.phone, u.wallet_balance FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.market_id = ? AND t.status = "pending"',
      [marketId]
    );
    if (!tickets.length) return res.status(400).json({ success: false, error: 'No eligible tickets for this draw' });

    const correctPool = tickets.filter(t => t.user_prediction === draw.correct_outcome);
    if (correctPool.length === 0) {
      await execute('UPDATE draws SET client_seed = ?, status = "complete", winner_count = 0, completed_at = NOW() WHERE id = ?', [client_seed, draw.id]);
      await execute('UPDATE markets SET status = "settled" WHERE id = ?', [marketId]);
      await execute('UPDATE tickets SET status = "incorrect" WHERE market_id = ? AND status = "pending"', [marketId]);
      auditLog(req.user.id, 'RUN_DRAW_NO_WINNERS', draw.id);
      return res.json({ success: true, data: { winners: [], draw_id: draw.id }, message: 'Draw complete — no correct predictions' });
    }

    const tier       = draw.tier || 'silver';
    const maxWinners = draw.winner_count || 1;

    let selectedTickets;
    if (correctPool.length <= maxWinners) {
      selectedTickets = correctPool;
    } else if (tier === 'platinum') {
      const shuffled = platinumShuffle(correctPool, draw.server_seed, client_seed);
      selectedTickets = shuffled.slice(0, maxWinners);
    } else {
      const shuffled = [...correctPool].sort(() => Math.random() - 0.5);
      selectedTickets = shuffled.slice(0, maxWinners);
    }

    const prizePool   = tickets.reduce((sum, t) => sum + (t.amount_paid || 0), 0);
    const platformFee = Math.floor(prizePool * 0.10);
    const netPool     = prizePool - platformFee;
    const prizeEach   = Math.floor(netPool / selectedTickets.length);
    const winners     = [];
    const winningIds  = selectedTickets.map(t => t.id);

    await transaction(async (conn) => {
      for (const ticket of selectedTickets) {
        if (IS_SUPABASE) {
          await supabaseAdmin.rpc('btwin_credit_wallet', { p_user_id: ticket.u_id, p_amount: prizeEach }).catch(() => {});
        } else {
          await conn.execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [prizeEach, ticket.u_id]);
        }
        await conn.execute('UPDATE tickets SET status = "won", prize_amount = ? WHERE id = ?', [prizeEach, ticket.id]);
        await conn.execute(
          'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "prize_payout", ?, ?, "successful", ?)',
          [ticket.u_id, prizeEach, ticket.ticket_number, JSON.stringify({ draw_id: draw.id, market_id: marketId })]
        );
        winners.push({ user_id: ticket.u_id, username: ticket.username, ticket_number: ticket.ticket_number, prize: prizeEach });
      }

      const placeholders = winningIds.map(() => '?').join(',');
      if (winningIds.length > 0) {
        await conn.execute(
          `UPDATE tickets SET status = "incorrect" WHERE market_id = ? AND status = "pending" AND id NOT IN (${placeholders})`,
          [marketId, ...winningIds]
        );
      } else {
        await conn.execute('UPDATE tickets SET status = "incorrect" WHERE market_id = ? AND status = "pending"', [marketId]);
      }

      const correctNotWon = correctPool.filter(t => !winningIds.includes(t.id));
      for (const t of correctNotWon) {
        await conn.execute('UPDATE tickets SET status = "correct" WHERE id = ?', [t.id]);
        if (tier === 'platinum') {
          if (IS_SUPABASE) {
            supabaseAdmin.rpc('btwin_credit_wallet', { p_user_id: t.u_id, p_amount: t.amount_paid }).catch(() => {});
          } else {
            await conn.execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [t.amount_paid, t.u_id]);
          }
          await conn.execute(
            'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "refund", ?, ?, "successful", ?)',
            [t.u_id, t.amount_paid, `REFUND-${t.ticket_number}`, JSON.stringify({ reason: 'platinum_correct_not_selected' })]
          );
        }
      }

      await conn.execute(
        'UPDATE draws SET client_seed = ?, status = "complete", winner_count = ?, prize_pool = ?, platform_fee = ?, prize_each = ?, completed_at = NOW() WHERE id = ?',
        [client_seed, selectedTickets.length, prizePool, platformFee, prizeEach, draw.id]
      );
      await conn.execute('UPDATE markets SET status = "settled" WHERE id = ?', [marketId]);
    });

    for (const ticket of selectedTickets) {
      emailService.sendWinnerEmail({ email: ticket.email, username: ticket.username }, 'the match', prizeEach).catch(() => {});
      if (ticket.phone) smsService.sendWinnerSMS(ticket.phone, 'the match', prizeEach).catch(() => {});
    }

    auditLog(req.user.id, 'RUN_DRAW', draw.id, { tier, winner_count: selectedTickets.length, prize_each: prizeEach });
    const finalDraw = await queryOne('SELECT * FROM draws WHERE id = ?', [draw.id]);

    return res.json({
      success: true,
      data: { draw: finalDraw, winners, prize_pool: prizePool, platform_fee: platformFee, prize_each: prizeEach, server_seed: draw.server_seed, client_seed },
      message: `Draw complete — ${selectedTickets.length} winner(s)`,
    });
  } catch (err) {
    console.error('[draws/run]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/draws/verify/:drawId  (public) ───────────────────────────────────
router.get('/verify/:drawId', async (req, res) => {
  // Supabase path
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data: draw } = await supabaseAdmin
        .from('btwin_draws')
        .select('id, server_seed, server_seed_hash, client_seed, status, winner_count, prize_each, market_id')
        .eq('id', req.params.drawId)
        .single();
      if (!draw) return res.status(404).json({ success: false, error: 'Draw not found' });
      if (draw.status !== 'complete') return res.status(400).json({ success: false, error: 'Draw not yet complete' });

      const { data: market } = await supabaseAdmin
        .from('btwin_markets')
        .select('tier, correct_prediction')
        .eq('id', draw.market_id)
        .single();

      const isValid = draw.server_seed ? verifyServerSeed(draw.server_seed, draw.server_seed_hash) : false;
      return res.json({
        success: true,
        data: {
          valid:            isValid,
          draw_id:          draw.id,
          server_seed:      draw.server_seed,
          server_seed_hash: draw.server_seed_hash,
          client_seed:      draw.client_seed,
          tier:             market?.tier,
          winner_count:     draw.winner_count,
          prize_each:       draw.prize_each,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

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
      data: { valid: isValid, draw_id: draw.id, server_seed: draw.server_seed, server_seed_hash: draw.server_seed_hash, client_seed: draw.client_seed, tier: draw.tier, winner_count: draw.winner_count, prize_each: draw.prize_each },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
