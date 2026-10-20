const express = require('express');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');
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

// Локальный стенд (LOCAL_UPLOADS=true): файлы пишутся на диск и отдаются бэкендом по /uploads,
// чтобы не нужны были ключи от боевого S3. В проде флаг не задан — всё как раньше.
const LOCAL_UPLOADS    = process.env.LOCAL_UPLOADS === 'true';
const LOCAL_UPLOAD_DIR = path.join(__dirname, '..', 'local-uploads');
const PUBLIC_API_URL   = process.env.PUBLIC_API_URL || 'http://localhost:3000';

// Публичный URL загруженного файла по ключу вида 'certificates/<uuid>.pdf'
function fileUrl(key) {
  return LOCAL_UPLOADS
    ? `${PUBLIC_API_URL}/uploads/${key}`
    : `https://storage.yandexcloud.net/${BUCKET}/${key}`;
}

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

// Лимит на файл — 7 МБ (фото сжимаются в браузере ещё до отправки).
// Файл приходит в base64 — он длиннее файла на треть, поэтому сравниваем
// длину строки с лимитом × 4/3. nginx пропускает тело запроса до 12 МБ.
const MAX_FILE_MB  = parseFloat(process.env.MAX_FILE_MB || '7');
const MAX_FILE_B64 = Math.ceil(MAX_FILE_MB * 1024 * 1024 * 4 / 3) + 1024;

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
    // Логотип организации буст-партнёра — только изображения
    if (folder === 'org-logos' && !IMAGE_TYPES[contentType]) {
      return res.status(400).json({ error: 'Логотип: разрешены изображения (jpg, png, webp, gif)' });
    }
    // Сертификаты для модерации роли — только PDF и изображения
    if (folder === 'certificates' && !IMAGE_TYPES[contentType] && contentType !== 'application/pdf') {
      return res.status(400).json({ error: 'Сертификат: разрешены PDF или изображение (jpg, png, webp)' });
    }
    const isVideo = !!VIDEO_TYPES[contentType];
    const isDoc   = !!DOC_TYPES[contentType];
    if (data.length > MAX_FILE_B64) {
      return res.status(400).json({
        error: isVideo
          ? `Видео слишком большое. Максимум ${MAX_FILE_MB} МБ. Для больших видео используйте ссылку ВКонтакте или Rutube.`
          : `Файл слишком большой. Максимум ${MAX_FILE_MB} МБ`,
      });
    }

    const allowed = ['avatars', 'chat', 'startups', 'updates', 'docs', 'certificates', 'org-logos'];
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

    if (LOCAL_UPLOADS) {
      fs.mkdirSync(path.join(LOCAL_UPLOAD_DIR, safeFolder), { recursive: true });
      fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, key), buffer);
    } else {
      await s3.send(new PutObjectCommand(putParams));
    }

    res.json({ url: fileUrl(key) });
  } catch (e) {
    console.error('[upload]', e);
    res.status(500).json({ error: 'Ошибка загрузки файла' });
  }
});

// Удалить ранее загруженный файл по его публичному URL.
// Удаляет только файлы из папок allowedFolders (защита от удаления чужих / произвольных файлов).
// Возвращает true, если файл удалён или его уже нет; false — если URL не наш или папка не разрешена.
async function deleteStoredFile(url, allowedFolders) {
  const prefix = fileUrl('');
  if (typeof url !== 'string' || !url.startsWith(prefix)) return false;
  const key = url.slice(prefix.length);
  const folder = key.split('/')[0];
  if (!allowedFolders.includes(folder) || key.includes('..') || !/^[\w-]+\/[\w.-]+$/.test(key)) return false;
  if (LOCAL_UPLOADS) {
    try { fs.unlinkSync(path.join(LOCAL_UPLOAD_DIR, key)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  }
  return true;
}

module.exports = router;
module.exports.fileUrl = fileUrl;
module.exports.deleteStoredFile = deleteStoredFile;
module.exports.LOCAL_UPLOADS = LOCAL_UPLOADS;
module.exports.LOCAL_UPLOAD_DIR = LOCAL_UPLOAD_DIR;
