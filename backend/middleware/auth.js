const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const JWT_EXPIRES = '30d';

// Создать JWT токен для пользователя
function signToken(user) {
  return jwt.sign(
    { uid: user.uid, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// Роль в токене фиксируется при входе и живёт 30 дней. После модерации
// (наблюдатель → эксперт / ментор / ...) или смены роли админом она устаревает,
// поэтому актуальную роль берём из базы. Короткий кеш, чтобы не ходить в БД на каждый запрос.
const ROLE_TTL_MS = 15 * 1000;
const roleCache = new Map(); // uid → { role, exp }

async function currentRole(uid) {
  const hit = roleCache.get(uid);
  if (hit && hit.exp > Date.now()) return hit.role;
  const { queryOne } = require('../db');
  const row = await queryOne('SELECT role FROM users WHERE uid = $1', [uid]);
  const role = row ? row.role : null;
  roleCache.set(uid, { role, exp: Date.now() + ROLE_TTL_MS });
  if (roleCache.size > 5000) roleCache.clear();
  return role;
}

// Сбросить кеш роли (после одобрения заявки или смены роли)
function forgetRole(uid) { roleCache.delete(uid); }

// Расшифровать токен и подставить актуальную роль. null — токен невалиден или пользователь удалён.
async function userFromToken(token) {
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
  const role = await currentRole(payload.uid);
  if (!role) return null;
  return Object.assign(payload, { role });
}

// Middleware: проверить токен, добавить req.user
async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  try {
    const user = await userFromToken(token);
    if (!user) return res.status(401).json({ error: 'Токен недействителен или истёк' });
    req.user = user;
  } catch (e) {
    console.error('requireAuth error:', e.message);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
  next();
}

// Middleware: проверить токен если есть (не обязательно)
async function optionalAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { const user = await userFromToken(token); if (user) req.user = user; } catch (e) {}
  }
  next();
}

// Middleware: только администратор
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Только для администраторов' });
    }
    next();
  });
}

module.exports = { signToken, requireAuth, optionalAuth, requireAdmin, forgetRole };
