# Полная инструкция: GitHub Pages + Yandex Cloud Backend

## Текущая ситуация → Целевая

```
СЕЙЧАС:                          СТАНЕТ:
┌─────────────────┐              ┌─────────────────┐
│  GitHub Pages   │              │  GitHub Pages   │
│  (HTML файлы)   │              │  (HTML файлы)   │
└────────┬────────┘              └────────┬────────┘
         │ firebase-config.js             │ api-config.js
         ▼                               ▼
┌─────────────────┐        ┌────────────────────────┐
│    Firebase     │        │   Yandex API Gateway   │
│  (Auth+Firestore│        │   (один URL для всего) │
└─────────────────┘        └────────────┬───────────┘
                                        │
                           ┌────────────▼───────────┐
                           │   Cloud Function        │
                           │   (Node.js / Express)   │
                           └────────────┬───────────┘
                                        │
                           ┌────────────▼───────────┐
                           │  Managed PostgreSQL     │
                           │  (твоя база данных)     │
                           └────────────────────────┘
```

---

## Содержание

1. [Регистрация в Yandex Cloud](#1-регистрация-в-yandex-cloud)
2. [Создание PostgreSQL базы данных](#2-создание-postgresql-базы-данных)
3. [Применение схемы БД](#3-применение-схемы-бд)
4. [Установка Yandex CLI на компьютер](#4-установка-yandex-cli-на-компьютер)
5. [Деплой Cloud Function](#5-деплой-cloud-function)
6. [Создание API Gateway](#6-создание-api-gateway)
7. [Проверка что всё работает](#7-проверка-что-всё-работает)
8. [Подключение фронтенда](#8-подключение-фронтенда)
9. [Публикация на GitHub Pages](#9-публикация-на-github-pages)
10. [Как обновлять бэкенд](#10-как-обновлять-бэкенд)

---

## 1. Регистрация в Yandex Cloud

### 1.1 Создать аккаунт

1. Открой **console.cloud.yandex.ru**
2. Нажми **Войти** → авторизуйся через Яндекс ID
3. При первом входе нажми **Создать платёжный аккаунт**
4. Заполни данные, привяжи карту  
   _(карта нужна для верификации, при старте дают ~3000 ₽ на тестирование)_
5. Дождись активации аккаунта (обычно мгновенно)

### 1.2 Создать каталог (Folder)

Каталог = папка для всех ресурсов проекта.

1. В левом меню нажми на название облака (вверху)
2. Нажми **Создать каталог**
3. Имя: `startuphelper`
4. Нажми **Создать**

> Запомни или запиши **ID каталога** — он понадобится. Выглядит так: `b1gxxxxxxxxxxxxxxxxx`

---

## 2. Создание PostgreSQL базы данных

### 2.1 Открыть сервис

1. В левом меню найди **Managed Service for PostgreSQL**  
   _(или через поиск сверху: введи "postgres")_
2. Нажми **Создать кластер**

### 2.2 Заполнить настройки кластера

**Вкладка "Основные параметры":**

| Поле | Значение |
|------|----------|
| Имя кластера | `startuphelper-pg` |
| Версия PostgreSQL | `15` |
| Класс хоста | `b2.nano` (самый дешёвый, ~800₽/мес) |
| Тип хранилища | `network-hdd` |
| Размер хранилища | `10 ГБ` |

**Вкладка "База данных":**

| Поле | Значение |
|------|----------|
| Имя БД | `startuphelper` |
| Имя пользователя | `startuphelper_user` |
| Пароль | Придумай надёжный, **запиши его** |

**Вкладка "Хосты":**
1. Нажми **Добавить хост**
2. Зона доступности: `ru-central1-b` (или любая)
3. ✅ Поставь галочку **Публичный доступ** (нужно для применения схемы)

**Вкладка "Дополнительно":**
- Ничего не меняй

### 2.3 Нажать "Создать кластер"

Кластер создаётся 5–10 минут. Статус изменится с `Creating` на `Alive`.

### 2.4 Получить данные для подключения

Когда кластер создался:
1. Нажми на него
2. Вкладка **Хосты** — скопируй **FQDN хоста**  
   Выглядит так: `rc1b-xxxxxxxxxxxxxxxxxx.mdb.yandexcloud.net`
3. Запиши — это `DB_HOST`

---

## 3. Применение схемы БД

Нужно создать все таблицы. Для этого подключимся к базе через psql.

### 3.1 Установить psql

**macOS:**
```bash
brew install postgresql
```

**Windows:** скачай [PostgreSQL installer](https://www.postgresql.org/download/windows/), при установке можно снять галочки со всего кроме "Command Line Tools"

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install postgresql-client
```

### 3.2 Скачать SSL-сертификат Яндекса

```bash
# macOS / Linux:
mkdir -p ~/.postgresql
curl "https://storage.yandexcloud.net/cloud-certs/CA.pem" \
     --output ~/.postgresql/root.crt
chmod 0600 ~/.postgresql/root.crt
```

**Windows** (в PowerShell):
```powershell
New-Item -ItemType Directory -Force -Path "$env:APPDATA\postgresql"
Invoke-WebRequest `
  -Uri "https://storage.yandexcloud.net/cloud-certs/CA.pem" `
  -OutFile "$env:APPDATA\postgresql\root.crt"
```

### 3.3 Подключиться и применить схему

```bash
psql "host=ТВОЙ_ХОСТ \
      port=6432 \
      sslmode=verify-full \
      sslrootcert=~/.postgresql/root.crt \
      dbname=startuphelper \
      user=startuphelper_user \
      password=ТВОЙ_ПАРОЛЬ"
```

> Замени `ТВОЙ_ХОСТ` и `ТВОЙ_ПАРОЛЬ` на реальные значения.  
> Если подключилось — увидишь приглашение `startuphelper=>`.

Применяем схему (не выходя из psql):
```sql
\i /ПОЛНЫЙ_ПУТЬ/StartupDash/backend/schema.sql
```

Или выполни напрямую из терминала:
```bash
psql "host=ТВОЙ_ХОСТ port=6432 sslmode=verify-full \
      sslrootcert=~/.postgresql/root.crt \
      dbname=startuphelper user=startuphelper_user \
      password=ТВОЙ_ПАРОЛЬ" \
     -f /ПОЛНЫЙ_ПУТЬ/StartupDash/backend/schema.sql
```

Успешный результат — список `CREATE TABLE`, `CREATE INDEX` без ошибок.

Проверь что таблицы создались:
```sql
\dt
```
Должно показать: `users`, `startups`, `startup_team`, `invites`, `conversations`, и т.д.

---

## 4. Установка Yandex CLI на компьютер

### 4.1 Установить

**macOS / Linux:**
```bash
curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
```
После установки перезапусти терминал.

**Windows:** скачай [installer](https://storage.yandexcloud.net/yandexcloud-yc/release/latest/windows/amd64/yc.exe), положи в папку из `PATH`.

Проверь:
```bash
yc --version
# Yandex Cloud CLI 0.x.x
```

### 4.2 Авторизоваться

```bash
yc init
```

Откроется браузер → войди в Яндекс → разреши доступ → вернись в терминал.

Выбери:
- **Облако:** твоё облако (там одно)
- **Каталог:** `startuphelper`
- **Зона:** `ru-central1-b`

Проверь:
```bash
yc config list
# token: ...
# cloud-id: ...
# folder-id: b1gxxxxxxxxxxxxxxxxx  ← запомни это
```

---

## 5. Деплой Cloud Function

### 5.1 Установить зависимости

```bash
cd /ПУТЬ/StartupDash/backend
npm install
```

### 5.2 Сгенерировать JWT_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Скопируй результат — это твой `JWT_SECRET`.

### 5.3 Создать функцию

```bash
yc serverless function create \
  --name startuphelper-api \
  --folder-id ТВОЙ_FOLDER_ID
```

Запомни **function-id** из вывода. Выглядит так: `d4exxxxxxxxxxxxxxxxx`

### 5.4 Запаковать код

```bash
# Находясь в папке backend/
zip -r function.zip . \
  --exclude "*.git*" \
  --exclude ".env" \
  --exclude "*.md"
```

**Windows (PowerShell):**
```powershell
Compress-Archive -Path * -DestinationPath function.zip -Force
```

### 5.5 Задеплоить версию функции

Замени все значения в `< >` на свои:

```bash
yc serverless function version create \
  --function-name startuphelper-api \
  --runtime nodejs18 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 15s \
  --source-path ./function.zip \
  --environment DB_HOST=<ТВОЙ_ХОСТ.mdb.yandexcloud.net> \
  --environment DB_PORT=6432 \
  --environment DB_NAME=startuphelper \
  --environment DB_USER=startuphelper_user \
  --environment DB_PASSWORD=<ТВОЙ_ПАРОЛЬ_ОТ_БД> \
  --environment DB_SSL=true \
  --environment JWT_SECRET=<СГЕНЕРИРОВАННЫЙ_СЕКРЕТ> \
  --environment ALLOWED_ORIGIN=https://<ТВОЙ_ЛОГИН>.github.io
```

> `ALLOWED_ORIGIN` — это URL твоего GitHub Pages.  
> Например: `https://ivanpetrov.github.io` (без названия репозитория!)  
> Если есть кастомный домен — укажи его.

Деплой займёт 1–2 минуты. В конце увидишь `status: ACTIVE`.

### 5.6 Сделать функцию публично вызываемой

```bash
yc serverless function allow-unauthenticated-invoke \
  --name startuphelper-api
```

### 5.7 Быстро проверить функцию

```bash
# Получаем URL
yc serverless function get --name startuphelper-api
# Копируем http_invoke_url

curl <HTTP_INVOKE_URL>/health
# {"ok":true,"ts":"2024-..."}
```

---

## 6. Создание API Gateway

Функция уже работает, но её URL меняется при каждом деплое и выглядит некрасиво.  
API Gateway даёт постоянный красивый URL.

### 6.1 Создать Service Account

```bash
# Создаём сервисный аккаунт
yc iam service-account create \
  --name startuphelper-sa

# Запоминаем его ID
yc iam service-account get --name startuphelper-sa
# id: aje.................  ← запомни
```

Даём аккаунту право вызывать функцию:
```bash
yc serverless function add-access-binding \
  --name startuphelper-api \
  --role serverless.functions.invoker \
  --service-account-name startuphelper-sa
```

### 6.2 Создать файл спецификации

Создай файл `api-gateway.yaml` в корне проекта (рядом с backend/):

```yaml
openapi: "3.0.0"
info:
  title: StartupHelper API
  version: "1.0"

paths:
  /{path+}:
    x-yc-apigateway-any-method:
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ТВОЙ_FUNCTION_ID
        service_account_id: ТВОЙ_SERVICE_ACCOUNT_ID
      parameters:
        - name: path
          in: path
          required: false
          schema:
            type: string
```

> Замени `ТВОЙ_FUNCTION_ID` и `ТВОЙ_SERVICE_ACCOUNT_ID` на реальные ID.

### 6.3 Создать Gateway

```bash
yc serverless api-gateway create \
  --name startuphelper-gateway \
  --spec api-gateway.yaml
```

### 6.4 Получить финальный URL

```bash
yc serverless api-gateway get --name startuphelper-gateway
```

В выводе найди строку:
```
domain: d5dxxxxxxxxxx.apigw.yandexcloud.net
```

**Это твой постоянный API URL.** Запиши его.

---

## 7. Проверка что всё работает

### 7.1 Проверить healthcheck

```bash
curl https://d5dxxxxxxxxxx.apigw.yandexcloud.net/health
# {"ok":true,"ts":"..."}
```

### 7.2 Проверить регистрацию

```bash
curl -X POST https://d5dxxxxxxxxxx.apigw.yandexcloud.net/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@test.com",
    "password": "123456",
    "name": "Тестовый пользователь",
    "role": "startup"
  }'
```

Должно вернуть:
```json
{
  "token": "eyJ...",
  "user": {
    "uid": "...",
    "email": "test@test.com",
    "name": "Тестовый пользователь",
    "role": "startup"
  }
}
```

### 7.3 Проверить вход

```bash
curl -X POST https://d5dxxxxxxxxxx.apigw.yandexcloud.net/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@test.com", "password": "123456"}'
```

### 7.4 Если что-то не работает — посмотреть логи

```bash
yc serverless function logs --name startuphelper-api --follow
```

---

## 8. Подключение фронтенда

### 8.1 Прописать URL в api-config.js

Открой файл `api-config.js` и замени первую строку:

```js
// БЫЛО:
const API_URL = 'https://YOUR_FUNCTION_ID.apigw.yandexcloud.net';

// СТАЛО (твой реальный URL):
const API_URL = 'https://d5dxxxxxxxxxx.apigw.yandexcloud.net';
```

### 8.2 В каждом HTML-файле заменить подключение скриптов

Найди в каждом HTML-файле этот блок (обычно перед `</body>`):

```html
<!-- БЫЛО — удалить эти 4 строки: -->
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js"></script>
<script src="firebase-config.js"></script>

<!-- СТАЛО — одна строка: -->
<script src="api-config.js"></script>
```

**Список файлов для замены:**
- [ ] `index.html`
- [ ] `login.html`
- [ ] `register.html`
- [ ] `dashboard.html`
- [ ] `startups.html`
- [ ] `startup.html`
- [ ] `profile.html`
- [ ] `members.html`
- [ ] `member.html`
- [ ] `messages.html`
- [ ] `forum.html`
- [ ] `feed.html`
- [ ] `create-startup.html`
- [ ] `my-startups.html`
- [ ] `update-startup.html`
- [ ] `roadmap.html`
- [ ] `admin.html`

### 8.3 Обновить register.html

Форма регистрации теперь должна передавать всё сразу в один вызов.

Найди функцию `doRegister()` в `register.html` и замени блок создания пользователя:

```js
// БЫЛО (Firebase):
var cred = await auth.createUserWithEmailAndPassword(email, pass);
await db.collection('users').doc(cred.user.uid).set({
  uid: cred.user.uid, name, email, role: roleToSave,
  bio, skills, contacts, portfolio, avatar: '',
  createdAt: firebase.firestore.FieldValue.serverTimestamp()
});
window.location.href = 'dashboard.html';

// СТАЛО (новый API — один вызов):
await auth.createUserWithEmailAndPassword(email, pass, {
  name, role: roleToSave, bio,
  skills: skills.slice(),
  contacts, portfolio
});
window.location.href = 'dashboard.html';
```

### 8.4 Обновить login.html

Найди в `login.html` вызов входа. Скорее всего он уже совместим:

```js
// Это работает и с Firebase и с новым API:
await auth.signInWithEmailAndPassword(email, password);
```

Только убедись что импорт заменён на `api-config.js`.

### 8.5 Остальные страницы

Большинство страниц используют `db.collection(...)` — это работает через слой совместимости в `api-config.js`. Но для некоторых сложных запросов может потребоваться небольшая доработка.

**Самые простые для замены сначала:** `login`, `register`, `startups` (каталог), `members`.

---

## 9. Публикация на GitHub Pages

После изменений в HTML-файлах:

```bash
git add .
git commit -m "Migrate to Yandex Cloud backend"
git push origin main
```

GitHub Pages автоматически обновится через 1–2 минуты.

---

## 10. Как обновлять бэкенд

Когда меняешь код в `backend/`:

```bash
cd backend

# Пересобрать архив
zip -r function.zip . --exclude "*.git*" --exclude ".env" --exclude "*.md"

# Задеплоить новую версию (те же переменные окружения)
yc serverless function version create \
  --function-name startuphelper-api \
  --runtime nodejs18 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 15s \
  --source-path ./function.zip \
  --environment DB_HOST=<ХОСТ> \
  --environment DB_PORT=6432 \
  --environment DB_NAME=startuphelper \
  --environment DB_USER=startuphelper_user \
  --environment DB_PASSWORD=<ПАРОЛЬ> \
  --environment DB_SSL=true \
  --environment JWT_SECRET=<СЕКРЕТ> \
  --environment ALLOWED_ORIGIN=https://<ЛОГИН>.github.io
```

---

## Шпаргалка — все данные которые нужно записать

Заполни по ходу настройки:

```
Yandex Cloud:
  Folder ID:          b1g_______________________
  
PostgreSQL:
  DB_HOST:            rc1b-______________________.mdb.yandexcloud.net
  DB_NAME:            startuphelper
  DB_USER:            startuphelper_user
  DB_PASSWORD:        ______________________________

Cloud Function:
  Function ID:        d4e_______________________
  Function URL:       https://functions.yandexcloud.net/d4e_______

Service Account:
  SA ID:              aje_______________________

API Gateway:
  Gateway ID:         d5d_______________________
  API URL:            https://d5d______________________.apigw.yandexcloud.net

JWT:
  JWT_SECRET:         ____________________________________________

GitHub Pages:
  URL:                https://__________________.github.io
```

---

## Частые проблемы

### "Connection refused" от PostgreSQL
→ Проверь что у хоста включён **Публичный доступ** (в настройках хоста кластера)  
→ Убедись что порт `6432`, а не `5432`

### "Function timeout"
→ Увеличь `--execution-timeout 30s`  
→ Проверь что DB_HOST правильный

### CORS ошибка в браузере
→ Убедись что `ALLOWED_ORIGIN` в переменных функции точно совпадает с URL GitHub Pages (без слеша в конце)

### "JWT malformed" при входе
→ Убедись что `JWT_SECRET` одинаковый при каждом деплое (не генерируй новый каждый раз!)

### Страница грузится но данные не приходят
→ Открой DevTools → Network → посмотри какие запросы падают и с какой ошибкой  
→ Проверь логи функции: `yc serverless function logs --name startuphelper-api`
