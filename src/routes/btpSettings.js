const express = require('express');
const router  = express.Router();
const { adminMiddleware } = require('../middleware/admin');
const { supabaseAdmin }   = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

const BTP_KEYS = [
  'usd_per_btp', 'min_purchase_btp', 'max_purchase_btp',
  'min_withdrawal_btp', 'max_withdrawal_btp',
  'withdrawal_fee_pct', 'platform_fee_pct', 'bonus_on_first_deposit',
];

const DEFAULTS = {
  usd_per_btp:            0.01,
  min_purchase_btp:       100,
  max_purchase_btp:       100000,
  min_withdrawal_btp:     500,
  max_withdrawal_btp:     50000,
  withdrawal_fee_pct:     5,
  platform_fee_pct:       10,
  bonus_on_first_deposit: 0,
};

// GET /api/btp-settings
router.get('/', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) {
    return res.json({ success: true, data: DEFAULTS });
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('btwin_settings')
      .select('key, value')
      .in('key', BTP_KEYS);
    if (error) throw error;

    const flat = { ...DEFAULTS };
    for (const row of (data || [])) {
      const raw = row.value;
      flat[row.key] = typeof raw === 'string' ? parseFloat(raw) || raw : raw;
    }
    return res.json({ success: true, data: flat });
  } catch (err) {
    console.error('[btpSettings GET]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/btp-settings
router.put('/', adminMiddleware, async (req, res) => {
  if (!IS_SUPABASE) {
    return res.json({ success: true, data: req.body });
  }
  try {
    const rows = BTP_KEYS
      .filter(k => req.body[k] !== undefined && req.body[k] !== '')
      .map(k => ({
        key:        k,
        value:      JSON.stringify(req.body[k]),
        updated_by: req.user.id === 'demo-admin-001' ? null : req.user.id,
        updated_at: new Date().toISOString(),
      }));

    if (rows.length) {
      const { error } = await supabaseAdmin
        .from('btwin_settings')
        .upsert(rows, { onConflict: 'key' });
      if (error) throw error;
    }

    return res.json({ success: true, message: 'Settings saved' });
  } catch (err) {
    console.error('[btpSettings PUT]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
