// Батч-эндпоинт дашборда: всё, что нужно странице для текущей роли, одним ответом.
// Раньше dashboard.html делал до 16 последовательных запросов (~200 мс каждый).
const express = require('express');
const { queryOne, queryAll } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getUserGroupSettings } = require('./groups');

const router = express.Router();

function tryParse(val, fallback) {
  if (!val) return fallback;
  if (typeof val !== 'string') return val;
  try { return JSON.parse(val); } catch (e) { return fallback; }
}

// Стартап в том же виде, что отдаёт GET /startups (фронт ждёт camelCase-алиасы)
function shapeStartup(s) {
  return {
    id: s.id,
    name: s.name,
    tagline: s.tagline,
    stage: s.stage,
    category: s.category,
    privacy: s.privacy,
    emoji: s.emoji,
    icon_image: s.icon_image,
    iconImage: s.icon_image,
    owner_uid: s.owner_uid,
    ownerUid: s.owner_uid,
    owner_name: s.owner_name,
    ownerName: s.owner_name,
    created_at: s.created_at,
    createdAt: s.created_at,
  };
}

function shapeInvite(inv) {
  return {
    ...inv,
    from_skills: tryParse(inv.from_skills, []),
    applications: tryParse(inv.applications, []),
    fromUid: inv.from_uid,
    fromName: inv.from_name,
    fromAvatar: inv.from_avatar,
    toUid: inv.to_uid,
    startupId: inv.startup_id,
    startupName: inv.startup_name,
    startupOwner: inv.startup_owner,
    vacancyId: inv.vacancy_id,
    // Глобальная роль заявителя — приходит JOIN'ом, раньше это был запрос на каждую заявку
    _fromRole: inv.from_role || 'user',
  };
}

// Свежие стартапы для лент «Стартапы» / «Свежие стартапы».
// Скрытые и закрытые не показываем; ограничение по группе — как в GET /startups.
async function recentStartups(user, limit) {
  const params = [user.uid];
  let sql = `SELECT * FROM startups
             WHERE privacy <> 'closed'
               AND (hidden IS NOT TRUE OR owner_uid = $1)`;

  const gs = await getUserGroupSettings(user.uid);
  if (gs && gs.startup_visibility === 'group_only') {
    params.push(gs.group_id);
    sql += ` AND owner_uid IN (SELECT user_uid FROM user_groups WHERE group_id = $${params.length})`;
  }

  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  return (await queryAll(sql, params)).map(shapeStartup);
}

// GET /dashboard — данные дашборда для роли текущего пользователя
router.get('/', requireAuth, async (req, res) => {
  try {
    const uid  = req.user.uid;
    const role = req.user.role || 'user';

    if (role === 'startup') {
      // Три независимых запроса вместо цепочки «стартапы → заявки → профиль на каждую заявку → команда на каждый стартап»
      const [startups, invites, teamRow] = await Promise.all([
        queryAll('SELECT * FROM startups WHERE owner_uid = $1 ORDER BY created_at DESC', [uid]),
        queryAll(
          `SELECT i.*, u.role AS from_role
           FROM invites i
           LEFT JOIN users u ON u.uid = i.from_uid
           WHERE i.startup_owner = $1
             AND i.status = 'pending'
             AND (i.type IS NULL OR i.type <> 'from_startup')
           ORDER BY i.created_at DESC`,
          [uid]
        ),
        queryOne(
          `SELECT COUNT(*)::int AS c
           FROM startup_team t
           JOIN startups s ON s.id = t.startup_id
           WHERE s.owner_uid = $1`,
          [uid]
        ),
      ]);

      return res.json({
        role,
        startups:  startups.map(shapeStartup),
        invites:   invites.map(shapeInvite),
        teamTotal: teamRow ? teamRow.c : 0,
      });
    }

    if (role === 'expert') {
      const [mine, recent] = await Promise.all([
        queryAll('SELECT * FROM startups WHERE owner_uid = $1 ORDER BY created_at DESC', [uid]),
        recentStartups(req.user, 10),
      ]);
      return res.json({ role, myStartups: mine.map(shapeStartup), recentStartups: recent });
    }

    if (role === 'admin') {
      // Считаем в БД, а не выкачиванием обеих таблиц целиком на клиент
      const [stats, startupCount] = await Promise.all([
        queryOne(
          `SELECT COUNT(*)::int AS users,
                  COUNT(*) FILTER (WHERE role = 'expert')::int AS experts
           FROM users WHERE hidden IS NOT TRUE`
        ),
        queryOne('SELECT COUNT(*)::int AS c FROM startups WHERE hidden IS NOT TRUE'),
      ]);
      return res.json({
        role,
        stats: {
          users:    stats ? stats.users : 0,
          experts:  stats ? stats.experts : 0,
          startups: startupCount ? startupCount.c : 0,
        },
      });
    }

    // moderator сюда намеренно не включён: у него и так один запрос,
    // а скоуп жалоб по группе живёт в GET /complaints — дублировать его здесь опасно.
    if (role === 'moderator') {
      return res.json({ role, useComplaintsEndpoint: true });
    }

    // role === 'user' и всё остальное
    const [incoming, recent, mine] = await Promise.all([
      queryAll(
        `SELECT * FROM invites
         WHERE to_uid = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [uid]
      ),
      recentStartups(req.user, 6),
      queryAll('SELECT * FROM invites WHERE from_uid = $1 ORDER BY created_at DESC', [uid]),
    ]);

    return res.json({
      role,
      incomingInvites: incoming.map(shapeInvite),
      recentStartups:  recent,
      myInvites:       mine.map(shapeInvite),
    });
  } catch (e) {
    console.error('GET /dashboard error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
