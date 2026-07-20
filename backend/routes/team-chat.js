const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { checkCensor } = require('../lib/censor');

const router = express.Router();

// Проверяем что пользователь — участник или владелец стартапа
async function isTeamMember(startup_id, uid) {
  const startup = await queryOne('SELECT owner_uid FROM startups WHERE id=$1', [startup_id]);
  if (!startup) return false;
  if (startup.owner_uid === uid) return true;
  const member = await queryOne(
    'SELECT 1 FROM startup_team WHERE startup_id=$1 AND user_uid=$2',
    [startup_id, uid]
  );
  return !!member;
}

// GET /team-chat/my — список стартапов у которых есть чат (для левой панели)
router.get('/my', requireAuth, async (req, res) => {
  try {
    // Стартапы где я владелец
    const owned = await queryAll(
      `SELECT s.id, s.name, s.emoji, s.icon_image, c.id AS conv_id, c.last_message, c.last_at
       FROM startups s
       LEFT JOIN conversations c ON c.startup_id = s.id AND c.is_group = TRUE
       WHERE s.owner_uid = $1`,
      [req.user.uid]
    );
    // Стартапы где я участник
    const member = await queryAll(
      `SELECT s.id, s.name, s.emoji, s.icon_image, c.id AS conv_id, c.last_message, c.last_at
       FROM startup_team st
       JOIN startups s ON s.id = st.startup_id
       LEFT JOIN conversations c ON c.startup_id = s.id AND c.is_group = TRUE
       WHERE st.user_uid = $1`,
      [req.user.uid]
    );
    // Объединяем без дублей
    const seen = new Set();
    const all = [];
    [...owned, ...member].forEach(s => {
      if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
    });
    all.sort((a, b) => (b.last_at||'') > (a.last_at||'') ? 1 : -1);
    res.json({ startups: all });
  } catch (e) {
    console.error('[team-chat/my]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /team-chat/:startup_id — получить или создать групповой чат стартапа
router.get('/:startup_id', requireAuth, async (req, res) => {
  try {
    const { startup_id } = req.params;
    if (!await isTeamMember(startup_id, req.user.uid)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    // Ищем существующий чат
    let conv = await queryOne(
      'SELECT * FROM conversations WHERE startup_id=$1 AND is_group=TRUE',
      [startup_id]
    );

    if (!conv) {
      // Создаём чат и добавляем всю команду
      const startup = await queryOne(
        'SELECT id, name, owner_uid FROM startups WHERE id=$1', [startup_id]
      );
      const teamRows = await queryAll(
        'SELECT user_uid FROM startup_team WHERE startup_id=$1', [startup_id]
      );
      const memberUids = [startup.owner_uid, ...teamRows.map(r => r.user_uid)];
      const uniqueUids = [...new Set(memberUids)];

      // Получаем данные участников
      const users = await queryAll(
        `SELECT uid, name, avatar, role FROM users WHERE uid = ANY($1)`,
        [uniqueUids]
      );
      const names   = {};
      const avatars = {};
      const roles   = {};
      users.forEach(u => {
        names[u.uid]   = u.name;
        avatars[u.uid] = u.avatar || '';
        roles[u.uid]   = u.role;
      });

      const id = uuidv4();
      conv = await queryOne(
        `INSERT INTO conversations
           (id, startup_id, is_group, participant_names, participant_avatars, participant_roles, last_message, last_at, created_at)
         VALUES ($1,$2,TRUE,$3,$4,$5,'',NOW(),NOW()) RETURNING *`,
        [id, startup_id, JSON.stringify(names), JSON.stringify(avatars), JSON.stringify(roles)]
      );

      // Добавляем всех участников
      for (const uid of uniqueUids) {
        await queryOne(
          'INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, uid]
        );
      }
    }

    res.json({ conversation: parseConv(conv) });
  } catch (e) {
    console.error('[team-chat/:startup_id]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /team-chat/:startup_id/messages
router.get('/:startup_id/messages', requireAuth, async (req, res) => {
  try {
    const { startup_id } = req.params;
    if (!await isTeamMember(startup_id, req.user.uid)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const conv = await queryOne(
      'SELECT id FROM conversations WHERE startup_id=$1 AND is_group=TRUE', [startup_id]
    );
    if (!conv) return res.json({ messages: [] });

    const messages = await queryAll(
      `SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar,
              COALESCE(st.role, u.role) AS sender_role
       FROM messages m
       LEFT JOIN users u ON u.uid = m.sender_uid
       LEFT JOIN startup_team st ON st.startup_id=$1 AND st.user_uid = m.sender_uid
       WHERE m.conv_id=$2
       ORDER BY m.created_at ASC`,
      [startup_id, conv.id]
    );
    res.json({ messages });
  } catch (e) {
    console.error('[team-chat/:startup_id/messages]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /team-chat/:startup_id/messages — отправить сообщение
router.post('/:startup_id/messages', requireAuth, async (req, res) => {
  try {
    const { startup_id } = req.params;
    if (!await isTeamMember(startup_id, req.user.uid)) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const conv = await queryOne(
      'SELECT id FROM conversations WHERE startup_id=$1 AND is_group=TRUE', [startup_id]
    );
    if (!conv) return res.status(404).json({ error: 'Чат не найден — сначала открой его' });

    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'text обязателен' });
    if ((type || 'user') === 'user') {
      const cen = await checkCensor(text, 'messages');
      if (cen.blocked) return res.status(400).json({ error: cen.message });
    }

    const me = await queryOne(
      'SELECT name, avatar, role FROM users WHERE uid=$1', [req.user.uid]
    );
    const teamRole = await queryOne(
      'SELECT role FROM startup_team WHERE startup_id=$1 AND user_uid=$2',
      [startup_id, req.user.uid]
    );

    const id  = uuidv4();
    const msg = await queryOne(
      `INSERT INTO messages (id, conv_id, sender_uid, sender_name, sender_avatar, sender_role, text, type, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
      [id, conv.id, req.user.uid,
       me.name, me.avatar || '',
       teamRole ? teamRole.role : me.role,
       text, type || 'user']
    );

    const preview = type === 'image' ? '📷 Фото' : text.substring(0, 80);
    await queryOne(
      'UPDATE conversations SET last_message=$1, last_at=NOW() WHERE id=$2',
      [preview, conv.id]
    );

    res.status(201).json({ message: msg });
  } catch (e) {
    console.error('[team-chat/:startup_id/messages POST]', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function parseConv(c) {
  return {
    ...c,
    participantNames:   tryParse(c.participant_names, {}),
    participantAvatars: tryParse(c.participant_avatars, {}),
    participantRoles:   tryParse(c.participant_roles, {}),
  };
}
function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

module.exports = router;
