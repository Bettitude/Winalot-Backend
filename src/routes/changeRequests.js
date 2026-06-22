const express = require('express');
const router  = express.Router();
const { adminMiddleware } = require('../middleware/admin');
const { supabaseAdmin }   = require('../lib/supabase');
const { applyChangeRequest, IS_DB } = require('../services/changeRequests');

// GET /api/admin/requests?status=pending  (any admin can view)
router.get('/', adminMiddleware, async (req, res) => {
  if (!IS_DB) return res.json({ success: true, data: [] });
  try {
    let q = supabaseAdmin.from('btwin_change_requests').select('*').order('created_at', { ascending: false });
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q.limit(100);
    if (error) throw error;

    const userIds = [...new Set((data || []).flatMap(r => [r.requested_by, r.reviewed_by]).filter(Boolean))];
    const { data: users } = userIds.length
      ? await supabaseAdmin.from('btwin_users').select('id, username').in('id', userIds)
      : { data: [] };
    const userMap = Object.fromEntries((users || []).map(u => [u.id, u.username]));

    const result = (data || []).map(r => ({
      ...r,
      requested_by_username: userMap[r.requested_by] || null,
      reviewed_by_username:  userMap[r.reviewed_by]  || null,
    }));
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/requests/:id/approve  (super admin only)
router.post('/:id/approve', adminMiddleware, async (req, res) => {
  if (!req.user?.is_super_admin) return res.status(403).json({ success: false, error: 'Super admin access required' });
  try {
    const { data: reqRow, error: findErr } = await supabaseAdmin
      .from('btwin_change_requests').select('*').eq('id', req.params.id).single();
    if (findErr || !reqRow) return res.status(404).json({ success: false, error: 'Request not found' });
    if (reqRow.status !== 'pending') return res.status(400).json({ success: false, error: `Request already ${reqRow.status}` });

    await applyChangeRequest(reqRow);

    const { error: updErr } = await supabaseAdmin.from('btwin_change_requests').update({
      status: 'approved', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    if (updErr) throw updErr;

    return res.json({ success: true, message: 'Approved and applied' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/requests/:id/reject  (super admin only)
router.post('/:id/reject', adminMiddleware, async (req, res) => {
  if (!req.user?.is_super_admin) return res.status(403).json({ success: false, error: 'Super admin access required' });
  try {
    const { error } = await supabaseAdmin.from('btwin_change_requests').update({
      status: 'rejected', reviewed_by: req.user.id, reviewed_at: new Date().toISOString(),
    }).eq('id', req.params.id).eq('status', 'pending');
    if (error) throw error;
    return res.json({ success: true, message: 'Rejected' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
