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

// Единый каталог услуг: и клиентское меню, и админка берут цены/названия отсюда.
// code — короткий идентификатор для callback_data (Telegram ограничивает длину).
const SERVICES = {
  detailing_basic:    { code: "detbas", price: 1000, ua: "Базовий пакет (детейлінг)",       en: "Basic Package (detailing)" },
  detailing_standard: { code: "detstd", price: 1500, ua: "Стандартний пакет (детейлінг)",    en: "Standard Package (detailing)" },
  detailing_exclusive:{ code: "detexc", price: 2200, ua: "Ексклюзивний пакет (детейлінг)",   en: "Exclusive Package (detailing)" },
  polishing:          { code: "pol",    price: 800,  ua: "Полірування фар",                  en: "Headlight Polishing" },
  chips:              { code: "chp",    price: 500,  ua: "Ремонт сколів",                    en: "Chip Repair" }
};
const CODE_TO_KEY = Object.fromEntries(Object.entries(SERVICES).map(([key, v]) => [v.code, key]));

function T(chatId) {
  return TEXTS[store.getLang(chatId)] || TEXTS.ua;
}

// ============================================================
// СООБЩЕНИЯ (текст, контакт)
// ============================================================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const clientName = msg.from.first_name || "Клієнт";
  const contactPhone = msg.contact ? msg.contact.phone_number : null;
  const state = store.getState(chatId);

  // --- Админ ждёт ввод новой цены: правим то же сообщение вместо новых ---
  if (String(chatId) === String(ADMIN_ID) && state && state.step === STEP.AWAITING_ADMIN_PRICE) {
    if (/^\d+$/.test(text)) {
      await sheetsApi.updateOrderCell(state.ordIdx, 6, parseInt(text, 10));
      sheetsApi.invalidateOrdersCache();
      store.clearState(chatId);
      if (state.promptMessageId) {
        await renderAdminOrder(chatId, state.ordIdx, state.promptMessageId);
      } else {
        await showAdminOrder(chatId, state.ordIdx);
      }
    } else if (state.promptMessageId) {
      await tg.editMessage(chatId, state.promptMessageId, T(chatId).invalid_price + "\n\n💰 *Введіть нову суму для заказу в чат (наприклад: 1200):*");
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
  const messageId = cb.message.message_id;
  const data = cb.data;
  const clientName = cb.from.first_name || "Клієнт";

  if (data.startsWith("lang_")) {
    const selectedLang = data.split("_")[1];
    store.setLang(chatId, selectedLang);
    await renderMainMenu(chatId, cb.id, messageId);
    return;
  }

  const d = T(chatId);

  if (data === "menu_main") {
    store.clearState(chatId);
    await renderMainMenu(chatId, cb.id, messageId);
    return;
  }
  if (data === "info_about") {
    const kb = { inline_keyboard: [[{ text: d.btn_back, callback_data: "menu_main" }]] };
    await tg.ackAndEdit(cb.id, chatId, messageId, d.about, kb);
    return;
  }
  if (data === "srv_contact") {
    const kb = { inline_keyboard: [[{ text: d.btn_back, callback_data: "menu_main" }]] };
    await tg.ackAndEdit(cb.id, chatId, messageId, d.contact_info, kb);
    return;
  }

  // --- Виїзний детейлінг: спершу список пакетів ---
  if (data === "menu_detailing") {
    const kb = {
      inline_keyboard: [
        [{ text: d.pkg_basic_title, callback_data: "pkg_detailing_basic" }],
        [{ text: d.pkg_standard_title, callback_data: "pkg_detailing_standard" }],
        [{ text: d.pkg_exclusive_title, callback_data: "pkg_detailing_exclusive" }],
        [{ text: d.btn_back, callback_data: "menu_main" }]
      ]
    };
    await tg.ackAndEdit(cb.id, chatId, messageId, d.detailing_intro, kb);
    return;
  }
  if (data.startsWith("pkg_detailing_")) {
    const pkg = data.replace("pkg_detailing_", ""); // basic | standard | exclusive
    const descKey = "pkg_" + pkg + "_desc";
    const srvKey = "detailing_" + pkg;
    const kb = {
      inline_keyboard: [
        [{ text: d.btn_order, callback_data: "ask_phone_" + srvKey }],
        [{ text: d.btn_back_packages, callback_data: "menu_detailing" }]
      ]
    };
    await tg.ackAndEdit(cb.id, chatId, messageId, d[descKey], kb);
    return;
  }

  // --- Полировка / сколы — как раньше, без подпакетов ---
  if (data === "srv_polishing" || data === "srv_chips") {
    const srvKey = data.replace("srv_", "");
    const srvText = srvKey === "polishing" ? d.polishing_desc : d.chips_desc;
    const kb = {
      inline_keyboard: [
        [{ text: d.btn_order, callback_data: "ask_phone_" + srvKey }],
        [{ text: d.btn_back, callback_data: "menu_main" }]
      ]
    };
    await tg.ackAndEdit(cb.id, chatId, messageId, srvText, kb);
    return;
  }

  if (data.startsWith("ask_phone_")) {
    const srvKey = data.replace("ask_phone_", "");
    store.setState(chatId, { step: STEP.AWAITING_PHONE, srv: srvKey });
    // Reply-клавиатуру ("поділитися номером") нельзя прикрепить через editMessageText —
    // это ограничение Telegram API, не архитектуры бота. Поэтому тут единственное
    // место, где вместо правки сообщения уходит новое: правим текущее на "обробляємо",
    // и отдельным сообщением просим контакт.
    await Promise.all([
      tg.answerCallback(cb.id),
      tg.editMessage(chatId, messageId, d.processing),
      tg.sendPhoneRequest(chatId, d.ask_phone, d.btn_share_phone)
    ]);
    return;
  }

  // === 👑 АДМИНКА ===
  if (String(chatId) === String(ADMIN_ID)) {
    if (data.startsWith("adm_ord_")) {
      await renderAdminOrder(chatId, parseInt(data.split("_")[2], 10), messageId, cb.id);
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
      }
      await renderAdminOrder(chatId, ordIdx, messageId, cb.id);
      return;
    }
    if (data.startsWith("adm_promptprice_")) {
      const ordIdx = parseInt(data.split("_")[2], 10);
      store.setState(chatId, { step: STEP.AWAITING_ADMIN_PRICE, ordIdx, promptMessageId: messageId });
      await tg.ackAndEdit(cb.id, chatId, messageId, "💰 *Введіть нову суму для заказу в чат (наприклад: 1200):*");
      return;
    }
    if (data.startsWith("adm_status_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      await sheetsApi.updateOrderCell(ordIdx, 7, parts[3] === "work" ? "В роботі" : "Завершено");
      sheetsApi.invalidateOrdersCache();
      await renderAdminOrder(chatId, ordIdx, messageId, cb.id);
      return;
    }
    if (data.startsWith("adm_pricksrv_")) {
      const ordIdx = parseInt(data.split("_")[2], 10);
      await renderServicePicker(chatId, ordIdx, messageId, cb.id);
      return;
    }
    if (data.startsWith("adm_setsrv_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      const srvCode = parts[3];
      const srvKey = CODE_TO_KEY[srvCode];
      if (srvKey) {
        await sheetsApi.updateOrderCell(ordIdx, 5, SERVICES[srvKey].ua);
        sheetsApi.invalidateOrdersCache();
      }
      await renderAdminOrder(chatId, ordIdx, messageId, cb.id);
      return;
    }
    // Быстрые кнопки прямо на уведомлении о новом заказе (см. createOrder) —
    // тоже правят то самое сообщение-уведомление у админа.
    if (data.startsWith("adm_quick_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      const action = parts[3];
      if (action === "work" || action === "done") {
        await sheetsApi.updateOrderCell(ordIdx, 7, action === "work" ? "В роботі" : "Завершено");
        sheetsApi.invalidateOrdersCache();
        await tg.ackAndEdit(cb.id, chatId, messageId, cb.message.text + `\n\n📊 Статус: ${action === "work" ? "В роботі 🚀" : "Завершено 🏁"}`);
      } else {
        await renderAdminOrder(chatId, ordIdx, null, cb.id); // откроет карточку новым сообщением, чтобы не терять текст уведомления
      }
      return;
    }
    await tg.answerCallback(cb.id);
  }
}

// ============================================================
// СОЗДАНИЕ ЗАКАЗА
// ============================================================
async function createOrder(chatId, clientName, phone, state) {
  const d = T(chatId);
  const srvKey = (state && state.srv) || "detailing_standard";
  const srv = SERVICES[srvKey] || SERVICES.detailing_standard;
  const orderId = "ORD-" + Math.floor(Date.now() / 1000);
  const date = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date());

  // Индекс новой строки = текущее количество заказов (0-based), нужен заранее
  // для кнопок быстрого статуса на уведомлении админу.
  const existingOrders = await sheetsApi.getOrdersData();
  const newIndex = existingOrders.length;

  try {
    await sheetsApi.appendOrderRow([orderId, date, `${clientName} (${chatId})`, phone, srv.ua, srv.price, "Новий"]);
    sheetsApi.invalidateOrdersCache();
  } catch (e) {
    console.error("Failed to append order row after retries:", e.message || e);
    await tg.sendMessage(chatId, "⚠️ Виникла технічна помилка при оформленні заявки. Будь ласка, напишіть нам напряму: @zabrodni_y");
    return;
  }

  // Мастер/админ получает заказ сразу с быстрыми действиями прямо на уведомлении.
  await tg.sendMessage(
    ADMIN_ID,
    `🚨 *НОВА ЗАЯВКА WAP CLUB!*\n\n📦 ID: \`${orderId}\`\n👤 Клієнт: ${clientName}\n📞 Телефон: \`${phone}\`\n🛠 Послуга: *${srv.ua}*\n💵 Сума: ${srv.price} грн\n📅 ${date}`,
    {
      inline_keyboard: [
        [{ text: "📋 Детальніше / знижка / статус", callback_data: `adm_ord_${newIndex}` }],
        [{ text: "🚀 В роботу", callback_data: `adm_quick_${newIndex}_work` }, { text: "🏁 Завершити", callback_data: `adm_quick_${newIndex}_done` }]
      ]
    }
  );

  // Клиент видит подтверждение заказа со всеми деталями (номер, услуга, цена, дата).
  store.clearState(chatId);
  const successMsg = d.order_success
    .replace("{orderId}", orderId)
    .replace("{phone}", phone)
    .replace("{service}", srv.ua)
    .replace("{price}", srv.price)
    .replace("{date}", date);
  await tg.sendRemoveKeyboard(chatId, successMsg);
}

// ============================================================
// МЕНЮ (главное меню строится из srv_/menu_ callback_data)
// ============================================================
function mainMenuKb(chatId, d) {
  const rows = [
    [{ text: d.btn_detailing, callback_data: "menu_detailing" }],
    [{ text: d.btn_polishing, callback_data: "srv_polishing" }, { text: d.btn_chips, callback_data: "srv_chips" }],
    [{ text: d.btn_about, callback_data: "info_about" }],
    [{ text: d.btn_contact, callback_data: "srv_contact" }]
  ];
  if (String(chatId) === String(ADMIN_ID)) rows.push([{ text: "👑 Панель адміністратора", callback_data: "adm_ord_0" }]);
  return { inline_keyboard: rows };
}

async function renderMainMenu(chatId, cbId, messageId) {
  const d = T(chatId);
  const kb = mainMenuKb(chatId, d);
  if (messageId && cbId) {
    await tg.ackAndEdit(cbId, chatId, messageId, d.welcome, kb);
  } else {
    await tg.sendMessage(chatId, d.welcome, kb);
  }
}

function buildAdminCard(orders, index) {
  const total = orders.length;
  if (index < 0) index = 0;
  if (index >= total) index = total - 1;
  const ord = orders[index];
  const text =
    `👑 *УПРАВЛІННЯ ЗАЯВКОЮ* (№${index + 1} з ${total})\n\n` +
    `📦 *ID:* \`${ord[0]}\`\n📅 *Дата:* ${ord[1]}\n👤 *Клієнт:* ${ord[2]}\n📞 *Телефон:* \`${ord[3]}\`\n` +
    `🛠 *Послуга:* *${ord[4]}*\n💰 *Сума:* *${ord[5]} грн*\n📊 *Статус:* \`${ord[6] || "Новий"}\``;

  const navRow = [];
  if (index > 0) navRow.push({ text: "◀️ Попер.", callback_data: "adm_ord_" + (index - 1) });
  if (index < total - 1) navRow.push({ text: "▶️ Наст.", callback_data: "adm_ord_" + (index + 1) });

  const kb = {
    inline_keyboard: [
      navRow,
      [{ text: "🎁 -10%", callback_data: `adm_disc_${index}_10` }, { text: "🎁 -20%", callback_data: `adm_disc_${index}_20` }, { text: "🎁 -100 грн", callback_data: `adm_disc_${index}_100` }],
      [{ text: "💰 Своя ціна", callback_data: `adm_promptprice_${index}` }, { text: "🛠 Змінити послугу", callback_data: `adm_pricksrv_${index}` }],
      [{ text: "🚀 В роботу", callback_data: `adm_status_${index}_work` }, { text: "🏁 Завершити", callback_data: `adm_status_${index}_done` }],
      [{ text: "🔙 Вийти з адмінки", callback_data: "menu_main" }]
    ]
  };
  return { text, kb, index };
}

// Правит переданное сообщение (карточку заказа) на месте — используется и для
// навигации по заказам, и для возврата после ввода своей цены.
async function renderAdminOrder(chatId, index, messageId, cbId) {
  const orders = await sheetsApi.getOrdersData();
  if (!orders || orders.length === 0) {
    const text = "👑 *ПАНЕЛЬ АДМІНІСТРАТОРА*\n\nЗаявок у таблиці поки немає.";
    const kb = { inline_keyboard: [[{ text: "🔙 У головне меню", callback_data: "menu_main" }]] };
    if (cbId) await tg.answerCallback(cbId);
    if (messageId) await tg.editMessage(chatId, messageId, text, kb); else await tg.sendMessage(chatId, text, kb);
    return;
  }
  const { text, kb } = buildAdminCard(orders, index);
  if (cbId) await tg.answerCallback(cbId);
  if (messageId) { await tg.editMessage(chatId, messageId, text, kb); } else { await tg.sendMessage(chatId, text, kb); }
}

// Вызывается из /admin и из "показати заявку" без исходного сообщения — отправляет новое.
async function showAdminOrder(chatId, index) {
  await renderAdminOrder(chatId, index, null, null);
}

async function renderServicePicker(chatId, ordIdx, messageId, cbId) {
  const kb = {
    inline_keyboard: [
      [{ text: "🅱️ " + SERVICES.detailing_basic.ua, callback_data: `adm_setsrv_${ordIdx}_detbas` }],
      [{ text: "🅂 " + SERVICES.detailing_standard.ua, callback_data: `adm_setsrv_${ordIdx}_detstd` }],
      [{ text: "🅴 " + SERVICES.detailing_exclusive.ua, callback_data: `adm_setsrv_${ordIdx}_detexc` }],
      [{ text: "✨ " + SERVICES.polishing.ua, callback_data: `adm_setsrv_${ordIdx}_pol` }],
      [{ text: "🛠 " + SERVICES.chips.ua, callback_data: `adm_setsrv_${ordIdx}_chp` }],
      [{ text: "🔙 Назад", callback_data: `adm_ord_${ordIdx}` }]
    ]
  };
  const text = `🛠 *Оберіть нову послугу для заявки №${ordIdx + 1}:*`;
  if (cbId) await tg.ackAndEdit(cbId, chatId, messageId, text, kb);
  else await tg.sendMessage(chatId, text, kb);
}

async function sendLangMenu(chatId) {
  const kb = {
    inline_keyboard: [
      [{ text: "🇺🇦 Українська", callback_data: "lang_ua" }, { text: "🇬🇧 English", callback_data: "lang_en" }]
    ]
  };
  await tg.sendMessage(chatId, "👋 Вітаю! / Hello!\n\nОберіть мову / Choose language:", kb);
}

// ============================================================
// EXPRESS СЕРВЕР
// ============================================================
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("WAP CLUB bot is running."));

app.post("/webhook", async (req, res) => {
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
