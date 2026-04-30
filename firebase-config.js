// ─────────────────────────────────────────────────────
// FIREBASE CONFIG
// ─────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyC0GD7ZMnm-ooiY0_jQUym3-mKM-tkd7sk",
  authDomain:        "startuphelper-f5fb1.firebaseapp.com",
  projectId:         "startuphelper-f5fb1",
  storageBucket:     "startuphelper-f5fb1.firebasestorage.app",
  messagingSenderId: "204252040401",
  appId:             "1:204252040401:web:bc41fd62102771aa5b49f0",
  measurementId:     "G-YCP8PWH5JV"
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db   = firebase.firestore();

// CORS fix для Safari/WebKit — обязательно
db.settings({ experimentalForceLongPolling: true, merge: true });

// ─────────────────────────────────────────────────────
// СОСТОЯНИЕ
// ─────────────────────────────────────────────────────
let currentUser     = null;
let currentUserData = null;

// ─────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────

// Безопасное приведение любого значения к массиву
function safeArray(val) {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  if (typeof val === 'object') return Object.values(val);
  return [];
}

// Слушатель авторизации — вызывает callback(user, userData)
// userData = null если документ не найден (новый юзер или ошибка)
function onAuthReady(callback) {
  auth.onAuthStateChanged(async function(user) {
    if (user) {
      currentUser = user;
      try {
        var snap = await db.collection('users').doc(user.uid).get();
        currentUserData = snap.exists ? snap.data() : null;
      } catch(e) {
        console.warn('[firebase-config] Firestore error:', e.code, e.message);
        currentUserData = null;
      }
    } else {
      currentUser     = null;
      currentUserData = null;
    }
    callback(user, currentUserData);
  });
}

// Редирект если НЕ авторизован
function requireAuth(redirectTo) {
  auth.onAuthStateChanged(function(user) {
    if (!user) window.location.href = redirectTo || 'login.html';
  });
}

// Редирект если УЖЕ авторизован
function redirectIfAuth(redirectTo) {
  auth.onAuthStateChanged(function(user) {
    if (user) window.location.href = redirectTo || 'dashboard.html';
  });
}

// Получить GET-параметр из URL (?id=xxx)
function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// Форматировать Firestore Timestamp → читаемая дата
function formatDate(timestamp) {
  if (!timestamp) return '';
  var d = (timestamp.toDate) ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric'
  });
}

// Показать toast-уведомление
function showToast(message, type) {
  var toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = 'toast toast--' + (type || 'success') + ' toast--show';
  setTimeout(function() { toast.className = 'toast'; }, 3000);
}

// Аватар — URL сохраняется прямо в Firestore (без Storage)
function saveAvatarUrl(uid, url) {
  if (!url || !uid) return Promise.resolve();
  return db.collection('users').doc(uid).update({ avatar: url });
}

// Стандартный nav для авторизованных страниц
var ROLE_LABELS = {
  startup:  'Стартапер',
  investor: 'Инвестор',
  user:     'Специалист',
  admin:    'Администратор'
};

function renderNav(userData) {
  var navRole   = document.getElementById('navRole');
  var navAvatar = document.getElementById('navAvatar');
  if (!userData) return;
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
