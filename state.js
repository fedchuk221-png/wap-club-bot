// В отличие от GAS-версии (где состояние жило в CacheService с TTL),
// здесь процесс постоянно запущен — можно использовать простой Map в памяти.
// Единственный компромисс: при перезапуске сервера (например, деплой новой
// версии) состояние обнулится — язык и текущий незавершённый заказ пользователю
// нужно будет выбрать заново. Для этого бота это не критично.

const stateMap = new Map(); // chatId -> { step, srv?, ordIdx? }
const langMap = new Map(); // chatId -> "ru" | "ua" | "en"
const processedUpdates = new Map(); // updateId -> timestamp (для защиты от дублей)

function getState(chatId) {
  return stateMap.get(String(chatId)) || null;
}
function setState(chatId, obj) {
  stateMap.set(String(chatId), obj);
}
function clearState(chatId) {
  stateMap.delete(String(chatId));
}

function getLang(chatId) {
  return langMap.get(String(chatId)) || "ru";
}
function setLang(chatId, lang) {
  langMap.set(String(chatId), lang);
}

function isDuplicate(updateId) {
  const key = String(updateId);
  if (processedUpdates.has(key)) return true;
  processedUpdates.set(key, Date.now());
  // Периодическая уборка старых записей, чтобы Map не рос бесконечно
  if (processedUpdates.size > 5000) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, t] of processedUpdates) {
      if (t < cutoff) processedUpdates.delete(k);
    }
  }
  return false;
}

module.exports = { getState, setState, clearState, getLang, setLang, isDuplicate };
