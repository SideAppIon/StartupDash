// Модерация ролей Эксперт / Куратор / Ментор / Буст-партнёр.
// При регистрации такие пользователи получают роль «наблюдатель» и отправляют заявку:
// эксперт / куратор / ментор — с сертификатами, буст-партнёр — с реквизитами организации
// (ИНН, юридический адрес, ФИО и рабочий телефон руководителя, логотип; документы по желанию). Админ или поддержка проверяет её: при одобрении роль меняется
// на запрошенную, при отказе пользователь видит причину и может подать заново.
// О решении пользователь узнаёт из личного сообщения от проверяющего.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { MODERATED_ROLES, needsModeration, needsInn, isValidInn, ensureRoleConstraint } = require('../lib/roles');
const { fileUrl, deleteStoredFile } = require('./upload');
const { sendDirectMessage } = require('../lib/dm');

const router = express.Router();

const ROLE_NAMES = { expert: 'Эксперт', curator: 'Куратор', mentor: 'Ментор', boost_partner: 'Буст-партнёр' };
const MAX_CERTIFICATES = 5;
// Принимаем только файлы, загруженные через POST /upload в папку certificates
const CERT_URL_PREFIX = fileUrl('certificates/');
const LOGO_URL_PREFIX = fileUrl('org-logos/');

// Реквизиты организации буст-партнёра: возвращает { org } или { error }
function readOrgInfo(body) {
  const org = {
    inn:            String(body.inn || '').replace(/\s/g, ''),
    legal_address:  String(body.legal_address  || body.legalAddress  || '').trim().slice(0, 500),
    director_name:  String(body.director_name  || body.directorName  || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    director_phone: String(body.director_phone || body.directorPhone || '').trim().slice(0, 40),
    org_logo:       String(body.org_logo       || body.orgLogo       || ''),
  };
  if (!isValidInn(org.inn))                          return { error: 'Укажите корректный ИНН (10 или 12 цифр)' };
  if (org.legal_address.length < 10)                 return { error: 'Укажите юридический адрес полностью' };
  if (org.director_name.split(' ').length < 2)       return { error: 'Укажите ФИО руководителя (минимум фамилию и имя)' };
  const digits = org.director_phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15)      return { error: 'Укажите рабочий телефон руководителя' };
  if (!org.org_logo.startsWith(LOGO_URL_PREFIX))     return { error: 'Загрузите логотип организации' };
  return { org };
}

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
    // Реквизиты организации буст-партнёра
    await query("ALTER TABLE role_verifications ADD COLUMN IF NOT EXISTS legal_address  TEXT DEFAULT ''");
    await query("ALTER TABLE role_verifications ADD COLUMN IF NOT EXISTS director_name  TEXT DEFAULT ''");
    await query("ALTER TABLE role_verifications ADD COLUMN IF NOT EXISTS director_phone TEXT DEFAULT ''");
    await query("ALTER TABLE role_verifications ADD COLUMN IF NOT EXISTS org_logo       TEXT DEFAULT ''");
    // Когда удалены файлы заявки (сертификаты, логотип) — через 7 дней после решения
    await query('ALTER TABLE role_verifications ADD COLUMN IF NOT EXISTS files_purged_at TIMESTAMPTZ');
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
    legalAddress:  r.legal_address || '',
    directorName:  r.director_name || '',
    directorPhone: r.director_phone || '',
    orgLogo:       r.org_logo || '',
    filesPurgedAt: r.files_purged_at || null,
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
// Body: { requested_role, certificates: [{ url, name }], comment,
//         inn, legal_address, director_name, director_phone, org_logo }  ← реквизиты для буст-партнёра
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
    // Буст-партнёру обязательны реквизиты организации (документы — по желанию), остальным — сертификат
    let org = { inn: '', legal_address: '', director_name: '', director_phone: '', org_logo: '' };
    if (needsInn(requestedRole)) {
      const r = readOrgInfo(req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      org = r.org;
    } else if (!certs.length) {
      return res.status(400).json({ error: 'Прикрепите хотя бы один сертификат' });
    }

    const pending = await queryOne(
      "SELECT id FROM role_verifications WHERE user_uid=$1 AND status='pending'",
      [req.user.uid]
    );
    if (pending) return res.status(409).json({ error: 'Заявка уже на модерации' });

    const row = await queryOne(
      `INSERT INTO role_verifications (id, user_uid, requested_role, certificates, comment,
         inn, legal_address, director_name, director_phone, org_logo, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',NOW()) RETURNING *`,
      [uuidv4(), req.user.uid, requestedRole, JSON.stringify(certs),
       String(req.body.comment || '').trim().slice(0, 2000),
       org.inn, org.legal_address, org.director_name, org.director_phone, org.org_logo]
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

// ── Очистка файлов модерации ─────────────────────────
// Через FILES_KEEP_DAYS дней после решения (одобрено / отклонено) удаляем с сервера
// сертификаты и логотип организации, а из заявки убираем ссылки на них.
// Остальные данные заявки (роль, ИНН, реквизиты, причина отказа) остаются.
// Запускается по расписанию: npm run purge-moderation-files (см. purge-moderation-files.js).
const FILES_KEEP_DAYS = 7;
async function purgeReviewedFiles(days = FILES_KEEP_DAYS) {
  await ensureVerificationSchema();
  const rows = await queryAll(
    `SELECT id, certificates, org_logo FROM role_verifications
     WHERE status IN ('approved','rejected') AND files_purged_at IS NULL
       AND reviewed_at < NOW() - make_interval(days => $1)`,
    [days]
  );
  let files = 0;
  for (const r of rows) files += await purgeRequestFiles(r);
  return { requests: rows.length, files };
}

// Удалить файлы одной заявки и отметить это в ней. Возвращает число удалённых файлов.
async function purgeRequestFiles(r) {
  const urls = parseCerts(r.certificates).map(c => c.url);
  if (r.org_logo) urls.push(r.org_logo);
  let files = 0;
  for (const url of urls) {
    if (await deleteStoredFile(url, ['certificates', 'org-logos'])) files++;
  }
  await queryOne(
    `UPDATE role_verifications SET certificates='[]', org_logo='', files_purged_at=NOW() WHERE id=$1`,
    [r.id]
  );
  return files;
}

// Ручная очистка одобренной заявки (админ / поддержка) — экономия места, статус и роль не меняются.
// Только для одобренных: по ожидающей ещё нужно принять решение, отклонённую могут оспорить.
async function loadApprovedForCleanup(req, res) {
  if (!isReviewer(req.user)) { res.status(403).json({ error: 'Только для администратора и поддержки' }); return null; }
  await ensureVerificationSchema();
  const row = await queryOne('SELECT * FROM role_verifications WHERE id=$1', [req.params.id]);
  if (!row) { res.status(404).json({ error: 'Заявка не найдена' }); return null; }
  if (row.status !== 'approved') { res.status(409).json({ error: 'Удалять можно только одобренные заявки' }); return null; }
  return row;
}

// POST /verification/:id/purge-files — удалить вложения (заявка остаётся в списке)
router.post('/:id/purge-files', requireAuth, async (req, res) => {
  try {
    const row = await loadApprovedForCleanup(req, res);
    if (!row) return;
    const files = await purgeRequestFiles(row);
    res.json({ ok: true, files });
  } catch (e) {
    console.error('POST /verification/:id/purge-files error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /verification/:id — удалить заявку из списка целиком вместе с вложениями
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const row = await loadApprovedForCleanup(req, res);
    if (!row) return;
    await purgeRequestFiles(row);
    await queryOne('DELETE FROM role_verifications WHERE id=$1', [row.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /verification/:id error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
module.exports.purgeReviewedFiles = purgeReviewedFiles;
module.exports.FILES_KEEP_DAYS = FILES_KEEP_DAYS;
