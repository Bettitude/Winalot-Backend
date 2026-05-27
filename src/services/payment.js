const axios = require('axios');

// ── Paystack ──────────────────────────────────────────────────────────────
const PS_BASE = 'https://api.paystack.co';
const ps = (method, path, data) => {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error('PAYSTACK_SECRET_KEY not configured');
  return axios({ method, url: `${PS_BASE}${path}`, data,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } })
    .then(r => r.data);
};

// ── PayPal ────────────────────────────────────────────────────────────────
const PP_BASE = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let _ppToken = null;
let _ppExpiry = 0;

async function ppAccessToken() {
  if (_ppToken && Date.now() < _ppExpiry) return _ppToken;
  const id  = process.env.PAYPAL_CLIENT_ID;
  const sec = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !sec) throw new Error('PayPal credentials not configured');
  const r = await axios.post(`${PP_BASE}/v1/oauth2/token`,
    'grant_type=client_credentials',
    { auth: { username: id, password: sec }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  _ppToken  = r.data.access_token;
  _ppExpiry = Date.now() + (r.data.expires_in - 60) * 1000;
  return _ppToken;
}

async function pp(method, path, data) {
  const token = await ppAccessToken();
  return axios({ method, url: `${PP_BASE}${path}`, data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
    .then(r => r.data);
}

// ── Check if gateways are available ──────────────────────────────────────
const paystackEnabled = () => !!process.env.PAYSTACK_SECRET_KEY;
const paypalEnabled   = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

const paymentService = {
  paystackEnabled,
  paypalEnabled,

  // ── Deposits ─────────────────────────────────────────────────────────
  initPaystackDeposit: async ({ amountCents, email, userId, redirectUrl }) => {
    const reference = `WAL-PS-${userId.slice(0, 8)}-${Date.now()}`;
    const res = await ps('POST', '/transaction/initialize', {
      email,
      amount:       amountCents,        // Paystack uses kobo/cents
      reference,
      callback_url: redirectUrl || `${process.env.CLIENT_URL}/dashboard/wallet?verify=1&provider=paystack`,
      metadata:     { userId, cancel_action: `${process.env.CLIENT_URL}/dashboard/wallet` },
      currency:     process.env.PAYSTACK_CURRENCY || 'NGN',
    });
    if (!res.status) throw new Error(res.message || 'Paystack init failed');
    return { payment_url: res.data.authorization_url, reference };
  },

  verifyPaystackDeposit: async (reference) => {
    const res = await ps('GET', `/transaction/verify/${reference}`);
    if (!res.status) throw new Error(res.message || 'Verification failed');
    return {
      status:      res.data.status,      // 'success' | 'failed' | 'abandoned'
      amountCents: res.data.amount,      // already in kobo/cents
      reference:   res.data.reference,
      email:       res.data.customer?.email,
    };
  },

  initPaypalDeposit: async ({ amountUSD, userId, cancelUrl, returnUrl }) => {
    const res = await pp('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'USD', value: amountUSD.toFixed(2) },
        custom_id: userId,
        description: 'WinALot wallet top-up',
      }],
      application_context: {
        return_url:   returnUrl || `${process.env.CLIENT_URL}/dashboard/wallet?pp=1`,
        cancel_url:   cancelUrl || `${process.env.CLIENT_URL}/dashboard/wallet`,
        brand_name:   'WinALot',
        user_action:  'PAY_NOW',
        landing_page: 'BILLING',
      },
    });
    const approvalLink = res.links?.find(l => l.rel === 'approve')?.href;
    if (!approvalLink) throw new Error('PayPal order creation failed');
    return { approval_url: approvalLink, order_id: res.id };
  },

  capturePaypalOrder: async (orderId) => {
    const res = await pp('POST', `/v2/checkout/orders/${orderId}/capture`);
    if (res.status !== 'COMPLETED') throw new Error(`PayPal capture not completed: ${res.status}`);
    const unit = res.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    return {
      status:    res.status,
      amountUSD: parseFloat(capture?.amount?.value || 0),
      orderId:   res.id,
      userId:    unit?.custom_id,
    };
  },

  // ── Mock deposit (no real keys) ───────────────────────────────────────
  mockDeposit: ({ amountCents, userId }) => {
    const reference = `WAL-MOCK-${userId?.slice(0, 8) || 'x'}-${Date.now()}`;
    return { payment_url: null, reference, mock: true, amountCents };
  },

  // ── Withdrawals ───────────────────────────────────────────────────────

  // Auto bank transfer via Paystack
  initPaystackTransfer: async ({ accountNumber, bankCode, accountName, amountCents, narration }) => {
    // 1. Create recipient
    const recRes = await ps('POST', '/transferrecipient', {
      type:           'nuban',
      name:           accountName,
      account_number: accountNumber,
      bank_code:      bankCode,
      currency:       process.env.PAYSTACK_CURRENCY || 'NGN',
    });
    if (!recRes.status) throw new Error(recRes.message || 'Failed to create transfer recipient');
    const recipientCode = recRes.data.recipient_code;

    // 2. Initiate transfer
    const ref = `WDRAW-PS-${Date.now()}`;
    const txRes = await ps('POST', '/transfer', {
      source:    'balance',
      amount:    amountCents,
      recipient: recipientCode,
      reason:    narration || 'WinALot withdrawal',
      reference: ref,
    });
    if (!txRes.status) throw new Error(txRes.message || 'Transfer initiation failed');
    return { transfer_code: txRes.data.transfer_code, reference: ref, status: txRes.data.status };
  },

  // Auto PayPal payout
  initPaypalPayout: async ({ paypalEmail, amountUSD, note, userId }) => {
    const res = await pp('POST', '/v1/payments/payouts', {
      sender_batch_header: {
        sender_batch_id: `BATCH-${Date.now()}`,
        email_subject:   'Your WinALot withdrawal',
        email_message:   'You have received a withdrawal from WinALot.',
      },
      items: [{
        recipient_type: 'EMAIL',
        amount: { value: amountUSD.toFixed(2), currency: 'USD' },
        receiver:   paypalEmail,
        note:       note || 'WinALot withdrawal',
        sender_item_id: `WDRAW-PP-${userId?.slice(0, 8)}-${Date.now()}`,
      }],
    });
    return { batch_id: res.batch_header?.payout_batch_id, status: res.batch_header?.batch_status };
  },

  // Verify Paystack webhook signature
  verifyWebhookSignature: (rawBody, signature) => {
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '')
      .update(rawBody).digest('hex');
    return hash === signature;
  },

  // Verify PayPal webhook (basic — use PayPal SDK for full verification in prod)
  verifyPaypalWebhook: (body, headers) => {
    return true; // placeholder — integrate PayPal webhook verification SDK in production
  },

  // Fetch Paystack bank list for the dropdown
  listBanks: async (country = 'ng') => {
    const res = await ps('GET', `/bank?country=${country}&use_cursor=false&perPage=100`);
    if (!res.status) return [];
    return (res.data || []).map(b => ({ name: b.name, code: b.code }));
  },
};

module.exports = { paymentService };
