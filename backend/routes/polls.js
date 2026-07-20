const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Ленивая миграция таблиц опросов (автораннера миграций нет)
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS polls (
      id         TEXT PRIMARY KEY,
      owner_uid  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      owner_name TEXT DEFAULT '',
      question   TEXT NOT NULL,
      options    TEXT NOT NULL DEFAULT '[]',
      audience   TEXT DEFAULT 'all',
      status     TEXT DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS poll_votes (
      id           TEXT PRIMARY KEY,
      poll_id      TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL,
      voter_uid    TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_uid_uniq
                 ON poll_votes(poll_id, voter_uid) WHERE voter_uid IS NOT NULL`);
    schemaEnsured = true;
  } catch (e) {
    console.error('ensurePollsSchema error:', e.message);
  }
}

function tryParse(v, fb) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fb); } catch (e) { return fb; } }

async function countsFor(pollId, optionsLen) {
  const rows = await queryAll('SELECT option_index, COUNT(*)::int AS c FROM poll_votes WHERE poll_id=$1 GROUP BY option_index', [pollId]);
  const counts = new Array(optionsLen).fill(0);
  rows.forEach(r => { if (r.option_index >= 0 && r.option_index < optionsLen) counts[r.option_index] = r.c; });
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total };
}

// POST /polls — создать опрос (стартапер или админ)
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'startup' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Создавать опросы могут только стартаперы' });
    }
    await ensureSchema();
    const question = (req.body.question || '').trim();
    let options = Array.isArray(req.body.options) ? req.body.options.map(o => String(o || '').trim()).filter(Boolean) : [];
    options = options.slice(0, 4);
    const audience = req.body.audience === 'registered' ? 'registered' : 'all';
    if (!question) return res.status(400).json({ error: 'Введите вопрос' });
    if (options.length < 2) return res.status(400).json({ error: 'Нужно минимум 2 варианта ответа' });

    const id = uuidv4();
    const user = await queryOne('SELECT name FROM users WHERE uid=$1', [req.user.uid]);
    const poll = await queryOne(
      `INSERT INTO polls (id, owner_uid, owner_name, question, options, audience, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'open',NOW()) RETURNING *`,
      [id, req.user.uid, user ? user.name : '', question, JSON.stringify(options), audience]
    );
    res.status(201).json({ poll: { ...poll, options: tryParse(poll.options, []) } });
  } catch (e) {
    console.error('POST /polls:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /polls — мои опросы (или все — для админа с ?all=1)
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const all = req.query.all === '1' && req.user.role === 'admin';
    const rows = all
      ? await queryAll('SELECT * FROM polls ORDER BY created_at DESC')
      : await queryAll('SELECT * FROM polls WHERE owner_uid=$1 ORDER BY created_at DESC', [req.user.uid]);
    const polls = [];
    for (const p of rows) {
      const opts = tryParse(p.options, []);
      const { counts, total } = await countsFor(p.id, opts.length);
      polls.push({ ...p, options: opts, counts, total });
    }
    res.json({ polls });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /polls/:id — один опрос + результаты + мой голос
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    await ensureSchema();
    const p = await queryOne('SELECT * FROM polls WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Опрос не найден' });
    const opts = tryParse(p.options, []);
    const { counts, total } = await countsFor(p.id, opts.length);
    let myVote = -1;
    if (req.user) {
      const mine = await queryOne('SELECT option_index FROM poll_votes WHERE poll_id=$1 AND voter_uid=$2', [p.id, req.user.uid]);
      if (mine) myVote = mine.option_index;
    }
    const isOwnerOrAdmin = !!req.user && (req.user.uid === p.owner_uid || req.user.role === 'admin');
    res.json({ poll: { ...p, options: opts, counts, total, myVote, isOwnerOrAdmin } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /polls/:id/vote — проголосовать
router.post('/:id/vote', optionalAuth, async (req, res) => {
  try {
    await ensureSchema();
    const p = await queryOne('SELECT * FROM polls WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Опрос не найден' });
    if (p.status === 'closed') return res.status(400).json({ error: 'Опрос закрыт' });

    const opts = tryParse(p.options, []);
    const idx = parseInt(req.body.option, 10);
    if (isNaN(idx) || idx < 0 || idx >= opts.length) return res.status(400).json({ error: 'Неверный вариант' });

    if (p.audience === 'registered' && !req.user) {
      return res.status(401).json({ error: 'Голосовать могут только зарегистрированные пользователи' });
    }

    if (req.user) {
      const existing = await queryOne('SELECT id FROM poll_votes WHERE poll_id=$1 AND voter_uid=$2', [p.id, req.user.uid]);
      if (existing) return res.status(400).json({ error: 'Вы уже голосовали' });
      await queryOne('INSERT INTO poll_votes (id, poll_id, option_index, voter_uid, created_at) VALUES ($1,$2,$3,$4,NOW())',
        [uuidv4(), p.id, idx, req.user.uid]);
    } else {
      // Анонимный голос (audience='all')
      await queryOne('INSERT INTO poll_votes (id, poll_id, option_index, voter_uid, created_at) VALUES ($1,$2,$3,NULL,NOW())',
        [uuidv4(), p.id, idx]);
    }

    const { counts, total } = await countsFor(p.id, opts.length);
    res.json({ counts, total });
  } catch (e) {
    console.error('POST vote:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /polls/:id — закрыть/открыть (владелец или админ)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const p = await queryOne('SELECT owner_uid FROM polls WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Опрос не найден' });
    if (p.owner_uid !== req.user.uid && req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    const status = req.body.status === 'open' ? 'open' : 'closed';
    const updated = await queryOne('UPDATE polls SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    res.json({ poll: { ...updated, options: tryParse(updated.options, []) } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /polls/:id — удалить (владелец или админ)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const p = await queryOne('SELECT owner_uid FROM polls WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Опрос не найден' });
    if (p.owner_uid !== req.user.uid && req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    await queryOne('DELETE FROM polls WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
