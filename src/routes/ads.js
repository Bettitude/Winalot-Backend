const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { adminMiddleware } = require('../middleware/admin');
const { supabaseAdmin }   = require('../lib/supabase');
const { cacheMiddleware } = require('../middleware/cache');

const IS_DB = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

// In-memory store (mock mode)
const mockAds = new Map([
  ['demo-1', {
    id: 'demo-1', slot: 'leaderboard', title: 'Sample Leaderboard Ad',
    image_url: 'https://placehold.co/728x90/1A4D8F/F5C518?text=Your+Ad+Here',
    link_url: '#', bg_color: '', is_active: false,
    created_at: new Date().toISOString(),
  }],
  ['demo-2', {
    id: 'demo-2', slot: 'sidebar_right', title: 'Sample Sidebar Ad',
    image_url: 'https://placehold.co/300x250/0D2B5E/F5C518?text=Advertise+Here',
    link_url: '#', bg_color: '', is_active: false,
    created_at: new Date().toISOString(),
  }],
]);

// ── GET /api/ads?slot=xxx  (public — frontend fetches this) ───────────────────
router.get('/', cacheMiddleware(60), async (req, res) => {
  const { slot } = req.query;
  try {
    if (IS_DB) {
      let q = supabaseAdmin
        .from('btwin_ads')
        .select('id, slot, title, image_url, link_url, bg_color, is_active, created_at')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (slot) q = q.eq('slot', slot);
      const { data, error } = await q.limit(slot ? 1 : 50);
      if (error) throw error;
      return res.json({ success: true, data: slot ? (data?.[0] || null) : (data || []) });
    }

    // Mock mode
    const all = [...mockAds.values()].filter(a => a.is_active);
    if (slot) {
      const ad = all.find(a => a.slot === slot) || null;
      return res.json({ success: true, data: ad });
    }
    return res.json({ success: true, data: all });
  } catch (err) {
    console.error('[ads/get]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/ads/all  (admin — all ads, active or not) ───────────────────────
router.get('/all', adminMiddleware, async (req, res) => {
  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_ads')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ success: true, data: data || [] });
    }
    return res.json({ success: true, data: [...mockAds.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
  } catch (err) {
    console.error('[ads/all]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/ads  (admin — create) ──────────────────────────────────────────
router.post('/', adminMiddleware, async (req, res) => {
  const { slot, title, image_url, link_url, bg_color = '', is_active = true } = req.body;
  if (!slot || !title || !image_url) {
    return res.status(400).json({ success: false, error: 'slot, title, and image_url are required' });
  }
  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_ads')
        .insert({ slot, title, image_url, link_url: link_url || '', bg_color, is_active })
        .select().single();
      if (error) throw error;
      return res.status(201).json({ success: true, data });
    }
    const id  = crypto.randomUUID();
    const ad  = { id, slot, title, image_url, link_url: link_url || '', bg_color, is_active, created_at: new Date().toISOString() };
    mockAds.set(id, ad);
    return res.status(201).json({ success: true, data: ad });
  } catch (err) {
    console.error('[ads/create]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── PATCH /api/ads/:id  (admin — update) ─────────────────────────────────────
router.patch('/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { slot, title, image_url, link_url, bg_color, is_active } = req.body;
  const updates = {};
  if (slot       !== undefined) updates.slot       = slot;
  if (title      !== undefined) updates.title      = title;
  if (image_url  !== undefined) updates.image_url  = image_url;
  if (link_url   !== undefined) updates.link_url   = link_url;
  if (bg_color   !== undefined) updates.bg_color   = bg_color;
  if (is_active  !== undefined) updates.is_active  = is_active;

  try {
    if (IS_DB) {
      const { data, error } = await supabaseAdmin
        .from('btwin_ads').update(updates).eq('id', id).select().single();
      if (error) throw error;
      return res.json({ success: true, data });
    }
    const existing = mockAds.get(id);
    if (!existing) return res.status(404).json({ success: false, error: 'Ad not found' });
    const updated = { ...existing, ...updates };
    mockAds.set(id, updated);
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[ads/update]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/ads/:id  (admin) ──────────────────────────────────────────────
router.delete('/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    if (IS_DB) {
      const { error } = await supabaseAdmin.from('btwin_ads').delete().eq('id', id);
      if (error) throw error;
      return res.json({ success: true });
    }
    if (!mockAds.has(id)) return res.status(404).json({ success: false, error: 'Ad not found' });
    mockAds.delete(id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[ads/delete]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
