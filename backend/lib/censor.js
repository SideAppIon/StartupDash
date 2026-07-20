// Фильтр слов: список запрещённых слов и сообщение-заглушка хранятся
// в platform_config (key='platform') в поле censorship.
const { queryOne } = require('../db');

const DEFAULT_MSG = 'Сообщение содержит недопустимое слово и не может быть отправлено.';

async function getCensorship() {
  try {
    const row = await queryOne("SELECT value FROM platform_config WHERE key='platform'");
    const cfg = row ? JSON.parse(row.value) : {};
    const c = cfg.censorship || {};
    return {
      blockMessage: (typeof c.blockMessage === 'string' && c.blockMessage.trim()) ? c.blockMessage : DEFAULT_MSG,
      words: Array.isArray(c.words) ? c.words : [],
    };
  } catch (e) {
    return { blockMessage: DEFAULT_MSG, words: [] };
  }
}

// scope: 'forum' | 'messages'. Возвращает { blocked: bool, message?: string }
async function checkCensor(text, scope) {
  if (!text) return { blocked: false };
  const { blockMessage, words } = await getCensorship();
  if (!words.length) return { blocked: false };
  const lower = String(text).toLowerCase();
  for (const w of words) {
    if (!w || !w.word) continue;
    if (!w[scope]) continue; // слово не цензурится для этого раздела
    const term = String(w.word).toLowerCase().trim();
    if (term && lower.includes(term)) {
      return { blocked: true, message: blockMessage };
    }
  }
  return { blocked: false };
}

module.exports = { getCensorship, checkCensor };
