const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { queryOne } = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role, bio, skills, contacts, portfolio } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password и name обязательны' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    }
    const validRoles = ['user', 'startup', 'expert'];
    const userRole = validRoles.includes(role) ? role : 'user';

    // Проверяем дубль email
    const existing = await queryOne('SELECT uid FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: 'Этот email уже используется' });
    }

    const uid          = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);

    await queryOne(
      `INSERT INTO users (uid, email, name, role, bio, skills, contacts, portfolio, avatar, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '', NOW())
       RETURNING uid`,
      [uid, email.toLowerCase(), name, userRole, bio || '',
       JSON.stringify(skills || []), contacts || '', portfolio || '']
    );

    const user  = await queryOne('SELECT * FROM users WHERE uid = $1', [uid]);
    const token = signToken(user);

    res.status(201).json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error('register error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email и password обязательны' });
    }

    const user = await queryOne('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!user) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    const token = signToken(user);
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /auth/me — получить текущего пользователя по токену
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE uid = $1', [req.user.uid]);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ user: sanitizeUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /auth/reset-password — отправить письмо (заглушка, настрой под Yandex SES или Mailgun)
router.post('/reset-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email обязателен' });
  // TODO: отправить письмо через Yandex SES / другой SMTP
  res.json({ ok: true, message: 'Письмо отправлено (если такой email существует)' });
});

// Убираем чувствительные поля перед отправкой клиенту
function sanitizeUser(user) {
  const { password_hash, ...safe } = user;
  if (safe.skills && typeof safe.skills === 'string') {
    try { safe.skills = JSON.parse(safe.skills); } catch(e) {}
  }
  return safe;
}

module.exports = router;
