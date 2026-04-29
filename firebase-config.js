// Импорты (модульный SDK)
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

// Конфиг (оставляем как есть — он у тебя норм)
const firebaseConfig = {
  apiKey: "AIzaSyC0GD7ZMnm-ooiY0_jQUym3-mKM-tkd7sk",
  authDomain: "startuphelper-f5fb1.firebaseapp.com",
  projectId: "startuphelper-f5fb1",
  storageBucket: "startuphelper-f5fb1.firebasestorage.app",
  messagingSenderId: "204252040401",
  appId: "1:204252040401:web:bc41fd62102771aa5b49f0",
  measurementId: "G-YCP8PWH5JV"
};

// Инициализация
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

// Сервисы
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// =====================================================
// УТИЛИТЫ
// =====================================================

let currentUser = null;
let currentUserData = null;

// Слушатель авторизации
function onAuthReady(callback) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;

      const snap = await getDoc(doc(db, "users", user.uid));
      currentUserData = snap.exists() ? snap.data() : null;

    } else {
      currentUser = null;
      currentUserData = null;
    }

    callback(user, currentUserData);
  });
}

// Редирект если не авторизован
function requireAuth(redirectTo = 'login.html') {
  onAuthStateChanged(auth, (user) => {
    if (!user) window.location.href = redirectTo;
  });
}

// Редирект если уже авторизован
function redirectIfAuth(redirectTo = 'index.html') {
  onAuthStateChanged(auth, (user) => {
    if (user) window.location.href = redirectTo;
  });
}

// Получить параметр из URL
function getUrlParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// Форматирование даты
function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

// Показать уведомление
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast toast--${type} toast--show`;

  setTimeout(() => toast.className = 'toast', 3000);
}

// Загрузка аватара
async function uploadAvatar(file, uid) {
  const storageRef = ref(storage, `avatars/${uid}`);
  await uploadBytes(storageRef, file);
  return await getDownloadURL(storageRef);
}