const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { IS_MOCK }                   = require('../lib/mockMode');
const { emailService }              = require('../services/email');
const { smsService }                = require('../services/sms');
const { supabaseAdmin }             = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

// Generate WAL-YYYYMMDD-NNNNN ticket number
async function genTicketNumber() {
  if (!IS_DB_CONFIGURED) return `WAL-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Math.floor(Math.random()*99999)+1).padStart(5,'0')}`;
  const row = await queryOne('SELECT COUNT(*) AS n FROM tickets');
  const seq = (row?.n || 0) + 1;
  return `WAL-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(seq).padStart(5,'0')}`;
}

// GET /api/tickets/winners — PUBLIC, must be declared before /:id
router.get('/winners', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const tier  = req.query.tier || null;

  if (IS_MOCK || !IS_DB_CONFIGURED) {
    const tiers   = ['silver', 'gold', 'platinum', 'free'];
    const names   = ['mike23', 'james99', 'sarah', 'emma05', 'chris',
                     'tom', 'olivia', 'jack11', 'amy', 'liam',
                     'sophie', 'harry', 'ben', 'zoe', 'ryan07'];
    const matches = [
      'Mexico vs Poland', 'USA vs Jamaica', 'Brazil vs Venezuela',
      'Argentina vs Peru', 'England vs Serbia', 'France vs Morocco',
      'Spain vs Croatia', 'Germany vs Scotland', 'Portugal vs Czechia',
      'Netherlands vs Senegal', 'Canada vs Colombia', 'Belgium vs Egypt',
    ];
    const markets = ['Who will win this match?', 'Both teams to score?', 'Match winner?'];
    const tierPrize = { silver: [5,8,10,12,15], gold: [20,25,30,40,50], platinum: [100,150,200], free: [5,10,15,20] };
    const mock = Array.from({ length: limit }, (_, i) => {
      const t = tiers[i % tiers.length];
      const pool = tierPrize[t];
      return {
        id:           `winner-mock-${i}`,
        ticketNumber: `WAL-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(i+1).padStart(5,'0')}`,
        username:     names[i % names.length],
        match:        matches[i % matches.length],
        market:       markets[i % markets.length],
        prize:        pool[Math.floor(Math.random() * pool.length)],
        tier:         t,
        createdAt:    new Date(Date.now() - i * 7200000).toISOString(),
      };
    }).filter(w => !tier || w.tier === tier);
    return res.json({ success: true, data: { winners: mock } });
  }

  try {
    let where = "WHERE t.status = 'won'";
    const params = [limit];
    if (tier) { where += ' AND mk.tier = ?'; params.unshift(tier); }

    const winners = await query(
      `SELECT t.ticket_number AS ticketNumber, t.prize_amount AS prize,
              t.updated_at AS createdAt,
              u.username,
              mk.name AS market, mk.tier,
              CONCAT(ma.team_home, ' vs ', ma.team_away) AS match_title
       FROM tickets t
       JOIN users   u  ON u.id  = t.user_id
       JOIN markets mk ON mk.id = t.market_id
       JOIN matches ma ON ma.id = t.match_id
       ${where}
       ORDER BY t.updated_at DESC LIMIT ?`,
      params
    );
    return res.json({ success: true, data: { winners } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tickets/by-number/:number — PUBLIC shareable ticket lookup
router.get('/by-number/:number', async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.status(404).json({ success: false, error: 'Not available in mock mode' });
  try {
    const ticket = await queryOne(
      `SELECT t.*, mk.name AS market_name, mk.tier,
              ma.team_home, ma.team_away, ma.league, ma.match_date
       FROM tickets t
       JOIN markets mk ON mk.id = t.market_id
       JOIN matches ma ON ma.id = t.match_id
       WHERE t.ticket_number = ?`,
      [req.params.number]
    );
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
    return res.json({ success: true, data: { ticket } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tickets  (admin: all; user: own)
router.get('/', authMiddleware, async (req, res) => {
  if (IS_MOCK) return res.json({ success: true, data: { tickets: [], total: 0 } });

  const { page = 1, limit = 20, status, market_id } = req.query;
  const isAdmin = req.user.role === 'admin';
  const offset  = (parseInt(page) - 1) * parseInt(limit);

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      let q = supabaseAdmin
        .from('btwin_tickets')
        .select('id, ticket_number, user_id, market_id, user_prediction, amount_paid, status, prize_amount, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (!isAdmin) q = q.eq('user_id', req.user.id);
      if (status)   q = q.eq('status', status);
      if (market_id) q = q.eq('market_id', market_id);

      const { data: rawTickets, count, error } = await q;
      if (error) throw error;

      const tickets = rawTickets || [];
      if (!tickets.length) return res.json({ success: true, data: { tickets: [], total: 0 } });

      // Enrich with market + match info + username
      const marketIds = [...new Set(tickets.map(t => t.market_id).filter(Boolean))];
      const userIds   = [...new Set(tickets.map(t => t.user_id).filter(Boolean))];

      const [mkRes, uRes] = await Promise.all([
        supabaseAdmin.from('btwin_markets').select('id, name, type, tier, ticket_price, match_id').in('id', marketIds),
        supabaseAdmin.from('btwin_users').select('id, username').in('id', userIds),
      ]);

      const matchIds = [...new Set((mkRes.data || []).map(m => m.match_id).filter(Boolean))];
      const maRes = matchIds.length
        ? await supabaseAdmin.from('btwin_matches').select('id, team_home, team_away, league, match_date').in('id', matchIds)
        : { data: [] };

      const mkMap = Object.fromEntries((mkRes.data || []).map(m => [m.id, m]));
      const maMap = Object.fromEntries((maRes.data || []).map(m => [m.id, m]));
      const uMap  = Object.fromEntries((uRes.data  || []).map(u => [u.id, u]));

      const enriched = tickets.map(t => {
        const mk = mkMap[t.market_id] || {};
        const ma = maMap[mk.match_id] || {};
        const u  = uMap[t.user_id]    || {};
        return {
          ...t,
          market_type: mk.type || mk.name,
          tier:        mk.tier,
          entry_fee:   mk.ticket_price,
          team_home:   ma.team_home,
          team_away:   ma.team_away,
          league:      ma.league,
          match_date:  ma.match_date,
          username:    u.username,
        };
      });

      return res.json({ success: true, data: { tickets: enriched, total: count || 0 } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { tickets: [], total: 0 } });

  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (!isAdmin) { where += ' AND t.user_id = ?'; params.push(req.user.id); }
    if (status)   { where += ' AND t.status = ?'; params.push(status); }
    if (market_id){ where += ' AND t.market_id = ?'; params.push(market_id); }

    const [tickets, totals] = await Promise.all([
      query(
        `SELECT t.*, mk.market_type, mk.tier, mk.entry_fee, ma.team_home, ma.team_away, ma.league, ma.match_date
         FROM tickets t
         JOIN markets mk ON mk.id = t.market_id
         JOIN matches ma ON ma.id = t.match_id
         ${where} ORDER BY t.purchased_at DESC LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]
      ),
      query(`SELECT COUNT(*) AS total FROM tickets t ${where}`, params),
    ]);

    return res.json({ success: true, data: { tickets, total: totals[0]?.total || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tickets/:id
router.get('/:id', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.status(404).json({ success: false, error: 'Not available in mock mode' });

  try {
    const ticket = await queryOne(
      `SELECT t.*, mk.market_type, mk.tier, mk.entry_fee, mk.correct_outcome,
              ma.team_home, ma.team_away, ma.league, ma.match_date, ma.stadium
       FROM tickets t
       JOIN markets mk ON mk.id = t.market_id
       JOIN matches ma ON ma.id = t.match_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });
    if (ticket.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    return res.json({ success: true, data: { ticket } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/tickets — purchase ticket (deducts BTP from wallet)
router.post('/', authMiddleware, async (req, res) => {
  const { market_id, match_id, user_prediction, quantity = 1 } = req.body;
  let totalCost = 0; // declared outside try so catch can use it for rollback
  if (!market_id || !match_id || !user_prediction) {
    return res.status(400).json({ success: false, error: 'market_id, match_id, user_prediction required' });
  }

  // ── Supabase-only path (MySQL not configured) ─────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      // Get market
      const { data: market, error: mErr } = await supabaseAdmin
        .from('btwin_markets')
        .select('id, match_id, name, tier, ticket_price, status, winner_count, prize_pool, max_entries')
        .eq('id', market_id)
        .single();
      if (mErr || !market) return res.status(404).json({ success: false, error: 'Market not found' });
      if (market.status !== 'active') return res.status(400).json({ success: false, error: 'Market is not open for staking' });

      // Enforce admin-configured entry cap (null/unset = unlimited)
      if (market.max_entries != null) {
        const { count: entryCount } = await supabaseAdmin
          .from('btwin_tickets')
          .select('id', { count: 'exact', head: true })
          .eq('market_id', market_id)
          .neq('status', 'voided');
        if ((entryCount || 0) >= market.max_entries) {
          return res.status(400).json({ success: false, error: 'This pool is full' });
        }
      }

      // Check match timing
      const { data: matchRow } = await supabaseAdmin
        .from('btwin_matches')
        .select('match_date, status')
        .eq('id', market.match_id)
        .maybeSingle();
      if (matchRow) {
        if (['finished', 'live'].includes(matchRow.status)) {
          return res.status(400).json({ success: false, error: 'Staking is closed for this match' });
        }
        if (Date.now() >= new Date(matchRow.match_date).getTime() - 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Staking window closed (5 min before kickoff)' });
        }
      }

      const amount = market.ticket_price;

      // Check wallet balance
      const { data: walletRow } = await supabaseAdmin
        .from('btwin_users')
        .select('wallet_balance')
        .eq('id', req.user.id)
        .single();
      if (!walletRow || walletRow.wallet_balance < amount) {
        return res.status(400).json({ success: false, error: 'Insufficient wallet balance' });
      }

      // Debit wallet (atomic RPC)
      const { error: debitErr } = await supabaseAdmin
        .rpc('btwin_debit_wallet', { p_user_id: req.user.id, p_amount: amount });
      if (debitErr) return res.status(400).json({ success: false, error: debitErr.message || 'Wallet deduction failed' });

      // Generate ticket number
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const { count: ticketCount } = await supabaseAdmin
        .from('btwin_tickets').select('*', { count: 'exact', head: true });
      const ticketNumber = `WAL-${today}-${String((ticketCount || 0) + 1).padStart(5, '0')}`;

      // Create ticket
      const { data: ticket, error: tErr } = await supabaseAdmin
        .from('btwin_tickets')
        .insert({
          user_id:         req.user.id,
          market_id,
          ticket_number:   ticketNumber,
          user_prediction,
          amount_paid:     amount,
          status:          'active',
        })
        .select()
        .single();

      if (tErr) {
        supabaseAdmin.rpc('btwin_credit_wallet', { p_user_id: req.user.id, p_amount: amount }).catch(() => {});
        throw tErr;
      }

      // Update market prize pool
      supabaseAdmin
        .from('btwin_markets')
        .update({ prize_pool: (market.prize_pool || 0) + amount })
        .eq('id', market_id)
        .then(() => {})
        .catch(() => {});

      // Log transaction
      supabaseAdmin.from('btwin_transactions').insert({
        user_id:     req.user.id,
        type:        'ticket_purchase',
        amount:      -amount,
        status:      'completed',
        reference:   ticketNumber,
        description: `Stake — ${market.name} (${market.tier})`,
      }).catch(() => {});

      emailService.sendTicketConfirmation(req.user, ticket).catch(() => {});
      if (req.user.phone) smsService.sendTicketConfirmation(req.user.phone, ticket).catch(() => {});

      return res.status(201).json({ success: true, data: { ticket }, message: 'Ticket purchased successfully' });
    } catch (err) {
      console.error('[tickets/purchase/supabase]', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (IS_MOCK || !IS_DB_CONFIGURED) {
    const ticketNumber = await genTicketNumber();
    const mockTicket = { id: `mock-${Date.now()}`, ticket_number: ticketNumber, user_id: req.user.id, market_id, match_id, user_prediction, amount_paid: 100, status: 'pending', purchased_at: new Date().toISOString() };
    return res.status(201).json({ success: true, data: { ticket: mockTicket }, message: 'Ticket purchased (mock)' });
  }

  try {
    // Staking window: reject if match is live, finished, or within 5 mins of kickoff
    const matchRow = await queryOne('SELECT match_date, status FROM matches WHERE id = ?', [match_id]);
    if (!matchRow) return res.status(404).json({ success: false, error: 'Match not found' });
    if (matchRow.status === 'finished') {
      return res.status(400).json({ success: false, error: 'Match has ended — staking is closed' });
    }
    if (matchRow.status === 'live') {
      return res.status(400).json({ success: false, error: 'Match is live — staking is closed' });
    }
    const kickoff = new Date(matchRow.match_date).getTime();
    if (Date.now() >= kickoff - 5 * 60 * 1000) {
      return res.status(400).json({ success: false, error: 'Staking window has closed (5 minutes before kickoff)' });
    }

    const market = await queryOne('SELECT * FROM markets WHERE id = ? AND status = "open"', [market_id]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found or closed' });

    totalCost = market.entry_fee * parseInt(quantity);

    // Wallet lives on Supabase btwin_users — check balance there
    let walletBalance = req.user.wallet_balance ?? 0;
    if (IS_SUPABASE) {
      const { data: walletRow } = await supabaseAdmin
        .from('btwin_users')
        .select('wallet_balance')
        .eq('id', req.user.id)
        .single();
      walletBalance = walletRow?.wallet_balance ?? 0;
    }
    if (walletBalance < totalCost) {
      return res.status(400).json({ success: false, error: 'Insufficient wallet balance' });
    }

    // Deduct wallet on Supabase first (atomic RPC)
    if (IS_SUPABASE) {
      const { error: debitErr } = await supabaseAdmin
        .rpc('btwin_debit_wallet', { p_user_id: req.user.id, p_amount: totalCost });
      if (debitErr) {
        return res.status(400).json({ success: false, error: debitErr.message || 'Wallet deduction failed' });
      }
    }

    const ticketNumber = await genTicketNumber();

    const ticket = await transaction(async (conn) => {

      // Insert ticket
      await conn.execute(
        `INSERT INTO tickets (id, ticket_number, user_id, match_id, market_id, user_prediction, amount_paid, tier, quantity, status)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, "pending")`,
        [ticketNumber, req.user.id, match_id, market_id, user_prediction, totalCost, market.tier, parseInt(quantity)]
      );

      // Log transaction
      await conn.execute(
        'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "ticket_purchase", ?, ?, "successful", ?)',
        [req.user.id, -totalCost, ticketNumber, JSON.stringify({ market_id, match_id, prediction: user_prediction })]
      );

      // Update total_entries on market
      await conn.execute('UPDATE markets SET total_entries = total_entries + ?, prize_pool = prize_pool + ? WHERE id = ?',
        [parseInt(quantity), totalCost, market_id]);

      const [row] = await conn.execute('SELECT * FROM tickets WHERE ticket_number = ?', [ticketNumber]);
      return row[0];
    });

    // Log deduction in Supabase btwin_transactions for wallet history
    if (IS_SUPABASE) {
      supabaseAdmin.from('btwin_transactions').insert({
        user_id:     req.user.id,
        type:        'ticket_purchase',
        amount:      -totalCost,
        status:      'completed',
        reference:   ticketNumber,
        description: `Staking ticket — ${market.market_type} (${market.tier})`,
      }).catch(() => {});
    }

    emailService.sendTicketConfirmation(req.user, ticket).catch(() => {});
    smsService.sendTicketConfirmation(req.user.phone, ticket).catch(() => {});

    return res.status(201).json({ success: true, data: { ticket }, message: 'Ticket purchased successfully' });
  } catch (err) {
    console.error('[tickets/purchase]', err.message);
    // MySQL transaction failed after wallet was already debited — refund best-effort
    if (IS_SUPABASE && totalCost > 0) {
      supabaseAdmin.rpc('btwin_credit_wallet', { p_user_id: req.user.id, p_amount: totalCost }).catch(() => {});
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/tickets/:id  (admin void)
router.delete('/:id', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Ticket voided (mock)' });

  try {
    const ticket = await queryOne('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

    // Refund wallet on Supabase
    if (IS_SUPABASE) {
      await supabaseAdmin.rpc('btwin_credit_wallet', { p_user_id: ticket.user_id, p_amount: ticket.amount_paid }).catch(() => {});
    }
    await execute('UPDATE tickets SET status = "refunded" WHERE id = ?', [ticket.id]);
    await execute('INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "refund", ?, ?, "successful", ?)',
      [ticket.user_id, ticket.amount_paid, `VOID-${ticket.ticket_number}`, JSON.stringify({ admin_id: req.user.id })]);

    auditLog(req.user.id, 'VOID_TICKET', ticket.id);
    return res.json({ success: true, message: 'Ticket voided and refunded' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tickets/market/:marketId/count  (admin)
router.get('/market/:marketId/count', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { total: 0, correct: 0, incorrect: 0 } });

  try {
    const counts = await queryOne(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'correct' THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN status = 'incorrect' THEN 1 ELSE 0 END) AS incorrect
       FROM tickets WHERE market_id = ?`,
      [req.params.marketId]
    );
    return res.json({ success: true, data: counts });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
