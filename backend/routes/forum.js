const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { ensureModeratorSchema, isAdmin, moderatorCanActOn } = require('../lib/moderation');

const router = express.Router();

// Модератор или администратор
const isModerator = (user) => user && (user.role === 'admin' || user.role === 'moderator');

// Может ли пользователь модерировать контент автора authorUid.
// Админ — всегда; модератор — только если автор в его группе.
async function canModerateAuthor(user, authorUid) {
  if (isAdmin(user)) return true;
  if (user && user.role === 'moderator') {
    await ensureModeratorSchema();
    return moderatorCanActOn(user.uid, authorUid);
  }
  return false;
}

// Проверка запрета общения на форуме
async function isForumBanned(uid) {
  const row = await queryOne('SELECT forum_banned FROM users WHERE uid=$1', [uid]);
  return !!(row && row.forum_banned);
}

// GET /forum — список тем
router.get('/', optionalAuth, async (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const { search } = req.query;

    let sql = `SELECT t.*, u.name AS author_name, u.avatar AS author_avatar, u.diamond AS author_diamond
               FROM forum_topics t
               JOIN users u ON u.uid = t.author_uid
               WHERE 1=1`;
    const params = [];

    // Скрытые темы не показываем — но автор видит свои (как теневой бан)
    if (!isAdmin) {
      if (req.user) {
        params.push(req.user.uid);
        sql += ` AND (t.hidden IS NULL OR t.hidden = false OR t.author_uid = $${params.length})`;
      } else {
        sql += ` AND (t.hidden IS NULL OR t.hidden = false)`;
      }
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND t.title ILIKE $${params.length}`;
    }
    sql += ' ORDER BY t.last_at DESC NULLS LAST';

    const topics = await queryAll(sql, params);
    res.json({ topics });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /forum — создать тему
router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title и content обязательны' });

    if (await isForumBanned(req.user.uid)) {
      return res.status(403).json({ error: 'Вам запрещено общение на форуме. Доступен только просмотр.' });
    }

    const id = uuidv4();
    const topic = await queryOne(
      `INSERT INTO forum_topics (id, author_uid, title, content, reply_count, views, created_at, last_at)
       VALUES ($1,$2,$3,$4,0,0,NOW(),NOW()) RETURNING *`,
      [id, req.user.uid, title, content]
    );
    res.status(201).json({ topic });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /forum/:id — одна тема
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const topic = await queryOne(
      `SELECT t.*, u.name AS author_name, u.avatar AS author_avatar, u.diamond AS author_diamond,
              u.role AS author_role, u.forum_banned AS author_forum_banned
       FROM forum_topics t
       JOIN users u ON u.uid = t.author_uid
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
    const isAdmin = req.user && req.user.role === 'admin';
    const isAuthor = req.user && req.user.uid === topic.author_uid;
    if (topic.hidden && !isAdmin && !isAuthor) return res.status(404).json({ error: 'Тема не найдена' });
    res.json({ topic });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /forum/:id — обновить тему (автор или счётчики)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const topic = await queryOne('SELECT * FROM forum_topics WHERE id=$1', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Тема не найдена' });

    // Модератор может модерировать только темы авторов своей группы (админ — любые)
    const isMod = await canModerateAuthor(req.user, topic.author_uid);
    const isAuthor = topic.author_uid === req.user.uid;
    const serviceFields = ['reply_count', 'last_at', 'last_author', 'views'];
    const keys = Object.keys(req.body);
    const onlyServiceFields = keys.every(k => serviceFields.includes(k));

    if (!isAuthor && !isMod && !onlyServiceFields) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    // Модератор/админ модерирует (закреп/скрытие), автор редактирует свою тему
    const allowed = isMod
      ? ['title', 'content', 'hidden', 'pinned', ...serviceFields]
      : isAuthor
      ? ['title', 'content', ...serviceFields]
      : serviceFields;

    const updates = []; const values = [];
    allowed.forEach(f => {
      if (req.body[f] !== undefined) { values.push(req.body[f]); updates.push(`${f}=$${values.length}`); }
    });
    if (!updates.length) return res.status(400).json({ error: 'Нечего обновлять' });
    values.push(req.params.id);
    const updated = await queryOne(
      `UPDATE forum_topics SET ${updates.join(',')} WHERE id=$${values.length} RETURNING *`, values
    );
    res.json({ topic: updated });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /forum/:id — администратор или модератор (модератор — только своя группа)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (!isModerator(req.user)) return res.status(403).json({ error: 'Только модератор или администратор' });
    const topic = await queryOne('SELECT author_uid FROM forum_topics WHERE id=$1', [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
    if (!(await canModerateAuthor(req.user, topic.author_uid))) {
      return res.status(403).json({ error: 'Тема вне вашей группы' });
    }
    await queryOne('DELETE FROM forum_posts WHERE topic_id=$1', [req.params.id]);
    await queryOne('DELETE FROM forum_topics WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /forum/:id/posts — посты темы
router.get('/:id/posts', optionalAuth, async (req, res) => {
  try {
    const posts = await queryAll(
      `SELECT p.*, u.name AS author_name, u.avatar AS author_avatar, u.role AS author_role,
              u.forum_banned AS author_forum_banned, u.diamond AS author_diamond
       FROM forum_posts p
       JOIN users u ON u.uid = p.author_uid
       WHERE p.topic_id=$1
       ORDER BY p.created_at ASC`,
      [req.params.id]
    );

    // Обновляем счётчик просмотров
    await queryOne('UPDATE forum_topics SET views = views + 1 WHERE id=$1', [req.params.id]);

    res.json({ posts });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// POST /forum/:id/posts — добавить пост
router.post('/:id/posts', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content обязателен' });

    if (await isForumBanned(req.user.uid)) {
      return res.status(403).json({ error: 'Вам запрещено общение на форуме. Доступен только просмотр.' });
    }

    const id = uuidv4();
    const post = await queryOne(
      `INSERT INTO forum_posts (id, topic_id, author_uid, content, created_at)
       VALUES ($1,$2,$3,$4,NOW()) RETURNING *`,
      [id, req.params.id, req.user.uid, content]
    );

    // Обновляем счётчик ответов и last_at темы
    const user = await queryOne('SELECT name FROM users WHERE uid=$1', [req.user.uid]);
    await queryOne(
      `UPDATE forum_topics SET reply_count = reply_count + 1, last_at=NOW(), last_author=$1 WHERE id=$2`,
      [user.name, req.params.id]
    );

    res.status(201).json({ post });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// DELETE /forum/:id/posts/:postId — автор или администратор
router.delete('/:id/posts/:postId', requireAuth, async (req, res) => {
  try {
    const post = await queryOne('SELECT author_uid FROM forum_posts WHERE id=$1', [req.params.postId]);
    if (!post) return res.status(404).json({ error: 'Пост не найден' });

    // Автор удаляет свой пост; модератор — только посты авторов своей группы (админ — любые)
    const canDelete = post.author_uid === req.user.uid
      || (await canModerateAuthor(req.user, post.author_uid));
    if (!canDelete) return res.status(403).json({ error: 'Нет доступа' });

    await queryOne('DELETE FROM forum_posts WHERE id=$1', [req.params.postId]);

    // Обновляем счётчик
    await queryOne(
      'UPDATE forum_topics SET reply_count = GREATEST(reply_count - 1, 0) WHERE id=$1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
