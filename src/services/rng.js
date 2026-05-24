const crypto = require('crypto');

/**
 * Simple draw — picks `count` random tickets from the correct pool
 */
function simpleRandomDraw(ticketIds, count) {
  if (ticketIds.length === 0) return [];
  const pool    = [...ticketIds];
  const winners = [];
  const n       = Math.min(count, pool.length);

  for (let i = 0; i < n; i++) {
    const idx = crypto.randomInt(0, pool.length);
    winners.push(pool[idx]);
    pool.splice(idx, 1);
  }

  return winners;
}

/**
 * Provably Fair draw
 * Returns: { serverSeedHash, draw(clientSeed) }
 * — publish serverSeedHash before the draw
 * — after draw, reveal serverSeed for verification
 */
function createProvablyFairDraw(ticketIds, count) {
  const serverSeed     = crypto.randomBytes(32).toString('hex');
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

  const draw = (clientSeed, nonce = 0) => {
    if (ticketIds.length === 0) return { winners: [], serverSeed, clientSeed, nonce };

    const pool    = [...ticketIds];
    const winners = [];
    const n       = Math.min(count, pool.length);

    for (let i = 0; i < n; i++) {
      // HMAC-SHA256(serverSeed, clientSeed:nonce:i)
      const combined = crypto
        .createHmac('sha256', serverSeed)
        .update(`${clientSeed}:${nonce}:${i}`)
        .digest('hex');

      // Convert first 8 hex chars to number, map into pool range
      const num = parseInt(combined.slice(0, 8), 16);
      const idx = num % pool.length;

      winners.push(pool[idx]);
      pool.splice(idx, 1);
    }

    return { winners, serverSeed, clientSeed, nonce };
  };

  return { serverSeedHash, serverSeed, draw };
}

/**
 * Verify a completed provably fair draw
 */
function verifyDraw({ serverSeed, serverSeedHash, clientSeed, nonce, ticketIds, count }) {
  const computedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  if (computedHash !== serverSeedHash) return { valid: false, reason: 'Server seed hash mismatch' };

  const { draw }   = { draw: createProvablyFairDraw(ticketIds, count).draw };
  const { winners } = draw(clientSeed, nonce);

  return { valid: true, winners };
}

/**
 * Generate unique ticket number: WAL-YYYYMMDD-XXXXX
 */
function generateTicketNumber(sequence) {
  const date = new Date();
  const y    = date.getFullYear();
  const m    = String(date.getMonth() + 1).padStart(2, '0');
  const d    = String(date.getDate()).padStart(2, '0');
  const seq  = String(sequence).padStart(5, '0');
  return `WAL-${y}${m}${d}-${seq}`;
}

module.exports = { simpleRandomDraw, createProvablyFairDraw, verifyDraw, generateTicketNumber };
