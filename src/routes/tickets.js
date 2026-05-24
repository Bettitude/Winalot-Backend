const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { IS_MOCK }                   = require('../lib/mockMode');
const { emailService }              = require('../services/email');
const { smsService }                = require('../services/sms');

// Generate WAL-YYYYMMDD-NNNNN ticket number
async function genTicketNumber() {
  if (!IS_DB_CONFIGURED) return `WAL-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(Math.floor(Math.random()*99999)+1).padStart(5,'0')}`;
  const row = await queryOne('SELECT COUNT(*) AS n FROM tickets');
  const seq = (row?.n || 0) + 1;
  return `WAL-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(seq).padStart(5,'0')}`;
}

// GET /api/tickets  (admin: all; user: own)
router.get('/', authMiddleware, async (req, res) => {
  if (IS_MOCK || !IS_DB_CONFIGURED) return res.json({ success: true, data: { tickets: [], total: 0 } });

  const { page = 1, limit = 20, status, market_id } = req.query;
  const isAdmin = req.user.role === 'admin';
  const offset  = (parseInt(page) - 1) * parseInt(limit);

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
  if (!market_id || !match_id || !user_prediction) {
    return res.status(400).json({ success: false, error: 'market_id, match_id, user_prediction required' });
  }

  if (IS_MOCK || !IS_DB_CONFIGURED) {
    const ticketNumber = await genTicketNumber();
    const mockTicket = { id: `mock-${Date.now()}`, ticket_number: ticketNumber, user_id: req.user.id, market_id, match_id, user_prediction, amount_paid: 100, status: 'pending', purchased_at: new Date().toISOString() };
    return res.status(201).json({ success: true, data: { ticket: mockTicket }, message: 'Ticket purchased (mock)' });
  }

  try {
    const market = await queryOne('SELECT * FROM markets WHERE id = ? AND status = "open"', [market_id]);
    if (!market) return res.status(404).json({ success: false, error: 'Market not found or closed' });

    const totalCost = market.entry_fee * parseInt(quantity);
    const user = await queryOne('SELECT wallet_balance FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.wallet_balance < totalCost) {
      return res.status(400).json({ success: false, error: 'Insufficient BTP balance' });
    }

    const ticketNumber = await genTicketNumber();

    const ticket = await transaction(async (conn) => {
      // Deduct wallet
      await conn.execute('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', [totalCost, req.user.id]);

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

    emailService.sendTicketConfirmation(req.user, ticket).catch(() => {});
    smsService.sendTicketConfirmation(req.user.phone, ticket).catch(() => {});

    return res.status(201).json({ success: true, data: { ticket }, message: 'Ticket purchased successfully' });
  } catch (err) {
    console.error('[tickets/purchase]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/tickets/:id  (admin void)
router.delete('/:id', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Ticket voided (mock)' });

  try {
    const ticket = await queryOne('SELECT * FROM tickets WHERE id = ?', [req.params.id]);
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket not found' });

    // Refund wallet
    await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [ticket.amount_paid, ticket.user_id]);
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
