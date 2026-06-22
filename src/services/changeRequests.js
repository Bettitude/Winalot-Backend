const crypto = require('crypto');
const { supabaseAdmin } = require('../lib/supabase');

const IS_DB = !!(
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY &&
  !process.env.SUPABASE_URL.includes('your-')
);

async function createChangeRequest({ type, target_id, payload, summary, requested_by }) {
  if (!IS_DB) {
    return { id: `mock-${Date.now()}`, type, target_id, payload, summary, status: 'pending', created_at: new Date().toISOString() };
  }
  const { data, error } = await supabaseAdmin
    .from('btwin_change_requests')
    .insert({ type, target_id: target_id != null ? String(target_id) : null, payload, summary, requested_by })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Applies the proposed change once a super admin approves it.
async function applyChangeRequest(request) {
  if (!IS_DB) return;

  switch (request.type) {
    case 'market_price_change': {
      const { market_id, updates } = request.payload;
      const { error } = await supabaseAdmin.from('btwin_markets').update(updates).eq('id', market_id);
      if (error) throw error;
      return;
    }

    case 'btp_rate_change': {
      const rows = Object.entries(request.payload?.updates || {}).map(([key, value]) => ({
        key, value: JSON.stringify(value),
        updated_by: request.requested_by || null,
        updated_at: new Date().toISOString(),
      }));
      if (rows.length) {
        const { error } = await supabaseAdmin.from('btwin_settings').upsert(rows, { onConflict: 'key' });
        if (error) throw error;
      }
      return;
    }

    case 'late_game_creation': {
      const b   = request.payload;
      const key = String(b.fixture_id);

      const { data: existing } = await supabaseAdmin
        .from('btwin_wc_games').select('id').eq('fixture_id', key).maybeSingle();
      if (existing) throw new Error('A free game already exists for this fixture');

      const game = {
        id:                crypto.randomUUID(),
        fixture_id:        key,
        home_team:         b.home_team  || '',
        away_team:         b.away_team  || '',
        match_date:        b.match_date ? b.match_date.replace(' ', '+') : null,
        question:          b.question,
        options:           b.options,
        correct_option:    null,
        prize_type:        b.prize_type || 'cash',
        prize_usd:         b.prize_usd         ? Number(b.prize_usd)                  : null,
        prize_cents:       b.prize_usd         ? Math.round(Number(b.prize_usd) * 100) : null,
        prize_description: b.prize_description || null,
        winner_count:      Number(b.winner_count),
        status:            'open',
      };
      const { error } = await supabaseAdmin.from('btwin_wc_games').insert(game);
      if (error) throw error;
      return;
    }

    default:
      throw new Error(`Unknown change request type: ${request.type}`);
  }
}

module.exports = { createChangeRequest, applyChangeRequest, IS_DB };
