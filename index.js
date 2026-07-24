require("dotenv").config();

const express = require("express");
const TEXTS = require("./texts");
const tg = require("./telegram");
const sheetsApi = require("./sheets");
const store = require("./state");

const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 8080;

const STEP = {
  AWAITING_PHONE: "awaiting_phone",
  AWAITING_ADMIN_PRICE: "awaiting_admin_price"
};

const SERVICE_LABELS = {
  detailing: { code: "det", ru: "Выездной детейлинг" },
  polishing: { code: "pol", ru: "Полировка фар" },
  chips: { code: "chp", ru: "Ремонт сколов" }
};
const PRICE_BY_SERVICE = { detailing: 1500, polishing: 800, chips: 500 };

function T(chatId) {
  return TEXTS[store.getLang(chatId)] || TEXTS.ru;
}

// ============================================================
// СООБЩЕНИЯ (текст, контакт)
// ============================================================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const clientName = msg.from.first_name || "Клиент";
  const contactPhone = msg.contact ? msg.contact.phone_number : null;
  const state = store.getState(chatId);

  // --- Админ ждёт ввод новой цены ---
  if (String(chatId) === String(ADMIN_ID) && state && state.step === STEP.AWAITING_ADMIN_PRICE) {
    if (/^\d+$/.test(text)) {
      await sheetsApi.updateOrderCell(state.ordIdx, 6, parseInt(text, 10));
      sheetsApi.invalidateOrdersCache();
      store.clearState(chatId);
      await tg.sendMessage(chatId, "✅ *Цена успешно обновлена!*");
      await showAdminOrder(chatId, state.ordIdx);
    } else {
      await tg.sendMessage(chatId, T(chatId).invalid_price);
    }
    return;
  }

  // --- Пользователь явно ожидается на шаге "оставить телефон" ---
  if (contactPhone || (state && state.step === STEP.AWAITING_PHONE && text.length >= 9 && /\d{5,}/.test(text))) {
    await createOrder(chatId, clientName, contactPhone || text, state);
    return;
  }

  if (text.toLowerCase().includes("/start")) {
    store.clearState(chatId);
    await sendLangMenu(chatId);
  } else if (text.toLowerCase().includes("/admin") && String(chatId) === String(ADMIN_ID)) {
    await showAdminOrder(chatId, 0);
  }
  // Иначе — сообщение вне известного сценария, молча игнорируем.
}

// ============================================================
// CALLBACK-КНОПКИ
// ============================================================
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const clientName = cb.from.first_name || "Клиент";

  if (data.startsWith("lang_")) {
    const selectedLang = data.split("_")[1];
    store.setLang(chatId, selectedLang);
    const d = T(chatId);
    const kbRows = [
      [{ text: d.btn_detailing, callback_data: "srv_detailing" }],
      [{ text: d.btn_polishing, callback_data: "srv_polishing" }, { text: d.btn_chips, callback_data: "srv_chips" }],
      [{ text: d.btn_about, callback_data: "info_about" }],
      [{ text: d.btn_contact, callback_data: "srv_contact" }]
    ];
    if (String(chatId) === String(ADMIN_ID)) kbRows.push([{ text: "👑 Панель Администратора", callback_data: "adm_ord_0" }]);
    await tg.ackAndSend(cb.id, chatId, d.welcome, { inline_keyboard: kbRows });
    return;
  }

  const langDict = T(chatId);

  if (data === "menu_main") {
    store.clearState(chatId);
    await showMainMenu(chatId, cb.id);
    return;
  }
  if (data === "info_about") {
    const kb = { inline_keyboard: [[{ text: langDict.btn_back, callback_data: "menu_main" }]] };
    await tg.ackAndSend(cb.id, chatId, langDict.about, kb);
    return;
  }
  if (data.startsWith("srv_")) {
    if (data === "srv_contact") {
      await Promise.all([tg.answerCallback(cb.id), tg.sendMessage(chatId, langDict.contact_info)]);
      return;
    }
    const srvId = data.split("_")[1];
    const srvText = srvId === "detailing" ? langDict.detailing_desc : srvId === "polishing" ? langDict.polishing_desc : langDict.chips_desc;
    const confirmKb = {
      inline_keyboard: [
        [{ text: langDict.btn_order, callback_data: "ask_phone_" + srvId }],
        [{ text: langDict.btn_back, callback_data: "menu_main" }]
      ]
    };
    await tg.ackAndSend(cb.id, chatId, srvText, confirmKb);
    return;
  }
  if (data.startsWith("ask_phone_")) {
    const srvType = data.split("_")[2];
    store.setState(chatId, { step: STEP.AWAITING_PHONE, srv: srvType });
    await Promise.all([
      tg.answerCallback(cb.id),
      tg.sendPhoneRequest(chatId, langDict.ask_phone, langDict.btn_share_phone)
    ]);
    return;
  }

  // === 👑 АДМИНКА ===
  if (String(chatId) === String(ADMIN_ID)) {
    await tg.answerCallback(cb.id);

    if (data.startsWith("adm_ord_")) {
      await showAdminOrder(chatId, parseInt(data.split("_")[2], 10));
      return;
    }
    if (data.startsWith("adm_disc_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      const discType = parts[3];
      const orders = await sheetsApi.getOrdersData();
      if (orders[ordIdx]) {
        const oldPrice = parseFloat(orders[ordIdx][5]) || 0;
        const newPrice = discType === "10" ? Math.round(oldPrice * 0.9) : discType === "20" ? Math.round(oldPrice * 0.8) : Math.max(0, oldPrice - 100);
        await sheetsApi.updateOrderCell(ordIdx, 6, newPrice);
        sheetsApi.invalidateOrdersCache();
        await showAdminOrder(chatId, ordIdx);
      }
      return;
    }
    if (data.startsWith("adm_promptprice_")) {
      const ordIdx = parseInt(data.split("_")[2], 10);
      store.setState(chatId, { step: STEP.AWAITING_ADMIN_PRICE, ordIdx });
      await tg.sendMessage(chatId, "💰 *Введите новую сумму для заказа в чат (например: 1200):*");
      return;
    }
    if (data.startsWith("adm_status_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      await sheetsApi.updateOrderCell(ordIdx, 7, parts[3] === "work" ? "В работе" : "Завершен");
      sheetsApi.invalidateOrdersCache();
      await showAdminOrder(chatId, ordIdx);
      return;
    }
    if (data.startsWith("adm_pricksrv_")) {
      const ordIdx = parseInt(data.split("_")[2], 10);
      await showServicePicker(chatId, ordIdx);
      return;
    }
    if (data.startsWith("adm_setsrv_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      const srvCode = parts[3];
      const newSrv = srvCode === "det" ? SERVICE_LABELS.detailing.ru : srvCode === "pol" ? SERVICE_LABELS.polishing.ru : SERVICE_LABELS.chips.ru;
      await sheetsApi.updateOrderCell(ordIdx, 5, newSrv);
      sheetsApi.invalidateOrdersCache();
      await showAdminOrder(chatId, ordIdx);
      return;
    }
  }
}

// ============================================================
// СОЗДАНИЕ ЗАКАЗА
// ============================================================
async function createOrder(chatId, clientName, phone, state) {
  const langDict = T(chatId);
  const srvType = (state && state.srv) || "detailing";
  const savedSrv = (SERVICE_LABELS[srvType] || SERVICE_LABELS.detailing).ru;
  const price = PRICE_BY_SERVICE[srvType] || PRICE_BY_SERVICE.detailing;
  const orderId = "ORD-" + Math.floor(Date.now() / 1000);
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Kyiv",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date());

  try {
    await sheetsApi.appendOrderRow([orderId, date, `${clientName} (${chatId})`, phone, savedSrv, price, "Новый"]);
    sheetsApi.invalidateOrdersCache();
  } catch (e) {
    console.error("Failed to append order row after retries:", e.message || e);
    await tg.sendMessage(chatId, "⚠️ Произошла техническая ошибка при оформлении заявки. Пожалуйста, напишите нам напрямую: @zabrodni_y");
    return;
  }

  await tg.sendMessage(
    ADMIN_ID,
    `🚨 *НОВЫЙ ЗАКАЗ WAP CLUB!*\n\n📦 ID: \`${orderId}\`\n👤 Клиент: ${clientName}\n📞 Телефон: \`${phone}\`\n🛠 Услуга: *${savedSrv}*\n💵 Чек: ${price} грн`
  );

  store.clearState(chatId);
  const successMsg = langDict.order_success
    .replace("{orderId}", orderId)
    .replace("{phone}", phone)
    .replace("{service}", savedSrv);
  await tg.sendRemoveKeyboard(chatId, successMsg);
}

// ============================================================
// МЕНЮ
// ============================================================
async function showMainMenu(chatId, cbId) {
  const langDict = T(chatId);
  const kbRows = [
    [{ text: langDict.btn_detailing, callback_data: "srv_detailing" }],
    [{ text: langDict.btn_polishing, callback_data: "srv_polishing" }, { text: langDict.btn_chips, callback_data: "srv_chips" }],
    [{ text: langDict.btn_about, callback_data: "info_about" }],
    [{ text: langDict.btn_contact, callback_data: "srv_contact" }]
  ];
  if (String(chatId) === String(ADMIN_ID)) kbRows.push([{ text: "👑 Панель Администратора", callback_data: "adm_ord_0" }]);
  const mainKb = { inline_keyboard: kbRows };
  if (cbId) {
    await tg.ackAndSend(cbId, chatId, langDict.welcome, mainKb);
  } else {
    await tg.sendMessage(chatId, langDict.welcome, mainKb);
  }
}

async function showAdminOrder(chatId, index) {
  const orders = await sheetsApi.getOrdersData();
  if (!orders || orders.length === 0) {
    const kb = { inline_keyboard: [[{ text: "🔙 В главное меню", callback_data: "menu_main" }]] };
    await tg.sendMessage(chatId, "👑 *ПАНЕЛЬ АДМИНИСТРАТОРА*\n\nЗаказов в таблице пока нет.", kb);
    return;
  }
  const total = orders.length;
  if (index < 0) index = 0;
  if (index >= total) index = total - 1;
  const ord = orders[index];
  const ordText =
    `👑 *УПРАВЛЕНИЕ ЗАКАЗОМ* (№${index + 1} из ${total})\n\n` +
    `📦 *ID:* \`${ord[0]}\`\n📅 *Дата:* ${ord[1]}\n👤 *Клиент:* ${ord[2]}\n📞 *Телефон:* \`${ord[3]}\`\n` +
    `🛠 *Услуга:* *${ord[4]}*\n💰 *Сумма:* *${ord[5]} грн*\n📊 *Статус:* \`${ord[6] || "Новый"}\``;

  const navRow = [];
  if (index > 0) navRow.push({ text: "◀️ Пред.", callback_data: "adm_ord_" + (index - 1) });
  if (index < total - 1) navRow.push({ text: "▶️ След.", callback_data: "adm_ord_" + (index + 1) });

  const adminKb = {
    inline_keyboard: [
      navRow,
      [{ text: "🎁 -10%", callback_data: `adm_disc_${index}_10` }, { text: "🎁 -20%", callback_data: `adm_disc_${index}_20` }, { text: "🎁 -100 грн", callback_data: `adm_disc_${index}_100` }],
      [{ text: "💰 Своя цена", callback_data: `adm_promptprice_${index}` }, { text: "🛠 Сменить услугу", callback_data: `adm_pricksrv_${index}` }],
      [{ text: "🚀 В работу", callback_data: `adm_status_${index}_work` }, { text: "🏁 Завершить", callback_data: `adm_status_${index}_done` }],
      [{ text: "🔙 Выйти из админки", callback_data: "menu_main" }]
    ]
  };
  await tg.sendMessage(chatId, ordText, adminKb);
}

async function showServicePicker(chatId, ordIdx) {
  const kb = {
    inline_keyboard: [
      [{ text: "🚗 Детейлинг", callback_data: `adm_setsrv_${ordIdx}_det` }],
      [{ text: "✨ Полировка фар", callback_data: `adm_setsrv_${ordIdx}_pol` }],
      [{ text: "🛠 Ремонт сколов", callback_data: `adm_setsrv_${ordIdx}_chp` }],
      [{ text: "🔙 Назад", callback_data: `adm_ord_${ordIdx}` }]
    ]
  };
  await tg.sendMessage(chatId, `🛠 *Выберите новую услугу для заказа №${ordIdx + 1}:*`, kb);
}

async function sendLangMenu(chatId) {
  const kb = {
    inline_keyboard: [
      [{ text: "🇺🇦 Українська", callback_data: "lang_ua" }, { text: "🇷🇺 Русский", callback_data: "lang_ru" }],
      [{ text: "🇬🇧 English", callback_data: "lang_en" }]
    ]
  };
  await tg.sendMessage(chatId, "👋 Вітаю! / Здравствуйте! / Hello!\n\nОберіть мову / Выберите язык / Choose language:", kb);
}

// ============================================================
// EXPRESS СЕРВЕР
// ============================================================
const app = express();
app.use(express.json());

// Health check — Railway и любой мониторинг статуса дергают "/"
app.get("/", (req, res) => res.send("WAP CLUB bot is running."));

app.post("/webhook", async (req, res) => {
  // Отвечаем Telegram сразу, чтобы он не ждал и не ретраил —
  // вся реальная обработка идёт уже после ответа.
  res.sendStatus(200);

  try {
    const update = req.body;
    const updateId = update.update_id;
    if (updateId !== undefined && store.isDuplicate(updateId)) return;

    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (error) {
    console.error("Webhook handling error:", error);
  }
});

app.listen(PORT, () => {
  console.log(`WAP CLUB bot listening on port ${PORT}`);
});
