const express = require('express');
const { queryOne } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const DEFAULT_CONFIG = {
  categories: ['FinTech','EdTech','HealthTech','E-commerce','SaaS','AI / ML','Gaming','GreenTech','Marketplace','Другое'],
  stages: [
    {name:'Идея',icon:'💡'},{name:'MVP',icon:'⚡'},{name:'Бета',icon:'🔬'},
    {name:'Запущен',icon:'🚀'},{name:'Масштабирование',icon:'📈'}
  ],
  feedLimit: 25
};

// GET /platform-config
router.get('/', async (req, res) => {
  try {
    const row = await queryOne("SELECT value FROM platform_config WHERE key='platform'");
    const config = row ? JSON.parse(row.value) : DEFAULT_CONFIG;
    res.json({ config });
  } catch(e) {
    res.json({ config: DEFAULT_CONFIG });
  }
});

// GET /platform-config/platform (совместимость с db.collection('_config').doc('platform').get())
router.get('/platform', async (req, res) => {
  try {
    const row = await queryOne("SELECT value FROM platform_config WHERE key='platform'");
    const config = row ? JSON.parse(row.value) : DEFAULT_CONFIG;
    res.json({ config });
  } catch(e) {
    res.json({ config: DEFAULT_CONFIG });
  }
});

// Общий обработчик сохранения конфига (merge с существующим)
async function upsertConfig(body, res) {
  try {
    const row = await queryOne("SELECT value FROM platform_config WHERE key='platform'");
    const existing = row ? JSON.parse(row.value) : DEFAULT_CONFIG;
    // Удаляем служебные поля Firestore-совместимости
    const { _method, id, ...data } = body;
    const updated = Object.assign({}, existing, data);
    await queryOne(
      `INSERT INTO platform_config (key, value, updated_at) VALUES ('platform', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [JSON.stringify(updated)]
    );
    res.json({ ok: true, config: updated });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

// PATCH /platform-config
router.patch('/', requireAdmin, (req, res) => upsertConfig(req.body, res));
// POST /platform-config (fallback от _DocRef.set при 404)
router.post('/', requireAdmin, (req, res) => upsertConfig(req.body, res));
// PATCH /platform-config/platform (db.collection('_config').doc('platform').set/update)
router.patch('/platform', requireAdmin, (req, res) => upsertConfig(req.body, res));
// POST /platform-config/platform
router.post('/platform', requireAdmin, (req, res) => upsertConfig(req.body, res));

module.exports = router;
