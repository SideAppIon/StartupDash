// Ник пользователя: пока нигде не используется, хранится «на будущее».
// Правила: длина от 5 символов, латиница/цифры/._- (URL-безопасно),
// уникальность без учёта регистра. Если ник не задан — генерируем уникальный.
const { query, queryOne } = require('../db');

const NICK_MIN = 5;
const NICK_MAX = 30;
const NICK_RE  = /^[A-Za-z0-9._-]+$/;

// Ленивая миграция (в проде нет раннера миграций).
let nicknameSchemaEnsured = false;
async function ensureNicknameSchema() {
  if (nicknameSchemaEnsured) return;
  try {
    await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT');
    // Уникальность без учёта регистра; частичный индекс — чтобы несколько NULL
    // (у старых аккаунтов ник ещё не задан) не конфликтовали.
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname_lower
                 ON users (LOWER(nickname)) WHERE nickname IS NOT NULL`);
    nicknameSchemaEnsured = true;
  } catch (e) {
    console.error('ensureNicknameSchema error:', e.message);
  }
}

// Проверка формата. Возвращает { ok, error?, value? } (value — обрезанный ник).
function validateNicknameFormat(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value.length < NICK_MIN) {
    return { ok: false, error: `Ник должен быть не короче ${NICK_MIN} символов` };
  }
  if (value.length > NICK_MAX) {
    return { ok: false, error: `Ник не длиннее ${NICK_MAX} символов` };
  }
  if (!NICK_RE.test(value)) {
    return { ok: false, error: 'Ник может содержать только латиницу, цифры и символы . _ -' };
  }
  return { ok: true, value };
}

// Свободен ли ник (без учёта регистра). excludeUid — не считать конфликтом самого пользователя.
async function isNicknameFree(nickname, excludeUid) {
  const row = await queryOne(
    `SELECT uid FROM users WHERE LOWER(nickname) = LOWER($1)
     AND ($2::text IS NULL OR uid <> $2) LIMIT 1`,
    [nickname, excludeUid || null]
  );
  return !row;
}

// Сгенерировать уникальный ник вида user_ab12cd (всегда ≥ 5 символов).
async function generateUniqueNickname() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 8); // 6 символов base36
    const candidate = 'user_' + suffix;
    if (await isNicknameFree(candidate)) return candidate;
  }
  // Крайне маловероятный провал — подстрахуемся временной меткой
  return 'user_' + Date.now().toString(36);
}

// Подготовить ник для сохранения при регистрации/создании.
// Пустой ввод → автогенерация. Возвращает { ok, error?, nickname? }.
async function resolveNicknameForCreate(raw) {
  await ensureNicknameSchema();
  const provided = String(raw == null ? '' : raw).trim();
  if (!provided) {
    return { ok: true, nickname: await generateUniqueNickname() };
  }
  const fmt = validateNicknameFormat(provided);
  if (!fmt.ok) return fmt;
  if (!(await isNicknameFree(fmt.value))) {
    return { ok: false, error: 'Этот ник уже занят' };
  }
  return { ok: true, nickname: fmt.value };
}

module.exports = {
  NICK_MIN, NICK_MAX,
  ensureNicknameSchema,
  validateNicknameFormat,
  isNicknameFree,
  generateUniqueNickname,
  resolveNicknameForCreate,
};
