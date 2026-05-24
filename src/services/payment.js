const axios = require('axios');

const FLW_BASE = 'https://api.flutterwave.com/v3';
const FLW_KEY  = () => process.env.FLUTTERWAVE_SECRET_KEY || '';

async function flw(method, path, data) {
  const key = FLW_KEY();
  if (!key) throw new Error('FLUTTERWAVE_SECRET_KEY not configured');
  const res = await axios({ method, url: `${FLW_BASE}${path}`, data, headers: { Authorization: `Bearer ${key}` } });
  return res.data;
}

const paymentService = {
  // Initiate a Flutterwave payment — returns { payment_link, tx_ref }
  initDeposit: async ({ amount, currency = 'NGN', email, name, userId }) => {
    const tx_ref = `WAL-DEP-${userId.slice(0, 8)}-${Date.now()}`;
    const res = await flw('POST', '/payments', {
      tx_ref,
      amount,
      currency,
      redirect_url: `${process.env.CLIENT_URL}/dashboard/wallet?verify=1`,
      customer: { email, name },
      meta: { userId },
      customizations: { title: 'WinALot Wallet Top-up', logo: `${process.env.CLIENT_URL}/logo.png` },
    });
    if (res.status !== 'success') throw new Error(res.message || 'Failed to initiate payment');
    return { payment_link: res.data.link, tx_ref };
  },

  // Verify a completed Flutterwave transaction by ID
  verifyPayment: async (transaction_id) => {
    const res = await flw('GET', `/transactions/${transaction_id}/verify`);
    if (res.status !== 'success') throw new Error(res.message || 'Verification failed');
    return {
      status: res.data.status,       // 'successful' | 'failed' | 'pending'
      amount: res.data.amount,       // full currency units
      currency: res.data.currency,
      tx_ref: res.data.tx_ref,
      customer: res.data.customer,
    };
  },

  // Initiate a bank transfer payout via Flutterwave Transfer API
  initWithdrawal: async ({ accountNumber, bankCode, accountName, amountCents, narration }) => {
    const amount = amountCents / 100;
    const res = await flw('POST', '/transfers', {
      account_bank:   bankCode,
      account_number: accountNumber,
      amount,
      currency:       'NGN',
      narration:      narration || 'WinALot withdrawal',
      reference:      `WDRAW-${Date.now()}`,
      beneficiary_name: accountName,
    });
    if (res.status !== 'success') throw new Error(res.message || 'Withdrawal initiation failed');
    return { transfer_id: res.data.id, reference: res.data.reference };
  },
};

module.exports = { paymentService };
