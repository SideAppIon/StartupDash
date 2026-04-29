# Настройка Firebase для исправления ошибок CORS

## Проблема
Ошибка: `XMLHttpRequest cannot load https://firestore.googleapis.com/... due to access control checks`

## Решение

### 1. Проверьте настройки Firebase проекта
1. Откройте [Firebase Console](https://console.firebase.google.com/)
2. Выберите проект `startuphelper-f5fb1`
3. Перейдите в раздел **Firestore Database**
4. Убедитесь что база данных создана и находится в режиме **test mode** или настроены правила безопасности

### 2. Правила безопасности Firestore
Замените текущие правила на следующие:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Пользователи: читать всем, писать только себе
    match /users/{uid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }

    // Стартапы: читать всем, писать авторизованным стартаперам
    match /startups/{startupId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update, delete: if request.auth != null &&
        (resource.data.ownerUid == request.auth.uid ||
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');

      // Обновления стартапа
      match /updates/{updateId} {
        allow read: if true;
        allow write: if request.auth != null &&
          (get(/databases/$(database)/documents/startups/$(startupId)).data.ownerUid == request.auth.uid ||
           get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
      }

      // Команда стартапа
      match /team/{memberId} {
        allow read: if true;
        allow write: if request.auth != null &&
          (get(/databases/$(database)/documents/startups/$(startupId)).data.ownerUid == request.auth.uid ||
           get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
      }
    }

    // Приглашения
    match /invites/{inviteId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
      allow update: if request.auth != null &&
        (resource.data.startupOwner == request.auth.uid ||
         resource.data.fromUid == request.auth.uid);
    }

    // Диалоги
    match /conversations/{convId} {
      allow read, write: if request.auth != null &&
        request.auth.uid in resource.data.participants;
      allow create: if request.auth != null;

      match /messages/{msgId} {
        allow read: if request.auth != null &&
          request.auth.uid in get(/databases/$(database)/documents/conversations/$(convId)).data.participants;
        allow create: if request.auth != null;
      }
    }

    // Админ: полный доступ
    match /{document=**} {
      allow read, write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
  }
}
```

### 3. Настройка доменов
1. В Firebase Console → Authentication → Settings
2. В разделе "Authorized domains" добавьте:
   - `localhost`
   - `127.0.0.1`
   - Ваш домен если развертываете на хостинге

### 4. Проверка конфигурации
Убедитесь что в `firebase-config.js` правильные данные проекта:
- Project ID: `startuphelper-f5fb1`
- authDomain: `startuphelper-f5fb1.firebaseapp.com`

### 5. Если ошибка остается
Попробуйте временно включить test mode:
1. Firestore Database → Rules
2. Используйте правила:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.time < timestamp.date(2025, 1, 1);
    }
  }
}
```
Это разрешит доступ до 1 января 2025 года для тестирования.
