// ─────────────────────────────────────────────────────────
// api-config.js — полная замена firebase-config.js
// Совместимый слой: все вызовы db.collection(...) и auth.*
// работают через REST API бэкенда на Yandex Cloud
// ─────────────────────────────────────────────────────────

const API_URL = 'https://d5d0pq825bknmdlu2u40.6brbn2wz.apigw.yandexcloud.net';

// ─────────────────────────────────────────────────────────
// ТОКЕН
// ─────────────────────────────────────────────────────────
function getToken()    { return localStorage.getItem('auth_token'); }
function setToken(t)   { localStorage.setItem('auth_token', t); }
function removeToken() { localStorage.removeItem('auth_token'); }

// ─────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────
async function apiRequest(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API_URL + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка запроса');
    err.code  = res.status;
    throw err;
  }
  return data;
}
const api = {
  get:    (path)       => apiRequest('GET',  path),
  post:   (path, body) => apiRequest('POST', path, body),
  // Yandex Cloud API Gateway обрезает тело у PATCH/DELETE запросов.
  // Передаём _method в теле POST-запроса — бэкенд подменяет метод через middleware.
  patch:  (path, body) => apiRequest('POST', path, Object.assign({}, body || {}, { _method: 'PATCH' })),
  delete: (path)       => apiRequest('POST', path, { _method: 'DELETE' }),
};

// ─────────────────────────────────────────────────────────
// СОСТОЯНИЕ AUTH
// ─────────────────────────────────────────────────────────
let _currentUser     = null;
let _currentUserData = null;
let _authCallbacks   = [];
let _authResolved    = false;

// Публичные алиасы (используются напрямую в HTML файлах)
var currentUser     = null;
var currentUserData = null;

function _syncPublic() {
  currentUser     = _currentUser;
  currentUserData = _currentUserData;
}
function _notifyCallbacks() {
  _syncPublic();
  _authCallbacks.forEach(cb => cb(_currentUser));
}

// Восстанавливаем сессию при загрузке страницы
(async function initAuth() {
  const token = getToken();
  if (token) {
    try {
      const data = await api.get('/auth/me');
      // Если бэкенд вернул свежий токен (роль изменилась) — сохраняем
      if (data.token) setToken(data.token);
      _currentUser     = { uid: data.user.uid, email: data.user.email };
      _currentUserData = data.user;
    } catch (e) {
      removeToken();
      _currentUser = _currentUserData = null;
    }
  }
  _authResolved = true;
  _notifyCallbacks();
  // Колокольчик уведомлений — с задержкой, чтобы страницы с кастомной шапкой
  // (например, лента) успели построить .nav__user
  if (_currentUser) setTimeout(() => { try { _initNotifBell(); } catch (e) {} }, 900);
})();

// ─────────────────────────────────────────────────────────
// AUTH API
// ─────────────────────────────────────────────────────────
const auth = {
  async createUserWithEmailAndPassword(email, password, extra) {
    const data = await api.post('/auth/register', { email, password, ...(extra||{}) });
    setToken(data.token);
    _currentUser     = { uid: data.user.uid, email: data.user.email };
    _currentUserData = data.user;
    _syncPublic();
    return { user: _currentUser };
  },
  async signInWithEmailAndPassword(email, password) {
    const data = await api.post('/auth/login', { email, password });
    setToken(data.token);
    _currentUser     = { uid: data.user.uid, email: data.user.email };
    _currentUserData = data.user;
    _notifyCallbacks();
    return { user: _currentUser };
  },
  async signOut() {
    removeToken();
    _currentUser = _currentUserData = null;
    _notifyCallbacks();
  },
  async sendPasswordResetEmail(email) {
    await api.post('/auth/reset-password', { email });
  },
  onAuthStateChanged(cb) {
    _authCallbacks.push(cb);
    if (_authResolved) cb(_currentUser);
    return () => { _authCallbacks = _authCallbacks.filter(x => x !== cb); };
  },
  get currentUser() { return _currentUser; },
};

// ─────────────────────────────────────────────────────────
// HELPERS: совместимость с Firebase Auth callbacks
// ─────────────────────────────────────────────────────────
function requireAuth(redirectTo) {
  const _check = () => {
    if (!_currentUser) { window.location.href = redirectTo || 'login.html'; return; }
    // Авто-редирект на онбординг если не пройден (кроме самой страницы онбординга)
    const isOnboarding = window.location.pathname.includes('onboarding.html');
    if (!isOnboarding && _currentUserData && _currentUserData.onboarding_done === false) {
      window.location.href = 'onboarding.html';
    }
  };
  if (_authResolved) {
    _check();
  } else {
    const unsub = auth.onAuthStateChanged(() => {
      unsub();
      setTimeout(_check, 50);
    });
  }
}
function redirectIfAuth(redirectTo) {
  if (_authResolved) {
    if (_currentUser) window.location.href = redirectTo || 'dashboard.html';
  } else {
    const unsub = auth.onAuthStateChanged(() => {
      unsub();
      if (_currentUser) window.location.href = redirectTo || 'dashboard.html';
    });
  }
}
function onAuthReady(cb) {
  if (_authResolved) {
    cb(_currentUser, _currentUserData);
  } else {
    const unsub = auth.onAuthStateChanged(() => { unsub(); cb(_currentUser, _currentUserData); });
  }
}

// ─────────────────────────────────────────────────────────
// FIREBASE.FIRESTORE SENTINEL VALUES
// ─────────────────────────────────────────────────────────
class _FieldValueSentinel {
  constructor(type, value) { this._type = type; this._value = value; }
}

function _firestoreCompat() { return db; }
_firestoreCompat.FieldValue = {
  // Возвращаем sentinel — _cleanData его уберёт.
  // Timestamps ставит сам бэкенд через NOW() в SQL.
  serverTimestamp: () => new _FieldValueSentinel('serverTimestamp', null),
  increment:       (n) => new _FieldValueSentinel('increment', n),
  arrayUnion:      (...items) => new _FieldValueSentinel('arrayUnion', items),
  arrayRemove:     (...items) => new _FieldValueSentinel('arrayRemove', items),
};

const firebase = {
  firestore: _firestoreCompat,
  auth:      () => auth,
};

// ─────────────────────────────────────────────────────────
// МАППИНГ: Firestore collection → API endpoint
// ─────────────────────────────────────────────────────────
const _COL_MAP = {
  users:         '/users',
  startups:      '/startups',
  invites:       '/invites',
  conversations: '/messages/conversations',
  forum_topics:  '/forum',
  _config:       '/platform-config',
};

// Вложенные коллекции: "parentCol/parentId/subCol" → "/endpoint/{id}/sub"
function _subPath(parts) {
  // parts = ['startups', id, 'team'] или ['forum_topics', id, 'posts'] и т.д.
  const [col, id, sub] = parts;
  const subMap = {
    'startups/team':          `/startups/${id}/team`,
    'startups/updates':       `/startups/${id}/updates`,
    'startups/tasks':         `/startups/${id}/tasks`,
    'startups/vacancies':     `/startups/${id}/vacancies`,
    'conversations/messages': `/messages/conversations/${id}/messages`,
    'forum_topics/posts':     `/forum/${id}/posts`,
  };
  return subMap[`${col}/${sub}`] || `/${col}/${id}/${sub}`;
}

// Firestore field name → API query param
const _FIELD_MAP = {
  ownerUid:     'owner_uid',
  fromUid:      'from_uid',
  toUid:        'to_uid',
  startupId:    'startup_id',
  startupOwner: 'startup_owner',
  authorUid:    'author_uid',
  createdAt:    'created_at',
  updatedAt:    'updated_at',
};

// snake_case → camelCase (рекурсивно, сохраняет оба ключа)
function _toCamel(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(_toCamel);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = _toCamel(v); // сохраняем snake_case
    const camel = k.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    if (camel !== k) out[camel] = _toCamel(v); // добавляем camelCase
  }
  return out;
}

// Из ответа API вытащить массив документов
function _extractDocs(data, colName) {
  // API возвращает { users:[...] } или { startups:[...] } и т.д.
  const keys = ['users','startups','invites','conversations','topics',
                'team','updates','tasks','vacancies','messages','posts',
                'config','platform'];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  // fallback: первый массивный ключ
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

// Обернуть массив объектов в формат Firestore snapshot
function _makeSnap(rows, basePath) {
  const docs = rows.map(row => _makeDoc(row, basePath));
  return {
    docs,
    size:  docs.length,
    empty: docs.length === 0,
    forEach: (cb) => docs.forEach(cb),
  };
}

function _makeDoc(row, basePath) {
  const camel = _toCamel(row);
  const docId = camel.id || camel.uid || String(Math.random());
  const path  = basePath ? `${basePath}/${docId}` : docId;
  return {
    id:     docId,
    exists: true,
    data:   () => camel,
    ref:    new _DocRef(path),
  };
}

// ─────────────────────────────────────────────────────────
// COLLECTION REF
// ─────────────────────────────────────────────────────────
class _CollectionRef {
  constructor(path, filters = [], orders = [], lim = null) {
    this._path    = path;   // e.g. 'startups' or 'startups/id/team'
    this._filters = filters;
    this._orders  = orders;
    this._lim     = lim;
  }

  _apiPath() {
    const parts = this._path.split('/');
    if (parts.length === 1) {
      return _COL_MAP[parts[0]] || `/${parts[0]}`;
    }
    if (parts.length === 3) {
      return _subPath(parts);
    }
    return '/' + this._path;
  }

  doc(id) { return new _DocRef(`${this._path}/${id}`); }

  where(field, op, value) {
    return new _CollectionRef(this._path, [...this._filters, { field, op, value }], this._orders, this._lim);
  }
  orderBy(field, dir) {
    return new _CollectionRef(this._path, this._filters, [...this._orders, { field, dir }], this._lim);
  }
  limit(n) {
    return new _CollectionRef(this._path, this._filters, this._orders, n);
  }

  async get() {
    const base = this._apiPath();
    const qs   = new URLSearchParams();

    for (const f of this._filters) {
      if (f.op === '==' || f.op === '===') {
        const key = _FIELD_MAP[f.field] || f.field;
        qs.set(key, f.value);
      }
      // array-contains → handled by auth on server
    }
    if (this._lim)    qs.set('_limit',    this._lim);
    if (this._orders.length) {
      qs.set('_orderBy', this._orders.map(o => o.field + ':' + (o.dir||'asc')).join(','));
    }

    const url  = base + (qs.toString() ? '?' + qs.toString() : '');
    const data = await api.get(url);
    const rows = _extractDocs(data, this._path);
    return _makeSnap(rows, this._apiPath());
  }

  async add(docData) {
    // Очищаем FieldValue sentinels перед отправкой
    const clean = _cleanData(docData);
    const base  = this._apiPath();
    const data  = await api.post(base, clean);
    // API возвращает созданный объект — вытаскиваем id
    const obj   = data[Object.keys(data)[0]] || data;
    const id    = obj.id || obj.uid || '';
    return { id, ...obj };
  }

  onSnapshot(onNext, onError) {
    let active = true;
    const poll = async () => {
      if (!active) return;
      try { onNext(await this.get()); } catch(e) { if (onError) onError(e); }
      if (active) setTimeout(poll, 4000);
    };
    poll();
    return () => { active = false; };
  }
}

// ─────────────────────────────────────────────────────────
// DOCUMENT REF
// ─────────────────────────────────────────────────────────
class _DocRef {
  constructor(path) {
    this._path = path; // e.g. 'users/uid' or 'startups/id/team/uid'
  }

  _apiPath() {
    // Путь уже является API-путём (начинается с '/') — вернуть как есть
    if (this._path.startsWith('/')) return this._path;
    const parts = this._path.split('/');
    // Длина 2: 'collection/id'
    if (parts.length === 2) {
      const base = _COL_MAP[parts[0]] || `/${parts[0]}`;
      return `${base}/${parts[1]}`;
    }
    // Длина 4: 'collection/id/sub/subId' e.g. 'startups/id/team/uid'
    if (parts.length === 4) {
      const sub = _subPath([parts[0], parts[1], parts[2]]);
      return `${sub}/${parts[3]}`;
    }
    return '/' + this._path;
  }

  collection(sub) {
    const parts = this._path.split('/');
    return new _CollectionRef(`${parts[0]}/${parts[1]}/${sub}`);
  }

  async get() {
    try {
      const data  = await api.get(this._apiPath());
      const obj   = _firstObj(data);
      if (!obj) return { id: this._path.split('/').pop(), exists: false, data: () => null };
      const camel = _toCamel(obj);
      return { id: camel.id || camel.uid, exists: true, data: () => camel, ref: this };
    } catch(e) {
      if (e.code === 404) return { id: this._path.split('/').pop(), exists: false, data: () => null };
      throw e;
    }
  }

  async set(docData) {
    const clean = _cleanData(docData);
    try {
      await api.patch(this._apiPath(), clean);
    } catch(e) {
      if (e.code === 404) await api.post(this._apiPath().split('/').slice(0,-1).join('/'), { ...clean, id: this._path.split('/').pop() });
      else throw e;
    }
  }

  async update(docData) {
    const clean = _cleanData(docData);
    if (Object.keys(clean).length === 0) return; // только sentinels — ничего не делаем
    try {
      await api.patch(this._apiPath(), clean);
    } catch(e) {
      if (e.code === 404) return;
      throw e;
    }
  }

  async delete() {
    try { await api.delete(this._apiPath()); } catch(e) { if (e.code !== 404) throw e; }
  }

  onSnapshot(onNext, onError) {
    let active = true;
    const poll = async () => {
      if (!active) return;
      try { onNext(await this.get()); } catch(e) { if (onError) onError(e); }
      if (active) setTimeout(poll, 4000);
    };
    poll();
    return () => { active = false; };
  }
}

// ─────────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────────
// Убрать FieldValue sentinels из объекта перед отправкой
function _cleanData(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v instanceof _FieldValueSentinel) {
      // arrayUnion на applicants → отдельный API call (обрабатывается в startup.html через /apply)
      // increment/decrement → обрабатывается на сервере автоматически
      continue; // пропускаем sentinels
    }
    if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

// Вытащить первый объект из ответа API
function _firstObj(data) {
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return data;
}

// ─────────────────────────────────────────────────────────
// ГЛАВНЫЙ ОБЪЕКТ db
// ─────────────────────────────────────────────────────────
const db = {
  collection: (name) => new _CollectionRef(name),
};

// ─────────────────────────────────────────────────────────
// UI ХЕЛПЕРЫ (те же что были в firebase-config.js)
// ─────────────────────────────────────────────────────────
var ROLE_LABELS = {
  startup:   'Стартапер',
  expert:    'Эксперт',
  user:      'Специалист',
  admin:     'Администратор',
  moderator: 'Модератор',
};

function renderNav(userData) {
  if (!userData) return;
  const navRole   = document.getElementById('navRole');
  const navAvatar = document.getElementById('navAvatar');
  if (navRole) {
    navRole.textContent = ROLE_LABELS[userData.role] || userData.role;
    navRole.className   = 'nav__role nav__role--' + userData.role;
  }
  if (navAvatar) {
    navAvatar.src = userData.avatar ||
      'https://ui-avatars.com/api/?background=181c24&color=00e676&name=' +
      encodeURIComponent(userData.name || 'U');
  }
  _initNotifBell();
}

// ── Уведомления: колокольчик в шапке ──────────────────────
let _notifItems = [];
let _notifTimer = null;

function _initNotifBell() {
  if (!currentUser) return;
  if (document.getElementById('notifBell')) return;
  const navUser = document.querySelector('.nav__user');
  if (!navUser) return;

  const wrap = document.createElement('div');
  wrap.id = 'notifBell';
  wrap.style.cssText = 'position:relative;display:flex;align-items:center';
  wrap.innerHTML =
    '<button style="background:none;border:none;cursor:pointer;font-size:18px;position:relative;padding:6px;line-height:1" aria-label="Уведомления">🔔' +
      '<span id="notifBadge" style="display:none;position:absolute;top:-2px;right:-2px;background:#ff4d4f;color:#fff;font-size:10px;font-weight:700;min-width:16px;height:16px;line-height:16px;border-radius:8px;text-align:center;padding:0 4px">0</span>' +
    '</button>' +
    '<div id="notifPopup" style="display:none;position:absolute;top:calc(100% + 8px);right:0;width:320px;max-height:380px;overflow-y:auto;background:var(--bg2,#15191f);border:1px solid var(--border2,#2b323c);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.45);z-index:1000;padding:8px"></div>';
  navUser.insertBefore(wrap, navUser.firstChild);

  wrap.addEventListener('mouseenter', _openNotifPopup);
  wrap.addEventListener('mouseleave', () => {
    const p = document.getElementById('notifPopup');
    if (p) p.style.display = 'none';
  });

  _pollNotifs();
  if (!_notifTimer) _notifTimer = setInterval(_pollNotifs, 30000);
}

async function _pollNotifs() {
  if (!currentUser) return;
  try {
    const data = await api.get('/messages/notifications');
    _notifItems = data.items || [];
    const badge = document.getElementById('notifBadge');
    if (badge) {
      badge.style.display = _notifItems.length ? 'block' : 'none';
      badge.textContent = _notifItems.length > 9 ? '9+' : _notifItems.length;
    }
  } catch (e) {}
}

function _openNotifPopup() {
  const popup = document.getElementById('notifPopup');
  if (!popup) return;
  if (!_notifItems.length) {
    popup.innerHTML = '<div style="padding:14px;font-size:13px;color:var(--text3,#7a828c);text-align:center">Нет новых уведомлений</div>';
  } else {
    popup.innerHTML = _notifItems.map(it =>
      '<a href="messages.html?conv=' + encodeURIComponent(it.convId) + '" style="display:block;padding:10px 12px;border-radius:8px;text-decoration:none;color:inherit" ' +
        'onmouseover="this.style.background=\'var(--bg3,#1b2028)\'" onmouseout="this.style.background=\'none\'">' +
        '<div style="font-size:13px;font-weight:600">💬 ' + esc(it.title || 'Чат') + '</div>' +
        '<div style="font-size:12px;color:var(--text2,#9aa3ad);margin-top:2px">Новых сообщений: ' + (it.newCount || 1) +
          (it.lastText ? ' · «' + esc(String(it.lastText).slice(0, 60)) + '»' : '') + '</div>' +
      '</a>'
    ).join('');
    // Уведомления помечаем просмотренными; сам чат остаётся непрочитанным
    api.post('/messages/notifications/seen', {}).catch(() => {});
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
    _notifItems = [];
  }
  popup.style.display = 'block';
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day:'numeric', month:'long', year:'numeric' });
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className   = 'toast toast--' + (type || 'success') + ' toast--show';
  setTimeout(() => { t.className = 'toast'; }, 3000);
}

function safeArray(val) {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  if (typeof val === 'string') { try { return JSON.parse(val); } catch(e) {} }
  if (typeof val === 'object') return Object.values(val);
  return [];
}

function goProfile() { window.location.href = 'profile.html'; }

// ─────────────────────────────────────────────────────────
// PLATFORM CONFIG
// ─────────────────────────────────────────────────────────
var DEFAULT_CATEGORIES = ['FinTech','EdTech','HealthTech','E-commerce','SaaS','AI / ML','Gaming','GreenTech','Marketplace','Другое'];
var DEFAULT_STAGES = [
  {name:'Идея',icon:'💡'},{name:'MVP',icon:'⚡'},{name:'Бета',icon:'🔬'},
  {name:'Запущен',icon:'🚀'},{name:'Масштабирование',icon:'📈'},
];
var _platformConfig = null;

async function loadPlatformConfig() {
  if (_platformConfig) return _platformConfig;
  try {
    const data = await api.get('/platform-config');
    _platformConfig = data.config || data;
    if (!_platformConfig.categories) _platformConfig = { categories: DEFAULT_CATEGORIES, stages: DEFAULT_STAGES, feedLimit: 25 };
  } catch(e) {
    _platformConfig = { categories: DEFAULT_CATEGORIES, stages: DEFAULT_STAGES, feedLimit: 25 };
  }
  return _platformConfig;
}

function fillCategorySelect(selectId, selectedVal) {
  loadPlatformConfig().then(cfg => {
    const el = document.getElementById(selectId);
    if (!el) return;
    const cur = selectedVal || el.value;
    el.innerHTML = cfg.categories.map(c =>
      `<option value="${esc(c)}"${c===cur?' selected':''}>${esc(c)}</option>`
    ).join('');
  });
}

function fillStageSelect(selectId, selectedVal) {
  loadPlatformConfig().then(cfg => {
    const el = document.getElementById(selectId);
    if (!el) return;
    const cur = selectedVal || el.value;
    el.innerHTML = cfg.stages.map(s =>
      `<option value="${esc(s.name)}"${s.name===cur?' selected':''}>${esc(s.icon)} ${esc(s.name)}</option>`
    ).join('');
  });
}

function fillFilterSelect(selectId, type, selectedVal) {
  loadPlatformConfig().then(cfg => {
    const el = document.getElementById(selectId);
    if (!el) return;
    const items = type === 'category' ? cfg.categories : cfg.stages.map(s => s.name);
    const cur   = selectedVal || '';
    el.innerHTML = `<option value="">Все ${type==='category'?'категории':'стадии'}</option>` +
      items.map(i => `<option value="${esc(i)}"${i===cur?' selected':''}>${esc(i)}</option>`).join('');
  });
}
