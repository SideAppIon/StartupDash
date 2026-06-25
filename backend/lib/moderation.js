// Общие хелперы модерации: привязка модераторов к группам и проверка зоны ответственности.
const { query, queryOne } = require('../db');

let ensured = false;
// Ленивая миграция (автораннера миграций в проекте нет).
async function ensureModeratorSchema() {
  if (ensured) return;
  try {
    // group_id должен быть UUID — совпадать с типом groups.id / user_groups.group_id,
    // иначе JOIN'ы в скоуп-запросах падают (uuid = text).
    await query(`CREATE TABLE IF NOT EXISTS moderator_groups (
      moderator_uid TEXT NOT NULL,
      group_id      UUID NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (moderator_uid, group_id)
    )`);
    // Чиним legacy-таблицы, где колонка была создана как TEXT
    await query(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='moderator_groups' AND column_name='group_id' AND data_type='text'
      ) THEN
        ALTER TABLE moderator_groups ALTER COLUMN group_id TYPE uuid USING group_id::uuid;
      END IF;
    END $$;`);
    ensured = true;
  } catch (e) {
    console.error('ensureModeratorSchema error:', e.message);
  }
}

const isAdmin     = (u) => !!u && u.role === 'admin';
const isModerator = (u) => !!u && (u.role === 'admin' || u.role === 'moderator');

// Группы, закреплённые за модератором
async function getModeratorGroupIds(modUid) {
  const rows = await query('SELECT group_id FROM moderator_groups WHERE moderator_uid=$1', [modUid]);
  return rows.rows.map(r => r.group_id);
}

// Может ли модератор действовать в отношении конкретного пользователя
// (целевой пользователь состоит в одной из закреплённых за модератором групп).
async function moderatorCanActOn(modUid, targetUid) {
  if (!targetUid) return false;
  const row = await queryOne(
    `SELECT 1 FROM moderator_groups mg
     JOIN user_groups ug ON ug.group_id = mg.group_id
     WHERE mg.moderator_uid=$1 AND ug.user_uid=$2
     LIMIT 1`,
    [modUid, targetUid]
  );
  return !!row;
}

// SQL-подзапрос: uid'ы пользователей в зоне ответственности модератора.
// Используется для фильтрации жалоб/контента. Возвращает строку для подстановки.
function scopedUidsSubquery(paramIndex) {
  return `SELECT ug.user_uid FROM user_groups ug
          JOIN moderator_groups mg ON mg.group_id = ug.group_id
          WHERE mg.moderator_uid = $${paramIndex}`;
}

module.exports = {
  ensureModeratorSchema,
  isAdmin,
  isModerator,
  getModeratorGroupIds,
  moderatorCanActOn,
  scopedUidsSubquery,
};
