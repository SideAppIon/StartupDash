// Удаляет файлы модерации (сертификаты, логотипы организаций) через 7 дней после решения.
// Запуск по расписанию (cron на сервере): npm run purge-moderation-files
const { purgeReviewedFiles, FILES_KEEP_DAYS } = require('./routes/verification');
const { pool } = require('./db');

purgeReviewedFiles(FILES_KEEP_DAYS)
  .then(r => console.log(`${new Date().toISOString()} очистка файлов модерации: заявок ${r.requests}, файлов удалено ${r.files}`))
  .catch(e => { console.error('Ошибка очистки файлов модерации:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
