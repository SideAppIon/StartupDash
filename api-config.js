// ─────────────────────────────────────────────────────────
// API CONFIG — замена firebase-config.js
// Подключи этот файл вместо firebase-config.js во всех .html
// ─────────────────────────────────────────────────────────

// URL бэкенда: замени на свой URL Yandex Cloud Functions / API Gateway
const API_URL = 'https://YOUR_FUNCTION_ID.apigw.yandexcloud.net';
// Для локальной разработки: const API_URL = 'http://localhost:3000';

// ─────────────────────────────────────────────────────────
// СОСТОЯНИЕ
// ─────────────────────────────────────────────────────────
let _currentUser     = null;
let _currentUserData = null;
let _authCallbacks   = [];
let _authResolved    = false;

// ─────────────────────────────────────────────────────────
// ТОКЕН
// ─────────────────────────────────────────────────────────
function getToken()          { return localStorage.getItem('auth_token'); }
function setToken(t)         { localStorage.setItem('auth_token', t); }
function removeToken()       { localStorage.removeItem('auth_token'); }

// ─────────────────────────────────────────────────────────
// HTTP ХЕЛПЕРЫ
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
    err.code = res.status;
    throw err;
  }
  return data;
}

const api = {
  get:    (path)        => apiRequest('GET',    path),
  post:   (path, body)  => apiRequest('POST',   path, body),
  patch:  (path, body)  => apiRequest('PATCH',  path, body),
  delete: (path)        => apiRequest('DELETE', path),
};

// ─────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────
const auth = {
  // Регистрация
  async createUserWithEmailAndPassword(email, password, extraData) {
    const data = await api.post('/auth/register', { email, password, ...extraData });
    setToken(data.token);
    _currentUser     = { uid: data.user.uid, email: data.user.email };
    _currentUserData = data.user;
    return { user: _currentUser };
  },

  // Вход
  async signInWithEmailAndPassword(email, password) {
    const data = await api.post('/auth/login', { email, password });
    setToken(data.token);
    _currentUser     = { uid: data.user.uid, email: data.user.email };
    _currentUserData = data.user;
    _notifyCallbacks();
    return { user: _currentUser };
  },

  // Выход
  async signOut() {
    removeToken();
    _currentUser     = null;
    _currentUserData = null;
    _notifyCallbacks();
  },

  // Сброс пароля
  async sendPasswordResetEmail(email) {
    await api.post('/auth/reset-password', { email });
  },

  // Слушатель смены состояния (совместимость с firebase)
  onAuthStateChanged(callback) {
    _authCallbacks.push(callback);
    if (_authResolved) callback(_currentUser);
    return () => { _authCallbacks = _authCallbacks.filter(cb => cb !== callback); };
  },
};

// Восстанавливаем сессию при загрузке страницы
(async function initAuth() {
  const token = getToken();
  if (token) {
    try {
      const data = await api.get('/auth/me');
      _currentUser     = { uid: data.user.uid, email: data.user.email };
      _currentUserData = data.user;
    } catch (e) {
      // Токен протух — удаляем
      removeToken();
      _currentUser     = null;
      _currentUserData = null;
    }
  }
  _authResolved = true;
  _notifyCallbacks();
})();

function _notifyCallbacks() {
  _authCallbacks.forEach(cb => cb(_currentUser));
}

// ─────────────────────────────────────────────────────────
// СОВМЕСТИМОСТЬ С FIREBASE API (используется в HTML файлах)
// ─────────────────────────────────────────────────────────

// onAuthReady(callback(user, userData)) — аналог firebase onAuthReady
function onAuthReady(callback) {
  if (_authResolved) {
    callback(_currentUser, _currentUserData);
  } else {
    const unsub = auth.onAuthStateChanged(() => {
      unsub();
      callback(_currentUser, _currentUserData);
    });
  }
}

// requireAuth(redirectTo) — редирект если не авторизован
function requireAuth(redirectTo) {
  if (_authResolved) {
    if (!_currentUser) window.location.href = redirectTo || 'login.html';
  } else {
    const unsub = auth.onAuthStateChanged(() => {
      unsub();
      if (!_currentUser) window.location.href = redirectTo || 'login.html';
    });
  }
}

// redirectIfAuth(redirectTo) — редирект если уже авторизован
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

// ─────────────────────────────────────────────────────────
// FIRESTORE-ПОДОБНЫЙ API (db.collection)
// Обёртка для постепенной миграции — имитирует Firestore API
// через HTTP запросы к бэкенду
// ─────────────────────────────────────────────────────────
const db = {
  collection(name) {
    return new CollectionRef(name);
  }
};

class CollectionRef {
  constructor(name, _filters = [], _order = null, _limit = null) {
    this._name    = name;
    this._filters = _filters;
    this._order   = _order;
    this._limit   = _limit;
  }

  doc(id) { return new DocRef(this._name, id); }

  where(field, op, value) {
    return new CollectionRef(this._name, [...this._filters, { field, op, value }], this._order, this._limit);
  }

  orderBy(field, dir) {
    return new CollectionRef(this._name, this._filters, { field, dir: dir || 'asc' }, this._limit);
  }

  limit(n) {
    return new CollectionRef(this._name, this._filters, this._order, n);
  }

  async get() {
    const params = new URLSearchParams();
    this._filters.forEach(f => {
      if (f.op === '==' || f.op === '===') params.set(f.field, f.value);
      else if (f.op === 'array-contains') params.set('participants_contains', f.value);
    });
    if (this._limit) params.set('_limit', this._limit);

    const path = `/${this._name}?${params.toString()}`;
    const data = await api.get(path);

    // Нормализуем ответ в формат {docs: [{id, data()}]}
    const key  = Object.keys(data).find(k => Array.isArray(data[k]));
    const rows = key ? data[key] : [];
    return {
      docs: rows.map(row => ({
        id: row.id,
        data: () => row,
        exists: true,
      })),
      size: rows.length,
      empty: rows.length === 0,
    };
  }

  // onSnapshot — для обратной совместимости делаем polling каждые 5 секунд
  onSnapshot(onNext, onError) {
    let active = true;
    const poll = async () => {
      if (!active) return;
      try {
        const snap = await this.get();
        onNext(snap);
      } catch (e) {
        if (onError) onError(e);
      }
      if (active) setTimeout(poll, 5000);
    };
    poll();
    return () => { active = false; }; // unsubscribe
  }
}

class DocRef {
  constructor(collection, id) {
    this._col = collection;
    this._id  = id;
  }

  get path() { return `/${this._col}/${this._id}`; }

  async get() {
    try {
      const data = await api.get(this.path);
      const key  = Object.keys(data).find(k => data[k] && typeof data[k] === 'object' && !Array.isArray(data[k]));
      const doc  = key ? data[key] : data;
      return { id: this._id, data: () => doc, exists: true };
    } catch (e) {
      if (e.code === 404) return { id: this._id, data: () => null, exists: false };
      throw e;
    }
  }

  async set(docData) {
    // Попытка PATCH, если 404 — POST
    try {
      await api.patch(this.path, docData);
    } catch (e) {
      if (e.code === 404) await api.post(`/${this._col}`, { id: this._id, ...docData });
      else throw e;
    }
  }

  async update(docData) {
    await api.patch(this.path, docData);
  }

  async delete() {
    await api.delete(this.path);
  }

  collection(sub) {
    return new CollectionRef(`${this._col}/${this._id}/${sub}`);
  }

  // onSnapshot — polling
  onSnapshot(onNext, onError) {
    let active = true;
    const poll = async () => {
      if (!active) return;
      try { onNext(await this.get()); } catch(e) { if (onError) onError(e); }
      if (active) setTimeout(poll, 5000);
    };
    poll();
    return () => { active = false; };
  }
}

// Совместимость с firebase.firestore.FieldValue.serverTimestamp()
const firebase = {
  firestore: {
    FieldValue: { serverTimestamp: () => new Date().toISOString() },
  },
};

// ─────────────────────────────────────────────────────────
// UI ХЕЛПЕРЫ (те же что были в firebase-config.js)
// ─────────────────────────────────────────────────────────
var ROLE_LABELS = {
  startup: 'Стартапер',
  expert:  'Эксперт',
  user:    'Специалист',
  admin:   'Администратор',
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
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function showToast(message, type) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = 'toast toast--' + (type || 'success') + ' toast--show';
  setTimeout(() => { toast.className = 'toast'; }, 3000);
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
// PLATFORM CONFIG (категории, стадии)
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
    _platformConfig = data;
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
    el.innerHTML = cfg.categories.map(cat =>
      `<option value="${esc(cat)}"${cat===cur?' selected':''}>${esc(cat)}</option>`
    ).join('');
  });
}

function fillStageSelect(selectId, selectedVal) {
  loadPlatformConfig().then(cfg => {
    const el = document.getElementById(selectId);
    if (!el) return;
    const cur = selectedVal || el.value;
    el.innerHTML = cfg.stages.map(st =>
      `<option value="${esc(st.name)}"${st.name===cur?' selected':''}>${esc(st.icon)} ${esc(st.name)}</option>`
    ).join('');
  });
}

function fillFilterSelect(selectId, type, selectedVal) {
  loadPlatformConfig().then(cfg => {
    const el = document.getElementById(selectId);
    if (!el) return;
    const items = type === 'category' ? cfg.categories : cfg.stages.map(s => s.name);
    const cur = selectedVal || '';
    el.innerHTML = `<option value="">Все ${type==='category'?'категории':'стадии'}</option>` +
      items.map(item =>
        `<option value="${esc(item)}"${item===cur?' selected':''}>${esc(item)}</option>`
      ).join('');
  });
}
