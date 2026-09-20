// Обращения в поддержку: пользователь оставляет тему+вопрос, саппорт/админ отвечает в ЛС.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Саппорт и админ имеют доступ к обращениям
function isSupport(user) {
  return user && (user.role === 'support' || user.role === 'admin');
}

// Ленивая миграция (в проде нет автораннера)
let supportSchemaEnsured = false;
async function ensureSupportSchema() {
  if (supportSchemaEnsured) return;
  try {
    await query(`CREATE TABLE IF NOT EXISTS support_tickets (
      id          TEXT PRIMARY KEY,
      user_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
      user_name   TEXT DEFAULT '',
      subject     TEXT NOT NULL DEFAULT '',
      text        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','closed')),
      answered_by TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      answered_at TIMESTAMPTZ
    )`);
    await query('CREATE INDEX IF NOT EXISTS idx_support_status ON support_tickets(status)');
    await query('CREATE INDEX IF NOT EXISTS idx_support_user ON support_tickets(user_uid)');
    supportSchemaEnsured = true;
  } catch (e) {
    console.error('ensureSupportSchema error:', e.message);
  }
}

function parseTicket(t) {
  return {
    ...t,
    userUid:    t.user_uid,
    userName:   t.user_name,
    answeredBy: t.answered_by,
    createdAt:  t.created_at,
    answeredAt: t.answered_at,
  };
}

// POST /support — создать обращение (любой авторизованный пользователь)
router.post('/', requireAuth, async (req, res) => {
  try {
    await ensureSupportSchema();
    const subject = String(req.body.subject || '').trim().slice(0, 200);
    const text    = String(req.body.text || '').trim().slice(0, 4000);
    if (!subject) return res.status(400).json({ error: 'Укажите тему обращения' });
    if (!text)    return res.status(400).json({ error: 'Опишите ваш вопрос' });

    const me = await queryOne('SELECT name FROM users WHERE uid=$1', [req.user.uid]);
    const id = uuidv4();
    const ticket = await queryOne(
      `INSERT INTO support_tickets (id, user_uid, user_name, subject, text, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'open',NOW()) RETURNING *`,
      [id, req.user.uid, me ? me.name : '', subject, text]
    );
    res.status(201).json({ ticket: parseTicket(ticket) });
  } catch (e) {
    console.error('POST /support error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /support — список обращений (только саппорт/админ). ?status=open|answered|closed
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!isSupport(req.user)) return res.status(403).json({ error: 'Только для поддержки' });
    await ensureSupportSchema();
    const params = [];
    let sql = `SELECT t.*, u.email AS user_email, u.avatar AS user_avatar, u.role AS user_role
               FROM support_tickets t
               LEFT JOIN users u ON u.uid = t.user_uid
               WHERE 1=1`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND t.status = $${params.length}`; }
    // Сначала открытые, потом по свежести
    sql += ` ORDER BY (t.status='open') DESC, t.created_at DESC`;
    const rows = await queryAll(sql, params);
    res.json({ tickets: rows.map(parseTicket) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /support/:id — сменить статус (саппорт/админ): answered | closed | open
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (!isSupport(req.user)) return res.status(403).json({ error: 'Только для поддержки' });
    await ensureSupportSchema();
    const status = ['open', 'answered', 'closed'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Неверный статус' });
    const answeredAt = status === 'answered' ? 'NOW()' : 'answered_at';
    const ticket = await queryOne(
      `UPDATE support_tickets
       SET status=$1, answered_by=$2, answered_at=${answeredAt}
       WHERE id=$3 RETURNING *`,
      [status, status === 'answered' ? req.user.uid : null, req.params.id]
    );
    if (!ticket) return res.status(404).json({ error: 'Обращение не найдено' });
    res.json({ ticket: parseTicket(ticket) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
