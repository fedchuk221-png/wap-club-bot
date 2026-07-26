require("dotenv").config();

const express = require("express");
const TEXTS = require("./texts");
const tg = require("./telegram");
const sheetsApi = require("./sheets");
const store = require("./state");

const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 8080;
const GOOGLE_MAPS_LINK = process.env.GOOGLE_MAPS_LINK || "";

const STEP = {
  AWAITING_PHONE: "awaiting_phone",
  AWAITING_ADMIN_PRICE: "awaiting_admin_price",
  AWAITING_PHOTO_BEFORE: "awaiting_photo_before",
  AWAITING_PHOTO_AFTER: "awaiting_photo_after",
  CALCULATING: "calculating",
  CHEM_ADD: "chem_add",
  SET_CLIENT_DISCOUNT: "set_client_discount"
};

const SERVICES = {
  detailing_basic:     { code: "detbas", price: 1000, ua: "Базовий пакет (детейлінг)",    en: "Basic Package (detailing)" },
  detailing_standard:  { code: "detstd", price: 1500, ua: "Стандартний пакет (детейлінг)", en: "Standard Package (detailing)" },
  detailing_exclusive: { code: "detexc", price: 2200, ua: "Ексклюзивний пакет (детейлінг)",en: "Exclusive Package (detailing)" },
  polishing:           { code: "pol",    price: 800,  ua: "Полірування фар",               en: "Headlight Polishing" },
  chips:                { code: "chp",   price: 500,  ua: "Ремонт сколів",                  en: "Chip Repair" }
};
const CODE_TO_KEY = Object.fromEntries(Object.entries(SERVICES).map(([key, v]) => [v.code, key]));
const SERVICE_ORDER = ["detailing_basic", "detailing_standard", "detailing_exclusive", "polishing", "chips"];

const CAR_CLASSES = {
  sed:   { mult: 1.0, ua: "Седан",         en: "Sedan" },
  cross: { mult: 1.2, ua: "Кросовер",      en: "Crossover" },
  suv:   { mult: 1.5, ua: "Позашляховик",  en: "SUV" }
};

const ADDONS = {
  tires:   { code: "tires",   price: 100, ua: "Чорніння шин" },
  ceramic: { code: "ceramic", price: 300, ua: "Керамічний захист" },
  spot:    { code: "spot",    price: 200, ua: "Точкова полірування" }
};

const SPECIALISTS = (process.env.MASTERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry, i) => {
    const [name, chatId] = entry.split(":").map((x) => (x || "").trim());
    return { code: "m" + i, name: name || `Майстер ${i + 1}`, chatId: chatId || null };
  });

function isExecutor(chatId) {
  if (String(chatId) === String(ADMIN_ID)) return true;
  return SPECIALISTS.some((m) => m.chatId && String(m.chatId) === String(chatId));
}

function T(chatId) {
  return TEXTS[store.getLang(chatId)] || TEXTS.ua;
}
function langOf(chatId) {
  return store.getLang(chatId) === "en" ? "en" : "ua";
}
function formatDate() {
  return new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date());
}
function resolveServiceKeyFromLabel(label) {
  for (const [key, srv] of Object.entries(SERVICES)) {
    if (String(label).startsWith(srv.ua)) return key;
  }
  return null;
}
function getOrderClientChatId(ord) {
  const match = String((ord && ord[2]) || "").match(/\((\d+)\)\s*$/);
  return match ? match[1] : null;
}
// Заявки зі статусом "Виконано" ховаються з навігації адмінки, але зберігають
// свій реальний індекс рядка в таблиці — саме він і йде у всі callback_data.
function getActiveOrders(allOrders) {
  return allOrders.map((row, idx) => ({ row, idx })).filter((o) => o.row[6] !== "Виконано");
}

// ============================================================
// СООБЩЕНИЯ (текст, контакт, фото, фінанси, візард хімії)
// ============================================================
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const clientName = msg.from.first_name || "Клієнт";
  const contactPhone = msg.contact ? msg.contact.phone_number : null;
  const state = store.getState(chatId);

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

  if (String(chatId) === String(ADMIN_ID) && state && state.step === STEP.SET_CLIENT_DISCOUNT) {
    const pct = parseInt(text, 10);
    if (/^\d+$/.test(text) && pct >= 0 && pct <= 100) {
      const ok = await sheetsApi.setClientDiscount(state.clientChatId, pct);
      const ordIdx = state.ordIdx;
      store.clearState(chatId);
      await tg.sendMessage(chatId, ok ? `✅ Постійну знижку ${pct}% закріплено за клієнтом.` : "⚠️ Клієнта не знайдено в таблиці Клієнти.");
      if (ordIdx !== undefined) await renderAdminOrder(chatId, ordIdx, null);
    } else {
      await tg.sendMessage(chatId, "⚠️ Введіть ціле число від 0 до 100.");
    }
    return;
  }

  if (String(chatId) === String(ADMIN_ID) && state && state.step === STEP.CHEM_ADD) {
    await handleChemWizardStep(chatId, state, text);
    return;
  }

  if (state && state.step === STEP.AWAITING_PHOTO_BEFORE) {
    if (msg.photo && msg.photo.length) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      store.setState(chatId, { ...state, step: STEP.AWAITING_PHOTO_AFTER, photoBeforeId: fileId });
      await tg.sendMessage(chatId, "✅ Фото «ДО» отримано.\n\n📸 Тепер надішліть фото авто ПІСЛЯ завершення робіт.");
    } else {
      await tg.sendMessage(chatId, "🚫 Будь ласка, надішліть саме фото авто ДО початку робіт.");
    }
    return;
  }

  if (state && state.step === STEP.AWAITING_PHOTO_AFTER) {
    if (msg.photo && msg.photo.length) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const orders = await sheetsApi.getOrdersData();
      const ord = orders[state.ordIdx];
      const clientChatId = ord ? getOrderClientChatId(ord) : null;
      let defaultDiscount = 0;
      if (clientChatId) {
        const rec = await sheetsApi.getClientRecord(clientChatId);
        if (rec) defaultDiscount = rec.discount || 0;
      }
      store.setState(chatId, { ...state, step: STEP.CALCULATING, photoAfterId: fileId, extras: [], discountPct: defaultDiscount });
      await tg.sendMessage(chatId, "✅ Фото «ПІСЛЯ» отримано.");
      await renderEstimate(chatId, state.ordIdx, null, null);
    } else {
      await tg.sendMessage(chatId, "🚫 Будь ласка, надішліть саме фото авто ПІСЛЯ завершення робіт.");
    }
    return;
  }

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
}

async function handleChemWizardStep(chatId, state, text) {
  const data = state.data || {};
  if (state.stage === "name") {
    if (!text.trim()) { await tg.sendMessage(chatId, "⚠️ Введіть назву хімії:"); return; }
    data.name = text.trim();
    store.setState(chatId, { step: STEP.CHEM_ADD, stage: "unit", data });
    await tg.sendMessage(chatId, "Введіть одиницю виміру (мл, л, шт):");
    return;
  }
  if (state.stage === "unit") {
    if (!text.trim()) { await tg.sendMessage(chatId, "⚠️ Введіть одиницю виміру:"); return; }
    data.unit = text.trim();
    store.setState(chatId, { step: STEP.CHEM_ADD, stage: "stock", data });
    await tg.sendMessage(chatId, `Введіть поточний залишок (число, у ${data.unit}):`);
    return;
  }
  if (state.stage === "stock") {
    const val = parseFloat(text.replace(",", "."));
    if (isNaN(val)) { await tg.sendMessage(chatId, "⚠️ Введіть число:"); return; }
    data.stock = val;
    store.setState(chatId, { step: STEP.CHEM_ADD, stage: "min", data });
    await tg.sendMessage(chatId, "Введіть мінімальний залишок, при якому надсилати сповіщення (число):");
    return;
  }
  if (state.stage === "min") {
    const val = parseFloat(text.replace(",", "."));
    if (isNaN(val)) { await tg.sendMessage(chatId, "⚠️ Введіть число:"); return; }
    data.min = val;
    store.setState(chatId, { step: STEP.CHEM_ADD, stage: "consumption", data });
    await tg.sendMessage(
      chatId,
      "Введіть витрату (цілими числами, через кому) на кожну послугу в порядку:\n" +
      "Базовий, Стандартний, Ексклюзив, Полірування, Сколи\n\n" +
      "Наприклад: 50,80,120,0,0\n(якщо послуга не використовує цю хімію — поставте 0)"
    );
    return;
  }
  if (state.stage === "consumption") {
    const parts = text.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 5 || parts.some((n) => isNaN(n))) {
      await tg.sendMessage(chatId, "⚠️ Введіть рівно 5 чисел через кому, наприклад: 50,80,120,0,0");
      return;
    }
    const consumption = {};
    SERVICE_ORDER.forEach((key, i) => { if (parts[i] > 0) consumption[key] = parts[i]; });
    try {
      await sheetsApi.addChemical([data.name, data.unit, data.stock, data.min, JSON.stringify(consumption)]);
      store.clearState(chatId);
      await tg.sendMessage(chatId, `✅ Хімію «${data.name}» додано (залишок: ${data.stock} ${data.unit}).`);
      await renderChemicalsList(chatId, null, null);
    } catch (e) {
      console.error("addChemical failed:", e.message || e);
      store.clearState(chatId);
      await tg.sendMessage(chatId, "⚠️ Не вдалося зберегти хімію. Спробуйте ще раз пізніше.");
    }
    return;
  }
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

  if (data.startsWith("rate_")) {
    const parts = data.split("_");
    const ordIdx = parseInt(parts[1], 10);
    const rating = parseInt(parts[2], 10);
    await sheetsApi.updateOrderCell(ordIdx, 8, rating);
    sheetsApi.invalidateOrdersCache();

    let responseText;
    if (rating === 5) {
      responseText = d.review_thanks_high.replace("{rating}", "⭐".repeat(rating));
      if (GOOGLE_MAPS_LINK) responseText += `\n\n${d.review_maps_prompt}\n${GOOGLE_MAPS_LINK}`;
    } else if (rating <= 3) {
      responseText = d.review_thanks_low;
    } else {
      responseText = d.review_thanks.replace("{rating}", "⭐".repeat(rating));
    }
    await tg.ackAndEdit(cb.id, chatId, messageId, responseText);

    if (ADMIN_ID) {
      if (rating <= 3) {
        tg.sendMessage(ADMIN_ID, `🚨 *НЕЗАДОВОЛЕНИЙ КЛІЄНТ!*\n\nЗаявка №${ordIdx + 1} отримала оцінку ${rating}/5.\nЗверніться до клієнта якнайшвидше.`).catch(() => {});
      } else {
        tg.sendMessage(ADMIN_ID, `⭐ Клієнт оцінив заявку №${ordIdx + 1} на ${rating}/5`).catch(() => {});
      }
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
    const summary = d.order_summary.replace("{service}", srv[lang]).replace("{carclass}", cls[lang]).replace("{price}", finalPrice);
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
  if (data.startsWith("usesaved_")) {
    const parts = data.split("_");
    const code = parts[1];
    const classCode = parts[2];
    const srvKey = CODE_TO_KEY[code];
    const savedPhone = await sheetsApi.getClientPhone(chatId);
    await tg.answerCallback(cb.id);
    if (!savedPhone) {
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
    await Promise.all([
      tg.answerCallback(cb.id),
      tg.editMessage(chatId, messageId, d.processing),
      tg.sendPhoneRequest(chatId, d.ask_phone, d.btn_share_phone)
    ]);
    return;
  }

  // ============================================================
  // 👷 ИСПОЛНИТЕЛЬ (админ або призначений майстер)
  // ============================================================
  if (isExecutor(chatId)) {
    if (data.startsWith("arrive_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      await sheetsApi.updateOrderCell(ordIdx, 7, "Прибув на місце");
      sheetsApi.invalidateOrdersCache();
      store.setState(chatId, { step: STEP.AWAITING_PHOTO_BEFORE, ordIdx });
      await tg.ackAndEdit(cb.id, chatId, messageId, "📸 *Надішліть фото авто ДО початку робіт*");
      return;
    }
    if (data.startsWith("addon_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[1], 10);
      const code = parts[2];
      const state = store.getState(chatId) || { ordIdx, extras: [], discountPct: 0 };
      const extras = state.extras || [];
      const idx = extras.indexOf(code);
      if (idx >= 0) extras.splice(idx, 1); else extras.push(code);
      store.setState(chatId, { ...state, ordIdx, extras });
      await tg.answerCallback(cb.id);
      await renderEstimate(chatId, ordIdx, messageId, null);
      return;
    }
    if (data.startsWith("disc2_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[1], 10);
      const pct = parseInt(parts[2], 10);
      const state = store.getState(chatId) || { ordIdx, extras: [] };
      store.setState(chatId, { ...state, ordIdx, discountPct: pct });
      await tg.answerCallback(cb.id);
      await renderEstimate(chatId, ordIdx, messageId, null);
      return;
    }
    if (data.startsWith("finalize_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      await finalizeOrder(chatId, ordIdx, messageId, cb.id);
      return;
    }
  }

  // === 👑 АДМИНКА (тільки ADMIN_ID) ===
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
    if (data.startsWith("clientdisc_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      const orders = await sheetsApi.getOrdersData();
      const ord = orders[ordIdx];
      const clientChatId = ord ? getOrderClientChatId(ord) : null;
      if (!clientChatId) { await tg.answerCallback(cb.id); return; }
      store.setState(chatId, { step: STEP.SET_CLIENT_DISCOUNT, ordIdx, clientChatId, promptMessageId: messageId });
      await tg.ackAndEdit(cb.id, chatId, messageId, "🎗 *Введіть постійну знижку для цього клієнта у % (0-100, наприклад 10):*");
      return;
    }
    if (data.startsWith("assignmenu_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      const kb = {
        inline_keyboard: [
          [{ text: "👤 Прийняти самому", callback_data: `assignself_${ordIdx}` }],
          [{ text: "👨‍🔧 Призначити майстра", callback_data: `assignlist_${ordIdx}` }],
          [{ text: "🔙 Назад", callback_data: `adm_ord_${ordIdx}` }]
        ]
      };
      await tg.ackAndEdit(cb.id, chatId, messageId, `👷 *Хто виконуватиме заявку №${ordIdx + 1}?*`, kb);
      return;
    }
    if (data.startsWith("assignself_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      await assignOrder(chatId, ordIdx, cb.from.first_name || "Адмін", chatId, messageId, cb.id);
      return;
    }
    if (data.startsWith("assignlist_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      if (SPECIALISTS.length === 0) {
        await tg.ackAndEdit(cb.id, chatId, messageId,
          "⚠️ Список майстрів порожній. Додайте змінну середовища MASTERS (формат: Ім'я1:chatId1,Ім'я2:chatId2) в Railway і передеплойте.",
          { inline_keyboard: [[{ text: "🔙 Назад", callback_data: `assignmenu_${ordIdx}` }]] });
        return;
      }
      const rows = SPECIALISTS.map((m) => [{ text: "👨‍🔧 " + m.name, callback_data: `assignm_${ordIdx}_${m.code}` }]);
      rows.push([{ text: "🔙 Назад", callback_data: `assignmenu_${ordIdx}` }]);
      await tg.ackAndEdit(cb.id, chatId, messageId, `👨‍🔧 *Оберіть майстра для заявки №${ordIdx + 1}:*`, { inline_keyboard: rows });
      return;
    }
    if (data.startsWith("assignm_")) {
      const parts = data.split("_");
      const ordIdx = parseInt(parts[1], 10);
      const mcode = parts[2];
      const master = SPECIALISTS.find((m) => m.code === mcode);
      if (!master) { await tg.answerCallback(cb.id); return; }
      await assignOrder(chatId, ordIdx, master.name, master.chatId || chatId, messageId, cb.id);
      return;
    }
    if (data.startsWith("estimate_")) {
      const ordIdx = parseInt(data.split("_")[1], 10);
      await tg.answerCallback(cb.id);
      const orders = await sheetsApi.getOrdersData();
      const ord = orders[ordIdx];
      const clientChatId = ord ? getOrderClientChatId(ord) : null;
      let defaultDiscount = 0;
      if (clientChatId) {
        const rec = await sheetsApi.getClientRecord(clientChatId);
        if (rec) defaultDiscount = rec.discount || 0;
      }
      store.setState(chatId, { ordIdx, extras: [], discountPct: defaultDiscount });
      await renderEstimate(chatId, ordIdx, messageId, null);
      return;
    }
    if (data === "chem_list") {
      await renderChemicalsList(chatId, messageId, cb.id);
      return;
    }
    if (data === "chem_add") {
      store.setState(chatId, { step: STEP.CHEM_ADD, stage: "name", data: {} });
      await tg.ackAndEdit(cb.id, chatId, messageId, "🧪 *Додавання хімії*\n\nВведіть назву (наприклад: Шампунь-концентрат):");
      return;
    }

    await tg.answerCallback(cb.id);
  }
}

// ============================================================
// НАЗНАЧЕНИЕ ИСПОЛНИТЕЛЯ
// ============================================================
async function assignOrder(chatId, ordIdx, executorName, executorChatId, messageId, cbId) {
  await sheetsApi.updateOrderCell(ordIdx, 7, `Призначено: ${executorName}`);
  sheetsApi.invalidateOrdersCache();

  const orders = await sheetsApi.getOrdersData();
  const ord = orders[ordIdx];
  const arriveKb = { inline_keyboard: [[{ text: "📍 Підтвердити прибуття", callback_data: `arrive_${ordIdx}` }]] };
  const infoText = ord
    ? `🛠 *Заявка №${ordIdx + 1}*\n📞 Телефон: \`${ord[3]}\`\n🛠 Послуга: *${ord[4]}*\n💰 Сума: ${ord[5]} грн\n\nКоли будете на місці — натисніть кнопку:`
    : "Заявку призначено. Коли будете на місці — натисніть кнопку:";

  if (executorChatId && String(executorChatId) !== String(chatId)) {
    await tg.sendMessage(executorChatId, infoText, arriveKb);
    await tg.ackAndEdit(cbId, chatId, messageId, `✅ Заявку №${ordIdx + 1} призначено на ${executorName}.`, {
      inline_keyboard: [[{ text: "🔙 До заявки", callback_data: `adm_ord_${ordIdx}` }]]
    });
  } else {
    await tg.ackAndEdit(cbId, chatId, messageId, infoText, arriveKb);
  }
}

// ============================================================
// КОШТОРИС: базова ціна + допуслуги (upsell) + знижка
// ============================================================
async function renderEstimate(chatId, ordIdx, messageId, cbId) {
  const state = store.getState(chatId) || { ordIdx, extras: [], discountPct: 0 };
  const orders = await sheetsApi.getOrdersData();
  const ord = orders[ordIdx];
  if (!ord) {
    const text = "⚠️ Заявку не знайдено.";
    if (cbId) await tg.ackAndEdit(cbId, chatId, messageId, text); else await tg.sendMessage(chatId, text);
    return;
  }
  const basePrice = parseFloat(ord[5]) || 0;
  const extras = state.extras || [];
  const extrasTotal = extras.reduce((s, code) => s + (ADDONS[code] ? ADDONS[code].price : 0), 0);
  const discountPct = state.discountPct || 0;
  const total = Math.round((basePrice + extrasTotal) * (1 - discountPct / 100));

  let text = `🧾 *КОШТОРИС — заявка №${ordIdx + 1}*\n\n🛠 ${ord[4]}\n💰 База: ${basePrice} грн\n`;
  if (extras.length) {
    text += "\n➕ *Додаткові послуги:*\n" + extras.map((c) => `• ${ADDONS[c].ua} — +${ADDONS[c].price} грн`).join("\n") + "\n";
  }
  if (discountPct) text += `\n🎁 Знижка: -${discountPct}%\n`;
  text += `\n💵 *РАЗОМ: ${total} грн*`;

  const addonRows = Object.values(ADDONS).map((a) => {
    const active = extras.includes(a.code);
    return [{ text: `${active ? "✅" : "➕"} ${a.ua} (+${a.price})`, callback_data: `addon_${ordIdx}_${a.code}` }];
  });

  const kb = {
    inline_keyboard: [
      ...addonRows,
      [
        { text: "🎁 -10%", callback_data: `disc2_${ordIdx}_10` },
        { text: "🎁 -20%", callback_data: `disc2_${ordIdx}_20` },
        { text: "❌ Без знижки", callback_data: `disc2_${ordIdx}_0` }
      ],
      [{ text: "🏁 Завершити замовлення", callback_data: `finalize_${ordIdx}` }]
    ]
  };

  if (cbId && messageId) await tg.ackAndEdit(cbId, chatId, messageId, text, kb);
  else if (messageId) await tg.editMessage(chatId, messageId, text, kb);
  else await tg.sendMessage(chatId, text, kb);
}

// ============================================================
// ФИНАЛИЗАЦИЯ ЗАКАЗА -> СПИСАННЯ ХІМІЇ + ІСТОРІЯ КЛІЄНТА -> NPS
// ============================================================
async function deductChemicals(srvKey) {
  if (!srvKey) return;
  try {
    const chemicals = await sheetsApi.getChemicals();
    for (const chem of chemicals) {
      const amount = chem.consumption[srvKey] || 0;
      if (amount > 0) {
        const newStock = Math.max(0, chem.stock - amount);
        await sheetsApi.updateChemicalStock(chem.rowIndex, newStock);
        if (newStock <= chem.min && ADMIN_ID) {
          await tg.sendMessage(ADMIN_ID, `🧴 *Закінчується хімія!*\n\n${chem.name}: залишилось ${newStock} ${chem.unit} (поріг: ${chem.min} ${chem.unit}).\nПотрібно замовити.`);
        }
      }
    }
  } catch (e) {
    console.error("deductChemicals failed:", e.message || e);
  }
}

async function finalizeOrder(chatId, ordIdx, messageId, cbId) {
  const state = store.getState(chatId) || {};
  const orders = await sheetsApi.getOrdersData();
  const ord = orders[ordIdx];
  if (!ord) {
    if (cbId) await tg.ackAndEdit(cbId, chatId, messageId, "⚠️ Заявку не знайдено.");
    return;
  }
  const srvKey = resolveServiceKeyFromLabel(ord[4]);
  const basePrice = parseFloat(ord[5]) || 0;
  const extras = state.extras || [];
  const extrasTotal = extras.reduce((s, code) => s + (ADDONS[code] ? ADDONS[code].price : 0), 0);
  const discountPct = state.discountPct || 0;
  const total = Math.round((basePrice + extrasTotal) * (1 - discountPct / 100));
  const extrasLabel = extras.length ? " + " + extras.map((c) => ADDONS[c].ua).join(", ") : "";
  const finalDescription = ord[4] + extrasLabel + (discountPct ? ` (знижка -${discountPct}%)` : "");

  await sheetsApi.updateOrderCell(ordIdx, 5, finalDescription);
  await sheetsApi.updateOrderCell(ordIdx, 6, total);
  await sheetsApi.updateOrderCell(ordIdx, 7, "Виконано");
  if (state.photoBeforeId) await sheetsApi.updateOrderCell(ordIdx, 9, state.photoBeforeId);
  if (state.photoAfterId) await sheetsApi.updateOrderCell(ordIdx, 10, state.photoAfterId);
  sheetsApi.invalidateOrdersCache();

  await deductChemicals(srvKey);

  const clientChatId = getOrderClientChatId(ord);
  if (clientChatId) {
    sheetsApi.updateClientOrderInfo(clientChatId, finalDescription, state.photoBeforeId, state.photoAfterId).catch(() => {});
  }

  if (ADMIN_ID && String(chatId) !== String(ADMIN_ID)) {
    if (state.photoBeforeId) tg.tgApi("sendPhoto", { chat_id: String(ADMIN_ID), photo: state.photoBeforeId, caption: `ДО — заявка №${ordIdx + 1}` }).catch(() => {});
    if (state.photoAfterId) tg.tgApi("sendPhoto", { chat_id: String(ADMIN_ID), photo: state.photoAfterId, caption: `ПІСЛЯ — заявка №${ordIdx + 1}` }).catch(() => {});
  }

  store.clearState(chatId);

  const doneText = `🏁 *Заявку №${ordIdx + 1} завершено!*\n💵 Фінальна сума: ${total} грн`;
  if (cbId && messageId) {
    await tg.ackAndEdit(cbId, chatId, messageId, doneText, { inline_keyboard: [[{ text: "🔙 До списку заявок", callback_data: "adm_ord_0" }]] });
  } else {
    await tg.sendMessage(chatId, doneText);
  }

  await requestReview(ordIdx);
}

async function requestReview(ordIdx) {
  try {
    const orders = await sheetsApi.getOrdersData();
    const ord = orders[ordIdx];
    if (!ord) return;
    const clientChatId = getOrderClientChatId(ord);
    if (!clientChatId) return;
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
// СОЗДАНИЕ ЗАКАЗА (клиентский поток)
// ============================================================
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

    sheetsApi.saveClientPhone(chatId, clientName, phone).catch(() => {});

    if (ADMIN_ID) {
      await tg.sendMessage(
        ADMIN_ID,
        `🚨 *НОВА ЗАЯВКА WAP CLUB!*\n\n📦 ID: \`${orderId}\`\n👤 Клієнт: ${clientName}\n📞 Телефон: \`${phone}\`\n🛠 Послуга: *${serviceLabelUa}*\n💵 Сума: ${finalPrice} грн\n📅 ${date}`,
        {
          inline_keyboard: [
            [{ text: "📋 Детальніше", callback_data: `adm_ord_${newIndex}` }],
            [{ text: "🚀 В роботу", callback_data: `assignmenu_${newIndex}` }, { text: "🏁 Завершити", callback_data: `estimate_${newIndex}` }]
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
  if (String(chatId) === String(ADMIN_ID)) {
    rows.push([{ text: "👑 Панель адміністратора", callback_data: "adm_ord_0" }]);
    rows.push([{ text: "🧪 Склад хімії", callback_data: "chem_list" }]);
  }
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

function buildAdminCard(active, position) {
  const total = active.length;
  if (position < 0) position = 0;
  if (position >= total) position = total - 1;
  const { row: ord, idx: realIdx } = active[position];
  const ratingLine = ord[7] ? `\n⭐ *Оцінка:* ${ord[7]}/5` : "";
  const text =
    `👑 *УПРАВЛІННЯ ЗАЯВКОЮ №${realIdx + 1}* (${position + 1} з ${total} активних)\n\n` +
    `📦 *ID:* \`${ord[0]}\`\n📅 *Дата:* ${ord[1]}\n👤 *Клієнт:* ${ord[2]}\n📞 *Телефон:* \`${ord[3]}\`\n` +
    `🛠 *Послуга:* *${ord[4]}*\n💰 *Сума:* *${ord[5]} грн*\n📊 *Статус:* \`${ord[6] || "Новий"}\`${ratingLine}`;

  const navRow = [];
  if (position > 0) navRow.push({ text: "◀️ Попер.", callback_data: "adm_ord_" + active[position - 1].idx });
  if (position < total - 1) navRow.push({ text: "▶️ Наст.", callback_data: "adm_ord_" + active[position + 1].idx });

  const kb = {
    inline_keyboard: [
      navRow,
      [{ text: "🎁 -10%", callback_data: `adm_disc_${realIdx}_10` }, { text: "🎁 -20%", callback_data: `adm_disc_${realIdx}_20` }, { text: "🎁 -100 грн", callback_data: `adm_disc_${realIdx}_100` }],
      [{ text: "💰 Своя ціна", callback_data: `adm_promptprice_${realIdx}` }, { text: "🛠 Змінити послугу", callback_data: `adm_pricksrv_${realIdx}` }],
      [{ text: "🎗 Знижка клієнту", callback_data: `clientdisc_${realIdx}` }],
      [{ text: "🚀 В роботу", callback_data: `assignmenu_${realIdx}` }, { text: "🏁 Завершити", callback_data: `estimate_${realIdx}` }],
      [{ text: "🔙 Вийти з адмінки", callback_data: "menu_main" }]
    ]
  };
  return { text, kb };
}

async function renderAdminOrder(chatId, index, messageId, cbId) {
  const orders = await sheetsApi.getOrdersData();
  const active = getActiveOrders(orders);
  if (!active.length) {
    const text = "👑 *ПАНЕЛЬ АДМІНІСТРАТОРА*\n\nАктивних заявок немає — всі виконані 🎉";
    const kb = { inline_keyboard: [[{ text: "🔙 У головне меню", callback_data: "menu_main" }]] };
    if (cbId) await tg.answerCallback(cbId);
    if (messageId) await tg.editMessage(chatId, messageId, text, kb); else await tg.sendMessage(chatId, text, kb);
    return;
  }
  let position = active.findIndex((o) => o.idx === index);
  if (position === -1) position = 0;
  const { text, kb } = buildAdminCard(active, position);
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

async function renderChemicalsList(chatId, messageId, cbId) {
  const chemicals = await sheetsApi.getChemicals();
  let text = "🧪 *СКЛАД ХІМІЇ*\n\n";
  if (!chemicals.length) {
    text += "Поки що нічого не додано.";
  } else {
    text += chemicals.map((c) => {
      const warn = c.stock <= c.min ? " ⚠️ ЗАКІНЧУЄТЬСЯ" : "";
      return `• *${c.name}*: ${c.stock} ${c.unit}${warn}`;
    }).join("\n");
  }
  const kb = {
    inline_keyboard: [
      [{ text: "➕ Додати хімію", callback_data: "chem_add" }],
      [{ text: "🔙 У головне меню", callback_data: "menu_main" }]
    ]
  };
  if (cbId && messageId) await tg.ackAndEdit(cbId, chatId, messageId, text, kb);
  else if (messageId) await tg.editMessage(chatId, messageId, text, kb);
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
    console.error("Webhook handling error:", error && error.stack || error);
    if (ADMIN_ID) {
      tg.sendMessage(ADMIN_ID, `⚠️ Помилка в боті: ${error && error.message ? error.message : error}`).catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`WAP CLUB bot listening on port ${PORT}`);
});
