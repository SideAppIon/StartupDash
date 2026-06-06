const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// GET /startups — каталог (публично, с фильтрами)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, stage, search, owner_uid } = req.query;
    let sql = `SELECT * FROM startups WHERE 1=1`;
    const params = [];

    // Закрытые стартапы не показываем обычным пользователям
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isAdmin) {
      sql += ` AND privacy != 'closed'`;
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

    // Закрытый — только для владельца и админа
    if (startup.privacy === 'closed') {
      const uid = req.user && req.user.uid;
      const role = req.user && req.user.role;
      if (uid !== startup.owner_uid && role !== 'admin') {
        return res.status(403).json({ error: 'Доступ закрыт' });
      }
    }

    res.json({ startup: parseStartup(startup) });
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

    if (!name || !tagline) return res.status(400).json({ error: 'name и tagline обязательны' });

    const id = uuidv4();
    const startup = await queryOne(
      `INSERT INTO startups
         (id, owner_uid, owner_name, name, tagline, stage, category, website,
          looking_for, cover_image, emoji, icon_image, tags, privacy, content_blocks, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())
       RETURNING *`,
      [id, req.user.uid, req.user.name || '',
       name, tagline, stage || 'Идея', category || '',
       website || '', looking_for || '',
       cover_image || '', emoji || '🚀', icon_image || '',
       JSON.stringify(tags || []),
       privacy || 'public',
       JSON.stringify(content_blocks || [])]
    );

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

    const allowed = ['name', 'tagline', 'stage', 'category', 'website', 'looking_for',
                     'cover_image', 'emoji', 'icon_image', 'tags', 'privacy', 'content_blocks'];
    const updates = [];
    const values  = [];

    allowed.forEach(field => {
      if (normalized[field] !== undefined && normalized[field] !== null) {
        const val = ['tags', 'content_blocks'].includes(field)
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
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
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
    res.json({ ok: true });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Обновления проекта ────────────────────────────────────
router.get('/:id/updates', async (req, res) => {
  try {
    const updates = await queryAll(
      `SELECT u.*, usr.name AS author_name, usr.avatar AS author_avatar
       FROM startup_updates u
       JOIN users usr ON usr.uid = u.author_uid
       WHERE u.startup_id = $1
       ORDER BY u.created_at DESC`,
      [req.params.id]
    );
    res.json({ updates: updates.map(_parseUpdate) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/:id/updates', requireAuth, async (req, res) => {
  try {
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

    if (!content) return res.status(400).json({ error: 'Напиши содержание обновления' });

    const id = uuidv4();
    const update = await queryOne(
      `INSERT INTO startup_updates (id, startup_id, author_uid, title, content, type, image_url, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING *`,
      [id, req.params.id, req.user.uid, title, content, type, imageUrl]
    );
    res.status(201).json({ update: _parseUpdate(update) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Задачи (Roadmap/Kanban) ───────────────────────────────
router.get('/:id/tasks', async (req, res) => {
  try {
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

    const b = req.body;
    const title       = b.title       || '';
    const description = b.description || '';
    const status      = b.status      || 'todo';
    const assigned_to = b.assigned_to || b.assignedTo || null;
    const position    = b.position    || 0;
    const priority    = b.priority    || 'med';
    const assignee_name = b.assigneeName || b.assignee_name || '';
    const is_public   = b.is_public !== undefined ? b.is_public : (b.isPublic !== undefined ? b.isPublic : true);

    const id = uuidv4();
    const task = await queryOne(
      `INSERT INTO startup_tasks (id, startup_id, title, description, status, assigned_to, position, priority, assignee_name, is_public, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING *`,
      [id, req.params.id, title, description, status, assigned_to, position, priority, assignee_name, is_public]
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

    const bT = req.body;
    // Нормализуем camelCase → snake_case
    if (bT.assignedTo  !== undefined && bT.assigned_to  === undefined) bT.assigned_to  = bT.assignedTo;
    if (bT.assigneeName!== undefined && bT.assignee_name=== undefined) bT.assignee_name= bT.assigneeName;
    if (bT.isPublic    !== undefined && bT.is_public    === undefined) bT.is_public    = bT.isPublic;
    const allowed = ['title', 'description', 'status', 'assigned_to', 'position', 'priority', 'assignee_name', 'is_public'];
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
    authorUid:  u.author_uid,
    authorName: u.author_name,
    createdAt:  u.created_at,
  };
}

module.exports = router;
