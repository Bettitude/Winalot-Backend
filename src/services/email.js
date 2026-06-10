/**
 * Email service — tries Apps Script first, falls back to Resend.
 *
 * Set APPS_SCRIPT_URL in .env to enable Apps Script sending.
 * Set RESEND_API_KEY in .env to enable Resend as fallback.
 * If neither is set, emails are logged and skipped.
 */

const { Resend } = require('resend');

const CLIENT_URL = process.env.CLIENT_URL || 'https://winalott.com';

// ── Apps Script sender ────────────────────────────────────────────────────────

async function sendViaAppsScript(to, type, name, data = {}) {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return false;

  try {
    const res = await fetch(url, {
      method:   'POST',
      redirect: 'follow',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ type, to, name, data: { ...data, clientUrl: CLIENT_URL } }),
    });

    // Apps Script returns 200 even on errors — check the body
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { return false; }
    if (!json.success) {
      console.warn('[Email/AppScript] returned error:', json.error);
      return false;
    }
    console.log(`[Email/AppScript] sent type=${type} to=${to}`);
    return true;
  } catch (err) {
    console.warn('[Email/AppScript] fetch failed:', err.message);
    return false;
  }
}

// ── Resend fallback ───────────────────────────────────────────────────────────

let _resend;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

const FROM = process.env.RESEND_FROM_EMAIL || 'noreply@winalott.com';

async function sendViaResend(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    await getResend().emails.send({ from: FROM, to, subject, html });
    console.log(`[Email/Resend] sent subject="${subject}" to=${to}`);
    return true;
  } catch (err) {
    console.error('[Email/Resend]', err.message);
    return false;
  }
}

// ── Core dispatcher ───────────────────────────────────────────────────────────
// Fire-and-forget — never throws. Returns true if email was sent.

async function send(to, type, name, data = {}, resendFallback = {}) {
  if (!to) return false;

  // 1. Try Apps Script
  const sent = await sendViaAppsScript(to, type, name, data);
  if (sent) return true;

  // 2. Fall back to Resend (if subject + html provided)
  if (resendFallback.subject && resendFallback.html) {
    return sendViaResend(to, resendFallback.subject, resendFallback.html);
  }

  console.log(`[Email] skipped — no transport configured (type=${type}, to=${to})`);
  return false;
}

// ── Public service API ────────────────────────────────────────────────────────

const emailService = {

  sendWelcomeEmail(user) {
    const name = user.full_name || user.username || 'there';
    return send(user.email, 'welcome', name, {}, {
      subject: 'Welcome to WinALot!',
      html: `<h2>Welcome, ${name}!</h2><p>Your account is ready. <a href="${CLIENT_URL}/lobby">Start predicting</a>.</p>`,
    });
  },

  sendLoginNotification(user, meta = {}) {
    const name = user.full_name || user.username || 'there';
    return send(user.email, 'login', name, {
      time: new Date().toUTCString(),
      ...meta,
    }, {
      subject: 'New sign-in to your WinALot account',
      html: `<h2>New sign-in</h2><p>Hi ${name}, a new login was detected at ${new Date().toUTCString()}.</p>`,
    });
  },

  sendWinnerEmail(user, match, prizeInCents) {
    const name         = user.full_name || user.username || 'there';
    const prizeDisplay = '$' + (prizeInCents / 100).toFixed(2);
    return send(user.email, 'winner', name, {
      match,
      prize_display: prizeDisplay,
    }, {
      subject: `You won ${prizeDisplay} on WinALot!`,
      html: `<h2>You won ${prizeDisplay}!</h2><p>Hi ${name}, you won on <strong>${match}</strong>. Prize credited to your wallet.</p>`,
    });
  },

  sendReferralInvite(inviterUser, inviteeEmail) {
    const name    = inviterUser.full_name || inviterUser.username || 'A friend';
    const refCode = inviterUser.referral_code;
    const refLink = `${CLIENT_URL}/auth/signup?ref=${refCode}`;
    return send(inviteeEmail, 'referral_invite', name, { refLink }, {
      subject: `${name} invited you to WinALot!`,
      html: `<h2>${name} invited you!</h2><p><a href="${refLink}">Join WinALot</a> and start winning.</p>`,
    });
  },

  sendReferralCreditEmail(referrerUser, newUserName, bonusCents) {
    const name  = referrerUser.full_name || referrerUser.username || 'there';
    const bonus = '$' + (bonusCents / 100).toFixed(2);
    return send(referrerUser.email, 'referral_credit', name, {
      referredName:  newUserName,
      bonus_display: bonus,
    }, {
      subject: `Referral bonus: ${bonus} credited to your wallet!`,
      html: `<h2>Referral bonus!</h2><p>Hi ${name}, ${newUserName} joined using your link. ${bonus} added to your wallet.</p>`,
    });
  },

  sendTicketConfirmation(user, ticket) {
    const name = user.full_name || user.username || 'there';
    return send(user.email, 'ticket', name, {
      ticket_number: ticket.ticket_number,
      prediction:    ticket.user_prediction,
      match:         ticket.match_title || '',
    }, {
      subject: `Ticket Confirmed: ${ticket.ticket_number}`,
      html: `<h2>Ticket Confirmed!</h2><p>Ticket <strong>${ticket.ticket_number}</strong> · Prediction: <strong>${ticket.user_prediction}</strong>. Good luck!</p>`,
    });
  },

  sendTicketConfirmationEmail(user, ticket) {
    return emailService.sendTicketConfirmation(user, ticket);
  },

  sendPasswordResetEmail(user, resetUrl) {
    const name = user.full_name || user.username || 'there';
    return send(user.email, 'reset_password', name, { resetUrl }, {
      subject: 'Reset your WinALot password',
      html: `<h2>Password Reset</h2><p>Hi ${name}, <a href="${resetUrl}">click here</a> to reset your password. Expires in 1 hour.</p>`,
    });
  },

  sendWithdrawalConfirmationEmail(user, amountCents) {
    const name   = user.full_name || user.username || 'there';
    const amount = '$' + (amountCents / 100).toFixed(2);
    return send(user.email, 'generic', name, {
      subject: 'Withdrawal Processed — WinALot',
      message: `Hi ${name}, your withdrawal of <strong>${amount}</strong> has been initiated and should arrive within 1-3 business days.`,
    }, {
      subject: 'Withdrawal Processed — WinALot',
      html: `<h2>Withdrawal Processed</h2><p>Hi ${name}, your withdrawal of ${amount} has been initiated.</p>`,
    });
  },

  sendNotification(user, title, message) {
    const name = user.full_name || user.username || 'there';
    return send(user.email, 'generic', name, { subject: title, message }, {
      subject: title,
      html: `<h2>${title}</h2><p>${message}</p>`,
    });
  },
};

module.exports = { emailService };
