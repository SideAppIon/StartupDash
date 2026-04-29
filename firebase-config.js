// =====================================================
// FIREBASE CONFIG - реальные данные проекта
// =====================================================
const firebaseConfig = {
  apiKey: "AIzaSyC0GD7ZMnm-ooiY0_jQUym3-mKM-tkd7sk",
  authDomain: "startuphelper-f5fb1.firebaseapp.com",
  projectId: "startuphelper-f5fb1",
  storageBucket: "startuphelper-f5fb1.firebasestorage.app",
  messagingSenderId: "204252040401",
  appId: "1:204252040401:web:bc41fd62102771aa5b49f0",
  measurementId: "G-YCP8PWH5JV"
};

// Защита от двойной инициализации
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth    = firebase.auth();
const db      = firebase.firestore();

// =====================================================
// ГЛОБАЛЬНЫЕ УТИЛИТЫ
// =====================================================

let currentUser     = null;
let currentUserData = null;

function onAuthReady(callback) {
  console.log('Проверка аутентификации Firebase...');
  auth.onAuthStateChanged(async function(user) {
    console.log('Статус пользователя:', user ? 'авторизован' : 'не авторизован');
    if (user) {
      console.log('UID пользователя:', user.uid);
      console.log('Email пользователя:', user.email);
      currentUser = user;
      try {
        console.log('Загрузка данных из Firestore...');
        var snap = await db.collection('users').doc(user.uid).get();
        console.log('Документ существует:', snap.exists);
        if (snap.exists) {
          currentUserData = snap.data();
          console.log('Данные пользователя загружены:', currentUserData);
        } else {
          console.log('Документ пользователя не найден');
          currentUserData = null;
        }
        
        // Если данных нет, подождать и попробовать снова
        if (!currentUserData) {
          console.log('Повторная попытка загрузки через 1 секунду...');
          await new Promise(resolve => setTimeout(resolve, 1000));
          snap = await db.collection('users').doc(user.uid).get();
          currentUserData = snap.exists ? snap.data() : null;
          console.log('Результат повторной загрузки:', currentUserData);
        }
      } catch(e) {
        console.error('Ошибка загрузки данных пользователя:', e);
        console.error('Код ошибки:', e.code);
        console.error('Сообщение:', e.message);
        currentUserData = null;
      }
    } else {
      currentUser     = null;
      currentUserData = null;
    }
    console.log('Вызов callback с данными:', {user: !!user, data: !!currentUserData});
    callback(user, currentUserData);
  });
}

function requireAuth(redirectTo) {
  redirectTo = redirectTo || 'login.html';
  auth.onAuthStateChanged(function(user) {
    if (!user) window.location.href = redirectTo;
  });
}

function redirectIfAuth(redirectTo) {
  redirectTo = redirectTo || 'dashboard.html';
  auth.onAuthStateChanged(function(user) {
    if (user) window.location.href = redirectTo;
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
  type = type || 'success';
  var toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = 'toast toast--' + type + ' toast--show';
  setTimeout(function() { toast.className = 'toast'; }, 3000);
}

// Аватар — просто сохраняем URL в Firestore (без Storage)
async function saveAvatarUrl(uid, url) {
  if (!url) return;
  await db.collection('users').doc(uid).update({ avatar: url });
}
