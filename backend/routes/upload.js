const express = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const s3 = new S3Client({
  region: 'ru-central1',
  endpoint: 'https://storage.yandexcloud.net',
  credentials: {
    accessKeyId:     process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const BUCKET  = process.env.S3_BUCKET || 'startuphelper-files';
const MAX_B64 = 2.7 * 1024 * 1024; // ~2MB actual file

const ALLOWED_TYPES = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
};

// POST /upload
// Body: { data: "<base64>", contentType: "image/jpeg", folder: "avatars"|"chat" }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { data, contentType, folder = 'chat' } = req.body;

    if (!data || !contentType) {
      return res.status(400).json({ error: 'data и contentType обязательны' });
    }
    if (!ALLOWED_TYPES[contentType]) {
      return res.status(400).json({ error: 'Разрешены только изображения (jpeg, png, gif, webp)' });
    }
    if (data.length > MAX_B64) {
      return res.status(400).json({ error: 'Файл слишком большой. Максимум 2 МБ' });
    }

    const safeFolder = folder === 'avatars' ? 'avatars' : 'chat';
    const ext = ALLOWED_TYPES[contentType];
    const key = `${safeFolder}/${uuidv4()}.${ext}`;
    const buffer = Buffer.from(data, 'base64');

    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    }));

    const url = `https://storage.yandexcloud.net/${BUCKET}/${key}`;
    res.json({ url });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

module.exports = router;
