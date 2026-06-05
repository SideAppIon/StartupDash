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

// PATCH /platform-config — только администратор
router.patch('/', requireAdmin, async (req, res) => {
  try {
    const value = JSON.stringify(req.body);
    await queryOne(
      `INSERT INTO platform_config (key, value, updated_at) VALUES ('platform', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [value]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
