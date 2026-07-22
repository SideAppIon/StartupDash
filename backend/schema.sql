-- ============================================================
-- StartupDash — PostgreSQL Schema
-- Выполнить в Yandex Cloud: Managed Service for PostgreSQL
-- psql -h <HOST> -U <USER> -d <DATABASE> -f schema.sql
-- ============================================================

-- Расширения
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Пользователи ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  uid           TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user','startup','expert','admin','moderator')),
  bio           TEXT DEFAULT '',
  skills        TEXT DEFAULT '[]',       -- JSON array
  avatar        TEXT DEFAULT '',
  contacts      TEXT DEFAULT '',
  portfolio     TEXT DEFAULT '',
  forum_banned  BOOLEAN DEFAULT FALSE,   -- запрет общения на форуме (только чтение)
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ
);

-- ── Стартапы ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS startups (
  id             TEXT PRIMARY KEY,
  owner_uid      TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  owner_name     TEXT DEFAULT '',
  name           TEXT NOT NULL,
  tagline        TEXT DEFAULT '',
  stage          TEXT DEFAULT 'Идея',
  category       TEXT DEFAULT '',
  website        TEXT DEFAULT '',
  looking_for    TEXT DEFAULT '',
  cover_image    TEXT DEFAULT '',
  emoji          TEXT DEFAULT '🚀',
  icon_image     TEXT DEFAULT '',
  tags           TEXT DEFAULT '[]',            -- JSON array
  privacy        TEXT DEFAULT 'public'
                   CHECK (privacy IN ('public','private','closed')),
  content_blocks TEXT DEFAULT '[]',            -- JSON array [{type, content}]
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_startups_owner   ON startups(owner_uid);
CREATE INDEX IF NOT EXISTS idx_startups_privacy ON startups(privacy);

-- ── Команда стартапа ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS startup_team (
  id          SERIAL PRIMARY KEY,
  startup_id  TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  user_uid    TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  role        TEXT DEFAULT 'Участник',
  permissions TEXT DEFAULT '{}',   -- JSON {updates: bool, kanban: bool}
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(startup_id, user_uid)
);

-- ── Обновления проекта ────────────────────────────────────
CREATE TABLE IF NOT EXISTS startup_updates (
  id         TEXT PRIMARY KEY,
  startup_id TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  author_uid TEXT NOT NULL REFERENCES users(uid),
  title      TEXT DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  type       TEXT DEFAULT 'text',
  image_url  TEXT DEFAULT '',
  video_url  TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_updates_startup ON startup_updates(startup_id);

-- ── Задачи (Roadmap / Kanban) ─────────────────────────────
CREATE TABLE IF NOT EXISTS startup_tasks (
  id            TEXT PRIMARY KEY,
  startup_id    TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT DEFAULT '',
  status        TEXT DEFAULT 'todo',
  assigned_to   TEXT REFERENCES users(uid) ON DELETE SET NULL,
  position      INTEGER DEFAULT 0,
  priority      TEXT DEFAULT 'med',
  assignee_name TEXT DEFAULT '',
  is_public     BOOLEAN DEFAULT true,
  archived      BOOLEAN DEFAULT false,
  deadline      DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_startup ON startup_tasks(startup_id);

-- ── Вакансии ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS startup_vacancies (
  id          TEXT PRIMARY KEY,
  startup_id  TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  skills      TEXT DEFAULT '[]',      -- JSON array
  applicants  TEXT DEFAULT '[]',      -- JSON array [{uid, appliedAt}]
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Форум ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forum_topics (
  id          TEXT PRIMARY KEY,
  author_uid  TEXT NOT NULL REFERENCES users(uid),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  reply_count INTEGER DEFAULT 0,
  views       INTEGER DEFAULT 0,
  hidden      BOOLEAN DEFAULT FALSE,
  pinned      BOOLEAN DEFAULT FALSE,
  last_at     TIMESTAMPTZ DEFAULT NOW(),
  last_author TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id         TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL REFERENCES forum_topics(id) ON DELETE CASCADE,
  author_uid TEXT NOT NULL REFERENCES users(uid),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_topic ON forum_posts(topic_id);

-- ── Приглашения / Заявки ─────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
  id             TEXT PRIMARY KEY,
  from_uid       TEXT NOT NULL REFERENCES users(uid),
  from_name      TEXT DEFAULT '',
  from_avatar    TEXT DEFAULT '',
  from_skills    TEXT DEFAULT '[]',   -- JSON array
  to_uid         TEXT REFERENCES users(uid),   -- для приглашений от стартапа
  startup_id     TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  startup_name   TEXT DEFAULT '',
  startup_owner  TEXT DEFAULT '',
  type           TEXT DEFAULT 'specialist'
                   CHECK (type IN ('specialist','role','expert','from_startup')),
  role           TEXT DEFAULT 'Специалист',
  expert_area    TEXT DEFAULT '',
  message        TEXT DEFAULT '',
  applications   TEXT DEFAULT '[]',   -- JSON array
  vacancy_id     TEXT,                -- id вакансии, если отклик на конкретную вакансию
  status         TEXT DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','rejected','removed')),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invites_from    ON invites(from_uid);
CREATE INDEX IF NOT EXISTS idx_invites_startup ON invites(startup_id);
CREATE INDEX IF NOT EXISTS idx_invites_owner   ON invites(startup_owner);

-- ── Диалоги ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id                  TEXT PRIMARY KEY,
  participant_names   TEXT DEFAULT '{}',    -- JSON {uid: name}
  participant_avatars TEXT DEFAULT '{}',    -- JSON {uid: avatar}
  participant_roles   TEXT DEFAULT '{}',    -- JSON {uid: role}
  last_message        TEXT DEFAULT '',
  last_at             TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conv_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  PRIMARY KEY (conv_id, user_uid)
);

CREATE INDEX IF NOT EXISTS idx_conv_participants ON conversation_participants(user_uid);

-- ── Сообщения ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  conv_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_uid TEXT NOT NULL,
  text       TEXT NOT NULL,
  type       TEXT DEFAULT 'user',   -- 'user' | 'system'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at);

-- ── Жалобы (модерация) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS complaints (
  id           TEXT PRIMARY KEY,
  reporter_uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  target_uid   TEXT REFERENCES users(uid) ON DELETE CASCADE,  -- на кого жалоба
  context      TEXT DEFAULT '',          -- 'forum' | 'profile' | ...
  topic_id     TEXT,                      -- если жалоба с форума
  post_id      TEXT,                      -- конкретное сообщение (опц.)
  text         TEXT NOT NULL DEFAULT '',  -- текст жалобы
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','resolved','dismissed')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ,
  resolved_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_target ON complaints(target_uid);

-- ── Настройки платформы ──────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',   -- JSON
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Вставляем дефолтную конфигурацию
INSERT INTO platform_config (key, value) VALUES
  ('platform', '{"categories":["FinTech","EdTech","HealthTech","E-commerce","SaaS","AI / ML","Gaming","GreenTech","Marketplace","Другое"],"stages":[{"name":"Идея","icon":"💡"},{"name":"MVP","icon":"⚡"},{"name":"Бета","icon":"🔬"},{"name":"Запущен","icon":"🚀"},{"name":"Масштабирование","icon":"📈"}],"feedLimit":25}')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- МИГРАЦИИ для уже существующих БД (идемпотентны)
-- ============================================================
-- Роль модератора (скрытая, назначается только из админки)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user','startup','expert','admin','moderator'));
-- Запрет общения на форуме (пользователь может только читать)
ALTER TABLE users ADD COLUMN IF NOT EXISTS forum_banned BOOLEAN DEFAULT FALSE;
-- Закрепление тем форума
ALTER TABLE forum_topics ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;

-- Мягкое скрытие админом (теневой бан): не видно другим, владелец/автор видит своё
ALTER TABLE startups ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;
ALTER TABLE users    ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT FALSE;

-- Статус эксперта: 'available' (готов помочь, по умолчанию) | 'busy' (занят)
ALTER TABLE users ADD COLUMN IF NOT EXISTS expert_status TEXT DEFAULT 'available';

-- Значок-алмаз (💎), включается админом для конкретного пользователя
ALTER TABLE users ADD COLUMN IF NOT EXISTS diamond BOOLEAN DEFAULT FALSE;

-- Когда пользователь последний раз открывал уведомления (колокольчик)
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_seen_at TIMESTAMPTZ;

-- Опросы (создаёт стартапер) и голоса. Опрос может содержать несколько вопросов.
CREATE TABLE IF NOT EXISTS polls (
  id         TEXT PRIMARY KEY,
  owner_uid  TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  owner_name TEXT DEFAULT '',
  question   TEXT NOT NULL DEFAULT '',       -- первый вопрос (совместимость)
  options    TEXT NOT NULL DEFAULT '[]',      -- варианты первого вопроса (совместимость)
  questions    TEXT NOT NULL DEFAULT '[]',    -- JSON [{question, desc, options:[...]}]
  audience     TEXT DEFAULT 'all',            -- 'all' | 'registered'
  status       TEXT DEFAULT 'open',           -- 'open' | 'closed'
  show_results BOOLEAN DEFAULT true,          -- показывать ли результаты голосующим
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS poll_votes (
  id             TEXT PRIMARY KEY,
  poll_id        TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  question_index INTEGER NOT NULL DEFAULT 0,
  option_index   INTEGER NOT NULL,
  voter_uid      TEXT,   -- NULL для анонимных
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS poll_votes_q_uid_uniq
  ON poll_votes(poll_id, question_index, voter_uid) WHERE voter_uid IS NOT NULL;

-- Вложения-документы стартапа (JSON-массив {name, url, size, ext}, до 5 файлов)
ALTER TABLE startups ADD COLUMN IF NOT EXISTS attachments TEXT DEFAULT '[]';

-- Задачи канбана: комментарии (правят все участники) и блокировка редактирования
ALTER TABLE startup_tasks ADD COLUMN IF NOT EXISTS comments TEXT DEFAULT '';
ALTER TABLE startup_tasks ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false;

-- Лайки стартапов (один лайк на пользователя)
CREATE TABLE IF NOT EXISTS startup_likes (
  startup_id TEXT NOT NULL REFERENCES startups(id) ON DELETE CASCADE,
  user_uid   TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (startup_id, user_uid)
);

-- Форум стартапа: флаг включения + привязка темы к стартапу
-- (тема с startup_id не показывается в общем форуме, только на странице стартапа)
ALTER TABLE startups ADD COLUMN IF NOT EXISTS forum_enabled BOOLEAN DEFAULT true;
ALTER TABLE forum_topics ADD COLUMN IF NOT EXISTS startup_id TEXT;

-- Лайки постов-обновлений (один лайк на пользователя)
CREATE TABLE IF NOT EXISTS update_likes (
  update_id  TEXT NOT NULL REFERENCES startup_updates(id) ON DELETE CASCADE,
  user_uid   TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (update_id, user_uid)
);

-- Привязка модераторов к группам (модератор видит/модерирует только свои группы)
-- group_id — UUID, как groups.id / user_groups.group_id (иначе JOIN'ы падают uuid=text)
CREATE TABLE IF NOT EXISTS moderator_groups (
  moderator_uid TEXT NOT NULL,
  group_id      UUID NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (moderator_uid, group_id)
);
