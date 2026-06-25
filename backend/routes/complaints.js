const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  ensureModeratorSchema, isAdmin, isModerator,
  moderatorCanActOn, scopedUidsSubquery,
} = require('../lib/moderation');

const router = express.Router();

// POST /complaints — подать жалобу (любой авторизованный пользователь)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { targetUid, text, context, topicId, postId } = req.body;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: 'Опишите причину жалобы' });
    }
    if (targetUid && targetUid === req.user.uid) {
      return res.status(400).json({ error: 'Нельзя пожаловаться на себя' });
    }

    const id = uuidv4();
    const complaint = await queryOne(
      `INSERT INTO complaints (id, reporter_uid, target_uid, context, topic_id, post_id, text, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'open',NOW()) RETURNING *`,
      [id, req.user.uid, targetUid || null, context || '', topicId || null, postId || null, String(text).trim().slice(0, 2000)]
    );
    res.status(201).json({ complaint });
  } catch (e) {
    console.error('create complaint:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// GET /complaints — список жалоб (только модератор / администратор)
// Админ видит все жалобы; модератор — только те, где цель жалобы состоит
// в одной из закреплённых за ним групп (жалобщик может быть любым).
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!isModerator(req.user)) return res.status(403).json({ error: 'Только модератор или администратор' });
    await ensureModeratorSchema();

    const { status } = req.query;
    const params = [];
    let sql = `SELECT c.*,
                 r.name AS reporter_name, r.avatar AS reporter_avatar,
                 t.name AS target_name, t.avatar AS target_avatar,
                 t.role AS target_role, t.forum_banned AS target_forum_banned
               FROM complaints c
               LEFT JOIN users r ON r.uid = c.reporter_uid
               LEFT JOIN users t ON t.uid = c.target_uid
               WHERE 1=1`;
    if (status) { params.push(status); sql += ` AND c.status = $${params.length}`; }

    // Скоуп по группе для модератора (админ — без ограничений)
    if (!isAdmin(req.user)) {
      params.push(req.user.uid);
      sql += ` AND c.target_uid IN (${scopedUidsSubquery(params.length)})`;
    }

    sql += ' ORDER BY (c.status='+`'open'`+') DESC, c.created_at DESC';

    const complaints = await queryAll(sql, params);
    res.json({ complaints });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// PATCH /complaints/:id — изменить статус (модератор / администратор)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    if (!isModerator(req.user)) return res.status(403).json({ error: 'Только модератор или администратор' });
    await ensureModeratorSchema();
    const { status } = req.body;
    const valid = ['open', 'resolved', 'dismissed'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Неверный статус' });

    // Модератор может менять статус только жалоб на пользователей своей группы
    if (!isAdmin(req.user)) {
      const complaint = await queryOne('SELECT target_uid FROM complaints WHERE id=$1', [req.params.id]);
      if (!complaint) return res.status(404).json({ error: 'Жалоба не найдена' });
      if (!(await moderatorCanActOn(req.user.uid, complaint.target_uid))) {
        return res.status(403).json({ error: 'Жалоба вне вашей группы' });
      }
    }

    const updated = await queryOne(
      `UPDATE complaints SET status=$1, resolved_by=$2,
         resolved_at=${status === 'open' ? 'NULL' : 'NOW()'}
       WHERE id=$3 RETURNING *`,
      [status, req.user.uid, req.params.id]
    );
    if (!updated) return res.status(404).json({ error: 'Жалоба не найдена' });
    res.json({ complaint: updated });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
