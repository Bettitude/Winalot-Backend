const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL  || '';
const ANON_KEY      = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Only create real clients when credentials are present
const supabase = SUPABASE_URL && ANON_KEY
  ? createClient(SUPABASE_URL, ANON_KEY)
  : null;

const supabaseAdmin = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

module.exports = { supabase, supabaseAdmin };
