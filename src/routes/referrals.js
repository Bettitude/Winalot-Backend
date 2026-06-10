const express = require('express');
const router  = express.Router();
const { supabaseAdmin } = require('../lib/supabase');
const { authMiddleware } = require('../middleware/auth');
const { authLimiter }   = require('../middleware/rateLimiter');
const { emailService }  = require('../services/email');

// POST /api/referrals/invite — send a referral invite email to a friend
router.post('/invite', authMiddleware, authLimiter, async (req, res) => {
  const { invitee_email } = req.body;

  if (!invitee_email || !/\S+@\S+\.\S+/.test(invitee_email)) {
    return res.status(400).json({ success: false, error: 'A valid email address is required' });
  }

  // Don't let someone invite themselves
  if (invitee_email.toLowerCase() === req.user.email?.toLowerCase()) {
    return res.status(400).json({ success: false, error: 'You cannot invite yourself' });
  }

  // Check if this email already has an account
  const { data: existing } = await supabaseAdmin
    .from('btwin_users')
    .select('id')
    .eq('email', invitee_email.toLowerCase())
    .maybeSingle();

  if (existing) {
    return res.status(409).json({ success: false, error: 'This person already has a WinALot account' });
  }

  // Fetch full referrer profile (need referral_code)
  const { data: referrer } = await supabaseAdmin
    .from('btwin_users')
    .select('id, email, full_name, username, referral_code')
    .eq('id', req.user.id)
    .single();

  if (!referrer) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  await emailService.sendReferralInvite(referrer, invitee_email);

  console.log(`[referrals/invite] ${referrer.username} → ${invitee_email}`);
  return res.json({ success: true, message: 'Invite sent!' });
});

// GET /api/referrals/stats — referral stats for the logged-in user
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const { data: referrer } = await supabaseAdmin
      .from('btwin_users')
      .select('id, referral_code')
      .eq('id', req.user.id)
      .single();

    if (!referrer) return res.status(404).json({ success: false, error: 'User not found' });

    // Count users who were referred by this user
    const { count: totalReferrals } = await supabaseAdmin
      .from('btwin_users')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', req.user.id);

    // Sum referral bonuses from transactions
    const { data: bonusTxns } = await supabaseAdmin
      .from('btwin_transactions')
      .select('amount')
      .eq('user_id', req.user.id)
      .like('reference', 'REF-%')
      .eq('status', 'completed');

    const totalEarnedCents = (bonusTxns || []).reduce((sum, t) => sum + (t.amount || 0), 0);

    return res.json({
      success: true,
      data: {
        referral_code:      referrer.referral_code,
        total_referrals:    totalReferrals || 0,
        total_earned_cents: totalEarnedCents,
        total_earned:       '$' + (totalEarnedCents / 100).toFixed(2),
      },
    });
  } catch (err) {
    console.error('[referrals/stats]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load referral stats' });
  }
});

module.exports = router;
