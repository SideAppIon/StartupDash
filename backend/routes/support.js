// Обращения в поддержку: пользователь оставляет тему+вопрос, саппорт/админ отвечает в ЛС.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendDirectMessage } = require('../lib/dm');

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
    // Кому из поддержки ушло обращение и в каком диалоге идёт переписка
    await query('ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS agent_uid TEXT');
    await query('ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS conv_id TEXT');
    supportSchemaEnsured = true;
  } catch (e) {
    console.error('ensureSupportSchema error:', e.message);
  }
}

// Сотрудник, которому уходит обращение: тот, с кем пользователь уже переписывался,
// иначе первый сотрудник поддержки, иначе администратор.
async function pickSupportAgent(userUid) {
  const prev = await queryOne(
    `SELECT u.uid FROM conversation_participants me
     JOIN conversations c ON c.id = me.conv_id AND c.is_group IS NOT TRUE
     JOIN conversation_participants cp ON cp.conv_id = c.id AND cp.user_uid <> me.user_uid
     JOIN users u ON u.uid = cp.user_uid AND u.role IN ('support','admin')
     WHERE me.user_uid = $1
     ORDER BY (u.role = 'support') DESC, c.last_at DESC NULLS LAST LIMIT 1`,
    [userUid]
  );
  if (prev) return prev.uid;
  const agent = await queryOne(
    `SELECT uid FROM users WHERE role IN ('support','admin') AND uid <> $1
     ORDER BY (role = 'support') DESC, created_at ASC LIMIT 1`,
    [userUid]
  );
  return agent ? agent.uid : null;
}

function parseTicket(t) {
  return {
    ...t,
    userUid:    t.user_uid,
    userName:   t.user_name,
    agentUid:   t.agent_uid,
    convId:     t.conv_id,
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

    // Сообщение сразу уходит в личку поддержке — у пользователя появляется чат
    // с историей, поддержка отвечает в нём же
    let agentUid = null, convId = null;
    try {
      agentUid = await pickSupportAgent(req.user.uid);
      if (agentUid) convId = await sendDirectMessage(req.user.uid, agentUid, `🎧 Обращение в поддержку: ${subject}\n\n${text}`);
    } catch (e) {
      console.error('support DM error:', e.message);
    }

    const id = uuidv4();
    const ticket = await queryOne(
      `INSERT INTO support_tickets (id, user_uid, user_name, subject, text, status, agent_uid, conv_id, created_at)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$7,NOW()) RETURNING *`,
      [id, req.user.uid, me ? me.name : '', subject, text, agentUid, convId]
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
