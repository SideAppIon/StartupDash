const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Ленивая миграция: добавляем колонку vacancy_id, если её ещё нет.
// Автоматического раннера миграций нет, поэтому выполняем один раз за процесс.
let schemaEnsured = false;
async function ensureSchema() {
  if (schemaEnsured) return;
  try {
    await query('ALTER TABLE invites ADD COLUMN IF NOT EXISTS vacancy_id TEXT');
    // Расширяем CHECK по статусу: PATCH допускает 'removed', а старое ограничение — нет.
    await query('ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_status_check');
    await query(
      `ALTER TABLE invites ADD CONSTRAINT invites_status_check
         CHECK (status IN ('pending','accepted','rejected','removed'))`
    );
    schemaEnsured = true;
  } catch (e) {
    console.error('ensureSchema invites error:', e.message);
  }
}

// GET /invites — получить приглашения с поддержкой любых фильтров
router.get('/', requireAuth, async (req, res) => {
  try {
    const q = req.query;
    let sql = 'SELECT * FROM invites WHERE 1=1';
    const params = [];

    // Фильтры по конкретным полям (приоритет)
    if (q.to_uid) {
      params.push(q.to_uid); sql += ` AND to_uid = $${params.length}`;
    }
    if (q.from_uid) {
      params.push(q.from_uid); sql += ` AND from_uid = $${params.length}`;
    }
    if (q.startup_id) {
      params.push(q.startup_id); sql += ` AND startup_id = $${params.length}`;
    }
    if (q.startup_owner) {
      params.push(q.startup_owner); sql += ` AND startup_owner = $${params.length}`;
    }
    if (q.status) {
      params.push(q.status); sql += ` AND status = $${params.length}`;
    }
    if (q.type) {
      params.push(q.type); sql += ` AND type = $${params.length}`;
    }

    // Если ни одного фильтра нет — показываем связанные с текущим пользователем
    if (!q.to_uid && !q.from_uid && !q.startup_id && !q.startup_owner) {
      if (q.direction === 'sent') {
        params.push(req.user.uid); sql += ` AND from_uid = $${params.length}`;
      } else if (q.direction === 'received') {
        params.push(req.user.uid); sql += ` AND startup_owner = $${params.length}`;
      } else {
        params.push(req.user.uid);
        sql += ` AND (from_uid = $${params.length} OR startup_owner = $${params.length} OR to_uid = $${params.length})`;
      }
    }

    sql += ' ORDER BY created_at DESC';
    const invites = await queryAll(sql, params);
    res.json({ invites: invites.map(parseInvite) });
  } catch (e) {
    console.error('GET /invites error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /invites/:id — получить одно приглашение
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const invite = await queryOne('SELECT * FROM invites WHERE id = $1', [req.params.id]);
    if (!invite) return res.status(404).json({ error: 'Приглашение не найдено' });

    // Проверяем что пользователь связан с этим приглашением
    const uid = req.user.uid;
    if (invite.from_uid !== uid && invite.to_uid !== uid &&
        invite.startup_owner !== uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    res.json({ invite: parseInvite(invite) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /invites — создать заявку (специалист → стартап) или приглашение (стартап → специалист)
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureSchema();
    const b = req.body;
    // Принимаем и snake_case и camelCase
    const startup_id    = b.startup_id    || b.startupId;
    const startup_name  = b.startup_name  || b.startupName  || '';
    const startup_owner = b.startup_owner || b.startupOwner || '';
    const to_uid        = b.to_uid        || b.toUid        || null;
    const from_skills   = b.from_skills   || b.fromSkills   || [];
    const vacancy_id    = b.vacancy_id    || b.vacancyId    || null;
    const { type, role, expert_area, message, applications } = b;

    if (!startup_id) return res.status(400).json({ error: 'startup_id обязателен' });

    // Проверяем дубль (pending/accepted от того же from_uid).
    // Для отклика на вакансию — дубль считаем по конкретной вакансии,
    // для общей заявки — по стартапу (среди заявок без вакансии).
    if (!to_uid) { // это заявка от пользователя
      let existing;
      if (vacancy_id) {
        existing = await queryOne(
          `SELECT id FROM invites WHERE from_uid=$1 AND startup_id=$2 AND vacancy_id=$3 AND status IN ('pending','accepted')`,
          [req.user.uid, startup_id, vacancy_id]
        );
      } else {
        existing = await queryOne(
          `SELECT id FROM invites WHERE from_uid=$1 AND startup_id=$2 AND vacancy_id IS NULL AND status IN ('pending','accepted')`,
          [req.user.uid, startup_id]
        );
      }
      if (existing) {
        return res.status(409).json({
          error: vacancy_id ? 'Ты уже откликнулся на эту вакансию' : 'Заявка уже отправлена',
        });
      }
    }

    const id = uuidv4();
    const user = await queryOne('SELECT name, avatar FROM users WHERE uid=$1', [req.user.uid]);

    const invite = await queryOne(
      `INSERT INTO invites
         (id, from_uid, from_name, from_avatar, from_skills,
          to_uid, startup_id, startup_name, startup_owner,
          type, role, expert_area, message, applications, vacancy_id, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',NOW())
       RETURNING *`,
      [id,
       req.user.uid, user.name, user.avatar || '', JSON.stringify(from_skills || []),
       to_uid || null, startup_id, startup_name || '', startup_owner || '',
       type || 'specialist', role || 'Специалист', expert_area || '',
       message || '', JSON.stringify(applications || []), vacancy_id]
    );

    res.status(201).json({ invite: parseInvite(invite) });
  } catch (e) {
    console.error('POST /invites error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /invites/:id — принять/отклонить (owner стартапа, или получатель)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const invite = await queryOne('SELECT * FROM invites WHERE id=$1', [req.params.id]);
    if (!invite) return res.status(404).json({ error: 'Приглашение не найдено' });

    const canUpdate = invite.startup_owner === req.user.uid
      || invite.from_uid === req.user.uid
      || invite.to_uid === req.user.uid
      || req.user.role === 'admin';

    if (!canUpdate) return res.status(403).json({ error: 'Нет доступа' });

    const { status, role, permissions, applications } = req.body;

    if (status !== undefined && !['pending', 'accepted', 'rejected', 'removed'].includes(status)) {
      return res.status(400).json({ error: 'Неверный статус' });
    }

    // Если принимаем — добавляем в команду стартапа
    if (status === 'accepted') {
      const memberUid = (invite.type === 'from_startup' && invite.to_uid)
        ? invite.to_uid
        : invite.from_uid;
      const memberRole = role || invite.role || 'Участник';
      await queryOne(
        `INSERT INTO startup_team (startup_id, user_uid, role, permissions)
         VALUES ($1,$2,$3,'{}')
         ON CONFLICT (startup_id, user_uid) DO UPDATE SET role=$3`,
        [invite.startup_id, memberUid, memberRole]
      );
    }

    // Обновляем только переданные поля
    const invUpdates = [];
    const invParams  = [];
    if (status !== undefined)      { invParams.push(status);                       invUpdates.push(`status=$${invParams.length}`); }
    if (role !== undefined)        { invParams.push(role);                          invUpdates.push(`role=$${invParams.length}`); }
    if (permissions !== undefined) { invParams.push(JSON.stringify(permissions));   invUpdates.push(`permissions=$${invParams.length}`); }
    if (applications !== undefined){ invParams.push(JSON.stringify(applications));  invUpdates.push(`applications=$${invParams.length}`); }

    if (!invUpdates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    invParams.push(req.params.id);
    const updated = await queryOne(
      `UPDATE invites SET ${invUpdates.join(', ')} WHERE id=$${invParams.length} RETURNING *`,
      invParams
    );

    res.json({ invite: parseInvite(updated) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /invites/:id — удалить инвайт (владелец стартапа или участник)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const invite = await queryOne('SELECT * FROM invites WHERE id=$1', [req.params.id]);
    if (!invite) return res.status(404).json({ error: 'Приглашение не найдено' });
    const canDelete = invite.startup_owner === req.user.uid
      || invite.from_uid === req.user.uid
      || invite.to_uid === req.user.uid
      || req.user.role === 'admin';
    if (!canDelete) return res.status(403).json({ error: 'Нет доступа' });
    await queryOne('DELETE FROM invites WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function parseInvite(inv) {
  return {
    ...inv,
    from_skills: tryParse(inv.from_skills, []),
    applications: tryParse(inv.applications, []),
    // camelCase алиасы для совместимости с фронтендом
    fromUid: inv.from_uid,
    fromName: inv.from_name,
    fromAvatar: inv.from_avatar,
    toUid: inv.to_uid,
    startupId: inv.startup_id,
    startupName: inv.startup_name,
    startupOwner: inv.startup_owner,
    expertArea: inv.expert_area,
    vacancyId: inv.vacancy_id,
  };
}

function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

module.exports = router;
