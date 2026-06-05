const { Pool } = require('pg');

// Параметры подключения берутся из переменных окружения Yandex Cloud Functions
// Задаются в настройках функции: Настройки → Переменные окружения
const pool = new Pool({
  host:     process.env.DB_HOST,      // Хост Managed PostgreSQL (внутренний или внешний)
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

// Хелпер: выполнить запрос с параметрами
async function query(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

// Хелпер: одна строка или null
async function queryOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

// Хелпер: массив строк
async function queryAll(text, params) {
  const result = await query(text, params);
  return result.rows;
}

module.exports = { pool, query, queryOne, queryAll };
