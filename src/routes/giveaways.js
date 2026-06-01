const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { query, queryOne, execute, transaction, IS_DB_CONFIGURED } = require('../lib/db');
const { adminMiddleware, auditLog } = require('../middleware/admin');
const { authMiddleware }            = require('../middleware/auth');
const { emailService }              = require('../services/email');
const { smsService }                = require('../services/sms');

// ── Helpers ──────────────────────────────────────────────────────────────────

function genServerSeed() {
  const seed = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return { serverSeed: seed, serverSeedHash: hash };
}

function shufflePool(pool, serverSeed, clientSeed) {
  const hmac = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
  return [...pool].sort((a, b) => {
    const ai = pool.indexOf(a);
    const bi = pool.indexOf(b);
    const aScore = parseInt(hmac.slice((ai * 2) % 56, (ai * 2) % 56 + 8), 16);
    const bScore = parseInt(hmac.slice((bi * 2) % 56, (bi * 2) % 56 + 8), 16);
    return aScore - bScore;
  });
}

const MOCK_GIVEAWAYS = [
  {
    id: 'g1', title: 'Arsenal vs Chelsea — WAL Giveaway',
    prize_type: 'walp', prize_walp_each: 500000, prize_description: null,
    winner_count: 10, seconds_per_question: 30, total_questions: 5,
    status: 'open', opens_at: '2026-05-25T10:00:00Z', closes_at: '2026-05-28T20:00:00Z',
    total_entries: 142, correct_pool_size: 37, created_at: '2026-05-24T09:00:00Z',
  },
  {
    id: 'g2', title: 'Man City vs Liverpool — Weekly Quiz',
    prize_type: 'physical', prize_walp_each: null, prize_description: 'Official Match Ball + Jersey',
    winner_count: 3, seconds_per_question: 30, total_questions: 4,
    status: 'closed', opens_at: '2026-05-20T08:00:00Z', closes_at: '2026-05-26T18:00:00Z',
    total_entries: 89, correct_pool_size: 21, created_at: '2026-05-19T12:00:00Z',
  },
  {
    id: 'g3', title: 'Real Madrid vs Barcelona — El Clasico Special',
    prize_type: 'walp', prize_walp_each: 2000000, prize_description: null,
    winner_count: 5, seconds_per_question: 30, total_questions: 6,
    status: 'settled', opens_at: '2026-05-10T10:00:00Z', closes_at: '2026-05-15T22:00:00Z',
    total_entries: 310, correct_pool_size: 68, created_at: '2026-05-08T15:00:00Z',
  },
];

const MOCK_QUESTIONS = {
  g1: [
    { id: 'q1', question_order: 1, question_text: 'How many corners will Arsenal win in the first half?', option_a: 'Under 3', option_b: '3 to 5', option_c: 'Over 5', option_d: 'Exactly 3', correct_option: 'b', time_limit_seconds: 30 },
    { id: 'q2', question_order: 2, question_text: 'Who will score the first goal?', option_a: 'Saka', option_b: 'Havertz', option_c: 'Palmer', option_d: 'No goal in first 20 mins', correct_option: 'a', time_limit_seconds: 30 },
    { id: 'q3', question_order: 3, question_text: 'What will the half-time score be?', option_a: '0-0', option_b: '1-0 Arsenal', option_c: '1-1', option_d: '2-0 Arsenal', correct_option: 'b', time_limit_seconds: 30 },
    { id: 'q4', question_order: 4, question_text: 'Total yellow cards in the match?', option_a: '0 to 1', option_b: '2 to 3', option_c: '4 to 5', option_d: '6 or more', correct_option: 'b', time_limit_seconds: 30 },
    { id: 'q5', question_order: 5, question_text: 'Match winner?', option_a: 'Arsenal', option_b: 'Chelsea', option_c: 'Draw', option_d: 'Extra time needed', correct_option: 'a', time_limit_seconds: 30 },
  ],
  g2: [
    { id: 'q6', question_order: 1, question_text: 'Total goals in the match?', option_a: '0 to 1', option_b: '2 to 3', option_c: '4 to 5', option_d: '6 or more', correct_option: 'b', time_limit_seconds: 30 },
    { id: 'q7', question_order: 2, question_text: 'Will there be a penalty?', option_a: 'Yes, scored', option_b: 'Yes, missed', option_c: 'No', option_d: 'Two or more penalties', correct_option: 'c', time_limit_seconds: 30 },
    { id: 'q8', question_order: 3, question_text: 'How many shots on target will Man City have?', option_a: '1 to 3', option_b: '4 to 6', option_c: '7 to 9', option_d: '10 or more', correct_option: 'b', time_limit_seconds: 30 },
    { id: 'q9', question_order: 4, question_text: 'Match result?', option_a: 'Man City win', option_b: 'Liverpool win', option_c: 'Draw', option_d: 'Decided by VAR', correct_option: 'a', time_limit_seconds: 30 },
  ],
};

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/giveaways  — public list
router.get('/', async (req, res) => {
  const { status, limit = 20, offset = 0 } = req.query;

  if (!IS_DB_CONFIGURED) {
    let rows = [...MOCK_GIVEAWAYS];
    if (status) rows = rows.filter(g => g.status === status);
    return res.json({ success: true, data: { giveaways: rows.slice(Number(offset), Number(offset) + Number(limit)), total: rows.length } });
  }

  try {
    let sql    = 'SELECT * FROM btwin_giveaways WHERE 1=1';
    let params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY opens_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));

    const giveaways = await query(sql, params);
    const [{ cnt }] = await query('SELECT COUNT(*) AS cnt FROM btwin_giveaways' + (status ? ' WHERE status = ?' : ''), status ? [status] : []);

    return res.json({ success: true, data: { giveaways, total: cnt } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/giveaways/:id  — detail with questions (correct_option omitted for active giveaways)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const isAdmin = req.headers.authorization?.length > 10; // rough check; middleware enforces this for settle

  if (!IS_DB_CONFIGURED) {
    const giveaway = MOCK_GIVEAWAYS.find(g => g.id === id);
    if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });
    let questions = (MOCK_QUESTIONS[id] || []).map(q => {
      const out = { ...q };
      if (!isAdmin && giveaway.status === 'open') delete out.correct_option;
      return out;
    });
    return res.json({ success: true, data: { giveaway, questions } });
  }

  try {
    const giveaway = await queryOne('SELECT * FROM btwin_giveaways WHERE id = ?', [id]);
    if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });

    const questions = await query(
      'SELECT id, question_order, question_text, option_a, option_b, option_c, option_d, time_limit_seconds' +
      (isAdmin ? ', correct_option' : '') +
      ' FROM btwin_giveaway_questions WHERE giveaway_id = ? ORDER BY question_order ASC',
      [id]
    );

    return res.json({ success: true, data: { giveaway, questions } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/giveaways  — create (admin only)
router.post('/', adminMiddleware, async (req, res) => {
  const {
    title, description, match_id, prize_type, prize_walp_each, prize_description,
    winner_count, seconds_per_question, opens_at, closes_at, status = 'draft', questions = [],
  } = req.body;

  if (!title?.trim())   return res.status(400).json({ success: false, error: 'title is required' });
  if (!winner_count)    return res.status(400).json({ success: false, error: 'winner_count is required' });
  if (!opens_at)        return res.status(400).json({ success: false, error: 'opens_at is required' });
  if (!closes_at)       return res.status(400).json({ success: false, error: 'closes_at is required' });
  if (!questions.length) return res.status(400).json({ success: false, error: 'At least one question is required' });

  if (!IS_DB_CONFIGURED) {
    return res.status(201).json({
      success: true,
      data: { id: `mock-giveaway-${Date.now()}` },
      message: 'Giveaway created (mock)',
    });
  }

  try {
    const giveawayId = await transaction(async (conn) => {
      const [gRes] = await conn.execute(
        `INSERT INTO btwin_giveaways
          (id, title, description, match_id, prize_type, prize_walp_each, prize_description,
           winner_count, seconds_per_question, total_questions, status, opens_at, closes_at, created_by, created_at)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          title.trim(), description || null, match_id || null, prize_type || 'walp',
          prize_walp_each ? Math.round(prize_walp_each * 100) : null,
          prize_description || null, parseInt(winner_count), parseInt(seconds_per_question || 30),
          questions.length, status, opens_at, closes_at, req.user.id,
        ]
      );

      const [{ gid }] = await conn.query('SELECT LAST_INSERT_ID() AS gid');
      // Retrieve UUID for the inserted row
      const [{ id: newId }] = await conn.query(
        'SELECT id FROM btwin_giveaways WHERE created_by = ? ORDER BY created_at DESC LIMIT 1',
        [req.user.id]
      );

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await conn.execute(
          `INSERT INTO btwin_giveaway_questions
            (id, giveaway_id, question_text, option_a, option_b, option_c, option_d,
             correct_option, time_limit_seconds, question_order)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [newId, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
           q.correct_option, parseInt(q.time_limit_seconds || seconds_per_question || 30), i + 1]
        );
      }

      return newId;
    });

    auditLog(req.user.id, 'CREATE_GIVEAWAY', giveawayId);
    return res.status(201).json({ success: true, data: { id: giveawayId }, message: 'Giveaway created' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/giveaways/:id  — update (admin only)
router.patch('/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { status, title, closes_at, winner_count, prize_walp_each, prize_description } = req.body;

  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, message: 'Giveaway updated (mock)' });
  }

  try {
    const fields = [];
    const params = [];
    if (status)           { fields.push('status = ?');            params.push(status); }
    if (title)            { fields.push('title = ?');             params.push(title); }
    if (closes_at)        { fields.push('closes_at = ?');         params.push(closes_at); }
    if (winner_count)     { fields.push('winner_count = ?');      params.push(parseInt(winner_count)); }
    if (prize_walp_each != null) { fields.push('prize_walp_each = ?'); params.push(Math.round(prize_walp_each * 100)); }
    if (prize_description) { fields.push('prize_description = ?'); params.push(prize_description); }

    if (!fields.length) return res.status(400).json({ success: false, error: 'No fields to update' });

    params.push(id);
    await execute(`UPDATE btwin_giveaways SET ${fields.join(', ')} WHERE id = ?`, params);
    auditLog(req.user.id, 'UPDATE_GIVEAWAY', id);
    return res.json({ success: true, message: 'Giveaway updated' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/giveaways/:id  — delete (admin only)
router.delete('/:id', adminMiddleware, async (req, res) => {
  const { id } = req.params;

  if (!IS_DB_CONFIGURED) {
    return res.json({ success: true, message: 'Giveaway deleted (mock)' });
  }

  try {
    const g = await queryOne('SELECT status FROM btwin_giveaways WHERE id = ?', [id]);
    if (!g) return res.status(404).json({ success: false, error: 'Giveaway not found' });
    if (g.status === 'settled') return res.status(400).json({ success: false, error: 'Cannot delete a settled giveaway' });

    await execute('DELETE FROM btwin_giveaways WHERE id = ?', [id]);
    auditLog(req.user.id, 'DELETE_GIVEAWAY', id);
    return res.json({ success: true, message: 'Giveaway deleted' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/giveaways/:id/entry  — submit quiz answers (authenticated user)
router.post('/:id/entry', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { answers, time_taken_seconds } = req.body;
  // answers = { questionId: 'a'|'b'|'c'|'d', ... }

  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ success: false, error: 'answers object is required' });
  }

  if (!IS_DB_CONFIGURED) {
    const giveaway  = MOCK_GIVEAWAYS.find(g => g.id === id);
    if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });
    if (giveaway.status !== 'open') return res.status(400).json({ success: false, error: 'Giveaway is not open for entries' });

    const questions = MOCK_QUESTIONS[id] || [];
    const total     = questions.length;
    const correct   = questions.filter(q => answers[q.id] === q.correct_option).length;
    const allCorrect = correct === total;

    return res.status(201).json({
      success: true,
      data: { total, correct, all_correct: allCorrect, entered_pool: allCorrect },
      message: allCorrect ? 'All correct! You have entered the draw pool.' : `${correct}/${total} correct — must answer all correctly to enter pool`,
    });
  }

  try {
    const giveaway = await queryOne('SELECT * FROM btwin_giveaways WHERE id = ?', [id]);
    if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });
    if (giveaway.status !== 'open') return res.status(400).json({ success: false, error: 'Giveaway is not open for entries' });

    // Check duplicate entry
    const existing = await queryOne(
      'SELECT id FROM btwin_giveaway_entries WHERE giveaway_id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (existing) return res.status(409).json({ success: false, error: 'You have already entered this giveaway' });

    const questions  = await query('SELECT id, correct_option FROM btwin_giveaway_questions WHERE giveaway_id = ?', [id]);
    const total      = questions.length;
    const correct    = questions.filter(q => answers[q.id] === q.correct_option).length;
    const allCorrect = correct === total;

    await transaction(async (conn) => {
      await conn.execute(
        `INSERT INTO btwin_giveaway_entries
          (id, giveaway_id, user_id, total_questions, correct_answers, all_correct, answers, time_taken_seconds)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.id, total, correct, allCorrect ? 1 : 0, JSON.stringify(answers), time_taken_seconds || null]
      );

      await conn.execute(
        'UPDATE btwin_giveaways SET total_entries = total_entries + 1' +
        (allCorrect ? ', correct_pool_size = correct_pool_size + 1' : '') +
        ' WHERE id = ?',
        [id]
      );
    });

    return res.status(201).json({
      success: true,
      data: { total, correct, all_correct: allCorrect, entered_pool: allCorrect },
      message: allCorrect
        ? 'All correct! You have entered the draw pool.'
        : `${correct}/${total} correct — must answer all correctly to enter pool`,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, error: 'You have already entered this giveaway' });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/giveaways/:id/settle  — run randomizer and credit prizes (admin only)
router.post('/:id/settle', adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { client_seed } = req.body;

  if (!client_seed) return res.status(400).json({ success: false, error: 'client_seed is required' });

  if (!IS_DB_CONFIGURED) {
    return res.json({
      success: true,
      data: {
        winners: [{ username: 'mock_winner', prize_walp_each: 500000 }],
        winner_count: 1,
        draw_id: `mock-draw-${Date.now()}`,
      },
      message: 'Giveaway settled (mock)',
    });
  }

  try {
    const giveaway = await queryOne('SELECT * FROM btwin_giveaways WHERE id = ?', [id]);
    if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });
    if (giveaway.status !== 'closed') return res.status(400).json({ success: false, error: 'Giveaway must be in "closed" status to settle' });

    const correctPool = await query(
      `SELECT e.id AS entry_id, e.user_id, u.username, u.full_name, u.email, u.phone, u.wallet_balance
       FROM btwin_giveaway_entries e
       JOIN users u ON u.id = e.user_id
       WHERE e.giveaway_id = ? AND e.all_correct = 1 AND e.is_winner = 0`,
      [id]
    );

    if (!correctPool.length) {
      await execute('UPDATE btwin_giveaways SET status = "settled" WHERE id = ?', [id]);
      return res.json({ success: true, data: { winners: [], winner_count: 0 }, message: 'No correct entries — giveaway settled with no winners' });
    }

    const maxWinners = giveaway.winner_count;
    const { serverSeed, serverSeedHash } = genServerSeed();
    const shuffled = shufflePool(correctPool, serverSeed, client_seed);
    const selected = shuffled.slice(0, maxWinners);

    const winnerEntryIds = selected.map(e => e.entry_id);
    const prizeEach      = giveaway.prize_walp_each || 0;
    const winners        = [];

    await transaction(async (conn) => {
      for (const entry of selected) {
        // Mark entry as winner
        await conn.execute('UPDATE btwin_giveaway_entries SET is_winner = 1, prize_awarded_walp = ?, prize_paid_out = 1 WHERE id = ?', [prizeEach, entry.entry_id]);

        if (giveaway.prize_type === 'walp' && prizeEach > 0) {
          // Credit wallet
          await conn.execute('UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?', [prizeEach, entry.user_id]);
          // Log transaction
          await conn.execute(
            `INSERT INTO transactions (id, user_id, type, amount, reference, status, metadata)
             VALUES (UUID(), ?, 'prize_payout', ?, ?, 'successful', ?)`,
            [entry.user_id, prizeEach, `WAL-GIVEAWAY-${id.slice(-6).toUpperCase()}`, JSON.stringify({ giveaway_id: id })]
          );
        }

        // In-app notification
        const notifMsg = giveaway.prize_type === 'walp'
          ? `You won ${(prizeEach / 100).toFixed(2)} WALP from the "${giveaway.title}" giveaway!`
          : `You won "${giveaway.prize_description}" from the "${giveaway.title}" giveaway!`;
        await conn.execute(
          'INSERT INTO notifications (id, user_id, title, message, type, is_read, created_at) VALUES (UUID(), ?, "You Won a Giveaway!", ?, "prize", 0, NOW())',
          [entry.user_id, notifMsg]
        );

        winners.push({ user_id: entry.user_id, username: entry.username, entry_id: entry.entry_id, prize_walp_each: prizeEach });
      }

      // Store draw record
      await conn.execute(
        `INSERT INTO btwin_giveaway_draws
          (id, giveaway_id, server_seed, server_seed_hash, client_seed, winner_entry_ids, winner_count, methodology, drawn_at)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'hmac_sha256', NOW())`,
        [id, serverSeed, serverSeedHash, client_seed, JSON.stringify(winnerEntryIds), selected.length]
      );

      await conn.execute('UPDATE btwin_giveaways SET status = "settled" WHERE id = ?', [id]);
    });

    // Non-blocking notifications
    for (const entry of selected) {
      const msg = giveaway.prize_type === 'walp'
        ? `You won ${(prizeEach / 100).toFixed(2)} WALP!`
        : `You won ${giveaway.prize_description}!`;
      emailService.sendWinnerEmail({ email: entry.email, username: entry.username }, giveaway.title, prizeEach).catch(() => {});
      if (entry.phone) smsService.sendWinnerSMS(entry.phone, giveaway.title, prizeEach).catch(() => {});
    }

    auditLog(req.user.id, 'SETTLE_GIVEAWAY', id, { winner_count: selected.length, prize_each: prizeEach });

    return res.json({
      success: true,
      data: {
        winners,
        winner_count: selected.length,
        server_seed:  serverSeed,
        client_seed,
        server_seed_hash: serverSeedHash,
        verification: 'HMAC-SHA256 provably fair draw',
      },
      message: `Giveaway settled — ${selected.length} winner(s) selected and credited`,
    });
  } catch (err) {
    console.error('[giveaways/settle]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/giveaways/:id/winners  — public results after settlement
router.get('/:id/winners', async (req, res) => {
  const { id } = req.params;

  if (!IS_DB_CONFIGURED) {
    return res.json({
      success: true,
      data: {
        giveaway: MOCK_GIVEAWAYS.find(g => g.id === id) || null,
        winners: [{ username: 'mock_winner', full_name: 'Mock User', prize_walp_each: 500000 }],
      },
    });
  }

  try {
    const giveaway = await queryOne('SELECT id, title, prize_type, prize_walp_each, prize_description, status FROM btwin_giveaways WHERE id = ?', [id]);
    if (!giveaway) return res.status(404).json({ success: false, error: 'Giveaway not found' });
    if (giveaway.status !== 'settled') return res.status(400).json({ success: false, error: 'Giveaway has not been settled yet' });

    const winners = await query(
      `SELECT u.username, u.full_name, e.prize_awarded_walp
       FROM btwin_giveaway_entries e
       JOIN users u ON u.id = e.user_id
       WHERE e.giveaway_id = ? AND e.is_winner = 1`,
      [id]
    );

    return res.json({ success: true, data: { giveaway, winners } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
