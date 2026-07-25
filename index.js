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

// Единый каталог услуг — и клиентское меню, и админка берут названия/цены отсюда.
const SERVICES = {
  detailing_basic:     { code: "detbas", price: 1000, ua: "Базовий пакет (детейлінг)",    en: "Basic Package (detailing)" },
  detailing_standard:  { code: "detstd", price: 1500, ua: "Стандартний пакет (детейлінг)", en: "Standard Package (detailing)" },
  detailing_exclusive: { code: "detexc", price: 2200, ua: "Ексклюзивний пакет (детейлінг)",en: "Exclusive Package (detailing)" },
  polishing:           { code: "pol",    price: 800,  ua: "Полірування фар",               en: "Headlight Polishing" },
  chips:                { code: "chp",   price: 500,  ua: "Ремонт сколів",                  en: "Chip Repair" }
};
const CODE_TO_KEY = Object.fromEntries(Object.entries(SERVICES).map(([key, v]) => [v.code, key]));

// Коэффициенты калькулятора класса авто.
const CAR_CLASSES = {
  sed:   { mult: 1.0, ua: "Седан",         en: "Sedan" },
  cross: { mult: 1.2, ua: "Кросовер",      en: "Crossover" },
  suv:   { mult: 1.5, ua: "Позашляховик",  en: "SUV" }
};

function T(chatId) {
  return TEXTS[store.getLang(chatId)] || TEXTS.ua;
}
function langOf(chatId) {
  return store.getLang(chatId) === "en" ? "en" : "ua";
}

// ============================================================
// СООБЩЕНИЯ (текст, контакт, финансовые записи админа)
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
      await renderAdminOrder(chatId, state.ordIdx, state.promptMessageId || null);
    } else if (state.promptMessageId) {
      await tg.editMessage(chatId, state.promptMessageId, T(chatId).invalid_price + "\n\n💰 *Введіть нову суму для заявки в чат (наприклад: 1200):*");
    } else {
      await tg.sendMessage(chatId, T(chatId).invalid_price);
    }
    return;
  }

  // --- "Карманный бухгалтер": админ пишет "+1500 опис" или "-450 опис" ---
  if (String(chatId) === String(ADMIN_ID)) {
    const financeMatch = text.match(/^([+\-])\s*(\d+(?:[.,]\d+)?)\s+(.+)$/);
    if (financeMatch) {
      const sign = financeMatch[1];
      const amount = parseFloat(financeMatch[2].replace(",", "."));
      const description = financeMatch[3].trim();
      const type = sign === "+" ? "Дохід" : "Витрата";
      const who = msg.from.first_name || "Адмін";
      const date = formatDate();
      try {
        await sheetsApi.appendFinanceRow([date, type, amount, description, who]);
        const balance = await sheetsApi.getFinanceBalance();
        await tg.sendMessage(
          chatId,
          `${sign === "+" ? "✅ Дохід додано" : "🔻 Витрату додано"}: *${amount} грн* — ${description}\n\n💼 Поточний баланс: *${balance} грн*`
        );
      } catch (e) {
        console.error("Finance entry failed:", e);
        await tg.sendMessage(chatId, "⚠️ Не вдалося записати фінансову операцію. Спробуйте ще раз.");
      }
      return;
    }
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
  const d = T(chatId);

  // --- Оцінка після завершення замовлення (доступно будь-якому клієнту) ---
  if (data.startsWith("rate_")) {
    const parts = data.split("_");
    const ordIdx = parseInt(parts[1], 10);
    const rating = parseInt(parts[2], 10);
    await sheetsApi.updateOrderCell(ordIdx, 8, rating);
    sheetsApi.invalidateOrdersCache();
    await tg.ackAndEdit(cb.id, chatId, messageId, d.review_thanks.replace("{rating}", "⭐".repeat(rating)));
    if (ADMIN_ID) {
      tg.sendMessage(ADMIN_ID, `⭐ Клієнт оцінив заявку №${ordIdx + 1} на ${rating}/5`).catch(() => {});
    }
    return;
  }

  if (data.startsWith("lang_")) {
    const selectedLang = data.split("_")[1];
    store.setLang(chatId, selectedLang);
    await renderMainMenu(chatId, cb.id, messageId);
    return;
  }

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
    const pkg = data.replace("pkg_detailing_", "");
    const srvKey = "detailing_" + pkg;
    const srv = SERVICES[srvKey];
    if (!srv) { await tg.answerCallback(cb.id); return; }
    const kb = {
      inline_keyboard: [
        [{ text: d.btn_next_carclass, callback_data: "carclass_" + srv.code }],
        [{ text: d.btn_back_packages, callback_data: "menu_detailing" }]
      ]
    };
    await tg.ackAndEdit(cb.id, chatId, messageId, d["pkg_" + pkg + "_desc"], kb);
    return;
  }

  // --- Полировка / сколы — без подпакетов, сразу к классу авто ---
  if (data === "srv_polishing" || data === "srv_chips") {
    const srvKey = data.replace("srv_", "");
    const srv = SERVICES[srvKey];
    const srvText = srvKey === "polishing" ? d.polishing_desc : d.chips_desc;
    const kb = {
      inline_keyboard: [
        [{ text: d.btn_next_carclass, callback_data: "carclass_" + srv.code }],
        [{ text: d.btn_back, callback_data: "menu_main" }]
      ]
    };
    await tg.ackAndEdit(cb.id, chatId, messageId, srvText, kb);
    return;
  }

  // --- Калькулятор класса авто, шаг 1: выбор класса ---
  if (data.startsWith("carclass_")) {
    const code = data.replace("carclass_", "");
    const kb = {
      inline_keyboard: [
        [{ text: `${d.cls_sedan} (x1.0)`, callback_data: `pickclass_${code}_sed` }],
        [{ text: `${d.cls_crossover} (x1.2)`, callback_data: `pickclass_${code}_cross` }],
        [{ text: `${d.cls_suv} (x1.5)`, callback_data: `pickclass_${code}_suv` }],
        [{ text: d.btn_back, callback_data: "menu_main" }]
      ]
    };
    await tg.ackAndEdit(cb.id, chatId, messageId, d.carclass_intro, kb);
    return;
  }

  // --- Калькулятор класса авто, шаг 2: итоговая цена + переход к контакту ---
  if (data.startsWith("pickclass_")) {
    const parts = data.split("_");
    const code = parts[1];
    const classCode = parts[2];
    const srvKey = CODE_TO_KEY[code];
    const srv = SERVICES[srvKey];
    const cls = CAR_CLASSES[classCode];
    if (!srv || !cls) { await tg.answerCallback(cb.id); return; }

    const lang = langOf(chatId);
    const finalPrice = Math.round(srv.price * cls.mult);
    const summary = d.order_summary
      .replace("{service}", srv[lang])
      .replace("{carclass}", cls[lang])
      .replace("{price}", finalPrice);

    const savedPhone = await sheetsApi.getClientPhone(chatId);
    const kbRows = [];
    if (savedPhone) {
      kbRows.push([{ text: d.btn_confirm_saved_phone.replace("{phone}", savedPhone), callback_data: `usesaved_${code}_${classCode}` }]);
      kbRows.push([{ text: d.btn_change_phone, callback_data: `ask_phone_${code}_${classCode}` }]);
    } else {
      kbRows.push([{ text: d.btn_confirm_order, callback_data: `ask_phone_${code}_${classCode}` }]);
    }
    kbRows.push([{ text: d.btn_back, callback_data: "menu_main" }]);

    await tg.ackAndEdit(cb.id, chatId, messageId, summary, { inline_keyboard: kbRows });
    return;
  }

  // --- Клиент подтверждает заказ сохранённым номером — телефон спрашивать не нужно ---
  if (data.startsWith("usesaved_")) {
    const parts = data.split("_");
    const code = parts[1];
    const classCode = parts[2];
    const srvKey = CODE_TO_KEY[code];
    const savedPhone = await sheetsApi.getClientPhone(chatId);
    await tg.answerCallback(cb.id);
    if (!savedPhone) {
      // Номер могли удалить из таблицы вручную — подстрахуемся и попросим заново.
      await tg.editMessage(chatId, messageId, T(chatId).processing);
      store.setState(chatId, { step: STEP.AWAITING_PHONE, srv: srvKey, carClass: classCode });
      await tg.sendPhoneRequest(chatId, T(chatId).ask_phone, T(chatId).btn_share_phone);
      return;
    }
    await tg.editMessage(chatId, messageId, T(chatId).processing);
    await createOrder(chatId, clientName, savedPhone, { srv: srvKey, carClass: classCode });
    return;
  }

  if (data.startsWith("ask_phone_")) {
    const rest = data.replace("ask_phone_", "");
    const [code, classCode] = rest.split("_");
    const srvKey = CODE_TO_KEY[code] || rest;
    store.setState(chatId, { step: STEP.AWAITING_PHONE, srv: srvKey, carClass: classCode || "sed" });
    // Reply-клавиатуру ("поділитися номером") нельзя прикрепить через editMessageText —
    // ограничение Telegram API. Поэтому единственное место, где вместо правки
    // сообщения уходит новое.
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
      await tg.ackAndEdit(cb.id, chatId, messageId, "💰 *Введіть нову суму для заявки в чат (наприклад: 1200):*");
      return;
    }
    if (data.startsWith("adm_status_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      const action = parts[3];
      await sheetsApi.updateOrderCell(ordIdx, 7, action === "work" ? "В роботі" : "Завершено");
      sheetsApi.invalidateOrdersCache();
      await renderAdminOrder(chatId, ordIdx, messageId, cb.id);
      if (action === "done") await requestReview(ordIdx);
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
    if (data.startsWith("adm_quick_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[2], 10);
      const action = parts[3];
      if (action === "work" || action === "done") {
        await sheetsApi.updateOrderCell(ordIdx, 7, action === "work" ? "В роботі" : "Завершено");
        sheetsApi.invalidateOrdersCache();
        await tg.ackAndEdit(cb.id, chatId, messageId, cb.message.text + `\n\n📊 Статус: ${action === "work" ? "В роботі 🚀" : "Завершено 🏁"}`);
        if (action === "done") await requestReview(ordIdx);
      } else {
        await tg.answerCallback(cb.id);
      }
      return;
    }
    await tg.answerCallback(cb.id);
  }
}

// ============================================================
// ЗАВЕРШЕНИЕ ЗАКАЗА -> ЗАПРОС ОТЗЫВА
// ============================================================
async function requestReview(ordIdx) {
  try {
    const orders = await sheetsApi.getOrdersData();
    const ord = orders[ordIdx];
    if (!ord) return;
    const match = String(ord[2] || "").match(/\((\d+)\)\s*$/);
    if (!match) return;
    const clientChatId = match[1];
    const d = TEXTS[store.getLang(clientChatId)] || TEXTS.ua;
    const kb = {
      inline_keyboard: [[
        { text: "⭐", callback_data: `rate_${ordIdx}_1` },
        { text: "⭐⭐", callback_data: `rate_${ordIdx}_2` },
        { text: "⭐⭐⭐", callback_data: `rate_${ordIdx}_3` },
        { text: "⭐⭐⭐⭐", callback_data: `rate_${ordIdx}_4` },
        { text: "⭐⭐⭐⭐⭐", callback_data: `rate_${ordIdx}_5` }
      ]]
    };
    await tg.sendMessage(clientChatId, d.review_request, kb);
  } catch (e) {
    console.error("requestReview failed:", e.message || e);
  }
}

// ============================================================
// СОЗДАНИЕ ЗАКАЗА
// ============================================================
function formatDate() {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date());
}

async function createOrder(chatId, clientName, phone, state) {
  try {
    const d = T(chatId);
    const lang = langOf(chatId);
    const srvKey = (state && state.srv) || "detailing_standard";
    const srv = SERVICES[srvKey] || SERVICES.detailing_standard;
    const cls = CAR_CLASSES[(state && state.carClass) || "sed"];
    const finalPrice = Math.round(srv.price * cls.mult);
    const orderId = "ORD-" + Math.floor(Date.now() / 1000);
    const date = formatDate();
    const serviceLabelUa = `${srv.ua} — ${cls.ua} (x${cls.mult})`;
    const serviceLabelLang = `${srv[lang]} — ${cls[lang]} (x${cls.mult})`;

    const existingOrders = await sheetsApi.getOrdersData();
    const newIndex = existingOrders.length;

    try {
      await sheetsApi.appendOrderRow([orderId, date, `${clientName} (${chatId})`, phone, serviceLabelUa, finalPrice, "Новий"]);
      sheetsApi.invalidateOrdersCache();
    } catch (e) {
      console.error("Failed to append order row after retries:", e.message || e);
      await tg.sendRemoveKeyboard(chatId, "⚠️ Виникла технічна помилка при оформленні заявки. Будь ласка, напишіть нам напряму: @zabrodni_y");
      return;
    }

    // Сохраняем номер за chat_id — при следующем заказе спрашивать не будем.
    sheetsApi.saveClientPhone(chatId, clientName, phone).catch(() => {});

    if (ADMIN_ID) {
      await tg.sendMessage(
        ADMIN_ID,
        `🚨 *НОВА ЗАЯВКА WAP CLUB!*\n\n📦 ID: \`${orderId}\`\n👤 Клієнт: ${clientName}\n📞 Телефон: \`${phone}\`\n🛠 Послуга: *${serviceLabelUa}*\n💵 Сума: ${finalPrice} грн\n📅 ${date}`,
        {
          inline_keyboard: [
            [{ text: "📋 Детальніше / знижка / статус", callback_data: `adm_ord_${newIndex}` }],
            [{ text: "🚀 В роботу", callback_data: `adm_quick_${newIndex}_work` }, { text: "🏁 Завершити", callback_data: `adm_quick_${newIndex}_done` }]
          ]
        }
      );
    }

    store.clearState(chatId);
    const successMsg = d.order_success
      .replace("{orderId}", orderId)
      .replace("{phone}", phone)
      .replace("{service}", serviceLabelLang)
      .replace("{price}", finalPrice)
      .replace("{date}", date);
    await tg.sendRemoveKeyboard(chatId, successMsg);
  } catch (e) {
    // Гарантия: что бы ни пошло не так, клиент получает ответ, а не тишину.
    console.error("createOrder fatal error:", e && e.stack || e);
    try {
      await tg.sendRemoveKeyboard(chatId, "⚠️ Сталася технічна помилка. Будь ласка, напишіть нам напряму: @zabrodni_y");
    } catch (_) {}
    if (ADMIN_ID) {
      tg.sendMessage(ADMIN_ID, `⚠️ Помилка при оформленні заявки від chat_id ${chatId}: ${e.message || e}`).catch(() => {});
    }
  }
}

// ============================================================
// МЕНЮ
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
  const ratingLine = ord[7] ? `\n⭐ *Оцінка:* ${ord[7]}/5` : "";
  const text =
    `👑 *УПРАВЛІННЯ ЗАЯВКОЮ* (№${index + 1} з ${total})\n\n` +
    `📦 *ID:* \`${ord[0]}\`\n📅 *Дата:* ${ord[1]}\n👤 *Клієнт:* ${ord[2]}\n📞 *Телефон:* \`${ord[3]}\`\n` +
    `🛠 *Послуга:* *${ord[4]}*\n💰 *Сума:* *${ord[5]} грн*\n📊 *Статус:* \`${ord[6] || "Новий"}\`${ratingLine}`;

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
  return { text, kb };
}

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
    // ГЛАВНЫЙ ФИКС "бот не реагирует": раньше ошибка молча тонула в консоли,
    // и ни клиент, ни админ об этом не узнавали. Теперь при любом сбое
    // клиент/админ хотя бы видят факт ошибки, а не тишину.
    console.error("Webhook handling error:", error && error.stack || error);
    if (ADMIN_ID) {
      tg.sendMessage(ADMIN_ID, `⚠️ Помилка в боті: ${error && error.message ? error.message : error}`).catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`WAP CLUB bot listening on port ${PORT}`);
});
