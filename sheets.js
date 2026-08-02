const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Заказы";
const CLIENTS_SHEET_NAME = process.env.CLIENTS_SHEET_NAME || "Клієнти";
const FINANCE_SHEET_NAME = process.env.FINANCE_SHEET_NAME || "Фінанси";
const CHEMICALS_SHEET_NAME = process.env.CHEMICALS_SHEET_NAME || "Хімія";
const INVENTORY_SHEET_NAME = process.env.INVENTORY_SHEET_NAME || "Інвентар";
const CACHE_TTL_MS = 60 * 1000;

let sheetsClientPromise = null;
let ordersCache = null;
let ordersCacheTime = 0;
let clientsCache = null; // { map: Map(chatId -> record), maxCode }
const ensuredSheets = new Set();

function getSheetsClient() {
  if (sheetsClientPromise) return sheetsClientPromise;
  sheetsClientPromise = (async () => {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
      },
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive"
      ]
    });
    const client = await auth.getClient();
    return { sheets: google.sheets({ version: "v4", auth: client }), authClient: client };
  })();
  return sheetsClientPromise;
}
async function getSheets() {
  return (await getSheetsClient()).sheets;
}
// Календарный клиент переиспользует ту же авторизацию (см. calendar.js).
async function getAuthClient() {
  return (await getSheetsClient()).authClient;
}

async function withRetry(fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.error(`Sheet op failed, attempt ${i + 1}/${retries}:`, e.message || e);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr;
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function ensureSheetExists(title, headers) {
  if (ensuredSheets.has(title)) return;
  await withRetry(async () => {
    const sheets = await getSheets();
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const exists = (meta.data.sheets || []).some((s) => s.properties.title === title);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${title}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [headers] }
      });
    }
  });
  ensuredSheets.add(title);
}

// ============================================================
// ЗАКАЗЫ
// Стовпці: A ID, B Дата, C Клієнт, D Телефон, E Послуга, F Сума, G Статус,
// H Оцінка, I Фото До, J Фото Після, K Дата виконання, L LTV-нагадування, M Джерело
// ============================================================
async function appendOrderRow(row) {
  return withRetry(async () => {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:Q`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  });
}

async function updateOrderCell(rowIndex, colIndex, value) {
  return withRetry(async () => {
    const sheets = await getSheets();
    const range = `${SHEET_NAME}!${colLetter(colIndex)}${rowIndex + 2}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] }
    });
  });
}

function invalidateOrdersCache() {
  ordersCache = null;
}

async function getOrdersData() {
  const now = Date.now();
  if (ordersCache && now - ordersCacheTime < CACHE_TTL_MS) return ordersCache;
  try {
    const sheets = await getSheets();
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A2:Q`
      })
    );
    // КРИТИЧНО: тут НЕ можна фільтрувати рядки (навіть порожні) — позиція
    // елемента в цьому масиві має завжди дорівнювати номеру рядка в таблиці
    // мінус 2 (бо updateOrderCell/appendOrderRow рахують номер рядка саме так).
    // Якщо тут прибрати хоча б один рядок, усі заявки нижче "зʼїдуть" в нумерації
    // і записуватимуться/читатимуться не в ту заявку. Порожні рядки для показу
    // адміну відсіюються окремо, вже після цього — на рівні index.js.
    const rows = res.data.values || [];
    ordersCache = rows;
    ordersCacheTime = now;
    return rows;
  } catch (e) {
    console.error("getOrdersData failed after retries:", e.message || e);
    return ordersCache || [];
  }
}

// ============================================================
// КЛИЕНТЫ
// Стовпці: A Код, B ChatId, C Ім'я, D Телефон, E Знижка(%), F Остання послуга,
// G Фото До, H Фото Після, I Баланс бонусів, J Реферер(chatId), K Бонус нарахований
//
// ChatId може бути порожнім — це клієнти, з якими працюють тільки по дзвінку
// (замовлення вносить адмін вручну). Такі записи шукаються за телефоном.
// ============================================================
const CLIENTS_HEADERS = ["Код", "ChatId", "Ім'я", "Телефон", "Знижка(%)", "Остання послуга", "Фото До", "Фото Після", "Баланс бонусів", "Реферер", "Бонус нарахований"];

async function loadClientsCache() {
  await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
  const sheets = await getSheets();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CLIENTS_SHEET_NAME}!A2:K`
    })
  );
  const byChatId = new Map();
  const byPhone = new Map();
  const all = [];
  let maxCode = 0;
  (res.data.values || []).forEach((r, i) => {
    const chatId = r[1] || "";
    const phone = r[3] || "";
    if (!chatId && !phone) return; // порожній/структурний рядок — пропускаємо, але не змінюємо індексацію інших
    const code = parseInt(r[0], 10) || 0;
    if (code > maxCode) maxCode = code;
    const rec = {
      code, chatId, name: r[2] || "", phone,
      discount: parseFloat(r[4]) || 0,
      lastService: r[5] || "",
      photoBefore: r[6] || "",
      photoAfter: r[7] || "",
      balance: parseFloat(r[8]) || 0,
      referrer: r[9] || "",
      bonusPaid: r[10] === "1" || r[10] === 1,
      rowIndex: i
    };
    if (chatId) byChatId.set(chatId, rec);
    if (phone) byPhone.set(phone, rec);
    all.push(rec);
  });
  clientsCache = { byChatId, byPhone, all, maxCode };
  return clientsCache;
}

async function getClientRecord(chatId) {
  try {
    if (!clientsCache) await loadClientsCache();
    return clientsCache.byChatId.get(String(chatId)) || null;
  } catch (e) {
    console.error("getClientRecord failed:", e.message || e);
    return null;
  }
}

async function getClientRecordByPhone(phone) {
  try {
    if (!phone) return null;
    if (!clientsCache) await loadClientsCache();
    return clientsCache.byPhone.get(phone) || null;
  } catch (e) {
    console.error("getClientRecordByPhone failed:", e.message || e);
    return null;
  }
}

async function getClientPhone(chatId) {
  const rec = await getClientRecord(chatId);
  return rec ? rec.phone : null;
}

// Створює клієнта (з новим унікальним кодом, починаючи з 1) або оновлює ім'я/телефон існуючого.
async function saveClientPhone(chatId, name, phone) {
  try {
    await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
    if (!clientsCache) await loadClientsCache();
    const sheets = await getSheets();
    const existing = clientsCache.byChatId.get(String(chatId));
    if (existing) {
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${CLIENTS_SHEET_NAME}!C${existing.rowIndex + 2}:D${existing.rowIndex + 2}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[name, phone]] }
        })
      );
    } else {
      const newCode = (clientsCache.maxCode || 0) + 1;
      await withRetry(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${CLIENTS_SHEET_NAME}!A:K`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[newCode, String(chatId), name, phone, 0, "", "", "", 0, "", "0"]] }
        })
      );
    }
    clientsCache = null;
  } catch (e) {
    console.error("saveClientPhone failed:", e.message || e);
  }
}

// Для клієнтів, з якими працюють лише по дзвінку (ручні замовлення) — та сама
// таблиця, той самий унікальний код, просто без ChatId.
async function saveManualClient(phone, name) {
  try {
    if (!phone) return;
    await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
    if (!clientsCache) await loadClientsCache();
    const sheets = await getSheets();
    const existing = clientsCache.byPhone.get(phone);
    if (existing) {
      if (name && name !== existing.name) {
        await withRetry(() =>
          sheets.spreadsheets.values.update({
            spreadsheetId: SHEET_ID,
            range: `${CLIENTS_SHEET_NAME}!C${existing.rowIndex + 2}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[name]] }
          })
        );
        clientsCache = null;
      }
      return;
    }
    const newCode = (clientsCache.maxCode || 0) + 1;
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${CLIENTS_SHEET_NAME}!A:K`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[newCode, "", name || "", phone, 0, "", "", "", 0, "", "0"]] }
      })
    );
    clientsCache = null;
  } catch (e) {
    console.error("saveManualClient failed:", e.message || e);
  }
}

// Реєстрація клієнта, що прийшов за реферальним посиланням — ще до того, як
// відомий телефон (створюється мінімальний рядок зі стартовою знижкою 10%).
async function registerReferral(chatId, name, referrerChatId) {
  try {
    await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
    if (!clientsCache) await loadClientsCache();
    if (clientsCache.byChatId.has(String(chatId))) return false; // вже існує — не перереєструємо
    const sheets = await getSheets();
    const newCode = (clientsCache.maxCode || 0) + 1;
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${CLIENTS_SHEET_NAME}!A:K`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[newCode, String(chatId), name, "", 10, "", "", "", 0, String(referrerChatId), "0"]] }
      })
    );
    clientsCache = null;
    return true;
  } catch (e) {
    console.error("registerReferral failed:", e.message || e);
    return false;
  }
}

async function setClientDiscount(chatId, discountPct) {
  await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
  if (!clientsCache) await loadClientsCache();
  const existing = clientsCache.byChatId.get(String(chatId));
  if (!existing) return false;
  return setClientDiscountByRow(existing.rowIndex, discountPct);
}

// Та сама операція, але за номером рядка напряму — працює однаково для клієнтів
// із ChatId і для тих, з ким спілкуються лише по телефону.
async function setClientDiscountByRow(rowIndex, discountPct) {
  const sheets = await getSheets();
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CLIENTS_SHEET_NAME}!E${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[discountPct]] }
    })
  );
  clientsCache = null;
  return true;
}

async function updateClientOrderInfo(chatId, service, photoBeforeId, photoAfterId) {
  try {
    await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
    if (!clientsCache) await loadClientsCache();
    const existing = clientsCache.byChatId.get(String(chatId));
    if (!existing) return;
    const sheets = await getSheets();
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${CLIENTS_SHEET_NAME}!F${existing.rowIndex + 2}:H${existing.rowIndex + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[service || "", photoBeforeId || "", photoAfterId || ""]] }
      })
    );
    clientsCache = null;
  } catch (e) {
    console.error("updateClientOrderInfo failed:", e.message || e);
  }
}

async function addBonusBalance(chatId, amount) {
  try {
    await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
    if (!clientsCache) await loadClientsCache();
    const existing = clientsCache.byChatId.get(String(chatId));
    if (!existing) return false;
    const sheets = await getSheets();
    const newBalance = (existing.balance || 0) + amount;
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${CLIENTS_SHEET_NAME}!I${existing.rowIndex + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[newBalance]] }
      })
    );
    clientsCache = null;
    return true;
  } catch (e) {
    console.error("addBonusBalance failed:", e.message || e);
    return false;
  }
}

// Списує бонуси (використання при оплаті) — окрема від нарахування функція,
// щоб виклики читались однозначно в коді.
async function spendBonusBalance(chatId, amount) {
  return addBonusBalance(chatId, -Math.abs(amount));
}

async function markReferralBonusPaid(chatId) {
  try {
    await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
    if (!clientsCache) await loadClientsCache();
    const existing = clientsCache.byChatId.get(String(chatId));
    if (!existing) return;
    const sheets = await getSheets();
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${CLIENTS_SHEET_NAME}!K${existing.rowIndex + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [["1"]] }
      })
    );
    clientsCache = null;
  } catch (e) {
    console.error("markReferralBonusPaid failed:", e.message || e);
  }
}

// Для LTV-будильника: усі клієнти з ChatId (тільки їм можна написати в Telegram).
async function getAllClientsWithChatId() {
  if (!clientsCache) await loadClientsCache();
  return clientsCache.all.filter((c) => c.chatId);
}

// Для адмінської панелі "👥 Клієнти" — геть усі, включно з тими, хто тільки дзвонив.
async function getAllClients() {
  if (!clientsCache) await loadClientsCache();
  return clientsCache.all;
}

// ============================================================
// КЛУБНІ ПІДПИСКИ (WAP CLUB PASS)
// Стовпці: A Код, B ChatId, C Ім'я, D Тариф, E Дата початку, F Наступне подовження(ISO),
// G Статус, H Мийок залишилось, I Прибирань салону залишилось
// ============================================================
const SUBS_SHEET_NAME = process.env.SUBSCRIPTIONS_SHEET_NAME || "Підписки";
const SUBS_HEADERS = ["Код", "ChatId", "Ім'я", "Тариф", "Дата початку", "Наступне подовження", "Статус", "Мийок залишилось", "Прибирань залишилось"];
let subsCache = null; // { map: Map(chatId -> record), maxCode }

async function loadSubsCache() {
  await ensureSheetExists(SUBS_SHEET_NAME, SUBS_HEADERS);
  const sheets = await getSheets();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SUBS_SHEET_NAME}!A2:I` })
  );
  const map = new Map();
  let maxCode = 0;
  (res.data.values || []).forEach((r, i) => {
    if (!r[1]) return;
    const code = parseInt(r[0], 10) || 0;
    if (code > maxCode) maxCode = code;
    map.set(String(r[1]), {
      code, name: r[2] || "", tariff: r[3] || "", startDate: r[4] || "",
      nextRenewal: r[5] || "", status: r[6] || "", washesLeft: parseInt(r[7], 10) || 0,
      salonLeft: parseInt(r[8], 10) || 0, rowIndex: i
    });
  });
  subsCache = { map, maxCode };
  return subsCache;
}

async function getSubscriptionRecord(chatId) {
  try {
    if (!subsCache) await loadSubsCache();
    return subsCache.map.get(String(chatId)) || null;
  } catch (e) {
    console.error("getSubscriptionRecord failed:", e.message || e);
    return null;
  }
}

async function createPendingSubscription(chatId, name, tariffCode) {
  await ensureSheetExists(SUBS_SHEET_NAME, SUBS_HEADERS);
  if (!subsCache) await loadSubsCache();
  const sheets = await getSheets();
  const existing = subsCache.map.get(String(chatId));
  if (existing) {
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SUBS_SHEET_NAME}!D${existing.rowIndex + 2}:G${existing.rowIndex + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[tariffCode, "", "", "Очікує підтвердження"]] }
      })
    );
  } else {
    const newCode = (subsCache.maxCode || 0) + 1;
    await withRetry(() =>
      sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${SUBS_SHEET_NAME}!A:I`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[newCode, String(chatId), name, tariffCode, "", "", "Очікує підтвердження", 0, 0]] }
      })
    );
  }
  subsCache = null;
}

async function activateSubscription(chatId, tariffCode, washes, salonCleans, startISO, nextRenewalISO) {
  await ensureSheetExists(SUBS_SHEET_NAME, SUBS_HEADERS);
  if (!subsCache) await loadSubsCache();
  const existing = subsCache.map.get(String(chatId));
  if (!existing) return false;
  const sheets = await getSheets();
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SUBS_SHEET_NAME}!D${existing.rowIndex + 2}:I${existing.rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[tariffCode, startISO, nextRenewalISO, "Активна", washes, salonCleans]] }
    })
  );
  subsCache = null;
  return true;
}

async function cancelSubscription(chatId) {
  await ensureSheetExists(SUBS_SHEET_NAME, SUBS_HEADERS);
  if (!subsCache) await loadSubsCache();
  const existing = subsCache.map.get(String(chatId));
  if (!existing) return false;
  const sheets = await getSheets();
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SUBS_SHEET_NAME}!G${existing.rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Скасована"]] }
    })
  );
  subsCache = null;
  return true;
}

async function decrementSubscriptionQuota(chatId, field) {
  // field: "washes" | "salon"
  await ensureSheetExists(SUBS_SHEET_NAME, SUBS_HEADERS);
  if (!subsCache) await loadSubsCache();
  const existing = subsCache.map.get(String(chatId));
  if (!existing) return false;
  const col = field === "salon" ? "I" : "H";
  const current = field === "salon" ? existing.salonLeft : existing.washesLeft;
  const sheets = await getSheets();
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SUBS_SHEET_NAME}!${col}${existing.rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[Math.max(0, current - 1)]] }
    })
  );
  subsCache = null;
  return true;
}

// Продовжує (скидає ліміти) усі активні підписки, чия дата подовження настала
// або вже минула. Повертає список продовжених — для сповіщення адміну/клієнтів.
async function resetDueSubscriptions(quotaByTariff, todayISO) {
  if (!subsCache) await loadSubsCache();
  const sheets = await getSheets();
  const due = Array.from(subsCache.map.entries()).filter(
    ([, rec]) => rec.status === "Активна" && rec.nextRenewal && rec.nextRenewal <= todayISO
  );
  const results = [];
  for (const [chatId, rec] of due) {
    const q = quotaByTariff[rec.tariff] || { washes: 0, salon: 0 };
    const nextMonth = new Date(todayISO);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setDate(1);
    const nextISO = nextMonth.toISOString().slice(0, 10);
    await withRetry(() =>
      sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SUBS_SHEET_NAME}!F${rec.rowIndex + 2}:I${rec.rowIndex + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[nextISO, "Активна", q.washes, q.salon]] }
      })
    );
    results.push({ chatId, name: rec.name, tariff: rec.tariff });
  }
  if (due.length) subsCache = null;
  return results;
}

async function getAllActiveSubscriptions() {
  if (!subsCache) await loadSubsCache();
  return Array.from(subsCache.map.entries())
    .map(([chatId, rec]) => ({ chatId, ...rec }))
    .filter((r) => r.status === "Активна" || r.status === "Очікує підтвердження");
}

// ============================================================
// ФИНАНСЫ
// ============================================================
async function appendFinanceRow(row) {
  await ensureSheetExists(FINANCE_SHEET_NAME, ["Дата", "Тип", "Сума", "Опис", "Хто вніс"]);
  return withRetry(async () => {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${FINANCE_SHEET_NAME}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  });
}

async function getFinanceBalance() {
  await ensureSheetExists(FINANCE_SHEET_NAME, ["Дата", "Тип", "Сума", "Опис", "Хто вніс"]);
  const sheets = await getSheets();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${FINANCE_SHEET_NAME}!B2:C`
    })
  );
  let balance = 0;
  (res.data.values || []).forEach((r) => {
    const amount = parseFloat(String(r[1] || "0").replace(",", ".")) || 0;
    balance += r[0] === "Дохід" ? amount : -amount;
  });
  return balance;
}

// ============================================================
// ІНВЕНТАР / ЗАКУПІВЛІ (обладнання, витратні матеріали)
// Подвійний запис: рядок у "Інвентар" + автоматично рядок-витрата у "Фінанси",
// щоб баланс "кишенькового бухгалтера" завжди рахувався правильно.
// ============================================================
const INVENTORY_HEADERS = ["Дата", "Назва", "Сума", "Хто додав"];

async function addInventoryPurchase(itemName, amount, who) {
  await ensureSheetExists(INVENTORY_SHEET_NAME, INVENTORY_HEADERS);
  const date = new Intl.DateTimeFormat("uk-UA", {
    timeZone: "Europe/Kyiv",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  }).format(new Date());

  const sheets = await getSheets();
  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${INVENTORY_SHEET_NAME}!A:D`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[date, itemName, amount, who]] }
    })
  );

  // Те саме — витратою у "Фінанси", тим самим withRetry всередині appendFinanceRow.
  await appendFinanceRow([date, "Витрата", amount, `Закупка: ${itemName}`, who]);

  return date;
}

// ============================================================
// ХІМІЯ / СКЛАД
// ============================================================
const CHEMICALS_HEADERS = ["Назва", "Одиниця", "Залишок", "Мін. залишок", "Витрата (JSON)"];

async function getChemicals() {
  await ensureSheetExists(CHEMICALS_SHEET_NAME, CHEMICALS_HEADERS);
  const sheets = await getSheets();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CHEMICALS_SHEET_NAME}!A2:E`
    })
  );
  return (res.data.values || [])
    .map((r, i) => {
      let consumption = {};
      try { consumption = JSON.parse(r[4] || "{}"); } catch (e) { /* ignore malformed row */ }
      return {
        rowIndex: i,
        name: r[0] || "",
        unit: r[1] || "",
        stock: parseFloat(r[2]) || 0,
        min: parseFloat(r[3]) || 0,
        consumption
      };
    })
    .filter((c) => c.name);
}

async function addChemical(row) {
  await ensureSheetExists(CHEMICALS_SHEET_NAME, CHEMICALS_HEADERS);
  return withRetry(async () => {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CHEMICALS_SHEET_NAME}!A:E`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  });
}

async function updateChemicalStock(rowIndex, newStock) {
  return withRetry(async () => {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CHEMICALS_SHEET_NAME}!C${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newStock]] }
    });
  });
}

module.exports = {
  appendOrderRow,
  updateOrderCell,
  getOrdersData,
  invalidateOrdersCache,
  getClientPhone,
  getClientRecord,
  getClientRecordByPhone,
  saveClientPhone,
  saveManualClient,
  registerReferral,
  setClientDiscount,
  setClientDiscountByRow,
  updateClientOrderInfo,
  addBonusBalance,
  spendBonusBalance,
  markReferralBonusPaid,
  getAllClientsWithChatId,
  getAllClients,
  appendFinanceRow,
  getFinanceBalance,
  addInventoryPurchase,
  getChemicals,
  addChemical,
  updateChemicalStock,
  getAuthClient,
  getSubscriptionRecord,
  createPendingSubscription,
  activateSubscription,
  cancelSubscription,
  decrementSubscriptionQuota,
  resetDueSubscriptions,
  getAllActiveSubscriptions
};
