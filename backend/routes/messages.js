const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /conversations — список диалогов текущего пользователя
router.get('/conversations', requireAuth, async (req, res) => {
  try {
    const convs = await queryAll(
      `SELECT c.*
       FROM conversations c
       JOIN conversation_participants cp ON cp.conv_id = c.id
       WHERE cp.user_uid = $1
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

    // Ищем существующий диалог между двумя
    const existing = await queryOne(
      `SELECT c.* FROM conversations c
       JOIN conversation_participants cp1 ON cp1.conv_id = c.id AND cp1.user_uid = $1
       JOIN conversation_participants cp2 ON cp2.conv_id = c.id AND cp2.user_uid = $2
       LIMIT 1`,
      [req.user.uid, other_uid]
    );
    if (existing) return res.json({ conversation: parseConv(existing) });

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

    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'text обязателен' });

    const id  = uuidv4();
    const msg = await queryOne(
      `INSERT INTO messages (id, conv_id, sender_uid, text, type, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [id, req.params.id, req.user.uid, text, type || 'user']
    );

    // Обновляем preview диалога
    await queryOne(
      'UPDATE conversations SET last_message=$1, last_at=NOW() WHERE id=$2',
      [text.substring(0, 80), req.params.id]
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

    if (myRole === 'startup') {
      // Стартапер: специалисты и эксперты
      sql += ` AND role IN ('user','expert')`;
    } else if (myRole === 'expert') {
      // Эксперт: только стартаперы
      sql += ` AND role = 'startup'`;
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
  };
}

function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch(e) { return fallback; }
}

module.exports = router;
