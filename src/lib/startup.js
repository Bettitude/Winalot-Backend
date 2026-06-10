const { supabaseAdmin } = require('./supabase');
const { getRedis }      = require('./redis');

const LINE = '─'.repeat(52);

async function checkSupabase() {
  const url = process.env.SUPABASE_URL || '';
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url || url.includes('your-') || !key || key.includes('your-')) {
    return { ok: false, reason: 'env vars not set' };
  }

  try {
    // Lightweight count query — no rows fetched, just verifies DB is reachable
    const { error } = await supabaseAdmin
      .from('btwin_users')
      .select('id', { count: 'exact', head: true });

    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function checkRedis() {
  const r = getRedis();
  if (!r) return { ok: false, reason: 'env vars not set' };
  try {
    await r.ping();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function badge(ok) { return ok ? '✓' : '✗'; }
function label(ok) { return ok ? 'CONNECTED' : 'NOT CONNECTED'; }

/**
 * Run all service connection checks and print a startup summary.
 * Returns an object with each service status (used by /health endpoint).
 */
async function runStartupChecks() {
  console.log(`\n${LINE}`);
  console.log('  bWinALOTT — Service Connection Check');
  console.log(LINE);

  const [supabase, redis] = await Promise.all([checkSupabase(), checkRedis()]);

  const sb = supabase.ok;
  const rd = redis.ok;

  console.log(`  ${badge(sb)} Supabase   ${label(sb)}${!sb ? `  (${supabase.reason})` : ''}`);
  console.log(`  ${badge(rd)} Redis      ${label(rd)}${!rd ? `  (${redis.reason})` : ''}`);

  if (!sb) {
    console.log(`\n  ⚠  Supabase is NOT connected.`);
    console.log(`     Auth, users, tickets, draws will NOT work.`);
    console.log(`     Fix: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env`);
  }

  if (!rd) {
    console.log(`\n  ⚠  Redis is NOT connected.`);
    console.log(`     Auth will still work but user-status caching is disabled.`);
    console.log(`     Fix: set UPSTASH_REDIS_URL and UPSTASH_REDIS_TOKEN in .env`);
  }

  if (sb && rd) {
    console.log(`\n  All services connected. Ready to serve traffic.`);
  }

  console.log(`${LINE}\n`);

  return {
    supabase: sb,
    redis:    rd,
    details: {
      supabase: supabase.reason || 'ok',
      redis:    redis.reason    || 'ok',
    },
  };
}

// Store results for the /health endpoint (updated each check)
let _lastStatus = { supabase: false, redis: false, details: {}, checkedAt: null };

async function runAndStore() {
  const result = await runStartupChecks();
  _lastStatus = { ...result, checkedAt: new Date().toISOString() };
  return _lastStatus;
}

function getLastStatus() { return _lastStatus; }

module.exports = { runAndStore, getLastStatus };
