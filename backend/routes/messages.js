const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getUserGroupSettings } = require('./groups');
const { prepareChatMessage } = require('../lib/chat-message');
const { isActiveExpert, isStaff, isObserver, ACTIVE_EXPERT_ROLES_SQL } = require('../lib/roles');

const router = express.Router();

// Отметка «уведомления просмотрены» (не влияет на прочитанность самих чатов)
let notifSchemaEnsured = false;
async function ensureNotifSchema() {
  if (notifSchemaEnsured) return;
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_seen_at TIMESTAMPTZ');
    notifSchemaEnsured = true;
  } catch (e) {
    console.error('ensureNotifSchema error:', e.message);
  }
}

// GET /messages/notifications — чаты с новыми сообщениями (после последнего просмотра колокольчика)
router.get('/notifications', requireAuth, async (req, res) => {
  try {
    await ensureNotifSchema();
    const rows = await queryAll(
      `SELECT c.id, c.participant_names, c.is_group, c.startup_id,
              s.name AS startup_name,
              MAX(m.created_at) AS last_new_at,
              COUNT(m.id)::int  AS new_count,
              (ARRAY_AGG(m.text ORDER BY m.created_at DESC))[1] AS last_text
       FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conv_id
       JOIN messages m      ON m.conv_id = c.id
       LEFT JOIN startups s ON s.id = c.startup_id
       WHERE cp.user_uid = $1
         AND m.sender_uid <> $1
         AND m.created_at > COALESCE((SELECT notif_seen_at FROM users WHERE uid=$1), to_timestamp(0))
       GROUP BY c.id, s.name
       ORDER BY MAX(m.created_at) DESC
       LIMIT 10`,
      [req.user.uid]
    );

    const items = rows.map(r => {
      let title = 'Чат';
      try {
        const names = typeof r.participant_names === 'string' ? JSON.parse(r.participant_names) : (r.participant_names || {});
        if (r.is_group) {
          title = 'Чат команды' + (r.startup_name ? ': ' + r.startup_name : '');
        } else {
          const other = Object.keys(names).find(u => u !== req.user.uid);
          title = (other && names[other]) || 'Личный чат';
        }
      } catch (e) {}
      return {
        convId:   r.id,
        title,
        isGroup:  r.is_group === true,
        newCount: r.new_count,
        lastText: r.last_text || '',
        lastAt:   r.last_new_at,
      };
    });

    res.json({ count: items.length, items });
  } catch (e) {
    console.error('GET notifications:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /messages/notifications/seen — пометить уведомления просмотренными
router.post('/notifications/seen', requireAuth, async (req, res) => {
  try {
    await ensureNotifSchema();
    await queryOne('UPDATE users SET notif_seen_at = NOW() WHERE uid = $1', [req.user.uid]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Правила личной переписки (кто кому может НАЧАТЬ диалог) ──
// Те же правила, что в интерфейсе (messages.html → canMessageUser):
//   • персонал (админ, поддержка, модератор) пишет кому угодно, и ему может написать любой;
//   • наблюдатель пишет только персоналу, и наблюдателю пишет только персонал;
//   • одинаковые роли всегда могут писать друг другу;
//   • стартапер → стартаперы, специалисты, эксперты (эксперт, куратор, ментор, буст-партнёр);
//   • эксперт / куратор / ментор / буст-партнёр → стартаперы и коллеги со своей ролью;
//   • специалист → специалисты и люди из его команд (владелец и участники);
//   • если между людьми есть заявка или приглашение в проект — им можно переписываться.
// В уже существующем диалоге отвечать можно всегда — проверяется только создание нового.
async function canStartConversation(meUid, myRole, other) {
  if (isStaff(myRole) || isStaff(other.role)) return true;
  if (isObserver(myRole) || isObserver(other.role)) return false;
  if (myRole === other.role) return true;
  if (myRole === 'startup') return other.role === 'user' || isActiveExpert(other.role);
  if (isActiveExpert(myRole) && other.role === 'startup') return true;

  // Общая команда: один владелец стартапа, где другой в команде, или оба в одной команде
  const sameTeam = await queryOne(
    `SELECT 1 FROM startups s
     WHERE (s.owner_uid = $1 AND EXISTS (SELECT 1 FROM startup_team t WHERE t.startup_id = s.id AND t.user_uid = $2))
        OR (s.owner_uid = $2 AND EXISTS (SELECT 1 FROM startup_team t WHERE t.startup_id = s.id AND t.user_uid = $1))
        OR (EXISTS (SELECT 1 FROM startup_team t WHERE t.startup_id = s.id AND t.user_uid = $1)
            AND EXISTS (SELECT 1 FROM startup_team t WHERE t.startup_id = s.id AND t.user_uid = $2))
     LIMIT 1`,
    [meUid, other.uid]
  );
  if (sameTeam && myRole === 'user') return true;

  // Заявка / приглашение в проект между ними (обсуждение заявки)
  const invite = await queryOne(
    `SELECT 1 FROM invites
     WHERE (from_uid = $1 AND (startup_owner = $2 OR to_uid = $2))
        OR (from_uid = $2 AND (startup_owner = $1 OR to_uid = $1))
     LIMIT 1`,
    [meUid, other.uid]
  );
  return !!invite;
}

// GET /conversations — список диалогов текущего пользователя
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const convs = await queryAll(
      `SELECT c.*, s.name AS startup_name, s.emoji AS startup_emoji, s.icon_image AS startup_icon
       FROM conversations c
       JOIN conversation_participants cp ON cp.conv_id = c.id
       LEFT JOIN startups s ON s.id = c.startup_id
       WHERE cp.user_uid = $1
         AND (
           c.is_group = FALSE
           OR c.startup_id IS NULL
           OR s.owner_uid = $1
           OR EXISTS (
             SELECT 1 FROM startup_team st
             WHERE st.startup_id = c.startup_id AND st.user_uid = $1
           )
         )
       ORDER BY c.last_at DESC`,
      [req.user.uid]
    );
    res.json({ conversations: convs.map(parseConv) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /conversations — создать или найти существующий диалог с пользователем
router.post('/conversations', requireAuth, async (req, res) => {
  try {
    const { other_uid } = req.body;
    if (!other_uid || other_uid === req.user.uid) {
      return res.status(400).json({ error: 'other_uid обязателен' });
    }

    // Наблюдатель переписывается только с поддержкой / админами / модераторами,
    // и писать наблюдателю тоже может только персонал (ответить он больше никому не сможет)
    if (!isStaff(req.user.role)) {
      const otherUser = await queryOne('SELECT role FROM users WHERE uid=$1', [other_uid]);
      if (isObserver(req.user.role) && !(otherUser && isStaff(otherUser.role))) {
        return res.status(403).json({ error: 'Наблюдатель не может писать в личные сообщения' });
      }
      if (otherUser && isObserver(otherUser.role)) {
        return res.status(403).json({ error: 'Наблюдателю нельзя написать' });
      }
    }

    // Проверяем ограничение коммуникации по группе
    // Правило: если у инициатора стоит messaging_restriction=true,
    // он может писать только участникам своей группы
    // (если other_uid уже написал первым — existing диалог есть, блокировки нет)
    const myGs = await getUserGroupSettings(req.user.uid);
    if (myGs && myGs.messaging_restriction) {
      const sameGroup = await queryOne(
        'SELECT 1 FROM user_groups WHERE group_id=$1 AND user_uid=$2',
        [myGs.group_id, other_uid]
      );
      if (!sameGroup) {
        // Проверяем: может они уже общаются (other написал первым)
        const existingCheck = await queryOne(
          `SELECT c.* FROM conversations c
           JOIN conversation_participants cp1 ON cp1.conv_id = c.id AND cp1.user_uid = $1
           JOIN conversation_participants cp2 ON cp2.conv_id = c.id AND cp2.user_uid = $2
           WHERE c.is_group = FALSE LIMIT 1`,
          [req.user.uid, other_uid]
        );
        if (!existingCheck) {
          return res.status(403).json({ error: 'Вы можете писать только участникам своей группы' });
        }
      }
    }

    // Ищем существующий диалог между двумя
    const existing = await queryOne(
      `SELECT c.* FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conv_id = c.id AND cp1.user_uid = $1
       JOIN conversation_participants cp2 ON cp2.conv_id = c.id AND cp2.user_uid = $2
       LIMIT 1`,
      [req.user.uid, other_uid]
    );
    if (existing) return res.json({ conversation: parseConv(existing) });

    // Новый диалог — только если роли позволяют переписку
    const otherForRules = await queryOne('SELECT uid, role FROM users WHERE uid=$1', [other_uid]);
    if (!otherForRules) return res.status(404).json({ error: 'Пользователь не найден' });
    if (!(await canStartConversation(req.user.uid, req.user.role, otherForRules))) {
      return res.status(403).json({ error: 'Вы не можете написать этому пользователю' });
    }

    // Получаем данные обоих участников
    const [me, other] = await Promise.all([
      queryOne('SELECT uid, name, avatar, role FROM users WHERE uid=$1', [req.user.uid]),
      queryOne('SELECT uid, name, avatar, role FROM users WHERE uid=$1', [other_uid]),
    ]);
    if (!other) return res.status(404).json({ error: 'Пользователь не найден' });

    // Создаём диалог
    const id = uuidv4();
    const names     = JSON.stringify({ [req.user.uid]: me.name, [other_uid]: other.name });
    const avatars   = JSON.stringify({ [req.user.uid]: me.avatar || '', [other_uid]: other.avatar || '' });
    const roles     = JSON.stringify({ [req.user.uid]: me.role, [other_uid]: other.role });

    const conv = await queryOne(
      `INSERT INTO conversations (id, participant_names, participant_avatars, participant_roles, last_message, last_at, created_at)
       VALUES ($1,$2,$3,$4,'',NOW(),NOW()) RETURNING *`,
      [id, names, avatars, roles]
    );

    // Добавляем участников
    await queryOne('INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2)',
      [id, req.user.uid]);
    await queryOne('INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2)',
      [id, other_uid]);

    res.status(201).json({ conversation: parseConv(conv) });
  } catch (e) {
    console.error('POST /conversations error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /conversations/:id
router.get('/conversations/:id', requireAuth, async (req, res) => {
  try {
    const member = await queryOne(
      'SELECT 1 FROM conversation_participants WHERE conv_id=$1 AND user_uid=$2',
      [req.params.id, req.user.uid]
    );
    if (!member) return res.status(403).json({ error: 'Нет доступа' });
    const conv = await queryOne('SELECT * FROM conversations WHERE id=$1', [req.params.id]);
    if (!conv) return res.status(404).json({ error: 'Диалог не найден' });
    res.json({ conversation: parseConv(conv) });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /conversations/:id/messages
router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    // Проверяем что пользователь участник
    const member = await queryOne(
      'SELECT 1 FROM conversation_participants WHERE conv_id=$1 AND user_uid=$2',
      [req.params.id, req.user.uid]
    );
    if (!member) return res.status(403).json({ error: 'Нет доступа' });

    const messages = await queryAll(
      'SELECT * FROM messages WHERE conv_id=$1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /conversations/:id/messages — отправить сообщение
router.post('/conversations/:id/messages', requireAuth, async (req, res) => {
  try {
    const member = await queryOne(
      'SELECT 1 FROM conversation_participants WHERE conv_id=$1 AND user_uid=$2',
      [req.params.id, req.user.uid]
    );
    if (!member) return res.status(403).json({ error: 'Нет доступа' });

    // Наблюдатель может отвечать только в диалогах с персоналом (поддержка, модерация)
    if (isObserver(req.user.role)) {
      const nonStaff = await queryOne(
        `SELECT 1 FROM conversation_participants cp JOIN users u ON u.uid = cp.user_uid
         WHERE cp.conv_id = $1 AND cp.user_uid <> $2 AND u.role NOT IN ('admin','support','moderator') LIMIT 1`,
        [req.params.id, req.user.uid]
      );
      if (nonStaff) return res.status(403).json({ error: 'Наблюдатель может переписываться только с поддержкой' });
    }

    // Проверка типа, вложения и фильтр слов (системные сообщения не проверяем)
    const m = await prepareChatMessage(req.body.text, req.body.type);
    if (m.error) return res.status(400).json({ error: m.error });

    const id  = uuidv4();
    const msg = await queryOne(
      `INSERT INTO messages (id, conv_id, sender_uid, text, type, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [id, req.params.id, req.user.uid, m.text, m.type]
    );

    // Обновляем preview диалога
    await queryOne(
      'UPDATE conversations SET last_message=$1, last_at=NOW() WHERE id=$2',
      [m.preview, req.params.id]
    );

    res.status(201).json({ message: msg });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /users — список пользователей для выбора собеседника (с проверкой прав)
router.get('/available-users', requireAuth, async (req, res) => {
  try {
    const myRole = req.user.role;
    let sql = `SELECT uid, name, email, role, avatar FROM users WHERE uid != $1`;
    const params = [req.user.uid];

    // Одинаковые роли всегда могут писать друг другу (кроме наблюдателя — он не переписывается)
    if (myRole === 'startup') {
      // Стартапер: другие стартаперы, специалисты и эксперты (куратор, ментор, буст-партнёр)
      sql += ` AND role IN ('startup','user',${ACTIVE_EXPERT_ROLES_SQL})`;
    } else if (isActiveExpert(myRole)) {
      // Эксперт / куратор / ментор / буст-партнёр: стартаперы и коллеги с той же ролью
      params.push(myRole);
      sql += ` AND role IN ('startup', $${params.length})`;
    } else if (isObserver(myRole)) {
      // Наблюдатель новых диалогов не начинает
      return res.json({ users: [] });
    } else if (myRole === 'user') {
      // Специалист: другие специалисты + команды
      // Базовый список — другие специалисты
      sql += ` AND role = 'user'`;
      // Команды добавляются отдельным запросом ниже
    }
    // admin — без ограничений

    const users = await queryAll(sql, params);

    // Для специалиста добавляем стартаперов из команды
    if (myRole === 'user') {
      const teamOwners = await queryAll(
        `SELECT DISTINCT s.owner_uid AS uid, u.name, u.email, u.role, u.avatar
         FROM startup_team st
         JOIN startups s ON s.id = st.startup_id
         JOIN users u ON u.uid = s.owner_uid
         WHERE st.user_uid = $1`,
        [req.user.uid]
      );
      const teamMembers = await queryAll(
        `SELECT DISTINCT u.uid, u.name, u.email, u.role, u.avatar
         FROM startup_team st1
         JOIN startup_team st2 ON st2.startup_id = st1.startup_id AND st2.user_uid != $1
         JOIN users u ON u.uid = st2.user_uid
         WHERE st1.user_uid = $1`,
        [req.user.uid]
      );
      const extra = [...teamOwners, ...teamMembers];
      const seen = new Set(users.map(u => u.uid));
      extra.forEach(u => { if (!seen.has(u.uid)) { users.push(u); seen.add(u.uid); } });
    }

    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function parseConv(c) {
  return {
    ...c,
    participantNames:   tryParse(c.participant_names, {}),
    participantAvatars: tryParse(c.participant_avatars, {}),
    participantRoles:   tryParse(c.participant_roles, {}),
    lastMessage: c.last_message,
    lastAt: c.last_at,
    isGroup: c.is_group || false,
    startupName: c.startup_name || null,
    startupEmoji: c.startup_emoji || '🚀',
    startupIcon: c.startup_icon || null,
  };
}

function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

module.exports = router;
