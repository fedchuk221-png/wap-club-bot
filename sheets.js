const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Заказы";
const CLIENTS_SHEET_NAME = process.env.CLIENTS_SHEET_NAME || "Клієнти";
const FINANCE_SHEET_NAME = process.env.FINANCE_SHEET_NAME || "Фінанси";
const CACHE_TTL_MS = 60 * 1000;

let sheetsClientPromise = null;
let ordersCache = null;
let ordersCacheTime = 0;
let clientsCache = null; // Map(chatId -> {name, phone, rowIndex})
const ensuredSheets = new Set(); // какие вкладки уже точно существуют (проверено за время жизни процесса)

function getSheetsClient() {
  if (sheetsClientPromise) return sheetsClientPromise;
  sheetsClientPromise = (async () => {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n")
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
  })();
  return sheetsClientPromise;
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

// Создаёт вкладку с заголовками, если её ещё нет. Проверяется один раз за
// время жизни процесса (ensuredSheets), дальше не бьёт лишний раз по API.
async function ensureSheetExists(title, headers) {
  if (ensuredSheets.has(title)) return;
  await withRetry(async () => {
    const sheets = await getSheetsClient();
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
// ============================================================
async function appendOrderRow(row) {
  return withRetry(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:H`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  });
}

// rowIndex — 0-based индекс заказа, colIndex — 1-based номер колонки
// (6 = ціна, 7 = статус, 8 = оцінка).
async function updateOrderCell(rowIndex, colIndex, value) {
  return withRetry(async () => {
    const sheets = await getSheetsClient();
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
    const sheets = await getSheetsClient();
    const res = await withRetry(() =>
      sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A2:H`
      })
    );
    const rows = (res.data.values || []).filter((r) => r[0]);
    ordersCache = rows;
    ordersCacheTime = now;
    return rows;
  } catch (e) {
    console.error("getOrdersData failed after retries:", e.message || e);
    return ordersCache || [];
  }
}

// ============================================================
// КЛИЕНТЫ (привязка номера телефона к chat_id)
// ============================================================
async function loadClientsCache() {
  await ensureSheetExists(CLIENTS_SHEET_NAME, ["ChatId", "Ім'я", "Телефон"]);
  const sheets = await getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CLIENTS_SHEET_NAME}!A2:C`
    })
  );
  const map = new Map();
  (res.data.values || []).forEach((r, i) => {
    if (r[0]) map.set(String(r[0]), { name: r[1] || "", phone: r[2] || "", rowIndex: i });
  });
  clientsCache = map;
  return map;
}

async function getClientPhone(chatId) {
  try {
    if (!clientsCache) await loadClientsCache();
    const entry = clientsCache.get(String(chatId));
    return entry ? entry.phone : null;
  } catch (e) {
    console.error("getClientPhone failed:", e.message || e);
    return null;
  }
}

async function saveClientPhone(chatId, name, phone) {
  try {
    await ensureSheetExists(CLIENTS_SHEET_NAME, ["ChatId", "Ім'я", "Телефон"]);
    if (!clientsCache) await loadClientsCache();
    const sheets = await getSheetsClient();
    const existing = clientsCache.get(String(chatId));
    if (existing) {
      await withRetry(() =>
        sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${CLIENTS_SHEET_NAME}!B${existing.rowIndex + 2}:C${existing.rowIndex + 2}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[name, phone]] }
        })
      );
    } else {
      await withRetry(() =>
        sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${CLIENTS_SHEET_NAME}!A:C`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[String(chatId), name, phone]] }
        })
      );
    }
    clientsCache = null; // форс перечитать при следующем обращении
  } catch (e) {
    // Не критично — просто в следующий раз клиенту снова спросят телефон.
    console.error("saveClientPhone failed:", e.message || e);
  }
}

// ============================================================
// ФИНАНСЫ ("карманный бухгалтер" админа)
// ============================================================
async function appendFinanceRow(row) {
  await ensureSheetExists(FINANCE_SHEET_NAME, ["Дата", "Тип", "Сума", "Опис", "Хто вніс"]);
  return withRetry(async () => {
    const sheets = await getSheetsClient();
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
  const sheets = await getSheetsClient();
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

module.exports = {
  appendOrderRow,
  updateOrderCell,
  getOrdersData,
  invalidateOrdersCache,
  getClientPhone,
  saveClientPhone,
  appendFinanceRow,
  getFinanceBalance
};
