const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
    const {
      startup_id, startup_name, startup_owner,
      to_uid,
      type, role, expert_area, message, applications, from_skills
    } = req.body;

    if (!startup_id) return res.status(400).json({ error: 'startup_id обязателен' });

    // Проверяем дубль (pending/accepted от того же from_uid в тот же стартап)
    if (!to_uid) { // это заявка от пользователя
      const existing = await queryOne(
        `SELECT id FROM invites WHERE from_uid=$1 AND startup_id=$2 AND status IN ('pending','accepted')`,
        [req.user.uid, startup_id]
      );
      if (existing) return res.status(409).json({ error: 'Заявка уже отправлена' });
    }

    const id = uuidv4();
    const user = await queryOne('SELECT name, avatar FROM users WHERE uid=$1', [req.user.uid]);

    const invite = await queryOne(
      `INSERT INTO invites
         (id, from_uid, from_name, from_avatar, from_skills,
          to_uid, startup_id, startup_name, startup_owner,
          type, role, expert_area, message, applications, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',NOW())
       RETURNING *`,
      [id,
       req.user.uid, user.name, user.avatar || '', JSON.stringify(from_skills || []),
       to_uid || null, startup_id, startup_name || '', startup_owner || '',
       type || 'specialist', role || 'Специалист', expert_area || '',
       message || '', JSON.stringify(applications || [])]
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

    const { status } = req.body;
    if (!['pending', 'accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Неверный статус' });
    }

    // Если принимаем специалиста/эксперта — добавляем в команду стартапа
    if (status === 'accepted') {
      await queryOne(
        `INSERT INTO startup_team (startup_id, user_uid, role, permissions)
         VALUES ($1,$2,$3,'{}')
         ON CONFLICT (startup_id, user_uid) DO NOTHING`,
        [invite.startup_id, invite.from_uid, invite.role || 'Участник']
      );
    }

    const updated = await queryOne(
      'UPDATE invites SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );

    res.json({ invite: parseInvite(updated) });
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
  };
}

function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

module.exports = router;
