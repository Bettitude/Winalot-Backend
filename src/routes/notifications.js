const express = require('express');
const router  = express.Router();
const { query, queryOne, execute, IS_DB_CONFIGURED } = require('../lib/db');
const { authMiddleware }            = require('../middleware/auth');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { emailService }              = require('../services/email');
const { smsService }                = require('../services/sms');
const { supabaseAdmin }             = require('../lib/supabase');

const IS_SUPABASE = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

// GET /api/notifications
router.get('/', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { notifications: [], total: 0, unread: 0 } });

  const { read, page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    let where = 'WHERE user_id = ?';
    const params = [req.user.id];
    if (read !== undefined) { where += ' AND is_read = ?'; params.push(read === 'true' ? 1 : 0); }

    const [notifications, totals, unread] = await Promise.all([
      query(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]),
      query(`SELECT COUNT(*) AS total FROM notifications ${where}`, params),
      queryOne('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0', [req.user.id]),
    ]);

    return res.json({ success: true, data: { notifications, total: totals[0]?.total || 0, unread: unread?.n || 0 } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'Marked read (mock)' });

  try {
    await execute('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    return res.json({ success: true, message: 'Notification marked as read' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', authMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED) return res.json({ success: true, message: 'All marked read (mock)' });

  try {
    await execute('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    return res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/notifications/push  (admin — broadcast to users)
router.post('/push', adminMiddleware, async (req, res) => {
  const { title, message, target = 'all', user_ids, channels = ['in_app'] } = req.body;
  if (!title || !message) return res.status(400).json({ success: false, error: 'title and message required' });

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      let users = [];
      if (target === 'all') {
        const { data } = await supabaseAdmin.from('btwin_users').select('id, email, phone').eq('status', 'enabled');
        users = data || [];
      } else if (target === 'selected' && user_ids?.length) {
        const { data } = await supabaseAdmin.from('btwin_users').select('id, email, phone').in('id', user_ids);
        users = data || [];
      }

      if (users.length && channels.includes('in_app')) {
        const rows = users.map(u => ({ user_id: u.id, title, message, type: 'info', read: false }));
        await supabaseAdmin.from('btwin_notifications').insert(rows);
      }

      await supabaseAdmin.from('btwin_notification_history').insert({
        title, message, channels, target, recipient_count: users.length, sent_by: req.user.id,
      });

      if (channels.includes('email')) users.forEach(u => emailService.sendNotification?.(u, title, message)?.catch(() => {}));
      if (channels.includes('sms'))   users.forEach(u => u.phone && smsService.sendNotification?.(u.phone, `${title}: ${message}`)?.catch(() => {}));

      auditLog(req.user.id, 'PUSH_NOTIFICATION', null, null, { title, target, recipient_count: users.length });
      return res.json({ success: true, data: { recipient_count: users.length }, message: 'Notification sent' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { recipient_count: 0 }, message: 'Notification pushed (mock)' });

  try {
    let users = [];
    if (target === 'all') {
      users = await query('SELECT id, email, phone FROM users WHERE status = "enabled"');
    } else if (target === 'selected' && user_ids?.length) {
      users = await query(`SELECT id, email, phone FROM users WHERE id IN (${user_ids.map(() => '?').join(',')})`, user_ids);
    }

    // Batch insert in-app notifications
    if (users.length > 0 && channels.includes('in_app')) {
      const values = users.map(u => `(UUID(), '${u.id}', ${execute.escape?.(title) || `'${title.replace(/'/g,"''")}'`}, ${execute.escape?.(message) || `'${message.replace(/'/g,"''")}'`}, 'in_app', 0, NOW())`).join(',');
      // Use individual inserts to avoid escaping issues
      for (const u of users) {
        await execute('INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at) VALUES (UUID(), ?, ?, ?, "in_app", 0, NOW())', [u.id, title, message]);
      }
    }

    // Send email + SMS (non-blocking)
    if (channels.includes('email')) {
      users.forEach(u => emailService.sendNotification(u, title, message).catch(() => {}));
    }
    if (channels.includes('sms')) {
      users.forEach(u => u.phone && smsService.sendNotification(u.phone, `${title}: ${message}`).catch(() => {}));
    }

    // Log to notification history
    await execute(
      'INSERT INTO notification_history (id, title, message, channels, target, recipient_count, sent_by, created_at) VALUES (UUID(), ?, ?, ?, ?, ?, ?, NOW())',
      [title, message, JSON.stringify(channels), target, users.length, req.user.id]
    );

    auditLog(req.user.id, 'PUSH_NOTIFICATION', null, { title, target, recipient_count: users.length });
    return res.json({ success: true, data: { recipient_count: users.length }, message: 'Notification sent' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/history  (admin)
router.get('/history', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data } = await supabaseAdmin
        .from('btwin_notification_history')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      return res.json({ success: true, data: { history: data || [] } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { history: [] } });

  try {
    const history = await query('SELECT nh.*, u.username AS sent_by_username FROM notification_history nh LEFT JOIN users u ON u.id = nh.sent_by ORDER BY nh.created_at DESC LIMIT 50');
    return res.json({ success: true, data: { history } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/notifications/templates  (admin)
router.get('/templates', adminMiddleware, async (req, res) => {
  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data } = await supabaseAdmin
        .from('btwin_notification_templates')
        .select('*')
        .order('created_at', { ascending: false });
      return res.json({ success: true, data: { templates: data || [] } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  if (!IS_DB_CONFIGURED) return res.json({ success: true, data: { templates: [] } });

  try {
    const templates = await query('SELECT * FROM notification_templates ORDER BY created_at DESC');
    return res.json({ success: true, data: { templates } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/notifications/templates  (admin)
router.post('/templates', adminMiddleware, async (req, res) => {
  const { title, message, channels } = req.body;
  if (!title || !message) return res.status(400).json({ success: false, error: 'title and message required' });

  if (!IS_DB_CONFIGURED && IS_SUPABASE) {
    try {
      const { data, error } = await supabaseAdmin
        .from('btwin_notification_templates')
        .insert({ title, message, channels: channels || { in_app: true, email: false, sms: false }, created_by: req.user.id })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json({ success: true, data: { template: data } });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  if (!IS_DB_CONFIGURED) return res.status(201).json({ success: true, data: { template: { id: `mock-${Date.now()}`, title, message } } });

  try {
    await execute('INSERT INTO notification_templates (id, title, message, created_by) VALUES (UUID(), ?, ?, ?)', [title, message, req.user.id]);
    const template = await queryOne('SELECT * FROM notification_templates ORDER BY created_at DESC LIMIT 1');
    return res.status(201).json({ success: true, data: { template } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
