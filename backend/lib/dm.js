const { v4: uuidv4 } = require('uuid');
const { queryOne } = require('../db');

// Служебное личное сообщение fromUid → toUid: находит или создаёт диалог и пишет в него.
// Без проверок ограничений переписки — это уведомление (решение модерации, идея забрана и т.п.),
// пользователь увидит его в колокольчике.
async function sendDirectMessage(fromUid, toUid, text) {
  let conv = await queryOne(
    `SELECT c.id FROM conversations c
     JOIN conversation_participants cp1 ON cp1.conv_id = c.id AND cp1.user_uid = $1
     JOIN conversation_participants cp2 ON cp2.conv_id = c.id AND cp2.user_uid = $2
     WHERE c.is_group IS NOT TRUE LIMIT 1`,
    [fromUid, toUid]
  );
  if (!conv) {
    const [me, other] = await Promise.all([
      queryOne('SELECT uid, name, avatar, role FROM users WHERE uid=$1', [fromUid]),
      queryOne('SELECT uid, name, avatar, role FROM users WHERE uid=$1', [toUid]),
    ]);
    if (!me || !other) return;
    const id = uuidv4();
    conv = await queryOne(
      `INSERT INTO conversations (id, participant_names, participant_avatars, participant_roles, last_message, last_at, created_at)
       VALUES ($1,$2,$3,$4,'',NOW(),NOW()) RETURNING id`,
      [id,
       JSON.stringify({ [fromUid]: me.name, [toUid]: other.name }),
       JSON.stringify({ [fromUid]: me.avatar || '', [toUid]: other.avatar || '' }),
       JSON.stringify({ [fromUid]: me.role, [toUid]: other.role })]
    );
    await queryOne('INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2)', [id, fromUid]);
    await queryOne('INSERT INTO conversation_participants (conv_id, user_uid) VALUES ($1,$2)', [id, toUid]);
  }
  await queryOne(
    `INSERT INTO messages (id, conv_id, sender_uid, text, type, created_at)
     VALUES ($1,$2,$3,$4,'user',NOW())`,
    [uuidv4(), conv.id, fromUid, text]
  );
  await queryOne('UPDATE conversations SET last_message=$1, last_at=NOW() WHERE id=$2',
    [text.substring(0, 80), conv.id]);
}

module.exports = { sendDirectMessage };
