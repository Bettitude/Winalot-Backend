const { Resend } = require('resend');

let resend;
function getResend() {
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const FROM = process.env.RESEND_FROM_EMAIL || 'noreply@winalott.com';

async function sendEmail(to, subject, html) {
  try {
    if (!process.env.RESEND_API_KEY) { console.warn('[Email] RESEND_API_KEY not set — skipping'); return; }
    await getResend().emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error('[Email]', err.message);
  }
}

const emailService = {
  sendWelcomeEmail: (user) => sendEmail(
    user.email,
    'Welcome to WinALot!',
    `<h2>Welcome, ${user.full_name || user.username}!</h2>
     <p>Your account has been created. Start predicting and win big!</p>
     <p>Visit <a href="${process.env.CLIENT_URL}">WinALot</a> to get started.</p>`
  ),

  sendWinnerEmail: (user, match, prize) => sendEmail(
    user.email,
    `Congratulations! You won ${(prize / 100).toFixed(2)} BTP on WinALot!`,
    `<h2>You Won!</h2>
     <p>Hi ${user.full_name || user.username},</p>
     <p>You have won <strong>${(prize / 100).toFixed(2)} BTP</strong> on the <strong>${match}</strong> prediction market.</p>
     <p>Your prize has been credited to your WinALot wallet.</p>
     <p>Best Regards,<br>The WinALot Team</p>`
  ),

  sendPasswordResetEmail: (user, resetUrl) => sendEmail(
    user.email,
    'Reset your WinALot password',
    `<h2>Password Reset</h2>
     <p>Hi ${user.full_name || user.username},</p>
     <p>Click the link below to reset your password. This link expires in 1 hour.</p>
     <p><a href="${resetUrl}">Reset Password</a></p>
     <p>If you did not request this, ignore this email.</p>`
  ),

  // Called as: emailService.sendTicketConfirmation(user, ticket)
  sendTicketConfirmation: (user, ticket) => sendEmail(
    user.email,
    `Ticket Confirmed: ${ticket.ticket_number}`,
    `<h2>Ticket Confirmed!</h2>
     <p>Hi ${user.full_name || user.username},</p>
     <p>Your ticket <strong>${ticket.ticket_number}</strong> has been confirmed.</p>
     <p>Your Prediction: <strong>${ticket.user_prediction}</strong></p>
     <p>Good luck! Results are published after the match.<br>The WinALot Team</p>`
  ),

  // Alias kept for any code using the longer name
  sendTicketConfirmationEmail: (user, ticket) => emailService.sendTicketConfirmation(user, ticket),

  sendWithdrawalConfirmationEmail: (user, amount) => sendEmail(
    user.email,
    'Withdrawal Processed — WinALot',
    `<h2>Withdrawal Processed</h2>
     <p>Hi ${user.full_name || user.username},</p>
     <p>Your withdrawal of <strong>${(amount / 100).toFixed(2)} BTP</strong> has been initiated.</p>
     <p>It should arrive within 1–3 business days.<br>The WinALot Team</p>`
  ),

  // Broadcast notification — called as: emailService.sendNotification(user, title, message)
  sendNotification: (user, title, message) => sendEmail(
    user.email,
    title,
    `<h2>${title}</h2><p>${message}</p><p>The WinALot Team</p>`
  ),
};

module.exports = { emailService };
