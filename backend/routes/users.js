const express = require('express');
const bcrypt  = require('bcryptjs');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /users — список всех (публично)
router.get('/', async (req, res) => {
  try {
    const { role, search } = req.query;
    let sql = `SELECT uid, name, email, role, bio, skills, avatar, contacts, portfolio, created_at
               FROM users WHERE 1=1`;
    const params = [];

    if (role) {
      params.push(role);
      sql += ` AND role = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (name ILIKE $${params.length} OR bio ILIKE $${params.length})`;
    }
    sql += ' ORDER BY created_at DESC';

    const users = await queryAll(sql, params);
    res.json({ users: users.map(parseUser) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /users/:uid — профиль пользователя (публично)
router.get('/:uid', async (req, res) => {
  try {
    const user = await queryOne(
      `SELECT uid, name, email, role, bio, skills, avatar, contacts, portfolio, created_at
       FROM users WHERE uid = $1`,
      [req.params.uid]
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ user: parseUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /users/:uid — обновить профиль (только свой)
router.patch('/:uid', requireAuth, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const allowed = ['name', 'bio', 'skills', 'avatar', 'contacts', 'portfolio'];
    if (req.user.role === 'admin') allowed.push('role', 'blocked');
    const updates = [];
    const values  = [];

    allowed.forEach(field => {
      if (req.body[field] !== undefined) {
        values.push(field === 'skills' ? JSON.stringify(req.body[field]) : req.body[field]);
        updates.push(`${field} = $${values.length}`);
      }
    });

    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });

    values.push(req.params.uid);
    const user = await queryOne(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE uid = $${values.length}
       RETURNING uid, name, email, role, bio, skills, avatar, contacts, portfolio`,
      values
    );

    res.json({ user: parseUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /users/:uid/password — сменить пароль
router.patch('/:uid/password', requireAuth, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Новый пароль минимум 6 символов' });
    }

    const user = await queryOne('SELECT * FROM users WHERE uid = $1', [req.params.uid]);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Неверный текущий пароль' });

    const hash = await bcrypt.hash(newPassword, 10);
    await queryOne('UPDATE users SET password_hash = $1 WHERE uid = $2', [hash, req.params.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Admin: PATCH /users/:uid/role
router.patch('/:uid/role', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только администратор' });
    const { role } = req.body;
    const valid = ['user', 'startup', 'expert', 'admin'];
    if (!valid.includes(role)) return res.status(400).json({ error: 'Неверная роль' });

    await queryOne('UPDATE users SET role = $1 WHERE uid = $2', [role, req.params.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Admin: DELETE /users/:uid
router.delete('/:uid', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только администратор' });
    await queryOne('DELETE FROM users WHERE uid = $1', [req.params.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function parseUser(u) {
  if (u.skills && typeof u.skills === 'string') {
    try { u.skills = JSON.parse(u.skills); } catch(e) { u.skills = []; }
  }
  return u;
}

module.exports = router;
