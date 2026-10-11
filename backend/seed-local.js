// Локальный стенд: применяет schema.sql и создаёт тестовых пользователей на каждую роль.
// Запуск: npm run seed  (берёт настройки из .env)
// Работает ТОЛЬКО с базой на localhost — защита от случайного запуска на проде.
const fs     = require('fs');
const path   = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Client } = require('pg');

// Общий пароль тестовых аккаунтов (только для локальной базы)
const TEST_PASSWORD = 'Test123_';

// Логин = имя латиницей, имя = «Имя Роль-тест»
const USERS = [
  { email: 'artem@local.test',  name: 'Артем Админ-тест',              role: 'admin' },
  { email: 'sofia@local.test',  name: 'София Поддержка-тест',          role: 'support' },
  { email: 'maxim@local.test',  name: 'Максим Модератор-тест',         role: 'moderator' },
  { email: 'stas@local.test',   name: 'Стас Стартапер-тест',           role: 'startup' },
  { email: 'sveta@local.test',  name: 'Света Стартапер-тест',          role: 'startup' },
  { email: 'sergey@local.test', name: 'Сергей Специалист-тест',        role: 'user' },
  { email: 'eduard@local.test', name: 'Эдуард Эксперт-тест',           role: 'expert' },
  { email: 'kira@local.test',   name: 'Кира Куратор-тест',             role: 'curator' },
  { email: 'maria@local.test',  name: 'Мария Ментор-тест',             role: 'mentor' },
  { email: 'boris@local.test',  name: 'Борис Буст-партнёр-тест',       role: 'boost_partner' },
  { email: 'oleg@local.test',   name: 'Олег Наблюдатель-тест',         role: 'observer' },
  // Ждёт модерации: наблюдатель с заявкой на роль ментора
  { email: 'petr@local.test',   name: 'Пётр Наблюдатель-тест',         role: 'observer', pending: 'mentor' },
];

(async () => {
  const host = process.env.DB_HOST || '';
  if (!['localhost', '127.0.0.1'].includes(host)) {
    console.error(`Отказ: DB_HOST=${host || '(пусто)'} — сид работает только с локальной базой.`);
    process.exit(1);
  }
  const db = new Client({
    host, port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  });
  await db.connect();

  console.log('Применяю schema.sql...');
  await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  for (const u of USERS) {
    const uid = uuidv4();
    const nick = u.email.split('@')[0] + '_test';
    const r = await db.query(
      `INSERT INTO users (uid, email, password_hash, name, role, bio, skills, nickname, onboarding_done, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,NOW())
       ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, name = EXCLUDED.name
       RETURNING uid`,
      [uid, u.email, hash, u.name, u.role, 'Тестовый аккаунт локального стенда', '["Тестирование"]', nick]
    );
    if (u.pending) {
      await db.query(`CREATE TABLE IF NOT EXISTS role_verifications (
        id TEXT PRIMARY KEY, user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
        requested_role TEXT NOT NULL, certificates JSONB NOT NULL DEFAULT '[]', comment TEXT DEFAULT '',
        inn TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', review_note TEXT DEFAULT '',
        reviewed_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), reviewed_at TIMESTAMPTZ)`);
      await db.query(
        `INSERT INTO role_verifications (id, user_uid, requested_role, comment, status)
         SELECT $1, $2, $3, 'Тестовая заявка без файлов', 'pending'
         WHERE NOT EXISTS (SELECT 1 FROM role_verifications WHERE user_uid = $2 AND status = 'pending')`,
        [uuidv4(), r.rows[0].uid, u.pending]
      );
    }
    console.log(`  ${u.role.padEnd(13)} ${u.email}${u.pending ? '  (заявка на ' + u.pending + ')' : ''}`);
  }
  console.log(`\nГотово. Пароль у всех тестовых аккаунтов — в константе TEST_PASSWORD в ${path.basename(__filename)}`);
  await db.end();
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
