// Банк идей: буст-партнёры публикуют идеи, стартаперы забирают их себе
// и запускают на их основе стартапы.
// Идею забирает один стартапер (status: open → taken); он может вернуть её обратно.
// Автор получает личное сообщение, когда идею забрали.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkCensor } = require('../lib/censor');
const { sendDirectMessage } = require('../lib/dm');

const router = express.Router();

const canPublish = (user) => user && (user.role === 'boost_partner' || user.role === 'admin');
const canTake    = (user) => user && user.role === 'startup';
const isAdmin    = (user) => user && user.role === 'admin';

// Ленивая миграция (в проде нет автораннера)
let schemaEnsured = false;
async function ensureIdeasSchema() {
  if (schemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS ideas (
      id          TEXT PRIMARY KEY,
      author_uid  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category    TEXT DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','taken')),
      taken_by    TEXT REFERENCES users(uid) ON DELETE SET NULL,
      taken_at    TIMESTAMPTZ,
      startup_id  TEXT REFERENCES startups(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, created_at DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_author ON ideas(author_uid)');
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_taken  ON ideas(taken_by)');
    schemaEnsured = true;
  } catch (e) {
    console.error('ensureIdeasSchema error:', e.message);
  }
}

const SELECT_IDEAS = `
  SELECT i.*,
         a.name AS author_name, a.avatar AS author_avatar, a.role AS author_role,
         t.name AS taker_name,  t.avatar AS taker_avatar,
         s.name AS startup_name
  FROM ideas i
  LEFT JOIN users a    ON a.uid = i.author_uid
  LEFT JOIN users t    ON t.uid = i.taken_by
  LEFT JOIN startups s ON s.id  = i.startup_id`;

function shape(r) {
  return {
    id:           r.id,
    title:        r.title,
    description:  r.description,
    category:     r.category || '',
    status:       r.status,
    authorUid:    r.author_uid,
    authorName:   r.author_name || '',
    authorAvatar: r.author_avatar || '',
    authorRole:   r.author_role || '',
    takenBy:      r.taken_by,
    takerName:    r.taker_name || '',
    takerAvatar:  r.taker_avatar || '',
    takenAt:      r.taken_at,
    startupId:    r.startup_id,
    startupName:  r.startup_name || '',
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
  };
}

async function loadIdea(id) {
  return queryOne(`${SELECT_IDEAS} WHERE i.id = $1`, [id]);
}

function readFields(body) {
  return {
    title:       String(body.title || '').trim().slice(0, 120),
    description: String(body.description || '').trim().slice(0, 5000),
    category:    String(body.category || '').trim().slice(0, 60),
  };
}

// GET /ideas?status=open|taken&mine=1 — лента идей (только для авторизованных)
// mine=1: для буст-партнёра — его идеи, для стартапера — забранные им
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const params = [];
    let sql = `${SELECT_IDEAS} WHERE 1=1`;
    if (req.query.status === 'open' || req.query.status === 'taken') {
      params.push(req.query.status); sql += ` AND i.status = $${params.length}`;
    }
    if (req.query.mine) {
      params.push(req.user.uid);
      sql += ` AND (i.author_uid = $${params.length} OR i.taken_by = $${params.length})`;
    }
    if (req.query.category) {
      params.push(req.query.category); sql += ` AND i.category = $${params.length}`;
    }
    sql += ' ORDER BY i.created_at DESC LIMIT 300';
    const rows = await queryAll(sql, params);
    res.json({ ideas: rows.map(shape) });
  } catch (e) {
    console.error('GET /ideas error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /ideas/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const row = await loadIdea(req.params.id);
    if (!row) return res.status(404).json({ error: 'Идея не найдена' });
    res.json({ idea: shape(row) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas — опубликовать идею (буст-партнёр / админ)
router.post('/', requireAuth, async (req, res) => {
  try {
    if (!canPublish(req.user)) return res.status(403).json({ error: 'Публиковать идеи могут только буст-партнёры' });
    await ensureIdeasSchema();
    const f = readFields(req.body);
    if (!f.title) return res.status(400).json({ error: 'Укажите название идеи' });
    if (f.description.length < 30) return res.status(400).json({ error: 'Опишите идею подробнее (минимум 30 символов)' });
    const cen = await checkCensor(f.title + ' ' + f.description, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });

    const id = uuidv4();
    await queryOne(
      `INSERT INTO ideas (id, author_uid, title, description, category, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'open',NOW(),NOW())`,
      [id, req.user.uid, f.title, f.description, f.category]
    );
    res.status(201).json({ idea: shape(await loadIdea(id)) });
  } catch (e) {
    console.error('POST /ideas error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /ideas/:id — редактировать (автор, пока идею не забрали; админ — всегда).
// Частичное обновление: не переданные поля остаются прежними (например, админ меняет только title).
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const idea = await queryOne('SELECT author_uid, status, title, description, category FROM ideas WHERE id=$1', [req.params.id]);
    if (!idea) return res.status(404).json({ error: 'Идея не найдена' });
    const isAuthor = idea.author_uid === req.user.uid;
    if (!isAuthor && !isAdmin(req.user)) return res.status(403).json({ error: 'Нет доступа' });
    if (!isAdmin(req.user) && idea.status !== 'open') {
      return res.status(409).json({ error: 'Идею уже забрали — редактировать её нельзя' });
    }
    const f = readFields({
      title:       req.body.title       !== undefined ? req.body.title       : idea.title,
      description: req.body.description !== undefined ? req.body.description : idea.description,
      category:    req.body.category    !== undefined ? req.body.category    : idea.category,
    });
    if (!f.title) return res.status(400).json({ error: 'Укажите название идеи' });
    if (f.description.length < 30) return res.status(400).json({ error: 'Опишите идею подробнее (минимум 30 символов)' });
    const cen = await checkCensor(f.title + ' ' + f.description, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });

    await queryOne(
      'UPDATE ideas SET title=$1, description=$2, category=$3, updated_at=NOW() WHERE id=$4',
      [f.title, f.description, f.category, req.params.id]
    );
    res.json({ idea: shape(await loadIdea(req.params.id)) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /ideas/:id — удалить (автор, пока идею не забрали; админ — всегда)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const idea = await queryOne('SELECT author_uid, status FROM ideas WHERE id=$1', [req.params.id]);
    if (!idea) return res.status(404).json({ error: 'Идея не найдена' });
    const isAuthor = idea.author_uid === req.user.uid;
    if (!isAuthor && !isAdmin(req.user)) return res.status(403).json({ error: 'Нет доступа' });
    if (!isAdmin(req.user) && idea.status !== 'open') {
      return res.status(409).json({ error: 'Идею уже забрали — удалить её нельзя' });
    }
    await queryOne('DELETE FROM ideas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/:id/take — забрать идею себе (стартапер)
router.post('/:id/take', requireAuth, async (req, res) => {
  try {
    if (!canTake(req.user)) return res.status(403).json({ error: 'Забирать идеи могут только стартаперы' });
    await ensureIdeasSchema();
    // Атомарно: забрать можно только свободную идею
    const row = await queryOne(
      `UPDATE ideas SET status='taken', taken_by=$1, taken_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status='open' AND author_uid <> $1 RETURNING *`,
      [req.user.uid, req.params.id]
    );
    if (!row) return res.status(409).json({ error: 'Идею уже забрали или она недоступна' });

    try {
      await sendDirectMessage(req.user.uid, row.author_uid,
        `💡 Я забрал вашу идею «${row.title}» и буду делать на её основе стартап. Спасибо!`);
    } catch (e) { console.error('ideas DM error:', e.message); }

    res.json({ idea: shape(await loadIdea(row.id)) });
  } catch (e) {
    console.error('POST /ideas/:id/take error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/:id/release — вернуть идею в общий доступ (тот, кто забрал, или админ)
router.post('/:id/release', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const idea = await queryOne('SELECT taken_by, status FROM ideas WHERE id=$1', [req.params.id]);
    if (!idea) return res.status(404).json({ error: 'Идея не найдена' });
    if (idea.taken_by !== req.user.uid && !isAdmin(req.user)) return res.status(403).json({ error: 'Нет доступа' });
    await queryOne(
      `UPDATE ideas SET status='open', taken_by=NULL, taken_at=NULL, startup_id=NULL, updated_at=NOW()
       WHERE id=$1`,
      [req.params.id]
    );
    res.json({ idea: shape(await loadIdea(req.params.id)) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/:id/startup — привязать к идее стартап, созданный на её основе
// Body: { startup_id }. Только тот, кто забрал идею, и только свой стартап.
router.post('/:id/startup', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const startupId = req.body.startup_id || req.body.startupId;
    const idea = await queryOne('SELECT taken_by FROM ideas WHERE id=$1', [req.params.id]);
    if (!idea) return res.status(404).json({ error: 'Идея не найдена' });
    if (idea.taken_by !== req.user.uid) return res.status(403).json({ error: 'Идея закреплена не за вами' });
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id=$1', [startupId]);
    if (!startup || startup.owner_uid !== req.user.uid) {
      return res.status(403).json({ error: 'Можно привязать только свой стартап' });
    }
    await queryOne('UPDATE ideas SET startup_id=$1, updated_at=NOW() WHERE id=$2', [startupId, req.params.id]);
    res.json({ idea: shape(await loadIdea(req.params.id)) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
