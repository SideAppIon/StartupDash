// Проверка и нормализация сообщения чата (личка и проектный чат).
// Типы: user — текст, image — ссылка на картинку, file — вложение-документ,
// system — служебное. Для file в text лежит JSON { url, name, size }.
const { checkCensor } = require('./censor');

const TYPES = ['user', 'image', 'file', 'system'];
const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u) && u.length <= 1000;

async function prepareChatMessage(text, type) {
  type = type || 'user';
  if (!TYPES.includes(type)) return { error: 'Неверный тип сообщения' };
  if (!text) return { error: 'text обязателен' };

  if (type === 'user') {
    const cen = await checkCensor(text, 'messages');
    if (cen.blocked) return { error: cen.message };
    return { type, text, preview: text.substring(0, 80) };
  }
  if (type === 'image') {
    if (!isHttpUrl(text)) return { error: 'Неверная ссылка на изображение' };
    return { type, text, preview: '📷 Фото' };
  }
  if (type === 'file') {
    let f;
    try { f = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { f = null; }
    if (!f || !isHttpUrl(f.url)) return { error: 'Неверное вложение' };
    const name = String(f.name || 'файл').slice(0, 200);
    const size = Math.max(0, parseInt(f.size, 10) || 0);
    return { type, text: JSON.stringify({ url: f.url, name, size }), preview: '📎 ' + name.substring(0, 70) };
  }
  return { type, text, preview: String(text).substring(0, 80) };
}

module.exports = { prepareChatMessage };
