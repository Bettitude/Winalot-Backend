const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }  = require('../middleware/auth');
const { adminMiddleware } = require('../middleware/admin');
const { paymentService }  = require('../services/payment');
const { authLimiter }     = require('../middleware/rateLimiter');
const { supabaseAdmin }   = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

// GET /api/transactions
router.get('/', authMiddleware, async (req, res) => {
  const { type, status, page = 1, limit = 20 } = req.query;
  const isAdmin = req.user.role === 'admin';
  const offset  = (parseInt(page) - 1) * parseInt(limit);

  // ── Supabase path ──────────────────────────────────────────────────────────
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      let q = supabaseAdmin
        .from('btwin_transactions')
        .select('id, user_id, type, amount, reference, status, description, created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + parseInt(limit) - 1);

      if (!isAdmin) q = q.eq('user_id', req.user.id);
      if (type)     q = q.eq('type', type);
      if (status)   q = q.eq('status', status);

      const { data: transactions, count, error } = await q;
      if (error) throw error;

      return res.json({ success: true, data: { transactions: transactions || [], total: count || 0 } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { transactions: [], total: 0 } });

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

// GET /api/transactions/banks  — Paystack bank list (public)
router.get('/banks', async (req, res) => {
  if (!paymentService.paystackEnabled()) {
    return res.json({ success: true, data: { banks: [] } });
  }
  try {
    const banks = await paymentService.listBanks(req.query.country || 'ng');
    return res.json({ success: true, data: { banks } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/deposit/init
router.post('/deposit/init', authLimiter, authMiddleware, async (req, res) => {
  const { amount, provider = 'paystack', redirect_url } = req.body;
  if (!amount || amount < 100) {
    return res.status(400).json({ success: false, error: 'Minimum deposit is $1 (100 units)' });
  }

  try {
    // ── Mock mode ─────────────────────────────────────────────────────
    if (!IS_DB_CONFIGURED || (!paymentService.paystackEnabled() && !paymentService.paypalEnabled() && !paymentService.flutterwaveEnabled())) {
      const mock = paymentService.mockDeposit({ amountCents: amount, userId: req.user.id });
      return res.json({ success: true, data: { payment_url: null, reference: mock.reference, mock: true, amount }, message: 'Mock mode — no real payment' });
    }

    // ── Flutterwave ───────────────────────────────────────────────────
    if (provider === 'flutterwave' || provider === 'flutterwave_bank') {
      if (!paymentService.flutterwaveEnabled()) {
        return res.status(400).json({ success: false, error: 'Flutterwave not configured' });
      }
      const result = await paymentService.initFlutterwaveDeposit({
        amountCents: amount,
        email:       req.user.email,
        userId:      req.user.id,
        redirectUrl: redirect_url,
        bankTransferOnly: provider === 'flutterwave_bank',
      });
      return res.json({ success: true, data: { payment_url: result.payment_url, reference: result.reference } });
    }

    // ── PayPal ────────────────────────────────────────────────────────
    if (provider === 'paypal') {
      if (!paymentService.paypalEnabled()) {
        return res.status(400).json({ success: false, error: 'PayPal not configured' });
      }
      const amountUSD = amount / 100;
      const result = await paymentService.initPaypalDeposit({
        amountUSD,
        userId: req.user.id,
        returnUrl: redirect_url || `${process.env.CLIENT_URL}/dashboard/wallet?pp=1`,
        cancelUrl: `${process.env.CLIENT_URL}/dashboard/wallet`,
      });
      return res.json({ success: true, data: { payment_url: result.approval_url, order_id: result.order_id } });
    }

    // ── Paystack (default) ────────────────────────────────────────────
    if (!paymentService.paystackEnabled()) {
      return res.status(400).json({ success: false, error: 'Paystack not configured' });
    }
    const result = await paymentService.initPaystackDeposit({
      amountCents: amount,
      email:       req.user.email,
      userId:      req.user.id,
      redirectUrl: redirect_url,
    });
    return res.json({ success: true, data: { payment_url: result.payment_url, reference: result.reference } });

  } catch (err) {
    console.error('[deposit/init]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/deposit/verify
router.post('/deposit/verify', authMiddleware, async (req, res) => {
  const { reference, paypal_order_id, mock, amount } = req.body;

  // ── Mock instant credit ───────────────────────────────────────────
  if (mock && !IS_DB_CONFIGURED) {
    return res.json({ success: true, data: { amount_credited: amount || 0 }, message: 'Mock deposit credited' });
  }
  if (mock && IS_DB_CONFIGURED) {
    const amountCents = parseInt(amount || 0);
    await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amountCents, req.user.id]);
    await execute('INSERT INTO transactions (id,user_id,type,amount,reference,status,metadata) VALUES (UUID(),?,"deposit",?,?,"completed",?)',
      [req.user.id, amountCents, `MOCK-${Date.now()}`, JSON.stringify({ mock: true })]);
    return res.json({ success: true, data: { amount_credited: amountCents }, message: 'Mock deposit credited' });
  }

  // ── PayPal capture ────────────────────────────────────────────────
  if (paypal_order_id) {
    try {
      const result = await paymentService.capturePaypalOrder(paypal_order_id);
      const amountCents = Math.round(result.amountUSD * 100);
      if (IS_DB_CONFIGURED) {
        await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amountCents, req.user.id]);
        await execute('INSERT INTO transactions (id,user_id,type,amount,reference,status,metadata) VALUES (UUID(),?,"deposit",?,?,"completed",?)',
          [req.user.id, amountCents, `PP-${paypal_order_id}`, JSON.stringify({ paypal_order_id, amount: result.amountUSD })]);
      }
      return res.json({ success: true, data: { amount_credited: amountCents }, message: 'PayPal deposit confirmed' });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  }

  // ── Flutterwave verify ────────────────────────────────────────────
  if (reference && reference.startsWith('WAL-FW-')) {
    try {
      const result = await paymentService.verifyFlutterwaveDeposit(reference);
      if (result.status !== 'success') {
        return res.status(400).json({ success: false, error: `Payment status: ${result.status}` });
      }
      if (IS_DB_CONFIGURED) {
        const existing = await queryOne('SELECT id FROM transactions WHERE reference = ?', [reference]);
        if (existing) return res.json({ success: true, data: { amount_credited: result.amountCents }, message: 'Already credited' });
        await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [result.amountCents, req.user.id]);
        await execute('INSERT INTO transactions (id,user_id,type,amount,reference,status,metadata) VALUES (UUID(),?,"deposit",?,?,"completed",?)',
          [req.user.id, result.amountCents, reference, JSON.stringify({ reference, amount: result.amountCents })]);
      }
      return res.json({ success: true, data: { amount_credited: result.amountCents }, message: 'Flutterwave deposit confirmed' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── Paystack verify ───────────────────────────────────────────────
  if (!reference) return res.status(400).json({ success: false, error: 'reference or paypal_order_id required' });
  try {
    const result = await paymentService.verifyPaystackDeposit(reference);
    if (result.status !== 'success') {
      return res.status(400).json({ success: false, error: `Payment status: ${result.status}` });
    }
    // Idempotency: don't double-credit
    if (IS_DB_CONFIGURED) {
      const existing = await queryOne('SELECT id FROM transactions WHERE reference = ?', [reference]);
      if (existing) return res.json({ success: true, data: { amount_credited: result.amountCents }, message: 'Already credited' });
      await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [result.amountCents, req.user.id]);
      await execute('INSERT INTO transactions (id,user_id,type,amount,reference,status,metadata) VALUES (UUID(),?,"deposit",?,?,"completed",?)',
        [req.user.id, result.amountCents, reference, JSON.stringify({ reference, amount: result.amountCents })]);
    }
    return res.json({ success: true, data: { amount_credited: result.amountCents }, message: 'Deposit confirmed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/webhook  — Paystack webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const body = req.body;
  const rawBody = Buffer.isBuffer(body) ? body.toString() : JSON.stringify(body);
  const signature = req.headers['x-paystack-signature'];

  if (paymentService.paystackEnabled() && signature) {
    const valid = paymentService.verifyWebhookSignature(rawBody, signature);
    if (!valid) return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  try {
    const event = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;

    // Charge completed
    if (event.event === 'charge.success' && IS_DB_CONFIGURED) {
      const data = event.data;
      const userId    = data.metadata?.userId;
      const amountCents = data.amount;
      const reference = data.reference;
      if (userId && amountCents) {
        const existing = await queryOne('SELECT id FROM transactions WHERE reference = ?', [reference]);
        if (!existing) {
          await execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [amountCents, userId]);
          await execute('INSERT INTO transactions (id,user_id,type,amount,reference,status,metadata) VALUES (UUID(),?,"deposit",?,?,"completed",?)',
            [userId, amountCents, reference, JSON.stringify(data)]);
        }
      }
    }

    // Transfer success/failure
    if ((event.event === 'transfer.success' || event.event === 'transfer.failed') && IS_DB_CONFIGURED) {
      const st = event.event === 'transfer.success' ? 'completed' : 'failed';
      await execute('UPDATE transactions SET status = ? WHERE reference = ? AND type = "withdrawal"',
        [st, event.data?.reference]);
    }

    return res.json({ status: 'ok' });
  } catch (err) {
    console.error('[webhook]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/withdraw
router.post('/withdraw', authLimiter, authMiddleware, async (req, res) => {
  const { amount, method = 'bank', paypal_email,
          account_number, bank_code, bank_name, account_name, routing_number } = req.body;

  if (!amount || amount < 500) {
    return res.status(400).json({ success: false, error: 'Minimum withdrawal is $5 (500 units)' });
  }
  if (method === 'paypal' && !paypal_email) {
    return res.status(400).json({ success: false, error: 'PayPal email required' });
  }
  if (method === 'bank' && (!account_number || !account_name)) {
    return res.status(400).json({ success: false, error: 'account_number and account_name required' });
  }

  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, message: 'Withdrawal submitted (mock)', data: { status: 'pending', reference: `MOCK-WD-${Date.now()}` } });
  }

  try {
    const user = await queryOne('SELECT wallet_balance FROM users WHERE id = ?', [req.user.id]);
    if (!user || user.wallet_balance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    const ref = `WDRAW-${req.user.id.slice(0, 8)}-${Date.now()}`;
    const meta = { method, paypal_email, account_number, bank_code, bank_name, account_name, routing_number };

    // Deduct immediately, mark pending
    await execute('UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?', [parseInt(amount), req.user.id]);
    await execute('INSERT INTO transactions (id,user_id,type,amount,reference,status,metadata) VALUES (UUID(),?,"withdrawal",?,?,"pending",?)',
      [req.user.id, -parseInt(amount), ref, JSON.stringify(meta)]);

    let autoResult = null;

    // ── Attempt auto-payout ───────────────────────────────────────────
    if (method === 'paypal' && paymentService.paypalEnabled()) {
      try {
        autoResult = await paymentService.initPaypalPayout({
          paypalEmail: paypal_email,
          amountUSD:   amount / 100,
          note:        'WinALot withdrawal',
          userId:      req.user.id,
        });
        await execute('UPDATE transactions SET status = "processing", metadata = JSON_SET(metadata, "$.payout_batch_id", ?) WHERE reference = ?',
          [autoResult.batch_id, ref]);
      } catch (payErr) {
        console.error('[paypal-payout]', payErr.message);
      }
    } else if (method === 'bank' && paymentService.paystackEnabled() && bank_code) {
      try {
        autoResult = await paymentService.initPaystackTransfer({
          accountNumber: account_number,
          bankCode:      bank_code,
          accountName:   account_name,
          amountCents:   parseInt(amount),
          narration:     'WinALot withdrawal',
        });
        await execute('UPDATE transactions SET status = "processing", metadata = JSON_SET(metadata, "$.transfer_code", ?) WHERE reference = ?',
          [autoResult.transfer_code, ref]);
      } catch (psErr) {
        console.error('[paystack-transfer]', psErr.message);
      }
    }

    const status = autoResult ? 'processing' : 'pending';
    const message = autoResult
      ? 'Withdrawal is being processed automatically. Usually arrives within minutes.'
      : 'Withdrawal request received. Admin will process within 1–3 business days.';

    return res.json({ success: true, message, data: { reference: ref, status, auto: !!autoResult } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/transactions/withdraw/approve  (admin)
router.post('/withdraw/approve/:ref', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Approved (mock)' });
  try {
    await execute("UPDATE transactions SET status = 'completed' WHERE reference = ? AND type = 'withdrawal'", [req.params.ref]);
    return res.json({ success: true, message: 'Withdrawal marked completed' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
