const express  = require('express');
const jwt      = require('jsonwebtoken');
const router   = express.Router();
const { supabase, supabaseAdmin } = require('../lib/supabase');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');
const { emailService } = require('../services/email');

const TOKEN_TTL    = '7d';
const CLIENT_URL   = process.env.CLIENT_URL || 'http://localhost:5173';
const BACKEND_URL  = process.env.BACKEND_URL || 'http://localhost:3001';

const IS_SUPABASE_CONFIGURED = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

function makeToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function safeProfile(row) {
  if (!row) return null;
  const { password_hash: _, ...safe } = row;
  return safe;
}

// Fetch btwin_users profile, retry once if trigger hasn't fired yet
async function fetchProfile(userId) {
  const { data } = await supabaseAdmin
    .from('btwin_users')
    .select('id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, referral_code, created_at')
    .eq('id', userId)
    .single();

  if (!data) {
    // Trigger may not have completed — wait 300ms and retry once
    await new Promise(r => setTimeout(r, 300));
    const { data: retry } = await supabaseAdmin
      .from('btwin_users')
      .select('id, username, full_name, email, phone, avatar_url, role, status, wallet_balance, referral_code, created_at')
      .eq('id', userId)
      .single();
    return retry;
  }
  return data;
}


// ─── REGISTER ────────────────────────────────────────────────────────────────

router.post('/register', authLimiter, async (req, res) => {
  const { username, full_name, email, password, phone, terms_accepted, age_confirmed, referral_code } = req.body;
  console.log(`[auth/register] attempt → email=${email} | username=${username} | full_name=${full_name || '—'} | phone=${phone || '—'}`);

  if (!email || !password || !username) {
    return res.status(400).json({ success: false, error: 'email, password, and username are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return res.status(400).json({ success: false, error: 'Username must be 3–30 characters, letters/numbers/underscore only' });
  }
  if (!terms_accepted) {
    return res.status(400).json({ success: false, error: 'You must agree to the Terms and Conditions to continue' });
  }
  if (!age_confirmed) {
    return res.status(400).json({ success: false, error: 'You must confirm you are 18 or older to continue' });
  }

  if (!IS_SUPABASE_CONFIGURED) {
    return res.status(503).json({ success: false, error: 'Auth service not configured' });
  }

  try {
    // Check for duplicate email
    const { data: emailExists } = await supabaseAdmin
      .from('btwin_users')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (emailExists) {
      return res.status(409).json({ success: false, error: 'Email already registered' });
    }

    // Check for duplicate username
    const { data: usernameExists } = await supabaseAdmin
      .from('btwin_users')
      .select('id')
      .eq('username', username.toLowerCase())
      .maybeSingle();
    if (usernameExists) {
      return res.status(409).json({ success: false, error: 'Username already taken' });
    }

    // Create auth user (Supabase Auth handles password hashing)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,                         // pre-confirm; we send our own welcome email
      user_metadata: {
        username:  username.toLowerCase(),
        full_name: full_name || '',
        phone:     phone || null,
      },
    });

    if (authError) {
      console.error(`[auth/register] authError → code=${authError.code} | status=${authError.status} | message=${authError.message}`);
      if (authError.message.includes('already registered')) {
        return res.status(409).json({ success: false, error: 'Email already registered' });
      }
      throw authError;
    }

    let profile = await fetchProfile(authData.user.id);

    // Trigger may have failed silently (EXCEPTION block in SQL) — insert the profile manually.
    if (!profile) {
      console.warn(`[auth/register] trigger did not create profile for ${authData.user.id} — inserting manually`);
      const { error: insertError } = await supabaseAdmin
        .from('btwin_users')
        .insert({
          id:         authData.user.id,
          username:   username.toLowerCase(),
          email,
          full_name:  full_name || '',
          role:       'user',
          status:     'enabled',
          wallet_balance: 0,
        });

      if (insertError) {
        console.error('[auth/register] manual insert failed →', insertError.message, insertError.code);
        return res.status(500).json({ success: false, error: 'Profile creation failed — try again' });
      }

      profile = await fetchProfile(authData.user.id);
    }

    if (!profile) {
      return res.status(500).json({ success: false, error: 'Profile creation failed — try again' });
    }

    // Record terms/age acceptance — both required (already validated above)
    supabaseAdmin
      .from('btwin_users')
      .update({
        terms_accepted:    true,
        age_confirmed:     true,
        terms_accepted_at: new Date().toISOString(),
      })
      .eq('id', authData.user.id)
      .then(() => {}).catch(() => {});

    // Referral processing — find referrer by their referral_code, credit them $0.50
    if (referral_code) {
      supabaseAdmin
        .from('btwin_users')
        .select('id, email, full_name, username, wallet_balance, referral_code')
        .eq('referral_code', referral_code.toUpperCase())
        .maybeSingle()
        .then(async ({ data: referrer }) => {
          if (!referrer || referrer.id === authData.user.id) return;

          const BONUS = 50; // $0.50 in cents

          // Link the new user to the referrer
          await supabaseAdmin.from('btwin_users')
            .update({ referred_by: referrer.id })
            .eq('id', authData.user.id)
            .catch(() => {});

          // Credit the referrer's wallet
          await supabaseAdmin.from('btwin_users')
            .update({ wallet_balance: referrer.wallet_balance + BONUS })
            .eq('id', referrer.id)
            .catch(() => {});

          // Log the transaction
          await supabaseAdmin.from('btwin_transactions').insert({
            user_id:     referrer.id,
            type:        'manual_credit',
            amount:      BONUS,
            status:      'completed',
            reference:   `REF-${authData.user.id}`,
            description: `Referral bonus — ${profile.username || email} signed up with your link`,
          }).catch(() => {});

          // Notify the referrer by email
          emailService.sendReferralCreditEmail(
            referrer,
            profile.full_name || profile.username || email,
            BONUS
          ).catch(() => {});

          console.log(`[auth/register] referral credited → referrer=${referrer.username} +${BONUS}¢`);
        })
        .catch(() => {});
    }

    // Welcome email (non-blocking)
    emailService.sendWelcomeEmail(profile).catch(() => {});

    return res.status(201).json({
      success: true,
      data: { user: safeProfile(profile), token: makeToken(profile) },
      message: 'Account created successfully',
    });
  } catch (err) {
    console.error('[auth/register] UNHANDLED ERROR →', err.message, err.code || '', err.status || '');
    const isDev = process.env.NODE_ENV !== 'production';
    return res.status(500).json({
      success: false,
      error: isDev ? `Registration failed: ${err.message}` : 'Registration failed. Please try again.',
    });
  }
});


// ─── LOGIN ────────────────────────────────────────────────────────────────────

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  console.log(`[auth/login] attempt → email=${email}`);
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password required' });
  }

  if (!IS_SUPABASE_CONFIGURED) {
    return res.status(503).json({ success: false, error: 'Auth service not configured' });
  }

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      console.log(`[auth/login] FAILED → email=${email} | reason=${authError.message}`);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const profile = await fetchProfile(authData.user.id);
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Account profile not found' });
    }

    if (profile.status === 'suspended') {
      console.log(`[auth/login] BLOCKED → email=${email} | status=suspended`);
      return res.status(403).json({ success: false, error: 'Your account has been suspended' });
    }
    if (profile.status === 'disabled') {
      console.log(`[auth/login] BLOCKED → email=${email} | status=disabled`);
      return res.status(403).json({ success: false, error: 'Your account has been disabled. Contact support.' });
    }

    console.log(`[auth/login] SUCCESS → email=${email} | username=${profile.username} | role=${profile.role} | id=${profile.id}`);

    // Login notification email — non-blocking
    emailService.sendLoginNotification(profile, {
      time: new Date().toUTCString(),
    }).catch(() => {});

    return res.json({
      success: true,
      data: { user: safeProfile(profile), token: makeToken(profile) },
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    return res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});


// ─── LOGOUT ──────────────────────────────────────────────────────────────────
// JWTs are stateless — client discards the token. Backend logs the event.

router.post('/logout', authMiddleware, (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});


// ─── ME ───────────────────────────────────────────────────────────────────────

router.get('/me', authMiddleware, async (req, res) => {
  if (!IS_SUPABASE_CONFIGURED) {
    return res.json({ success: true, data: { user: req.user } });
  }
  try {
    const profile = await fetchProfile(req.user.id);
    if (!profile) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: { user: safeProfile(profile) } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─── FORGOT PASSWORD ─────────────────────────────────────────────────────────

router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, error: 'Email required' });

  // Always return the same message to prevent email enumeration
  if (IS_SUPABASE_CONFIGURED) {
    try {
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${CLIENT_URL}/auth/reset-password`,
      });
    } catch { /* non-blocking */ }
  }

  return res.json({ success: true, message: 'If that email exists, a reset link has been sent' });
});


// ─── RESET PASSWORD ───────────────────────────────────────────────────────────
// Frontend reads access_token from URL hash (#access_token=...&type=recovery)
// and sends it here along with the new password.

router.post('/reset-password', authLimiter, async (req, res) => {
  const { access_token, new_password } = req.body;

  if (!access_token || !new_password) {
    return res.status(400).json({ success: false, error: 'access_token and new_password required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }

  if (!IS_SUPABASE_CONFIGURED) {
    return res.json({ success: true, message: 'Password reset (mock)' });
  }

  try {
    // Validate the Supabase recovery token and get the user
    const { data: { user }, error: getUserError } = await supabaseAdmin.auth.getUser(access_token);
    if (getUserError || !user) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
    }

    // Update the password
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: new_password,
    });
    if (updateError) throw updateError;

    return res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    console.error('[auth/reset-password]', err.message);
    return res.status(400).json({ success: false, error: 'Invalid or expired reset token' });
  }
});


// ─── CHANGE PASSWORD ──────────────────────────────────────────────────────────

router.post('/change-password', authMiddleware, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ success: false, error: 'current_password and new_password required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
  }

  if (!IS_SUPABASE_CONFIGURED) {
    return res.json({ success: true, message: 'Password changed (mock)' });
  }

  try {
    // Verify current password by attempting a sign-in
    const { error: verifyError } = await supabase.auth.signInWithPassword({
      email: req.user.email,
      password: current_password,
    });
    if (verifyError) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
      password: new_password,
    });
    if (updateError) throw updateError;

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('[auth/change-password]', err.message);
    return res.status(500).json({ success: false, error: 'Password change failed' });
  }
});


// ─── GOOGLE OAUTH — INITIATE ──────────────────────────────────────────────────
// Browser navigates here → backend redirects to Google via Supabase OAuth URL.

router.get('/google', async (req, res) => {
  if (!IS_SUPABASE_CONFIGURED) {
    return res.status(503).json({ success: false, error: 'OAuth not configured' });
  }

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo:          `${CLIENT_URL}/auth/callback`,
        skipBrowserRedirect: true,               // we handle the redirect server-side
        queryParams: {
          access_type: 'offline',
          prompt:      'select_account',
        },
      },
    });

    if (error || !data?.url) {
      return res.status(500).json({ success: false, error: 'Could not generate OAuth URL' });
    }

    return res.redirect(data.url);
  } catch (err) {
    console.error('[auth/google]', err.message);
    return res.status(500).json({ success: false, error: 'OAuth initiation failed' });
  }
});


// ─── GOOGLE OAUTH — TOKEN EXCHANGE ───────────────────────────────────────────
// Frontend sends the Supabase access_token received after the OAuth redirect.
// Backend verifies it, fetches/creates the btwin_users profile, issues our JWT.

router.post('/google/token', authLimiter, async (req, res) => {
  const { access_token } = req.body;

  if (!access_token) {
    return res.status(400).json({ success: false, error: 'access_token required' });
  }
  if (!IS_SUPABASE_CONFIGURED) {
    return res.status(503).json({ success: false, error: 'Auth service not configured' });
  }

  try {
    // Verify the Supabase token — works for any valid Supabase JWT (OAuth or password)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(access_token);
    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    let profile = await fetchProfile(user.id);

    // Profile may not exist yet if the trigger hasn't run (rare race)
    if (!profile) {
      const name      = user.user_metadata?.full_name || user.user_metadata?.name || '';
      const baseUname = (user.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 28);

      const { error: insertError } = await supabaseAdmin
        .from('btwin_users')
        .upsert({
          id:            user.id,
          email:         user.email,
          username:      `${baseUname}_${Date.now().toString(36)}`,
          full_name:     name,
          avatar_url:    user.user_metadata?.avatar_url || user.user_metadata?.picture || null,
          role:          'user',
          status:        'enabled',
          wallet_balance: 0,
        }, { onConflict: 'id', ignoreDuplicates: true });

      if (insertError) throw insertError;
      profile = await fetchProfile(user.id);
    }

    if (!profile) {
      return res.status(500).json({ success: false, error: 'Profile setup failed — try again' });
    }

    if (profile.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'Your account has been suspended' });
    }
    if (profile.status === 'disabled') {
      return res.status(403).json({ success: false, error: 'Your account has been disabled' });
    }

    return res.json({
      success: true,
      data: { user: safeProfile(profile), token: makeToken(profile) },
    });
  } catch (err) {
    console.error('[auth/google/token]', err.message);
    return res.status(500).json({ success: false, error: 'Token exchange failed' });
  }
});

module.exports = router;
