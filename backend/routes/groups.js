const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { ensureModeratorSchema } = require('../lib/moderation');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только администратор' });
  next();
}

// GET /groups — список групп (только admin)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const groups = await queryAll(
      `SELECT g.*,
              COUNT(ug.user_uid)::int AS member_count
       FROM groups g
       LEFT JOIN user_groups ug ON ug.group_id = g.id
       GROUP BY g.id
       ORDER BY g.created_at DESC`,
      []
    );
    res.json({ groups });
  } catch (e) {
    console.error('[groups GET]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /groups — создать группу
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, startup_visibility = 'all', messaging_restriction = false } = req.body;
    if (!name) return res.status(400).json({ error: 'name обязателен' });
    const id = uuidv4();
    const group = await queryOne(
      `INSERT INTO groups (id, name, startup_visibility, messaging_restriction, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
      [id, name, startup_visibility, messaging_restriction]
    );
    res.status(201).json({ group });
  } catch (e) {
    console.error('[groups POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /groups/:id — обновить настройки группы
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, startup_visibility, messaging_restriction } = req.body;
    const updates = [];
    const values  = [];
    if (name !== undefined)                   { values.push(name);                   updates.push(`name=$${values.length}`); }
    if (startup_visibility !== undefined)      { values.push(startup_visibility);      updates.push(`startup_visibility=$${values.length}`); }
    if (messaging_restriction !== undefined)   { values.push(messaging_restriction);   updates.push(`messaging_restriction=$${values.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });
    values.push(req.params.id);
    const group = await queryOne(
      `UPDATE groups SET ${updates.join(',')} WHERE id=$${values.length} RETURNING *`,
      values
    );
    res.json({ group });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /groups/:id — удалить группу
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await queryOne('DELETE FROM groups WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /groups/:id/members — участники группы
router.get('/:id/members', requireAuth, requireAdmin, async (req, res) => {
  try {
    const members = await queryAll(
      `SELECT u.uid, u.name, u.email, u.role, u.avatar
       FROM user_groups ug
       JOIN users u ON u.uid = ug.user_uid
       WHERE ug.group_id = $1
       ORDER BY u.name`,
      [req.params.id]
    );
    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /groups/:id/members — добавить участника
router.post('/:id/members', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { user_uid } = req.body;
    if (!user_uid) return res.status(400).json({ error: 'user_uid обязателен' });
    await queryOne(
      'INSERT INTO user_groups (user_uid, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [user_uid, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /groups/:id/members/:uid — удалить участника
router.delete('/:id/members/:uid', requireAuth, requireAdmin, async (req, res) => {
  try {
    await queryOne(
      'DELETE FROM user_groups WHERE group_id=$1 AND user_uid=$2',
      [req.params.id, req.params.uid]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Модераторы группы ─────────────────────────────────────
// GET /groups/:id/moderators — модераторы, закреплённые за группой
router.get('/:id/moderators', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureModeratorSchema();
    const mods = await queryAll(
      `SELECT u.uid, u.name, u.email, u.role, u.avatar
       FROM moderator_groups mg
       JOIN users u ON u.uid = mg.moderator_uid
       WHERE mg.group_id = $1
       ORDER BY u.name`,
      [req.params.id]
    );
    res.json({ moderators: mods });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /groups/:id/moderators — закрепить модератора за группой
router.post('/:id/moderators', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureModeratorSchema();
    const { user_uid } = req.body;
    if (!user_uid) return res.status(400).json({ error: 'user_uid обязателен' });
    const user = await queryOne('SELECT role FROM users WHERE uid=$1', [user_uid]);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (user.role !== 'moderator') {
      return res.status(400).json({ error: 'Назначить можно только пользователя с ролью «модератор»' });
    }
    await queryOne(
      'INSERT INTO moderator_groups (moderator_uid, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [user_uid, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /groups/:id/moderators/:uid — снять модератора с группы
router.delete('/:id/moderators/:uid', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureModeratorSchema();
    await queryOne(
      'DELETE FROM moderator_groups WHERE group_id=$1 AND moderator_uid=$2',
      [req.params.id, req.params.uid]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Хелпер: получить настройки группы пользователя ────────
// Экспортируем для использования в других роутах
async function getUserGroupSettings(uid) {
  const row = await queryOne(
    `SELECT g.startup_visibility, g.messaging_restriction, g.id AS group_id
     FROM user_groups ug
     JOIN groups g ON g.id = ug.group_id
     WHERE ug.user_uid = $1
     LIMIT 1`,
    [uid]
  );
  return row || null; // null = нет группы = без ограничений
}

module.exports = router;
module.exports.getUserGroupSettings = getUserGroupSettings;
