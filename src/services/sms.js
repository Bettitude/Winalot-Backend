const https = require('https');

async function termiiPost(endpoint, body) {
  return new Promise((resolve) => {
    if (!process.env.TERMII_API_KEY) { console.warn('[SMS] TERMII_API_KEY not set — skipping'); return resolve({}); }
    const data    = JSON.stringify({ api_key: process.env.TERMII_API_KEY, ...body });
    const options = {
      hostname: 'api.ng.termii.com',
      path:     `/api${endpoint}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };

    const req = https.request(options, (res) => {
      let result = '';
      res.on('data', (c) => { result += c; });
      res.on('end', () => { try { resolve(JSON.parse(result)); } catch { resolve({ message: result }); } });
    });

    req.on('error', (err) => { console.error('[SMS]', err.message); resolve({ error: err.message }); });
    req.write(data);
    req.end();
  });
}

const smsService = {
  sendOTP: (phone, otp) => termiiPost('/sms/otp/send', {
    phone_number:  phone,
    sender_id:     process.env.TERMII_SENDER_ID || 'WinALott',
    message:       `Your WinALot verification code is: ${otp}. Valid for 10 minutes.`,
    channel:       'generic',
    message_type:  'ALPHANUMERIC',
  }),

  sendWinnerSMS: (phone, matchTitle, prize) => termiiPost('/sms/send', {
    to:      phone,
    from:    process.env.TERMII_SENDER_ID || 'WinALott',
    sms:     `Congrats! You won ${(prize / 100).toFixed(2)} BTP on WinALot for ${matchTitle}. Login to claim.`,
    type:    'plain',
    channel: 'generic',
  }),

  // Called as: smsService.sendTicketConfirmation(phone, ticket)
  sendTicketConfirmation: (phone, ticket) => {
    if (!phone) return Promise.resolve({});
    return termiiPost('/sms/send', {
      to:      phone,
      from:    process.env.TERMII_SENDER_ID || 'WinALott',
      sms:     `WinALot: Your ticket ${ticket.ticket_number} is confirmed. Good luck!`,
      type:    'plain',
      channel: 'generic',
    });
  },

  // Alias kept for backward compat
  sendTicketConfirmationSMS: (phone, ticketNumber) => {
    if (!phone) return Promise.resolve({});
    return termiiPost('/sms/send', {
      to:      phone,
      from:    process.env.TERMII_SENDER_ID || 'WinALott',
      sms:     `WinALot: Your ticket ${ticketNumber} is confirmed. Good luck! Visit winalott.com`,
      type:    'plain',
      channel: 'generic',
    });
  },

  // Broadcast notification — called as: smsService.sendNotification(phone, message)
  sendNotification: (phone, message) => {
    if (!phone) return Promise.resolve({});
    return termiiPost('/sms/send', {
      to:      phone,
      from:    process.env.TERMII_SENDER_ID || 'WinALott',
      sms:     message,
      type:    'plain',
      channel: 'generic',
    });
  },
};

module.exports = { smsService };
