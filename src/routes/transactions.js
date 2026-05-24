const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }  = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/admin');
const { paymentService }  = require('../services/payment');
const { authLimiter }     = require('../middleware/rateLimiter');

// GET /api/transactions
router.get('/', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { transactions: [], total: 0 } });

  const { type, status, page = 1, limit = 20 } = req.query;
  const isAdmin = req.user.role === 'admin';
  const offset  = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (!isAdmin) { where += ' AND user_id = ?'; params.push(req.user.id); }
    if (type)     { where += ' AND type = ?'; params.push(type); }
    if (status)   { where += ' AND status = ?'; params.push(status); }

    const [transactions, totals] = await Promise.all([
      query(`SELECT * FROM transactions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]),
      query(`SELECT COUNT(*) AS total FROM transactions ${where}`, params),
    ]);

    return res.json({ success: true, data: { transactions, total: totals[0]?.total || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/deposit/init  — initiate Flutterwave deposit
router.post('/deposit/init', authLimiter, authMiddleware, async (req, res) => {
  const { amount } = req.body; // amount in cents
  if (!amount || amount < 100) return res.status(400).json({ success: false, error: 'Minimum deposit is 100 BTP (1 unit)' });

  try {
    const paymentData = await paymentService.initDeposit({
      amount: amount / 100, // Flutterwave works in full currency units
      currency: 'USD',
      email:    req.user.email,
      name:     req.user.full_name || req.user.username,
      userId:   req.user.id,
    });
    return res.json({ success: true, data: paymentData });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/deposit/verify
router.post('/deposit/verify', authMiddleware, async (req, res) => {
  const { transaction_id, ref } = req.body;
  if (!transaction_id) return res.status(400).json({ success: false, error: 'transaction_id required' });

  try {
    const result = await paymentService.verifyPayment(transaction_id);
    if (result.status !== 'successful') {
      return res.status(400).json({ success: false, error: 'Payment not successful' });
    }

    const amountCents = Math.round(result.amount * 100);

    if (IS_DB_CONFIGURED) {
      // Credit wallet
      await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amountCents, req.user.id]);
      // Log
      await execute(
        'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "deposit", ?, ?, "successful", ?)',
        [req.user.id, amountCents, ref || `FLW-${transaction_id}`, JSON.stringify({ transaction_id, amount: result.amount })]
      );
    }

    return res.json({ success: true, data: { amount_credited: amountCents }, message: 'Deposit successful' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/webhook  — Flutterwave webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const hash = req.headers['verif-hash'];
  if (hash !== process.env.FLUTTERWAVE_WEBHOOK_HASH) {
    return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
  }

  try {
    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (event.event === 'charge.completed' && event.data?.status === 'successful') {
      const amountCents = Math.round(event.data.amount * 100);
      const userId      = event.data.meta?.userId;

      if (IS_DB_CONFIGURED && userId) {
        await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amountCents, userId]);
        await execute(
          'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "deposit", ?, ?, "successful", ?)',
          [userId, amountCents, `FLW-WEBHOOK-${event.data.id}`, JSON.stringify(event.data)]
        );
      }
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('[webhook]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/withdraw
router.post('/withdraw', authLimiter, authMiddleware, async (req, res) => {
  const { amount, account_number, bank_code, account_name } = req.body;
  if (!amount || amount < 100) return res.status(400).json({ success: false, error: 'Minimum withdrawal is 100 BTP' });
  if (!account_number || !bank_code) return res.status(400).json({ success: false, error: 'Bank details required' });

  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Withdrawal initiated (mock)' });

  try {
    const user = await queryOne('SELECT wallet_balance FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.wallet_balance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient BTP balance' });
    }

    // Deduct wallet immediately and mark as pending
    await execute('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', [parseInt(amount), req.user.id]);
    const ref = `WDRAW-${req.user.id.slice(0,8)}-${Date.now()}`;
    await execute(
      'INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata) VALUES (UUID(), ?, "withdrawal", ?, ?, "pending", ?)',
      [req.user.id, -parseInt(amount), ref, JSON.stringify({ account_number, bank_code, account_name })]
    );

    return res.json({ success: true, message: 'Withdrawal initiated. Processing within 24 hours.', data: { reference: ref } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
