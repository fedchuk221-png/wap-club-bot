const TOKEN = process.env.BOT_TOKEN;
const BASE = `https://api.telegram.org/bot${TOKEN}`;

async function tgApi(method, payload) {
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`TG API error [${method}]:`, text);
    }
    return res;
  } catch (e) {
    console.error(`TG API exception [${method}]:`, e);
    return null;
  }
}

function sendMessage(chatId, text, kb) {
  const payload = { chat_id: String(chatId), text, parse_mode: "Markdown" };
  if (kb) payload.reply_markup = kb;
  return tgApi("sendMessage", payload);
}

function editMessage(chatId, messageId, text, kb) {
  const payload = { chat_id: String(chatId), message_id: messageId, text, parse_mode: "Markdown" };
  if (kb) payload.reply_markup = kb;
  return tgApi("editMessageText", payload);
}

function answerCallback(callbackQueryId) {
  return tgApi("answerCallbackQuery", { callback_query_id: callbackQueryId });
}

// Основной паттерн навигации по меню: гасим "часики" на кнопке и одновременно
// правим ТО ЖЕ сообщение — параллельно (Promise.all), одним сетевым "раундом".
function ackAndEdit(callbackQueryId, chatId, messageId, text, kb) {
  return Promise.all([
    tgApi("answerCallbackQuery", { callback_query_id: callbackQueryId }),
    editMessage(chatId, messageId, text, kb)
  ]);
}

function sendPhoneRequest(chatId, text, btnText) {
  return tgApi("sendMessage", {
    chat_id: String(chatId),
    text,
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [[{ text: btnText, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

function sendRemoveKeyboard(chatId, text) {
  return tgApi("sendMessage", {
    chat_id: String(chatId),
    text,
    parse_mode: "Markdown",
    reply_markup: { remove_keyboard: true }
  });
}

module.exports = {
  tgApi,
  sendMessage,
  editMessage,
  answerCallback,
  ackAndEdit,
  sendPhoneRequest,
  sendRemoveKeyboard
};
