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

// Похоже ли на ошибку мёртвого/оборванного соединения (а не на ошибку SQL).
// Такое бывает после рестарта БД/простоя: инстанс функции держит в пуле уже
// закрытые соединения, и первый запрос по ним падает.
function isConnectionError(e) {
  const s = String((e && (e.code || e.message)) || '').toLowerCase();
  return /econnreset|epipe|etimedout|econnrefused|enotfound|connection terminated|server closed|connection error|terminating connection|shutdown|57p01|08006|08003|08000|timeout/.test(s);
}

// Хелпер: выполнить запрос. При обрыве соединения — отбрасываем мёртвый клиент
// и повторяем один раз на свежем. Обычные SQL-ошибки не ретраятся.
async function query(text, params) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let client;
    try {
      client = await pool.connect();
    } catch (e) {
      lastErr = e;                       // не смогли даже подключиться — дадим пулу шанс на новом клиенте
      if (isConnectionError(e) && attempt === 0) continue;
      throw e;
    }
    try {
      const result = await client.query(text, params);
      client.release();                  // вернуть здоровый клиент в пул
      return result;
    } catch (e) {
      lastErr = e;
      const dead = isConnectionError(e);
      client.release(dead);              // dead=true → уничтожить клиент, не возвращать в пул
      if (dead && attempt === 0) continue;  // повтор на свежем соединении
      throw e;
    }
  }
  throw lastErr;
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
