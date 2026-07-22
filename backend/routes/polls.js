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
      id           TEXT PRIMARY KEY,
      owner_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      owner_name   TEXT DEFAULT '',
      question     TEXT NOT NULL DEFAULT '',
      options      TEXT NOT NULL DEFAULT '[]',
      questions    TEXT NOT NULL DEFAULT '[]',
      audience     TEXT DEFAULT 'all',
      status       TEXT DEFAULT 'open',
      show_results BOOLEAN DEFAULT true,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS poll_votes (
      id             TEXT PRIMARY KEY,
      poll_id        TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      question_index INTEGER NOT NULL DEFAULT 0,
      option_index   INTEGER NOT NULL,
      voter_uid      TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )`);
    // На случай старой схемы (один вопрос)
    await query("ALTER TABLE polls ADD COLUMN IF NOT EXISTS questions TEXT NOT NULL DEFAULT '[]'");
    await query('ALTER TABLE polls ADD COLUMN IF NOT EXISTS show_results BOOLEAN DEFAULT true');
    await query('ALTER TABLE poll_votes ADD COLUMN IF NOT EXISTS question_index INTEGER NOT NULL DEFAULT 0');
    await query('DROP INDEX IF EXISTS poll_votes_uid_uniq');
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_q_uid_uniq
                 ON poll_votes(poll_id, question_index, voter_uid) WHERE voter_uid IS NOT NULL`);
    schemaEnsured = true;
  } catch (e) {
    console.error('ensurePollsSchema error:', e.message);
  }
}

function tryParse(v, fb) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fb); } catch (e) { return fb; } }

// Нормализованный список вопросов опроса (с обратной совместимостью со старым форматом)
function pollQuestions(p) {
  const qs = tryParse(p.questions, null);
  if (Array.isArray(qs) && qs.length) {
    return qs.map(q => ({
      question: String((q && q.question) || ''),
      desc: String((q && q.desc) || ''),
      options: (Array.isArray(q && q.options) ? q.options : []).map(o => String(o || '')),
    }));
  }
  // Старый формат: один вопрос
  return [{ question: p.question || '', desc: '', options: tryParse(p.options, []).map(String) }];
}

// Валидация входного массива вопросов
function cleanQuestions(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).map(q => ({
    question: String((q && q.question) || '').trim(),
    desc: String((q && q.desc) || '').trim().slice(0, 500),
    options: (Array.isArray(q && q.options) ? q.options : []).map(o => String(o || '').trim()).filter(Boolean).slice(0, 4),
  })).filter(q => q.question && q.options.length >= 2);
}

async function resultsFor(pollId, questions) {
  const rows = await queryAll(
    'SELECT question_index AS qi, option_index AS oi, COUNT(*)::int AS c FROM poll_votes WHERE poll_id=$1 GROUP BY question_index, option_index',
    [pollId]
  );
  return questions.map((q, qi) => {
    const counts = new Array(q.options.length).fill(0);
    rows.forEach(r => { if (r.qi === qi && r.oi >= 0 && r.oi < counts.length) counts[r.oi] = r.c; });
    const total = counts.reduce((a, b) => a + b, 0);
    return { counts, total };
  });
}

// POST /polls — создать опрос (стартапер или админ)
router.post('/', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'startup' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Создавать опросы могут только стартаперы' });
    }
    await ensureSchema();

    // Поддерживаем и новый формат (questions[]), и старый (question + options[])
    let questions = cleanQuestions(req.body.questions);
    if (!questions.length && (req.body.question || req.body.options)) {
      questions = cleanQuestions([{ question: req.body.question, options: req.body.options }]);
    }
    const audience = req.body.audience === 'registered' ? 'registered' : 'all';
    const showResults = !(req.body.show_results === false || req.body.showResults === false);
    if (!questions.length) return res.status(400).json({ error: 'Нужен хотя бы один вопрос с 2 вариантами' });

    const id = uuidv4();
    const user = await queryOne('SELECT name FROM users WHERE uid=$1', [req.user.uid]);
    const poll = await queryOne(
      `INSERT INTO polls (id, owner_uid, owner_name, question, options, questions, audience, status, show_results, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,NOW()) RETURNING *`,
      [id, req.user.uid, user ? user.name : '', questions[0].question, JSON.stringify(questions[0].options), JSON.stringify(questions), audience, showResults]
    );
    res.status(201).json({ poll: { ...poll, questions } });
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
      const questions = pollQuestions(p);
      const results = await resultsFor(p.id, questions);
      const total = results.reduce((a, r) => Math.max(a, r.total), 0); // максимум голосов среди вопросов
      polls.push({ ...p, questions, questionCount: questions.length, results, total });
    }
    res.json({ polls });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /polls/:id — один опрос + результаты + мои голоса
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    await ensureSchema();
    const p = await queryOne('SELECT * FROM polls WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Опрос не найден' });
    const questions = pollQuestions(p);
    let myVotes = questions.map(() => -1);
    let voted = false;
    if (req.user) {
      const votes = await queryAll('SELECT question_index AS qi, option_index AS oi FROM poll_votes WHERE poll_id=$1 AND voter_uid=$2', [p.id, req.user.uid]);
      voted = votes.length > 0;
      votes.forEach(v => { if (v.qi >= 0 && v.qi < myVotes.length) myVotes[v.qi] = v.oi; });
    }
    const isOwnerOrAdmin = !!req.user && (req.user.uid === p.owner_uid || req.user.role === 'admin');
    // Результаты видит автор/админ всегда; остальным — только если разрешено
    const showResults = p.show_results !== false;
    const canSeeResults = isOwnerOrAdmin || showResults;
    const results = canSeeResults ? await resultsFor(p.id, questions) : null;
    res.json({ poll: { ...p, questions, results, myVotes, voted, isOwnerOrAdmin, showResults, canSeeResults } });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /polls/:id/vote — проголосовать (votes: [{question, option}])
router.post('/:id/vote', optionalAuth, async (req, res) => {
  try {
    await ensureSchema();
    const p = await queryOne('SELECT * FROM polls WHERE id=$1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Опрос не найден' });
    if (p.status === 'closed') return res.status(400).json({ error: 'Опрос закрыт' });
    if (p.audience === 'registered' && !req.user) {
      return res.status(401).json({ error: 'Голосовать могут только зарегистрированные пользователи' });
    }

    const questions = pollQuestions(p);
    const votes = Array.isArray(req.body.votes) ? req.body.votes : [];
    if (!votes.length) return res.status(400).json({ error: 'Нет ответов' });

    if (req.user) {
      const existing = await queryOne('SELECT 1 FROM poll_votes WHERE poll_id=$1 AND voter_uid=$2 LIMIT 1', [p.id, req.user.uid]);
      if (existing) return res.status(400).json({ error: 'Вы уже голосовали' });
    }

    let inserted = 0;
    for (const v of votes) {
      const qi = parseInt(v.question, 10);
      const oi = parseInt(v.option, 10);
      if (isNaN(qi) || qi < 0 || qi >= questions.length) continue;
      if (isNaN(oi) || oi < 0 || oi >= questions[qi].options.length) continue;
      await queryOne(
        'INSERT INTO poll_votes (id, poll_id, question_index, option_index, voter_uid, created_at) VALUES ($1,$2,$3,$4,$5,NOW())',
        [uuidv4(), p.id, qi, oi, req.user ? req.user.uid : null]
      );
      inserted++;
    }
    if (!inserted) return res.status(400).json({ error: 'Неверные ответы' });

    // Возвращаем результаты только если автор разрешил их показывать (или это автор/админ)
    const isOwnerOrAdmin = !!req.user && (req.user.uid === p.owner_uid || req.user.role === 'admin');
    const canSeeResults = isOwnerOrAdmin || p.show_results !== false;
    const results = canSeeResults ? await resultsFor(p.id, questions) : null;
    res.json({ results, canSeeResults });
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
    res.json({ poll: { ...updated, questions: pollQuestions(updated) } });
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
