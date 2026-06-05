const express = require('express');
const cors    = require('cors');
const { Readable } = require('stream');
const { ServerResponse } = require('http');

const authRoutes     = require('./routes/auth');
const usersRoutes    = require('./routes/users');
const startupsRoutes = require('./routes/startups');
const invitesRoutes  = require('./routes/invites');
const messagesRoutes = require('./routes/messages');
const forumRoutes    = require('./routes/forum');
const configRoutes   = require('./routes/config');

const app = express();

// ── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));

// ── Healthcheck ───────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Роуты ─────────────────────────────────────────────────
app.use('/auth',            authRoutes);
app.use('/users',           usersRoutes);
app.use('/startups',        startupsRoutes);
app.use('/invites',         invitesRoutes);
app.use('/messages',        messagesRoutes);
app.use('/forum',           forumRoutes);
app.use('/platform-config', configRoutes);

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Маршрут ${req.method} ${req.path} не найден` }));

// ── Глобальный обработчик ошибок ──────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

// ── Запуск локально (npm run dev) ────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

// ── Yandex Cloud Functions handler ───────────────────────
// Ручной адаптер — serverless-http не поддерживает формат Yandex Cloud
module.exports.handler = async (event, context) => {
  return new Promise((resolve) => {
    // Достаём путь — API Gateway может передавать шаблон /{path+}
    // поэтому берём реальный путь из pathParameters
    let path = event.path || '/';
    if (path.includes('{') || path === '/{path+}') {
      const pp = event.pathParameters || {};
      const real = pp['path+'] || pp['path'] || '';
      path = real ? '/' + real : '/';
    }
    const method = (event.httpMethod || 'GET').toUpperCase();
    // Приводим заголовки к нижнему регистру — Yandex Cloud присылает их в разном регистре
    const headers = {};
    Object.entries(event.headers || {}).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    const qs      = event.queryStringParameters || {};

    // Тело запроса
    let bodyBuffer = Buffer.alloc(0);
    if (event.body) {
      bodyBuffer = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body, 'utf8');
    }

    // Строка запроса
    const qstr = Object.keys(qs).length
      ? '?' + Object.entries(qs).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
      : '';
    const url = path + qstr;

    // Создаём фейковый req (Readable stream)
    const req = new Readable({ read() {} });
    req.push(bodyBuffer);
    req.push(null);

    Object.assign(req, {
      method,
      url,
      path,
      headers: {
        'content-type':   'application/json',
        'content-length': String(bodyBuffer.length),
        ...headers,
      },
      connection: { remoteAddress: '127.0.0.1' },
      socket:     { remoteAddress: '127.0.0.1' },
    });

    // Создаём фейковый res
    const chunks = [];
    const res = new ServerResponse(req);

    const originalWrite = res.write.bind(res);
    const originalEnd   = res.end.bind(res);

    res.write = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));
      if (cb) cb();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8'));

      const body    = Buffer.concat(chunks).toString('utf8');
      const rawHdrs = res.getHeaders ? res.getHeaders() : {};

      // Преобразуем заголовки в строки
      const outHeaders = {};
      Object.entries(rawHdrs).forEach(([k, v]) => {
        outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
      });

      resolve({
        statusCode: res.statusCode || 200,
        headers:    outHeaders,
        body,
        isBase64Encoded: false,
      });
    };

    // Передаём запрос в Express
    app(req, res);
  });
};
