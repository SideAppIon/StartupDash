const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { getUserGroupSettings } = require('./groups');
const { checkCensor } = require('../lib/censor');

const router = express.Router();

// Ленивая миграция колонок обновлений (автораннера миграций нет).
let updatesSchemaEnsured = false;
async function ensureUpdatesSchema() {
  if (updatesSchemaEnsured) return;
  try {
    await query('ALTER TABLE startup_updates ADD COLUMN IF NOT EXISTS image_url TEXT');
    await query('ALTER TABLE startup_updates ADD COLUMN IF NOT EXISTS video_url TEXT');
    updatesSchemaEnsured = true;
  } catch (e) {
    console.error('ensureUpdatesSchema error:', e.message);
  }
}

// Доп. колонки задач: комментарии (правят все) и блокировка редактирования
let tasksSchemaEnsured = false;
async function ensureTasksSchema() {
  if (tasksSchemaEnsured) return;
  try {
    await query("ALTER TABLE startup_tasks ADD COLUMN IF NOT EXISTS comments TEXT DEFAULT ''");
    await query('ALTER TABLE startup_tasks ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false');
    tasksSchemaEnsured = true;
  } catch (e) {
    console.error('ensureTasksSchema error:', e.message);
  }
}

// Является ли пользователь участником стартапа (для правки комментариев)
async function isStartupMember(startupId, uid) {
  if (!uid) return false;
  const t = await queryOne('SELECT 1 FROM startup_team WHERE startup_id=$1 AND user_uid=$2', [startupId, uid]);
  if (t) return true;
  const inv = await queryOne(
    `SELECT 1 FROM invites WHERE startup_id=$1 AND status='accepted' AND (from_uid=$2 OR to_uid=$2) LIMIT 1`,
    [startupId, uid]
  );
  return !!inv;
}

// Лайки стартапов (один лайк на пользователя)
let likesSchemaEnsured = false;
async function ensureLikesSchema() {
  if (likesSchemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS startup_likes (
      startup_id TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      user_uid   TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (startup_id, user_uid)
    )`);
    likesSchemaEnsured = true;
  } catch (e) {
    console.error('ensureLikesSchema error:', e.message);
  }
}

// Форум стартапа: флаг включения + привязка темы к стартапу
let startupForumSchemaEnsured = false;
async function ensureStartupForumSchema() {
  if (startupForumSchemaEnsured) return;
  try {
    await query('ALTER TABLE startups ADD COLUMN IF NOT EXISTS forum_enabled BOOLEAN DEFAULT true');
    await query('ALTER TABLE forum_topics ADD COLUMN IF NOT EXISTS startup_id TEXT');
    startupForumSchemaEnsured = true;
  } catch (e) {
    console.error('ensureStartupForumSchema error:', e.message);
  }
}

// Лайки постов-обновлений (один лайк на пользователя)
let updateLikesSchemaEnsured = false;
async function ensureUpdateLikesSchema() {
  if (updateLikesSchemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS update_likes (
      update_id  TEXT NOT NULL REFERENCES startup_updates(id) ON DELETE CASCADE,
      user_uid   TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (update_id, user_uid)
    )`);
    updateLikesSchemaEnsured = true;
  } catch (e) {
    console.error('ensureUpdateLikesSchema error:', e.message);
  }
}

// Витрина товаров стартапа (в проде нет автораннера миграций — создаём таблицу лениво)
let productsSchemaEnsured = false;
async function ensureProductsSchema() {
  if (productsSchemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS startup_products (
      id          TEXT PRIMARY KEY,
      startup_id  TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
      name        TEXT DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      image_url   TEXT DEFAULT '',
      price       TEXT DEFAULT '',
      buy_url     TEXT NOT NULL DEFAULT '',
      position    INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_products_startup ON startup_products(startup_id)');
    productsSchemaEnsured = true;
  } catch (e) {
    console.error('ensureProductsSchema error:', e.message);
  }
}

// Доп. колонки стартапа: мягкое скрытие (hidden) и вложения-документы (attachments)
let hiddenSchemaEnsured = false;
async function ensureHiddenSchema() {
  if (hiddenSchemaEnsured) return;
  try {
    await query('ALTER TABLE startups ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE');
    await query("ALTER TABLE startups ADD COLUMN IF NOT EXISTS attachments TEXT DEFAULT '[]'");
    hiddenSchemaEnsured = true;
  } catch (e) {
    console.error('ensureHiddenSchema (startups) error:', e.message);
  }
}

// Нормализация ссылки на видео ВКонтакте → URL для встраивания (video_ext.php).
// Принимает: код <iframe src="...">, готовую ссылку video_ext.php,
// либо обычную ссылку на страницу видео (vk.com/video-123_456, vkvideo.ru/...).
function normalizeVkVideo(raw) {
  if (!raw) return '';
  let s = String(raw).trim();

  // Прямая ссылка на загруженный видеофайл — оставляем как есть
  if (/storage\.yandexcloud\.net/i.test(s) || /\.(mp4|webm|mov)(\?|$)/i.test(s)) {
    return s.replace(/^http:\/\//i, 'https://');
  }

  // 1. Если вставили целиком код вставки <iframe src="...">
  const iframeMatch = s.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  if (iframeMatch) s = iframeMatch[1].trim();

  // Добавляем протокол, если ссылку скопировали без него
  if (/^\/\//.test(s)) s = 'https:' + s;
  if (/^www\./i.test(s)) s = 'https://' + s;

  // 2. Уже готовая ссылка для встраивания
  if (/video_ext\.php/i.test(s)) {
    return s.replace(/^http:\/\//i, 'https://');
  }

  // 3. Обычная ссылка на страницу видео: vk.com/video-123_456, vkvideo.ru/video123_456,
  //    либо ?z=video-123_456 — извлекаем oid и id
  const m = s.match(/video(-?\d+)_(\d+)/i);
  if (m) {
    return `https://vk.com/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2`;
  }

  // Ничего не распознали — вернём как есть (фронтенд покажет только https-ссылки)
  return s;
}

// GET /startups — каталог (публично, с фильтрами)
router.get('/', optionalAuth, async (req, res) => {
  try {
    await ensureHiddenSchema();
    const { category, stage, search, owner_uid } = req.query;
    let sql = `SELECT * FROM startups WHERE 1=1`;
    const params = [];

    // Закрытые стартапы не показываем обычным пользователям
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin) {
      sql += ` AND privacy != 'closed'`;
      // Мягко скрытые админом — не показываем (владелец видит свои)
      if (req.user) {
        params.push(req.user.uid);
        sql += ` AND (hidden IS NOT TRUE OR owner_uid = $${params.length})`;
      } else {
        sql += ` AND hidden IS NOT TRUE`;
      }
    }

    // Ограничение видимости по группе
    if (req.user && !isAdmin) {
      const gs = await getUserGroupSettings(req.user.uid);
      if (gs && gs.startup_visibility === 'group_only') {
        // Показываем только стартапы участников той же группы
        params.push(gs.group_id);
        sql += ` AND owner_uid IN (
          SELECT user_uid FROM user_groups WHERE group_id = $${params.length}
        )`;
      }
    }

    if (owner_uid) {
      params.push(owner_uid);
      sql += ` AND owner_uid = $${params.length}`;
    }
    if (category) {
      params.push(category);
      sql += ` AND category = $${params.length}`;
    }
    if (stage) {
      params.push(stage);
      sql += ` AND stage = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (name ILIKE $${params.length} OR tagline ILIKE $${params.length})`;
    }

    sql += ' ORDER BY created_at DESC';

    const startups = await queryAll(sql, params);
    res.json({ startups: startups.map(parseStartup) });
  } catch (e) {
    console.error('GET /startups error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /startups/:id — одна запись
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT * FROM startups WHERE id = $1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Стартап не найден' });

    const uid = req.user && req.user.uid;
    const role = req.user && req.user.role;

    // Закрытый — только для владельца и админа
    if (startup.privacy === 'closed') {
      if (uid !== startup.owner_uid && role !== 'admin') {
        return res.status(403).json({ error: 'Доступ закрыт' });
      }
    }

    // Мягко скрытый админом — «не найден» для посторонних.
    // Но владелец, админ и участники команды (в т.ч. по accepted-инвайту) видят его.
    if (startup.hidden && uid !== startup.owner_uid && role !== 'admin') {
      if (!(await isStartupMember(req.params.id, uid))) {
        return res.status(404).json({ error: 'Стартап не найден' });
      }
    }

    // Лайки: общее число и поставил ли текущий пользователь
    await ensureLikesSchema();
    const out = parseStartup(startup);
    const cnt = await queryOne('SELECT COUNT(*)::int AS c FROM startup_likes WHERE startup_id=$1', [req.params.id]);
    out.likes = cnt ? cnt.c : 0;
    out.liked = false;
    if (uid) {
      const mine = await queryOne('SELECT 1 FROM startup_likes WHERE startup_id=$1 AND user_uid=$2', [req.params.id, uid]);
      out.liked = !!mine;
    }
    res.json({ startup: out });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /startups/:id/like — поставить лайк (идемпотентно)
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    await ensureLikesSchema();
    const s = await queryOne('SELECT id FROM startups WHERE id=$1', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Стартап не найден' });
    await queryOne(
      'INSERT INTO startup_likes (startup_id, user_uid, created_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING',
      [req.params.id, req.user.uid]
    );
    const cnt = await queryOne('SELECT COUNT(*)::int AS c FROM startup_likes WHERE startup_id=$1', [req.params.id]);
    res.json({ likes: cnt ? cnt.c : 0, liked: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /startups/:id/like — убрать лайк
router.delete('/:id/like', requireAuth, async (req, res) => {
  try {
    await ensureLikesSchema();
    await queryOne('DELETE FROM startup_likes WHERE startup_id=$1 AND user_uid=$2', [req.params.id, req.user.uid]);
    const cnt = await queryOne('SELECT COUNT(*)::int AS c FROM startup_likes WHERE startup_id=$1', [req.params.id]);
    res.json({ likes: cnt ? cnt.c : 0, liked: false });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /startups — создать
router.post('/', requireAuth, async (req, res) => {
  try {
    const allowedCreators = ['startup', 'expert', 'admin'];
    if (!allowedCreators.includes(req.user.role)) {
      return res.status(403).json({ error: 'Только стартапер или эксперт могут создавать проекты' });
    }

    const b = req.body;
    // Принимаем и snake_case и camelCase
    const name           = b.name;
    const tagline        = b.tagline;
    const stage          = b.stage;
    const category       = b.category;
    const website        = b.website;
    const looking_for    = b.looking_for    || b.lookingFor    || '';
    const cover_image    = b.cover_image    || b.coverImage    || '';
    const emoji          = b.emoji          || '🚀';
    const icon_image     = b.icon_image     || b.iconImage     || '';
    const tags           = b.tags;
    const privacy        = b.privacy;
    const content_blocks = b.content_blocks || b.contentBlocks || [];
    const attachments    = (b.attachments || []).slice(0, 5); // до 5 файлов

    if (!name || !tagline) return res.status(400).json({ error: 'name и tagline обязательны' });

    await ensureHiddenSchema();
    await ensureStartupForumSchema();
    // Форум стартапа: включён по умолчанию, но при создании можно отключить
    const forumEnabled = (b.forum_enabled === false || b.forumEnabled === false) ? false : true;
    const id = uuidv4();
    const startup = await queryOne(
      `INSERT INTO startups
         (id, owner_uid, owner_name, name, tagline, stage, category, website,
          looking_for, cover_image, emoji, icon_image, tags, privacy, content_blocks, attachments, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
       RETURNING *`,
      [id, req.user.uid, req.user.name || '',
       name, tagline, stage || 'Идея', category || '',
       website || '', looking_for || '',
       cover_image || '', emoji || '🚀', icon_image || '',
       JSON.stringify(tags || []),
       privacy || 'public',
       JSON.stringify(content_blocks || []),
       JSON.stringify(attachments || [])]
    );

    if (!forumEnabled) {
      await queryOne('UPDATE startups SET forum_enabled=false WHERE id=$1', [id]);
      startup.forum_enabled = false;
    }

    res.status(201).json({ startup: parseStartup(startup) });
  } catch (e) {
    console.error('POST /startups error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /startups/:id — обновить
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT * FROM startups WHERE id = $1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Стартап не найден' });

    const isOwner = startup.owner_uid === req.user.uid;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Нет доступа' });
    await ensureHiddenSchema();

    // Нормализуем тело — camelCase → snake_case
    const b2 = req.body;
    const normalized = {
      name:           b2.name,
      tagline:        b2.tagline,
      stage:          b2.stage,
      category:       b2.category,
      website:        b2.website,
      emoji:          b2.emoji,
      privacy:        b2.privacy,
      looking_for:    b2.looking_for    ?? b2.lookingFor,
      cover_image:    b2.cover_image    ?? b2.coverImage,
      icon_image:     b2.icon_image     ?? b2.iconImage,
      tags:           b2.tags,
      content_blocks: b2.content_blocks ?? b2.contentBlocks,
    };
    // Вложения (до 5) — владелец и админ
    if (b2.attachments !== undefined) normalized.attachments = (b2.attachments || []).slice(0, 5);
    // Форум стартапа вкл/выкл — владелец и админ
    if (b2.forum_enabled !== undefined) normalized.forum_enabled = b2.forum_enabled;
    else if (b2.forumEnabled !== undefined) normalized.forum_enabled = b2.forumEnabled;
    if (normalized.forum_enabled !== undefined) await ensureStartupForumSchema();
    // Мягкое скрытие — только админ
    if (isAdmin && b2.hidden !== undefined) normalized.hidden = b2.hidden;

    const allowed = ['name', 'tagline', 'stage', 'category', 'website', 'looking_for',
                     'cover_image', 'emoji', 'icon_image', 'tags', 'privacy', 'content_blocks', 'attachments', 'forum_enabled'];
    if (isAdmin) allowed.push('hidden');
    const updates = [];
    const values  = [];

    allowed.forEach(field => {
      if (normalized[field] !== undefined && normalized[field] !== null) {
        const val = ['tags', 'content_blocks', 'attachments'].includes(field)
          ? JSON.stringify(normalized[field])
          : normalized[field];
        values.push(val);
        updates.push(`${field} = $${values.length}`);
      }
    });

    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    values.push(req.params.id);
    const updated = await queryOne(
      `UPDATE startups SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length} RETURNING *`,
      values
    );

    res.json({ startup: parseStartup(updated) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /startups/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id = $1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Стартап не найден' });

    if (startup.owner_uid !== req.user.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    await queryOne('DELETE FROM startups WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Команда ──────────────────────────────────────────────
router.get('/:id/team', async (req, res) => {
  try {
    const team = await queryAll(
      `SELECT t.*, u.name, u.avatar, u.bio, u.skills
       FROM startup_team t
       JOIN users u ON u.uid = t.user_uid
       WHERE t.startup_id = $1`,
      [req.params.id]
    );
    res.json({ team: team.map(m => ({
      ...m,
      skills: tryParse(m.skills, []),
      permissions: tryParse(m.permissions, {})
    })) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/:id/team', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    const { user_uid, role, permissions } = req.body;
    await queryOne(
      `INSERT INTO startup_team (startup_id, user_uid, role, permissions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (startup_id, user_uid) DO UPDATE SET role=$3, permissions=$4`,
      [req.params.id, user_uid, role || 'Участник', JSON.stringify(permissions || {})]
    );

    // Если групповой чат уже существует — добавляем нового участника в него
    const conv = await queryOne(
      'SELECT id FROM conversations WHERE startup_id=$1 AND is_group=TRUE LIMIT 1',
      [req.params.id]
    );
    if (conv) {
      await queryOne(
        'INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [conv.id, user_uid]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /startups/:id/transfer — передать стартап новому основателю (текущий владелец или админ)
router.post('/:id/transfer', requireAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id=$1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Стартап не найден' });
    const isOwner = startup.owner_uid === req.user.uid;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Только основатель может передать проект' });

    const newOwnerUid = req.body.new_owner_uid || req.body.newOwnerUid;
    if (!newOwnerUid) return res.status(400).json({ error: 'Не указан новый основатель' });
    if (newOwnerUid === startup.owner_uid) return res.status(400).json({ error: 'Пользователь уже основатель' });

    const newOwner = await queryOne('SELECT uid, name, role FROM users WHERE uid=$1', [newOwnerUid]);
    if (!newOwner) return res.status(404).json({ error: 'Пользователь не найден' });
    // Передавать можно только стартаперу, который состоит в команде
    if (newOwner.role !== 'startup') {
      return res.status(400).json({ error: 'Передать проект можно только стартаперу' });
    }
    if (!(await isStartupMember(req.params.id, newOwnerUid))) {
      return res.status(400).json({ error: 'Новый основатель должен быть в команде проекта' });
    }

    // Меняем владельца
    await queryOne(
      'UPDATE startups SET owner_uid=$1, owner_name=$2, updated_at=NOW() WHERE id=$3',
      [newOwner.uid, newOwner.name || '', req.params.id]
    );

    // Новый владелец больше не числится в команде (он теперь основатель)
    await queryOne('DELETE FROM startup_team WHERE startup_id=$1 AND user_uid=$2', [req.params.id, newOwner.uid]);

    // Старый владелец остаётся в проекте как со-основатель с полными правами
    await queryOne(
      `INSERT INTO startup_team (startup_id, user_uid, role, permissions)
       VALUES ($1,$2,'Со-основатель',$3)
       ON CONFLICT (startup_id, user_uid) DO UPDATE SET role='Со-основатель', permissions=$3`,
      [req.params.id, startup.owner_uid, JSON.stringify({ kanban: true, updates: true, team: true })]
    );

    // Оба должны быть в групповом чате, если он есть
    const conv2 = await queryOne('SELECT id FROM conversations WHERE startup_id=$1 AND is_group=TRUE LIMIT 1', [req.params.id]);
    if (conv2) {
      await queryOne('INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2) ON CONFLICT DO NOTHING', [conv2.id, newOwner.uid]);
      await queryOne('INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2) ON CONFLICT DO NOTHING', [conv2.id, startup.owner_uid]);
    }

    res.json({ ok: true, owner_uid: newOwner.uid });
  } catch (e) {
    console.error('transfer error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.patch('/:id/team/:uid', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    const { role, permissions } = req.body;
    const updates = []; const values = [];
    if (role !== undefined) { values.push(role); updates.push(`role=$${values.length}`); }
    if (permissions !== undefined) { values.push(JSON.stringify(permissions)); updates.push(`permissions=$${values.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });
    values.push(req.params.id, req.params.uid);
    await queryOne(
      `UPDATE startup_team SET ${updates.join(', ')} WHERE startup_id=$${values.length-1} AND user_uid=$${values.length}`,
      values
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.delete('/:id/team/:uid', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    await queryOne('DELETE FROM startup_team WHERE startup_id=$1 AND user_uid=$2',
      [req.params.id, req.params.uid]);

    // Убираем исключённого из участников группового чата стартапа
    // (сообщения остаются, но человек теряет доступ к чату)
    await queryOne(
      `DELETE FROM conversation_participants
       WHERE user_uid=$1
         AND conv_id = (
           SELECT id FROM conversations
           WHERE startup_id=$2 AND is_group=TRUE
           LIMIT 1
         )`,
      [req.params.uid, req.params.id]
    );

    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Обновления проекта ────────────────────────────────────
router.get('/:id/updates', optionalAuth, async (req, res) => {
  try {
    await ensureUpdateLikesSchema();
    const uid = (req.user && req.user.uid) || null;
    const updates = await queryAll(
      `SELECT u.*, usr.name AS author_name, usr.avatar AS author_avatar,
              (SELECT COUNT(*) FROM update_likes ul WHERE ul.update_id = u.id)::int AS likes,
              EXISTS(SELECT 1 FROM update_likes ul2 WHERE ul2.update_id = u.id AND ul2.user_uid = $2) AS liked
       FROM startup_updates u
       JOIN users usr ON usr.uid = u.author_uid
       WHERE u.startup_id = $1
       ORDER BY u.created_at DESC`,
      [req.params.id, uid]
    );
    res.json({ updates: updates.map(_parseUpdate) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /startups/:id/updates/:updateId/like — лайкнуть пост (идемпотентно)
router.post('/:id/updates/:updateId/like', requireAuth, async (req, res) => {
  try {
    await ensureUpdateLikesSchema();
    const upd = await queryOne('SELECT id FROM startup_updates WHERE id=$1 AND startup_id=$2', [req.params.updateId, req.params.id]);
    if (!upd) return res.status(404).json({ error: 'Обновление не найдено' });
    await queryOne(
      'INSERT INTO update_likes (update_id, user_uid, created_at) VALUES ($1,$2,NOW()) ON CONFLICT DO NOTHING',
      [req.params.updateId, req.user.uid]
    );
    const cnt = await queryOne('SELECT COUNT(*)::int AS c FROM update_likes WHERE update_id=$1', [req.params.updateId]);
    res.json({ likes: cnt ? cnt.c : 0, liked: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /startups/:id/updates/:updateId/like — убрать лайк
router.delete('/:id/updates/:updateId/like', requireAuth, async (req, res) => {
  try {
    await ensureUpdateLikesSchema();
    await queryOne('DELETE FROM update_likes WHERE update_id=$1 AND user_uid=$2', [req.params.updateId, req.user.uid]);
    const cnt = await queryOne('SELECT COUNT(*)::int AS c FROM update_likes WHERE update_id=$1', [req.params.updateId]);
    res.json({ likes: cnt ? cnt.c : 0, liked: false });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Форум стартапа ────────────────────────────────────────
// GET /startups/:id/forum — статус форума + последние 3 сообщения
router.get('/:id/forum', optionalAuth, async (req, res) => {
  try {
    await ensureStartupForumSchema();
    const s = await queryOne('SELECT id, forum_enabled FROM startups WHERE id=$1', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Стартап не найден' });
    if (s.forum_enabled === false) return res.json({ enabled: false });

    const topic = await queryOne('SELECT id, reply_count FROM forum_topics WHERE startup_id=$1 LIMIT 1', [req.params.id]);
    if (!topic) return res.json({ enabled: true, topicId: null, posts: [], total: 0 });

    const posts = await queryAll(
      `SELECT p.id, p.content, p.created_at, p.author_uid,
              u.name AS author_name, u.avatar AS author_avatar, u.diamond AS author_diamond
       FROM forum_posts p JOIN users u ON u.uid = p.author_uid
       WHERE p.topic_id=$1 ORDER BY p.created_at DESC LIMIT 3`,
      [topic.id]
    );
    res.json({ enabled: true, topicId: topic.id, posts: posts.reverse(), total: topic.reply_count || posts.length });
  } catch (e) {
    console.error('GET startup forum:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /startups/:id/forum — написать сообщение (создаёт тему стартапа при первом сообщении)
router.post('/:id/forum', requireAuth, async (req, res) => {
  try {
    await ensureStartupForumSchema();
    const s = await queryOne('SELECT id, name, owner_uid, forum_enabled FROM startups WHERE id=$1', [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Стартап не найден' });
    if (s.forum_enabled === false) return res.status(403).json({ error: 'Форум этого стартапа отключён' });

    const content = (req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Пустое сообщение' });

    const ban = await queryOne('SELECT forum_banned FROM users WHERE uid=$1', [req.user.uid]);
    if (ban && ban.forum_banned) return res.status(403).json({ error: 'Вам запрещено общение на форуме' });
    const cen = await checkCensor(content, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });

    let topic = await queryOne('SELECT id FROM forum_topics WHERE startup_id=$1 LIMIT 1', [req.params.id]);
    if (!topic) {
      const tid = uuidv4();
      topic = await queryOne(
        `INSERT INTO forum_topics (id, author_uid, title, content, reply_count, views, startup_id, created_at, last_at)
         VALUES ($1,$2,$3,'',0,0,$4,NOW(),NOW()) RETURNING id`,
        [tid, s.owner_uid, 'Обсуждение: ' + (s.name || 'стартап'), req.params.id]
      );
    }

    const pid = uuidv4();
    const post = await queryOne(
      'INSERT INTO forum_posts (id, topic_id, author_uid, content, created_at) VALUES ($1,$2,$3,$4,NOW()) RETURNING *',
      [pid, topic.id, req.user.uid, content]
    );
    const user = await queryOne('SELECT name FROM users WHERE uid=$1', [req.user.uid]);
    await queryOne(
      'UPDATE forum_topics SET reply_count=reply_count+1, last_at=NOW(), last_author=$1 WHERE id=$2',
      [user ? user.name : '', topic.id]
    );

    res.status(201).json({ topicId: topic.id, post });
  } catch (e) {
    console.error('POST startup forum:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/:id/updates', requireAuth, async (req, res) => {
  try {
    await ensureUpdatesSchema();
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id = $1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Стартап не найден' });

    const isOwner = startup.owner_uid === req.user.uid;
    const isAdmin = req.user.role === 'admin';
    const isMemberWithPerm = await checkTeamPermission(req.params.id, req.user.uid, 'updates');
    if (!isOwner && !isAdmin && !isMemberWithPerm) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    // Принимаем 'body' как алиас для 'content' (совместимость с фронтендом)
    const content = req.body.content || req.body.body || '';
    const title   = req.body.title   || '';
    const type    = req.body.type    || 'text';
    const imageUrl = req.body.imageUrl || req.body.image_url || '';
    const videoUrl = normalizeVkVideo(req.body.videoUrl || req.body.video_url || '');

    if (!content) return res.status(400).json({ error: 'Напиши содержание обновления' });

    // Фильтр слов для публикуемых обновлений (область публичного контента)
    const cen = await checkCensor(title + ' ' + content, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });

    const id = uuidv4();
    const update = await queryOne(
      `INSERT INTO startup_updates (id, startup_id, author_uid, title, content, type, image_url, video_url, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
      [id, req.params.id, req.user.uid, title, content, type, imageUrl, videoUrl]
    );
    res.status(201).json({ update: _parseUpdate(update) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить обновление (владелец стартапа или админ)
router.delete('/:id/updates/:updateId', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    const existing = await queryOne(
      'SELECT id FROM startup_updates WHERE id=$1 AND startup_id=$2',
      [req.params.updateId, req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Обновление не найдено' });
    await queryOne('DELETE FROM startup_updates WHERE id=$1', [req.params.updateId]);
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Задачи (Roadmap/Kanban) ───────────────────────────────
router.get('/:id/tasks', async (req, res) => {
  try {
    await ensureTasksSchema();
    const tasks = await queryAll(
      'SELECT * FROM startup_tasks WHERE startup_id = $1 ORDER BY position ASC, created_at ASC',
      [req.params.id]
    );
    res.json({ tasks });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/:id/tasks', requireAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id = $1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Не найдено' });

    const isOwner = startup.owner_uid === req.user.uid;
    const isAdmin = req.user.role === 'admin';
    const hasPerm = await checkTeamPermission(req.params.id, req.user.uid, 'kanban');
    if (!isOwner && !isAdmin && !hasPerm) return res.status(403).json({ error: 'Нет доступа' });
    await ensureTasksSchema();

    const b = req.body;
    const title       = b.title       || '';
    const description = b.description || '';
    const comments    = b.comments    || '';
    const status      = b.status      || 'todo';
    const assigned_to = b.assigned_to || b.assignedTo || null;
    const position    = b.position    || 0;
    const priority    = b.priority    || 'med';
    const assignee_name = b.assigneeName || b.assignee_name || '';
    const is_public   = b.is_public !== undefined ? b.is_public : (b.isPublic !== undefined ? b.isPublic : true);
    // Блокировку может задать только владелец/админ
    const locked      = (isOwner || isAdmin) ? (b.locked === true || b.locked === 'true') : false;

    const id = uuidv4();
    const task = await queryOne(
      `INSERT INTO startup_tasks (id, startup_id, title, description, comments, status, assigned_to, position, priority, assignee_name, is_public, locked, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *`,
      [id, req.params.id, title, description, comments, status, assigned_to, position, priority, assignee_name, is_public, locked]
    );
    res.status(201).json({ task });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.patch('/:id/tasks/:taskId', requireAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id = $1', [req.params.id]);
    const isOwner = startup && startup.owner_uid === req.user.uid;
    const isAdmin = req.user.role === 'admin';
    const hasPerm = await checkTeamPermission(req.params.id, req.user.uid, 'kanban');
    if (!isOwner && !isAdmin && !hasPerm) return res.status(403).json({ error: 'Нет доступа' });
    await ensureTasksSchema();

    // Если задача заблокирована — редактировать может только владелец/админ
    const current = await queryOne('SELECT locked FROM startup_tasks WHERE id=$1', [req.params.taskId]);
    if (current && current.locked && !isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Задача заблокирована основателем' });
    }

    const bT = req.body;
    // Нормализуем camelCase → snake_case
    if (bT.assignedTo  !== undefined && bT.assigned_to  === undefined) bT.assigned_to  = bT.assignedTo;
    if (bT.assigneeName!== undefined && bT.assignee_name=== undefined) bT.assignee_name= bT.assigneeName;
    if (bT.isPublic    !== undefined && bT.is_public    === undefined) bT.is_public    = bT.isPublic;
    const allowed = ['title', 'description', 'comments', 'status', 'assigned_to', 'position', 'priority', 'assignee_name', 'is_public'];
    // Блокировку меняет только владелец/админ
    if (isOwner || isAdmin) allowed.push('locked');
    const updates = []; const values = [];
    allowed.forEach(f => {
      if (bT[f] !== undefined) { values.push(bT[f]); updates.push(`${f}=$${values.length}`); }
    });
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });
    values.push(req.params.taskId);
    const task = await queryOne(
      `UPDATE startup_tasks SET ${updates.join(',')} WHERE id=$${values.length} RETURNING *`, values
    );
    res.json({ task });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.delete('/:id/tasks/:taskId', requireAuth, async (req, res) => {
  try {
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id = $1', [req.params.id]);
    const isOwner = startup && startup.owner_uid === req.user.uid;
    if (!isOwner && req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    await queryOne('DELETE FROM startup_tasks WHERE id = $1', [req.params.taskId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /:id/tasks/:taskId/comments — комментарии правят все участники стартапа
// (не зависит от блокировки задачи и от права kanban)
router.patch('/:id/tasks/:taskId/comments', requireAuth, async (req, res) => {
  try {
    await ensureTasksSchema();
    const startup = await queryOne('SELECT owner_uid FROM startups WHERE id = $1', [req.params.id]);
    if (!startup) return res.status(404).json({ error: 'Стартап не найден' });
    const isOwner = startup.owner_uid === req.user.uid;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin && !(await isStartupMember(req.params.id, req.user.uid))) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    const comments = req.body.comments !== undefined ? String(req.body.comments) : '';
    // Фильтр слов для комментариев к задачам (область публичного контента)
    const cen = await checkCensor(comments, 'forum');
    if (cen.blocked) return res.status(400).json({ error: cen.message });
    const task = await queryOne(
      'UPDATE startup_tasks SET comments=$1 WHERE id=$2 AND startup_id=$3 RETURNING *',
      [comments, req.params.taskId, req.params.id]
    );
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });
    res.json({ task });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Вакансии ─────────────────────────────────────────────
router.get('/:id/vacancies', async (req, res) => {
  try {
    const rows = await queryAll('SELECT * FROM startup_vacancies WHERE startup_id=$1', [req.params.id]);
    res.json({ vacancies: rows.map(v => ({ ...v, applicants: tryParse(v.applicants, []) })) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/:id/vacancies', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    const { title, description, skills } = req.body;
    const id = uuidv4();
    const vac = await queryOne(
      `INSERT INTO startup_vacancies (id, startup_id, title, description, skills, applicants, created_at)
       VALUES ($1,$2,$3,$4,$5,'[]',NOW()) RETURNING *`,
      [id, req.params.id, title || '', description || '', JSON.stringify(skills || [])]
    );
    res.status(201).json({ vacancy: vac });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.delete('/:id/vacancies/:vacId', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    await queryOne('DELETE FROM startup_vacancies WHERE id=$1', [req.params.vacId]);
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Подать заявку на вакансию (добавить applicant)
router.post('/:id/vacancies/:vacId/apply', requireAuth, async (req, res) => {
  try {
    const vac = await queryOne('SELECT * FROM startup_vacancies WHERE id=$1', [req.params.vacId]);
    if (!vac) return res.status(404).json({ error: 'Вакансия не найдена' });
    const applicants = tryParse(vac.applicants, []);
    if (!applicants.find(a => a.uid === req.user.uid)) {
      applicants.push({ uid: req.user.uid, appliedAt: new Date().toISOString() });
      await queryOne('UPDATE startup_vacancies SET applicants=$1 WHERE id=$2',
        [JSON.stringify(applicants), req.params.vacId]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Витрина товаров ───────────────────────────────────────
// Доступ на чтение: как у самого стартапа (приватность проверяется на клиенте
// так же, как для команды/обновлений). Изменять — только владелец/админ.
function parseProduct(p) {
  return {
    ...p,
    imageUrl:  p.image_url,
    buyUrl:    p.buy_url,
    startupId: p.startup_id,
    createdAt: p.created_at,
  };
}

// Обрезаем и валидируем поля товара
function sanitizeProductInput(body) {
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  return {
    name:        clip(body.name, 120),
    description: clip(body.description, 2000),
    image_url:   clip(body.image_url != null ? body.image_url : body.imageUrl, 1000),
    price:       clip(body.price, 60),
    buy_url:     clip(body.buy_url != null ? body.buy_url : body.buyUrl, 1000),
  };
}

// Разрешаем только http(s)-ссылки — чтобы в кнопку «Купить» не попал javascript:/data:
function isSafeHttpUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

router.get('/:id/products', async (req, res) => {
  try {
    await ensureProductsSchema();
    const rows = await queryAll(
      'SELECT * FROM startup_products WHERE startup_id=$1 ORDER BY position ASC, created_at ASC',
      [req.params.id]
    );
    res.json({ products: rows.map(parseProduct) });
  } catch (e) {
    console.error('GET products error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/:id/products', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    await ensureProductsSchema();
    const data = sanitizeProductInput(req.body);
    if (!data.description) return res.status(400).json({ error: 'Добавьте описание товара' });
    if (!isSafeHttpUrl(data.buy_url)) {
      return res.status(400).json({ error: 'Укажите корректную ссылку «Купить» (http/https)' });
    }
    const posRow = await queryOne(
      'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM startup_products WHERE startup_id=$1',
      [req.params.id]
    );
    const id = uuidv4();
    const product = await queryOne(
      `INSERT INTO startup_products (id, startup_id, name, description, image_url, price, buy_url, position, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
      [id, req.params.id, data.name, data.description, data.image_url, data.price, data.buy_url, posRow ? posRow.pos : 0]
    );
    res.status(201).json({ product: parseProduct(product) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('POST products error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.patch('/:id/products/:productId', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    await ensureProductsSchema();
    const existing = await queryOne(
      'SELECT * FROM startup_products WHERE id=$1 AND startup_id=$2',
      [req.params.productId, req.params.id]
    );
    if (!existing) return res.status(404).json({ error: 'Товар не найден' });

    const data = sanitizeProductInput(req.body);
    if (!data.description) return res.status(400).json({ error: 'Добавьте описание товара' });
    if (!isSafeHttpUrl(data.buy_url)) {
      return res.status(400).json({ error: 'Укажите корректную ссылку «Купить» (http/https)' });
    }
    const product = await queryOne(
      `UPDATE startup_products SET name=$1, description=$2, image_url=$3, price=$4, buy_url=$5
       WHERE id=$6 RETURNING *`,
      [data.name, data.description, data.image_url, data.price, data.buy_url, req.params.productId]
    );
    res.json({ product: parseProduct(product) });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.delete('/:id/products/:productId', requireAuth, async (req, res) => {
  try {
    await assertOwnerOrAdmin(req.params.id, req.user);
    await ensureProductsSchema();
    await queryOne('DELETE FROM startup_products WHERE id=$1 AND startup_id=$2',
      [req.params.productId, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Хелперы ───────────────────────────────────────────────
async function assertOwnerOrAdmin(startupId, user) {
  const startup = await queryOne('SELECT owner_uid FROM startups WHERE id=$1', [startupId]);
  if (!startup) { const e = new Error('Стартап не найден'); e.status = 404; throw e; }
  if (startup.owner_uid !== user.uid && user.role !== 'admin') {
    const e = new Error('Нет доступа'); e.status = 403; throw e;
  }
}

async function checkTeamPermission(startupId, uid, perm) {
  const member = await queryOne(
    'SELECT permissions FROM startup_team WHERE startup_id=$1 AND user_uid=$2',
    [startupId, uid]
  );
  if (!member) return false;
  const perms = tryParse(member.permissions, {});
  return perms[perm] === true;
}

function parseStartup(s) {
  return {
    ...s,
    tags: tryParse(s.tags, []),
    content_blocks: tryParse(s.content_blocks, []),
    attachments: tryParse(s.attachments, []),
    // Поля с camelCase для совместимости с фронтендом
    ownerUid: s.owner_uid,
    ownerName: s.owner_name,
    contentBlocks: tryParse(s.content_blocks, []),
    coverImage: s.cover_image,
    iconImage: s.icon_image,
    lookingFor: s.looking_for,
  };
}

function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

// Нормализация обновления — добавляем алиасы для совместимости с фронтендом
function _parseUpdate(u) {
  if (!u) return u;
  return {
    ...u,
    body:       u.content || u.body || '',   // фронтенд читает .body
    imageUrl:   u.image_url || '',
    videoUrl:   u.video_url || '',
    authorUid:  u.author_uid,
    authorName: u.author_name,
    createdAt:  u.created_at,
    likes:      u.likes || 0,
    liked:      u.liked === true,
  };
}

module.exports = router;
