// Загружает function.zip в Object Storage, затем выводит команду деплоя
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

const s3 = new S3Client({
  region: 'ru-central1',
  endpoint: 'https://storage.yandexcloud.net',
  credentials: {
    accessKeyId:     'YCAJErs5NaxA96axCjvXyibqV',
    secretAccessKey: 'YCNsQhxzdpMpQzzgmUfh_C6LgL6czpST38M6Nv3D',
  },
});

(async () => {
  console.log('Загружаю function.zip в Object Storage...');
  const body = fs.readFileSync('./function.zip');
  await s3.send(new PutObjectCommand({
    Bucket: 'startuphelper-files',
    Key:    'deploy/function.zip',
    Body:   body,
    ContentType: 'application/zip',
  }));
  console.log('✓ Загружено: deploy/function.zip');
  console.log('');
  console.log('Теперь запусти деплой:');
  console.log('');
  console.log('yc serverless function version create \\');
  console.log('  --function-name startuphelper-api \\');
  console.log('  --runtime nodejs18 \\');
  console.log('  --entrypoint index.handler \\');
  console.log('  --memory 256m \\');
  console.log('  --execution-timeout 15s \\');
  console.log('  --package-bucket-name startuphelper-files \\');
  console.log('  --package-object-name deploy/function.zip \\');
  console.log('  --environment DB_HOST=rc1b-0is3tpsihr5uacob.mdb.yandexcloud.net \\');
  console.log('  --environment DB_PORT=6432 \\');
  console.log('  --environment DB_NAME=startuphelper \\');
  console.log('  --environment DB_USER=startuphelper_user \\');
  console.log('  --environment DB_PASSWORD=MediaHub2025@ \\');
  console.log('  --environment DB_SSL=true \\');
  console.log('  --environment JWT_SECRET=1d38257143f2c884feeb8ff5e85012c5a26b3a76082be28e06f144a7a4ae1600fa7e341750a592a5e1564285c3a05ff8 \\');
  console.log('  --environment ALLOWED_ORIGIN=https://LeiGGaRFeeD.github.io \\');
  console.log('  --environment S3_BUCKET=startuphelper-files \\');
  console.log('  --environment S3_ACCESS_KEY_ID=YCAJErs5NaxA96axCjvXyibqV \\');
  console.log('  --environment S3_SECRET_ACCESS_KEY=YCNsQhxzdpMpQzzgmUfh_C6LgL6czpST38M6Nv3D');
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
