// Модерация ролей Эксперт / Куратор / Ментор / Буст-партнёр.
// При регистрации такие пользователи получают роль «наблюдатель» и отправляют заявку:
// эксперт / куратор / ментор — с сертификатами, буст-партнёр — с ИНН (документы по желанию). Админ или поддержка проверяет её: при одобрении роль меняется
// на запрошенную, при отказе пользователь видит причину и может подать заново.
// О решении пользователь узнаёт из личного сообщения от проверяющего.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MODERATED_ROLES, needsModeration, needsInn, isValidInn, ensureRoleConstraint } = require('../lib/roles');
const { BUCKET } = require('./upload');
const { sendDirectMessage } = require('../lib/dm');

const router = express.Router();

const ROLE_NAMES = { expert: 'Эксперт', curator: 'Куратор', mentor: 'Ментор', boost_partner: 'Буст-партнёр' };
const MAX_CERTIFICATES = 5;
// Принимаем только файлы, загруженные через POST /upload в папку certificates
const CERT_URL_PREFIX = `https://storage.yandexcloud.net/${BUCKET}/certificates/`;

function isReviewer(user) {
  return user && (user.role === 'admin' || user.role === 'support');
}

// Ленивая миграция (в проде нет автораннера)
let schemaEnsured = false;
async function ensureVerificationSchema() {
  if (schemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS role_verifications (
      id             TEXT PRIMARY KEY,
      user_uid       TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      requested_role TEXT NOT NULL,
      certificates   JSONB NOT NULL DEFAULT '[]',
      comment        TEXT DEFAULT '',
      status         TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected')),
      review_note    TEXT DEFAULT '',
      reviewed_by    TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at    TIMESTAMPTZ
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_role_verif_status ON role_verifications(status)');
    await query('CREATE INDEX IF NOT EXISTS idx_role_verif_user ON role_verifications(user_uid)');
    await query("ALTER TABLE role_verifications ADD COLUMN IF NOT EXISTS inn TEXT DEFAULT ''");
    schemaEnsured = true;
  } catch (e) {
    console.error('ensureVerificationSchema error:', e.message);
  }
}

function parseCerts(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || '[]'); } catch (e) { return []; }
}

function shape(r) {
  return {
    id:            r.id,
    userUid:       r.user_uid,
    requestedRole: r.requested_role,
    certificates:  parseCerts(r.certificates),
    comment:       r.comment || '',
    inn:           r.inn || '',
    status:        r.status,
    reviewNote:    r.review_note || '',
    reviewedBy:    r.reviewed_by,
    createdAt:     r.created_at,
    reviewedAt:    r.reviewed_at,
    // Поля пользователя — только в списке для проверяющих
    ...(r.user_name !== undefined ? {
      userName:   r.user_name,
      userEmail:  r.user_email,
      userAvatar: r.user_avatar,
      userBio:    r.user_bio,
      userRole:   r.user_role,
      userPortfolio: r.user_portfolio,
    } : {}),
  };
}

// GET /verification/me — последняя заявка текущего пользователя (или null)
router.get('/me', requireAuth, async (req, res) => {
  try {
    await ensureVerificationSchema();
    const row = await queryOne(
      'SELECT * FROM role_verifications WHERE user_uid=$1 ORDER BY created_at DESC LIMIT 1',
      [req.user.uid]
    );
    res.json({ verification: row ? shape(row) : null });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /verification — подать заявку на роль (только наблюдатель)
// Body: { requested_role, certificates: [{ url, name }], comment, inn }
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureVerificationSchema();
    const requestedRole = req.body.requested_role || req.body.requestedRole;
    if (!needsModeration(requestedRole)) {
      return res.status(400).json({ error: `Роль должна быть одной из: ${MODERATED_ROLES.join(', ')}` });
    }

    const me = await queryOne('SELECT role FROM users WHERE uid=$1', [req.user.uid]);
    if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
    if (me.role !== 'observer') {
      return res.status(403).json({ error: 'Заявку на роль может подать только наблюдатель' });
    }

    const certs = (Array.isArray(req.body.certificates) ? req.body.certificates : [])
      .filter(c => c && typeof c.url === 'string' && c.url.startsWith(CERT_URL_PREFIX))
      .slice(0, MAX_CERTIFICATES)
      .map(c => ({ url: c.url, name: String(c.name || 'Сертификат').slice(0, 200) }));
    // Буст-партнёру обязателен ИНН (документы — по желанию), остальным — сертификат
    let inn = '';
    if (needsInn(requestedRole)) {
      inn = String(req.body.inn || '').replace(/\s/g, '');
      if (!isValidInn(inn)) return res.status(400).json({ error: 'Укажите корректный ИНН (10 или 12 цифр)' });
    } else if (!certs.length) {
      return res.status(400).json({ error: 'Прикрепите хотя бы один сертификат' });
    }

    const pending = await queryOne(
      "SELECT id FROM role_verifications WHERE user_uid=$1 AND status='pending'",
      [req.user.uid]
    );
    if (pending) return res.status(409).json({ error: 'Заявка уже на модерации' });

    const row = await queryOne(
      `INSERT INTO role_verifications (id, user_uid, requested_role, certificates, comment, inn, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW()) RETURNING *`,
      [uuidv4(), req.user.uid, requestedRole, JSON.stringify(certs),
       String(req.body.comment || '').trim().slice(0, 2000), inn]
    );
    res.status(201).json({ verification: shape(row) });
  } catch (e) {
    console.error('POST /verification error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /verification?status=pending|approved|rejected — список заявок (админ / поддержка)
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!isReviewer(req.user)) return res.status(403).json({ error: 'Только для администратора и поддержки' });
    await ensureVerificationSchema();
    const params = [];
    let sql = `SELECT v.*, u.name AS user_name, u.email AS user_email, u.avatar AS user_avatar,
                      u.bio AS user_bio, u.role AS user_role, u.portfolio AS user_portfolio
               FROM role_verifications v
               LEFT JOIN users u ON u.uid = v.user_uid
               WHERE 1=1`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND v.status = $${params.length}`; }
    sql += ` ORDER BY (v.status='pending') DESC, v.created_at DESC LIMIT 300`;
    const rows = await queryAll(sql, params);
    res.json({ verifications: rows.map(shape) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /verification/:id — решение по заявке (админ / поддержка)
// Body: { status: 'approved' | 'rejected', note }
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (!isReviewer(req.user)) return res.status(403).json({ error: 'Только для администратора и поддержки' });
    await ensureVerificationSchema();
    const status = req.body.status;
    const note   = String(req.body.note || '').trim().slice(0, 2000);
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Неверный статус' });
    if (status === 'rejected' && !note) return res.status(400).json({ error: 'Укажите причину отказа' });

    // Меняем только ожидающую заявку — защита от двойного решения
    const row = await queryOne(
      `UPDATE role_verifications
       SET status=$1, review_note=$2, reviewed_by=$3, reviewed_at=NOW()
       WHERE id=$4 AND status='pending' RETURNING *`,
      [status, note, req.user.uid, req.params.id]
    );
    if (!row) return res.status(409).json({ error: 'Заявка не найдена или уже рассмотрена' });

    const roleName = ROLE_NAMES[row.requested_role] || row.requested_role;
    if (status === 'approved') {
      await ensureRoleConstraint();
      // Повышаем только наблюдателя: если админ уже сменил роль вручную — не трогаем
      await queryOne("UPDATE users SET role=$1 WHERE uid=$2 AND role='observer'", [row.requested_role, row.user_uid]);
    }

    const text = status === 'approved'
      ? `✅ Ваша заявка на роль «${roleName}» одобрена. Роль уже активна — обновите страницу.` +
        (note ? `\nКомментарий: ${note}` : '')
      : `❌ Заявка на роль «${roleName}» отклонена.\nПричина: ${note}\n` +
        'Вы можете исправить данные и подать заявку заново в своём профиле.';
    try { await sendDirectMessage(req.user.uid, row.user_uid, text); }
    catch (e) { console.error('verification DM error:', e.message); }

    res.json({ verification: shape(row) });
  } catch (e) {
    console.error('PATCH /verification error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
