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

// ─────────────────────────────────────────────────────
// СОСТОЯНИЕ
// ─────────────────────────────────────────────────────
let currentUser     = null;
let currentUserData = null;

// ─────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────

function safeArray(val) {
  if (Array.isArray(val)) return val;
  if (!val) return [];
  if (typeof val === 'object') return Object.values(val);
  return [];
}

function onAuthReady(callback) {
  auth.onAuthStateChanged(async function(user) {
    if (user) {
      currentUser = user;
      try {
        var snap = await db.collection('users').doc(user.uid).get();
        currentUserData = snap.exists ? snap.data() : null;
      } catch(e) {
        console.warn('[firebase-config] Firestore:', e.code, e.message);
        currentUserData = null;
      }
    } else {
      currentUser     = null;
      currentUserData = null;
    }
    callback(user, currentUserData);
  });
}

function requireAuth(redirectTo) {
  auth.onAuthStateChanged(function(user) {
    if (!user) window.location.href = redirectTo || 'login.html';
  });
}

function redirectIfAuth(redirectTo) {
  auth.onAuthStateChanged(function(user) {
    if (user) window.location.href = redirectTo || 'dashboard.html';
  });
}

function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  var d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function showToast(message, type) {
  var toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = 'toast toast--' + (type || 'success') + ' toast--show';
  setTimeout(function() { toast.className = 'toast'; }, 3000);
}

var ROLE_LABELS = {
  startup:  'Стартапер',
  investor: 'Инвестор',
  user:     'Специалист',
  admin:    'Администратор'
};

function renderNav(userData) {
  if (!userData) return;
  var navRole   = document.getElementById('navRole');
  var navAvatar = document.getElementById('navAvatar');
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
