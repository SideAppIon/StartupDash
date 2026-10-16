// Банк идей: эксперты, менторы и буст-партнёры публикуют идеи для стартапов
// и бизнес-задачи компаний, стартаперы забирают их себе и запускают проекты.
//
// Публикация проходит модерацию (до 24 часов): moderation = pending → approved | rejected.
// Проверяют админ и поддержка, решение приходит автору в личные сообщения.
// Правка автором снова отправляет идею на модерацию. Посторонние видят только одобренные.
//
// Одобренную идею забирает один стартапер (status: open → taken); он может вернуть её обратно.
// Идею можно обсудить на форуме — тема создаётся один раз от имени автора идеи.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkCensor } = require('../lib/censor');
const { sendDirectMessage } = require('../lib/dm');

const router = express.Router();

const PUBLISHER_ROLES = ['expert', 'mentor', 'boost_partner'];
const canPublish  = (user) => user && PUBLISHER_ROLES.includes(user.role);
const canTake     = (user) => user && user.role === 'startup';
const isAdmin     = (user) => user && user.role === 'admin';
const isModerator = (user) => user && (user.role === 'admin' || user.role === 'support');

const KINDS = { idea: 'Идея для стартапа/проекта', task: 'Бизнес-задача компании' };
const TITLE_MAX = 50;
const DESC_MAX  = 2000;
const DESC_MIN  = 20;

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
    // Тип (идея / бизнес-задача), модерация и тема на форуме.
    // Идеи, созданные до появления модерации, считаются одобренными (DEFAULT 'approved').
    await query("ALTER TABLE ideas ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'idea'");
    await query("ALTER TABLE ideas ADD COLUMN IF NOT EXISTS moderation TEXT NOT NULL DEFAULT 'approved'");
    await query("ALTER TABLE ideas ADD COLUMN IF NOT EXISTS review_note TEXT DEFAULT ''");
    await query('ALTER TABLE ideas ADD COLUMN IF NOT EXISTS reviewed_by TEXT');
    await query('ALTER TABLE ideas ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ');
    await query('ALTER TABLE ideas ADD COLUMN IF NOT EXISTS forum_topic_id TEXT');
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status, created_at DESC)');
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_author ON ideas(author_uid)');
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_taken  ON ideas(taken_by)');
    await query('CREATE INDEX IF NOT EXISTS idx_ideas_moderation ON ideas(moderation)');
    // Приглашения поработать над идеей: автор → конкретный специалист или стартапер
    await query(`CREATE TABLE IF NOT EXISTS idea_invites (
      id           TEXT PRIMARY KEY,
      idea_id      TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
      from_uid     TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      to_uid       TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      message      TEXT DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','accepted','declined','cancelled')),
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_idea_invites_to   ON idea_invites(to_uid, status)');
    await query('CREATE INDEX IF NOT EXISTS idx_idea_invites_idea ON idea_invites(idea_id, status)');
    schemaEnsured = true;
  } catch (e) {
    console.error('ensureIdeasSchema error:', e.message);
  }
}

const SELECT_IDEAS = `
  SELECT i.*,
         a.name AS author_name, a.avatar AS author_avatar, a.role AS author_role,
         t.name AS taker_name,  t.avatar AS taker_avatar,
         s.name AS startup_name,
         (SELECT COALESCE(json_agg(json_build_object('uid', u.uid, 'name', u.name) ORDER BY ii.responded_at), '[]'::json)
            FROM idea_invites ii JOIN users u ON u.uid = ii.to_uid
           WHERE ii.idea_id = i.id AND ii.status = 'accepted' AND u.role = 'user') AS participants,
         (SELECT COALESCE(json_agg(json_build_object('id', ii.id, 'uid', u.uid, 'name', u.name, 'role', u.role) ORDER BY ii.created_at), '[]'::json)
            FROM idea_invites ii JOIN users u ON u.uid = ii.to_uid
           WHERE ii.idea_id = i.id AND ii.status = 'pending') AS pending_invites
  FROM ideas i
  LEFT JOIN users a    ON a.uid = i.author_uid
  LEFT JOIN users t    ON t.uid = i.taken_by
  LEFT JOIN startups s ON s.id  = i.startup_id`;

function shape(r, viewer) {
  const canSeeInvites = viewer && (viewer.uid === r.author_uid || isAdmin(viewer));
  return {
    id:           r.id,
    kind:         r.kind || 'idea',
    title:        r.title,
    description:  r.description,
    category:     r.category || '',
    status:       r.status,
    moderation:   r.moderation || 'approved',
    reviewNote:   r.review_note || '',
    reviewedAt:   r.reviewed_at,
    forumTopicId: r.forum_topic_id || null,
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
    participants: r.participants || [],                         // специалисты, работающие над идеей
    pendingInvites: canSeeInvites ? (r.pending_invites || []) : [],
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
  };
}

async function loadIdea(id) {
  return queryOne(`${SELECT_IDEAS} WHERE i.id = $1`, [id]);
}

// Может ли пользователь видеть идею: одобренную — все; на модерации / отклонённую — автор и модераторы
function canSee(user, row) {
  return row.moderation === 'approved' || row.author_uid === user.uid || isModerator(user);
}

// Поля формы: тип, краткое название (до 50), описание (до 2000). Возвращает { f } или { error }
function readFields(body) {
  const f = {
    kind:        KINDS[body.kind] ? body.kind : 'idea',
    title:       String(body.title || '').trim(),
    description: String(body.description || '').trim(),
  };
  if (!f.title) return { error: 'Укажите краткое наименование' };
  if (f.title.length > TITLE_MAX) return { error: `Наименование — не длиннее ${TITLE_MAX} символов` };
  if (f.description.length < DESC_MIN) return { error: `Опишите суть подробнее (минимум ${DESC_MIN} символов)` };
  if (f.description.length > DESC_MAX) return { error: `Описание — не длиннее ${DESC_MAX} символов` };
  return { f };
}

// GET /ideas — лента идей (только для авторизованных)
//   ?status=open|taken  ?kind=idea|task  ?mine=1 (свои и забранные)
//   ?moderation=pending|approved|rejected — для админа и поддержки (очередь модерации)
// Обычные пользователи получают одобренные идеи + свои (в любом статусе модерации).
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const params = [];
    let sql = `${SELECT_IDEAS} WHERE 1=1`;
    if (isModerator(req.user)) {
      if (['pending', 'approved', 'rejected'].includes(req.query.moderation)) {
        params.push(req.query.moderation); sql += ` AND i.moderation = $${params.length}`;
      }
    } else {
      params.push(req.user.uid);
      sql += ` AND (i.moderation = 'approved' OR i.author_uid = $${params.length})`;
    }
    if (req.query.status === 'open' || req.query.status === 'taken') {
      params.push(req.query.status); sql += ` AND i.status = $${params.length}`;
    }
    if (KINDS[req.query.kind]) {
      params.push(req.query.kind); sql += ` AND i.kind = $${params.length}`;
    }
    if (req.query.mine) {
      params.push(req.user.uid);
      sql += ` AND (i.author_uid = $${params.length} OR i.taken_by = $${params.length})`;
    }
    sql += ` ORDER BY (i.moderation = 'pending') DESC, i.created_at DESC LIMIT 300`;
    const rows = await queryAll(sql, params);
    res.json({ ideas: rows.map(r => shape(r, req.user)) });
  } catch (e) {
    console.error('GET /ideas error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Приглашения поработать над идеей ──────────────────
const INVITEE_ROLES = ['user', 'startup'];   // приглашать можно специалистов и стартаперов

function shapeInvite(r) {
  return {
    id: r.id, ideaId: r.idea_id, status: r.status, message: r.message || '',
    createdAt: r.created_at, respondedAt: r.responded_at,
    ideaTitle: r.idea_title, ideaKind: r.idea_kind || 'idea', ideaStatus: r.idea_status,
    fromUid: r.from_uid, fromName: r.from_name || '', fromRole: r.from_role || '',
    toUid: r.to_uid, toName: r.to_name || '', toRole: r.to_role || '',
  };
}
const SELECT_INVITES = `
  SELECT ii.*, i.title AS idea_title, i.kind AS idea_kind, i.status AS idea_status,
         f.name AS from_name, f.role AS from_role, t.name AS to_name, t.role AS to_role
  FROM idea_invites ii
  JOIN ideas i ON i.id = ii.idea_id
  LEFT JOIN users f ON f.uid = ii.from_uid
  LEFT JOIN users t ON t.uid = ii.to_uid`;

// GET /ideas/invites — мои приглашения: полученные и отправленные
router.get('/invites', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const [received, sent] = await Promise.all([
      queryAll(`${SELECT_INVITES} WHERE ii.to_uid = $1 ORDER BY (ii.status = 'pending') DESC, ii.created_at DESC LIMIT 100`, [req.user.uid]),
      queryAll(`${SELECT_INVITES} WHERE ii.from_uid = $1 ORDER BY ii.created_at DESC LIMIT 100`, [req.user.uid]),
    ]);
    res.json({ received: received.map(shapeInvite), sent: sent.map(shapeInvite) });
  } catch (e) {
    console.error('GET /ideas/invites error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/invites/:inviteId/respond — ответ приглашённого. Body: { decision: 'accept' | 'decline' }
// Стартапер, приняв приглашение, забирает идею себе; специалист становится участником идеи.
router.post('/invites/:inviteId/respond', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const decision = req.body.decision;
    if (!['accept', 'decline'].includes(decision)) return res.status(400).json({ error: 'Неверное решение' });
    const inv = await queryOne(`${SELECT_INVITES} WHERE ii.id = $1`, [req.params.inviteId]);
    if (!inv || inv.to_uid !== req.user.uid) return res.status(404).json({ error: 'Приглашение не найдено' });
    if (inv.status !== 'pending') return res.status(409).json({ error: 'Приглашение уже неактуально' });

    if (decision === 'accept' && req.user.role === 'startup') {
      // Стартапер забирает идею — атомарно, только если она ещё свободна
      const took = await queryOne(
        `UPDATE ideas SET status='taken', taken_by=$1, taken_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND status='open' AND moderation='approved' RETURNING id`,
        [req.user.uid, inv.idea_id]
      );
      if (!took) return res.status(409).json({ error: 'Идею уже забрал другой стартапер' });
    } else if (decision === 'accept' && !INVITEE_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Принять приглашение может только специалист или стартапер' });
    }

    await queryOne(
      'UPDATE idea_invites SET status=$1, responded_at=NOW() WHERE id=$2',
      [decision === 'accept' ? 'accepted' : 'declined', inv.id]
    );
    const what = inv.idea_kind === 'task' ? 'бизнес-задаче' : 'идее';
    const text = decision === 'accept'
      ? (req.user.role === 'startup'
          ? `✅ Принимаю приглашение по ${what} «${inv.idea_title}» — забираю её и буду делать на её основе стартап.`
          : `✅ Принимаю приглашение поработать над ${inv.idea_kind === 'task' ? 'бизнес-задачей' : 'идеей'} «${inv.idea_title}».`)
      : `Спасибо за приглашение по ${what} «${inv.idea_title}», но сейчас не смогу присоединиться.`;
    try { await sendDirectMessage(req.user.uid, inv.from_uid, text); }
    catch (e) { console.error('idea invite DM error:', e.message); }

    res.json({ invite: shapeInvite(await queryOne(`${SELECT_INVITES} WHERE ii.id = $1`, [inv.id])) });
  } catch (e) {
    console.error('POST /ideas/invites/:id/respond error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/invites/:inviteId/cancel — отозвать ожидающее приглашение (автор идеи)
router.post('/invites/:inviteId/cancel', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const row = await queryOne(
      `UPDATE idea_invites SET status='cancelled', responded_at=NOW()
       WHERE id=$1 AND from_uid=$2 AND status='pending' RETURNING id`,
      [req.params.inviteId, req.user.uid]
    );
    if (!row) return res.status(404).json({ error: 'Приглашение не найдено или уже неактуально' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /ideas/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const row = await loadIdea(req.params.id);
    if (!row || !canSee(req.user, row)) return res.status(404).json({ error: 'Идея не найдена' });
    res.json({ idea: shape(row, req.user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas — предложить идею или бизнес-задачу (эксперт / ментор / буст-партнёр) → на модерацию
router.post('/', requireAuth, async (req, res) => {
  try {
    if (!canPublish(req.user)) {
      return res.status(403).json({ error: 'Добавлять идеи могут эксперты, менторы и буст-партнёры' });
    }
    await ensureIdeasSchema();
    const r = readFields(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const f = r.f;
    const cen = await checkCensor(f.title + ' ' + f.description, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });

    const id = uuidv4();
    await queryOne(
      `INSERT INTO ideas (id, author_uid, kind, title, description, category, status, moderation, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'','open','pending',NOW(),NOW())`,
      [id, req.user.uid, f.kind, f.title, f.description]
    );
    res.status(201).json({ idea: shape(await loadIdea(id), req.user) });
  } catch (e) {
    console.error('POST /ideas error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /ideas/:id — редактировать (автор, пока идею не забрали; админ — всегда).
// Частичное обновление: не переданные поля остаются прежними (например, админ меняет только title).
// Правка автором снова отправляет идею на модерацию; правка админа — нет.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const idea = await queryOne('SELECT author_uid, status, kind, title, description FROM ideas WHERE id=$1', [req.params.id]);
    if (!idea) return res.status(404).json({ error: 'Идея не найдена' });
    const isAuthor = idea.author_uid === req.user.uid;
    if (!isAuthor && !isAdmin(req.user)) return res.status(403).json({ error: 'Нет доступа' });
    if (!isAdmin(req.user) && idea.status !== 'open') {
      return res.status(409).json({ error: 'Идею уже забрали — редактировать её нельзя' });
    }
    const r = readFields({
      kind:        req.body.kind        !== undefined ? req.body.kind        : idea.kind,
      title:       req.body.title       !== undefined ? req.body.title       : idea.title,
      description: req.body.description !== undefined ? req.body.description : idea.description,
    });
    if (r.error) return res.status(400).json({ error: r.error });
    const f = r.f;
    const cen = await checkCensor(f.title + ' ' + f.description, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });

    const remoderate = !isAdmin(req.user);
    await queryOne(
      `UPDATE ideas SET kind=$1, title=$2, description=$3, updated_at=NOW()
         ${remoderate ? ", moderation='pending', review_note='', reviewed_by=NULL, reviewed_at=NULL" : ''}
       WHERE id=$4`,
      [f.kind, f.title, f.description, req.params.id]
    );
    res.json({ idea: shape(await loadIdea(req.params.id), req.user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/:id/moderate — решение модерации (админ / поддержка)
// Body: { decision: 'approve' | 'reject', note } — при отказе причина обязательна
router.post('/:id/moderate', requireAuth, async (req, res) => {
  try {
    if (!isModerator(req.user)) return res.status(403).json({ error: 'Только для администратора и поддержки' });
    await ensureIdeasSchema();
    const decision = req.body.decision;
    const note = String(req.body.note || '').trim().slice(0, 2000);
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Неверное решение' });
    if (decision === 'reject' && !note) return res.status(400).json({ error: 'Укажите причину отказа' });

    // Решаем только по ожидающей проверки идее — защита от двойного решения
    const row = await queryOne(
      `UPDATE ideas SET moderation=$1, review_note=$2, reviewed_by=$3, reviewed_at=NOW()
       WHERE id=$4 AND moderation='pending' RETURNING *`,
      [decision === 'approve' ? 'approved' : 'rejected', note, req.user.uid, req.params.id]
    );
    if (!row) return res.status(409).json({ error: 'Идея не найдена или уже рассмотрена' });

    const what = row.kind === 'task' ? 'Бизнес-задача' : 'Идея';
    const text = decision === 'approve'
      ? `✅ ${what} «${row.title}» прошла модерацию и опубликована в банке идей.`
      : `❌ ${what} «${row.title}» не прошла модерацию.\nПричина: ${note}\nВы можете исправить её на странице «Идеи» и отправить повторно.`;
    try { await sendDirectMessage(req.user.uid, row.author_uid, text); }
    catch (e) { console.error('idea moderation DM error:', e.message); }

    res.json({ idea: shape(await loadIdea(row.id), req.user) });
  } catch (e) {
    console.error('POST /ideas/:id/moderate error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/:id/discussion — тема на форуме для обсуждения идеи.
// Создаётся один раз от имени автора идеи, дальше возвращается существующая.
router.post('/:id/discussion', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const row = await loadIdea(req.params.id);
    if (!row || !canSee(req.user, row)) return res.status(404).json({ error: 'Идея не найдена' });
    if (row.moderation !== 'approved') {
      return res.status(409).json({ error: 'Обсуждение откроется после модерации' });
    }
    if (row.forum_topic_id) {
      const exists = await queryOne('SELECT id FROM forum_topics WHERE id=$1', [row.forum_topic_id]);
      if (exists) return res.json({ topicId: row.forum_topic_id });
    }
    const topicId = uuidv4();
    const prefix = row.kind === 'task' ? 'Бизнес-задача' : 'Идея';
    const content = `${row.description}\n\n— ${prefix} из банка идей «Атриума». Обсуждаем здесь: вопросы, уточнения, кто готов взяться.`;
    await queryOne(
      `INSERT INTO forum_topics (id, author_uid, title, content, reply_count, views, created_at, last_at)
       VALUES ($1,$2,$3,$4,0,0,NOW(),NOW())`,
      [topicId, row.author_uid, `${prefix}: ${row.title}`, content]
    );
    // Если две вкладки создали тему одновременно — берём ту, что записалась первой
    const linked = await queryOne(
      `UPDATE ideas SET forum_topic_id=$1 WHERE id=$2 AND (forum_topic_id IS NULL OR forum_topic_id=$1
         OR NOT EXISTS (SELECT 1 FROM forum_topics ft WHERE ft.id = ideas.forum_topic_id)) RETURNING forum_topic_id`,
      [topicId, row.id]
    );
    if (!linked) {
      await queryOne('DELETE FROM forum_topics WHERE id=$1', [topicId]);
      const cur = await queryOne('SELECT forum_topic_id FROM ideas WHERE id=$1', [row.id]);
      return res.json({ topicId: cur.forum_topic_id });
    }
    res.status(201).json({ topicId });
  } catch (e) {
    console.error('POST /ideas/:id/discussion error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /ideas/:id/invites — пригласить специалиста или стартапера поработать над идеей.
// Body: { to_uid, message }. Только автор, только одобренная и свободная идея.
router.post('/:id/invites', requireAuth, async (req, res) => {
  try {
    await ensureIdeasSchema();
    const idea = await queryOne('SELECT * FROM ideas WHERE id=$1', [req.params.id]);
    if (!idea) return res.status(404).json({ error: 'Идея не найдена' });
    if (idea.author_uid !== req.user.uid) return res.status(403).json({ error: 'Приглашать может только автор идеи' });
    if (idea.moderation !== 'approved') return res.status(409).json({ error: 'Приглашать можно после модерации идеи' });
    if (idea.status !== 'open') return res.status(409).json({ error: 'Идею уже забрали' });

    const toUid = req.body.to_uid || req.body.toUid;
    const target = await queryOne('SELECT uid, name, role FROM users WHERE uid=$1', [toUid]);
    if (!target || target.uid === req.user.uid) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!INVITEE_ROLES.includes(target.role)) {
      return res.status(400).json({ error: 'Пригласить можно только специалиста или стартапера' });
    }
    const dup = await queryOne(
      "SELECT status FROM idea_invites WHERE idea_id=$1 AND to_uid=$2 AND status IN ('pending','accepted')",
      [idea.id, target.uid]
    );
    if (dup) return res.status(409).json({ error: dup.status === 'pending' ? 'Приглашение уже отправлено' : 'Уже работает над идеей' });

    const message = String(req.body.message || '').trim().slice(0, 1000);
    if (message) {
      const cen = await checkCensor(message, 'messages');
      if (cen.blocked) return res.status(400).json({ error: cen.message });
    }
    const id = uuidv4();
    await queryOne(
      `INSERT INTO idea_invites (id, idea_id, from_uid, to_uid, message, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',NOW())`,
      [id, idea.id, req.user.uid, target.uid, message]
    );
    const what = idea.kind === 'task' ? 'бизнес-задачей' : 'идеей';
    const text = `💡 Приглашаю вас поработать над ${what} «${idea.title}».` +
      (message ? `\n${message}` : '') +
      '\nПринять или отклонить приглашение можно на странице «Идеи», во вкладке «Приглашения».';
    try { await sendDirectMessage(req.user.uid, target.uid, text); }
    catch (e) { console.error('idea invite DM error:', e.message); }

    res.status(201).json({ invite: shapeInvite(await queryOne(`${SELECT_INVITES} WHERE ii.id = $1`, [id])) });
  } catch (e) {
    console.error('POST /ideas/:id/invites error:', e.message);
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

// POST /ideas/:id/take — забрать идею себе (стартапер; только одобренную)
router.post('/:id/take', requireAuth, async (req, res) => {
  try {
    if (!canTake(req.user)) return res.status(403).json({ error: 'Забирать идеи могут только стартаперы' });
    await ensureIdeasSchema();
    // Атомарно: забрать можно только свободную одобренную идею
    const row = await queryOne(
      `UPDATE ideas SET status='taken', taken_by=$1, taken_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status='open' AND moderation='approved' AND author_uid <> $1 RETURNING *`,
      [req.user.uid, req.params.id]
    );
    if (!row) return res.status(409).json({ error: 'Идею уже забрали или она недоступна' });

    try {
      const what = row.kind === 'task' ? 'бизнес-задачу' : 'идею';
      await sendDirectMessage(req.user.uid, row.author_uid,
        `💡 Я забрал вашу ${what} «${row.title}» и буду делать на её основе стартап. Спасибо!`);
    } catch (e) { console.error('ideas DM error:', e.message); }

    res.json({ idea: shape(await loadIdea(row.id), req.user) });
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
    res.json({ idea: shape(await loadIdea(req.params.id), req.user) });
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
    res.json({ idea: shape(await loadIdea(req.params.id), req.user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
