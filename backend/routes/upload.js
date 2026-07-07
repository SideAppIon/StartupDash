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

const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/gif':  'gif',
  'image/webp': 'webp',
};
const VIDEO_TYPES = {
  'video/mp4':       'mp4',
  'video/webm':      'webm',
  'video/quicktime': 'mov',
};
const DOC_TYPES = {
  'application/pdf':                                                            'pdf',
  'application/msword':                                                         'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':    'docx',
  'application/vnd.ms-excel':                                                   'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':          'xlsx',
  'application/vnd.ms-powerpoint':                                              'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':  'pptx',
  'text/plain':                                                                 'txt',
  'text/csv':                                                                   'csv',
  'application/zip':                                                            'zip',
};
const ALLOWED_TYPES = { ...IMAGE_TYPES, ...VIDEO_TYPES, ...DOC_TYPES };

// Лимиты по base64 (фактический файл ~ в 1.37 раза меньше).
// ВАЖНО: запросы идут через API Gateway с лимитом тела ~3.5 МБ.
// base64 раздувает файл на ~35%, поэтому файл должен быть ≲ 2.3 МБ,
// иначе шлюз вернёт 413 ещё до функции (без CORS-заголовков → в браузере «CORS»).
const MAX_IMAGE_B64 = 2.7 * 1024 * 1024;                                  // ~2 МБ файл
const MAX_VIDEO_MB  = parseFloat(process.env.MAX_VIDEO_MB || '2.3');       // ~2.3 МБ файл (предел шлюза)
const MAX_VIDEO_B64 = MAX_VIDEO_MB * 1.37 * 1024 * 1024;
const MAX_DOC_MB    = parseFloat(process.env.MAX_DOC_MB || '2.3');         // ~2.3 МБ файл (предел шлюза)
const MAX_DOC_B64   = MAX_DOC_MB * 1.37 * 1024 * 1024;

// POST /upload
// Body: { data: "<base64>", contentType: "image/jpeg"|"video/mp4", folder: "avatars"|"chat"|... }
router.post('/', requireAuth, async (req, res) => {
  try {
    const { data, contentType, folder = 'chat' } = req.body;

    if (!data || !contentType) {
      return res.status(400).json({ error: 'data и contentType обязательны' });
    }
    if (!ALLOWED_TYPES[contentType]) {
      return res.status(400).json({ error: 'Разрешены изображения, видео и документы (pdf, doc, docx, xls, xlsx, ppt, pptx, txt, csv, zip)' });
    }
    const isVideo = !!VIDEO_TYPES[contentType];
    const isDoc   = !!DOC_TYPES[contentType];
    const maxB64  = isVideo ? MAX_VIDEO_B64 : isDoc ? MAX_DOC_B64 : MAX_IMAGE_B64;
    if (data.length > maxB64) {
      return res.status(400).json({
        error: isVideo
          ? `Видео слишком большое. Максимум ~${MAX_VIDEO_MB} МБ. Для больших видео используй ссылку ВКонтакте.`
          : isDoc
          ? `Файл слишком большой. Максимум ~${MAX_DOC_MB} МБ`
          : 'Файл слишком большой. Максимум 2 МБ',
      });
    }

    const allowed = ['avatars', 'chat', 'startups', 'updates', 'docs'];
    const safeFolder = allowed.includes(folder) ? folder : 'chat';
    const ext = ALLOWED_TYPES[contentType];
    const key = `${safeFolder}/${uuidv4()}.${ext}`;
    const buffer = Buffer.from(data, 'base64');

    const putParams = {
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
    };
    // Документы отдаём как вложение (скачивание), с исходным именем файла
    if (isDoc) {
      const rawName = (req.body.filename || `file.${ext}`).replace(/[\r\n"\\]/g, '').slice(0, 200);
      putParams.ContentDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(rawName)}`;
    }

    await s3.send(new PutObjectCommand(putParams));

    const url = `https://storage.yandexcloud.net/${BUCKET}/${key}`;
    res.json({ url });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

module.exports = router;
