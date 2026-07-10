const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth, optionalAuth, signToken } = require('../middleware/auth');
const { ensureModeratorSchema, isAdmin, moderatorCanActOn } = require('../lib/moderation');

const router = express.Router();

// Доп. колонки пользователя: мягкое скрытие (hidden) и статус эксперта (expert_status)
let hiddenSchemaEnsured = false;
async function ensureHiddenSchema() {
  if (hiddenSchemaEnsured) return;
  try {
    await queryOne('ALTER TABLE users ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE');
    // Статус эксперта: 'available' (готов помочь, по умолчанию) | 'busy' (занят)
    await queryOne("ALTER TABLE users ADD COLUMN IF NOT EXISTS expert_status TEXT DEFAULT 'available'");
    // Значок-алмаз (💎) — включается админом для конкретного пользователя
    await queryOne('ALTER TABLE users ADD COLUMN IF NOT EXISTS diamond BOOLEAN DEFAULT FALSE');
    hiddenSchemaEnsured = true;
  } catch (e) {
    console.error('ensureHiddenSchema (users) error:', e.message);
  }
}

// GET /users — список всех (публично); admin видит onboarding_done
router.get('/', optionalAuth, async (req, res) => {
  try {
    await ensureHiddenSchema();
    const { role, search } = req.query;
    const isAdmin = req.user && req.user.role === 'admin';
    let sql = `SELECT uid, name, email, role, bio, skills, avatar, contacts, portfolio, forum_banned, hidden, expert_status, diamond, created_at, onboarding_done
               FROM users WHERE 1=1`;
    const params = [];

    // Модераторы — скрытая роль: в общем списке их не показываем (видит только админ)
    if (!isAdmin) sql += ` AND role <> 'moderator'`;

    // Мягко скрытые админом — не показываем (сам пользователь видит себя)
    if (!isAdmin) {
      if (req.user) {
        params.push(req.user.uid);
        sql += ` AND (hidden IS NOT TRUE OR uid = $${params.length})`;
      } else {
        sql += ` AND hidden IS NOT TRUE`;
      }
    }

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
router.get('/:uid', optionalAuth, async (req, res) => {
  try {
    await ensureHiddenSchema();
    const user = await queryOne(
      `SELECT uid, name, email, role, bio, skills, avatar, contacts, portfolio, forum_banned, hidden, expert_status, diamond, created_at
       FROM users WHERE uid = $1`,
      [req.params.uid]
    );
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    // Мягко скрытый — «не найден» для всех, кроме самого пользователя и админа
    const viewerUid = req.user && req.user.uid;
    const viewerRole = req.user && req.user.role;
    if (user.hidden && viewerUid !== user.uid && viewerRole !== 'admin') {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
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
    await ensureHiddenSchema();

    // Статус эксперта: принимаем camelCase и snake_case, валидируем значение
    const rawStatus = req.body.expert_status !== undefined ? req.body.expert_status : req.body.expertStatus;
    if (rawStatus !== undefined) {
      req.body.expert_status = (rawStatus === 'busy') ? 'busy' : 'available';
    }

    const allowed = ['name', 'bio', 'skills', 'avatar', 'contacts', 'portfolio', 'expert_status'];
    if (req.user.role === 'admin') allowed.push('role', 'blocked', 'forum_banned', 'hidden', 'diamond');
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
       RETURNING uid, name, email, role, bio, skills, avatar, contacts, portfolio, expert_status`,
      values
    );

    res.json({ user: parseUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /users/:uid/password — сменить пароль (себе или admin принудительно)
router.patch('/:uid/password', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const isSelf  = req.user.uid === req.params.uid;
    if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Нет доступа' });

    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }

    // Обычный пользователь должен подтвердить старый пароль; admin — нет
    if (isSelf && !isAdmin) {
      const user = await queryOne('SELECT password_hash FROM users WHERE uid=$1', [req.params.uid]);
      const valid = await bcrypt.compare(currentPassword || '', user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Неверный текущий пароль' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await queryOne('UPDATE users SET password_hash=$1 WHERE uid=$2', [hash, req.params.uid]);
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
    const valid = ['user', 'startup', 'expert', 'admin', 'moderator'];
    if (!valid.includes(role)) return res.status(400).json({ error: 'Неверная роль' });

    await queryOne('UPDATE users SET role = $1 WHERE uid = $2', [role, req.params.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Модератор/админ: PATCH /users/:uid/forum-ban — запретить/разрешить общение на форуме (мут)
router.patch('/:uid/forum-ban', requireAuth, async (req, res) => {
  try {
    const isMod = req.user.role === 'admin' || req.user.role === 'moderator';
    if (!isMod) return res.status(403).json({ error: 'Только модератор или администратор' });
    await ensureModeratorSchema();

    // Нельзя банить администраторов и модераторов
    const target = await queryOne('SELECT role FROM users WHERE uid=$1', [req.params.uid]);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.role === 'admin' || target.role === 'moderator') {
      return res.status(403).json({ error: 'Нельзя ограничить администратора или модератора' });
    }
    // Модератор может мутить только пользователей своей группы
    if (!isAdmin(req.user) && !(await moderatorCanActOn(req.user.uid, req.params.uid))) {
      return res.status(403).json({ error: 'Пользователь вне вашей группы' });
    }

    const banned = req.body.banned === true || req.body.banned === 'true';
    await queryOne('UPDATE users SET forum_banned=$1 WHERE uid=$2', [banned, req.params.uid]);
    res.json({ ok: true, forum_banned: banned });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Модератор/админ: PATCH /users/:uid/reset-avatar — сбросить аватар на дефолтный
router.patch('/:uid/reset-avatar', requireAuth, async (req, res) => {
  try {
    const isMod = req.user.role === 'admin' || req.user.role === 'moderator';
    if (!isMod) return res.status(403).json({ error: 'Только модератор или администратор' });
    await ensureModeratorSchema();

    const target = await queryOne('SELECT role FROM users WHERE uid=$1', [req.params.uid]);
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.role === 'admin' || target.role === 'moderator') {
      return res.status(403).json({ error: 'Нельзя сбросить аватар администратора или модератора' });
    }
    // Модератор может сбрасывать аватар только пользователям своей группы
    if (!isAdmin(req.user) && !(await moderatorCanActOn(req.user.uid, req.params.uid))) {
      return res.status(403).json({ error: 'Пользователь вне вашей группы' });
    }

    await queryOne("UPDATE users SET avatar='' WHERE uid=$1", [req.params.uid]);
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

// Admin: POST /users/admin/create — создать пользователя из админки
router.post('/admin/create', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только администратор' });
    const { email, password, name, role } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password и name обязательны' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    const validRoles = ['user', 'startup', 'expert', 'admin', 'moderator'];
    const userRole = validRoles.includes(role) ? role : 'user';

    const existing = await queryOne('SELECT uid FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Email уже занят' });

    const uid          = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    await queryOne(
      `INSERT INTO users (uid, email, password_hash, name, role, bio, skills, contacts, portfolio, avatar, onboarding_done, created_at)
       VALUES ($1,$2,$3,$4,$5,'','[]','','','',FALSE,NOW())`,
      [uid, email.toLowerCase(), passwordHash, name, userRole]
    );
    res.status(201).json({ ok: true, uid });
  } catch (e) {
    console.error('admin create user:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /users/:uid/onboarding-done — пользователь завершил онбординг
router.patch('/:uid/onboarding-done', requireAuth, async (req, res) => {
  try {
    if (req.user.uid !== req.params.uid && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    await queryOne('UPDATE users SET onboarding_done=TRUE WHERE uid=$1', [req.params.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Admin: PATCH /users/:uid/reset-onboarding — сброс онбординга
router.patch('/:uid/reset-onboarding', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только администратор' });
    await queryOne('UPDATE users SET onboarding_done=FALSE WHERE uid=$1', [req.params.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function parseUser(u) {
  if (u.skills && typeof u.skills === 'string') {
    try { u.skills = JSON.parse(u.skills); } catch(e) { u.skills = []; }
  }
  // camelCase-алиас для фронтенда
  if (u.expert_status !== undefined) u.expertStatus = u.expert_status;
  return u;
}

module.exports = router;
