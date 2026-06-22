const express = require('express');
const router  = express.Router();
const { emailService } = require('../services/email');

// One env var per category — add a new NOTIFY_EMAIL_<CATEGORY> to route a new
// enquiry type to its own inbox. Falls back to NOTIFY_EMAIL_DEFAULT if unset.
const NOTIFY_EMAILS = {
  contact:     process.env.NOTIFY_EMAIL_CONTACT     || process.env.NOTIFY_EMAIL_DEFAULT,
  partnership: process.env.NOTIFY_EMAIL_PARTNERSHIP || process.env.NOTIFY_EMAIL_DEFAULT,
  advertising: process.env.NOTIFY_EMAIL_ADVERTISING || process.env.NOTIFY_EMAIL_DEFAULT,
};

// ── POST /api/enquiries  (public — Contact Us + Partner With Us forms) ────────
router.post('/', async (req, res) => {
  const { category, name, company, email, subject, type, message } = req.body || {};

  const cat = (category || 'contact').toLowerCase();
  const notifyEmail = NOTIFY_EMAILS[cat] || process.env.NOTIFY_EMAIL_DEFAULT;

  if (!name?.trim())                         return res.status(400).json({ success: false, error: 'Name is required' });
  if (!email || !/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ success: false, error: 'Valid email is required' });
  if (!message?.trim())                      return res.status(400).json({ success: false, error: 'Message is required' });
  if (!notifyEmail)                          return res.status(500).json({ success: false, error: 'Enquiry routing is not configured' });

  try {
    await emailService.sendEnquiry({
      category: cat,
      name:     name.trim(),
      company:  company?.trim() || '',
      email:    email.trim(),
      subject:  (subject || type || '').trim(),
      message:  message.trim(),
      notifyEmail,
    });
  } catch (err) {
    console.warn('[enquiries] email send failed:', err.message);
  }

  // Always succeed for the user — emails are fire-and-forget
  res.json({ success: true });
});

module.exports = router;
