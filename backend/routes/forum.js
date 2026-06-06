const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// GET /forum — список тем
router.get('/', optionalAuth, async (req, res) => {
  try {
    const isAdmin = req.user && req.user.role === 'admin';
    const { search } = req.query;

    let sql = `SELECT t.*, u.name AS author_name, u.avatar AS author_avatar
               FROM forum_topics t
               JOIN users u ON u.uid = t.author_uid
               WHERE 1=1`;
    const params = [];

    if (!isAdmin) sql += ` AND (t.hidden IS NULL OR t.hidden = false)`;
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
      `SELECT t.*, u.name AS author_name, u.avatar AS author_avatar
       FROM forum_topics t
       JOIN users u ON u.uid = t.author_uid
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
    const isAdmin = req.user && req.user.role === 'admin';
    if (topic.hidden && !isAdmin) return res.status(404).json({ error: 'Тема не найдена' });
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

    const isAdmin = req.user.role === 'admin';
    const isAuthor = topic.author_uid === req.user.uid;
    const serviceFields = ['reply_count', 'last_at', 'last_author', 'views'];
    const keys = Object.keys(req.body);
    const onlyServiceFields = keys.every(k => serviceFields.includes(k));

    if (!isAuthor && !isAdmin && !onlyServiceFields) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    const allowed = isAdmin || isAuthor
      ? ['title', 'content', 'hidden', ...serviceFields]
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

// DELETE /forum/:id — только администратор
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только администратор' });
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
      `SELECT p.*, u.name AS author_name, u.avatar AS author_avatar, u.role AS author_role
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

    const canDelete = post.author_uid === req.user.uid || req.user.role === 'admin';
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
