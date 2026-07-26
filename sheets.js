const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Заказы";
const CLIENTS_SHEET_NAME = process.env.CLIENTS_SHEET_NAME || "Клієнти";
const FINANCE_SHEET_NAME = process.env.FINANCE_SHEET_NAME || "Фінанси";
const CHEMICALS_SHEET_NAME = process.env.CHEMICALS_SHEET_NAME || "Хімія";
const CACHE_TTL_MS = 60 * 1000;

let sheetsClientPromise = null;
let ordersCache = null;
let ordersCacheTime = 0;
let clientsCache = null; // Map(chatId -> {code, name, phone, discount, lastService, photoBefore, photoAfter, rowIndex})
const ensuredSheets = new Set();

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
      range: `${SHEET_NAME}!A:J`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  });
}

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
        range: `${SHEET_NAME}!A2:J`
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
// КЛИЕНТЫ: унікальний код, телефон, знижка, історія фото/послуги
// Стовпці: A Код, B ChatId, C Ім'я, D Телефон, E Знижка(%), F Остання послуга, G Фото До, H Фото Після
// ============================================================
const CLIENTS_HEADERS = ["Код", "ChatId", "Ім'я", "Телефон", "Знижка(%)", "Остання послуга", "Фото До", "Фото Після"];

async function loadClientsCache() {
  await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
  const sheets = await getSheetsClient();
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CLIENTS_SHEET_NAME}!A2:H`
    })
  );
  const map = new Map();
  let maxCode = 0;
  (res.data.values || []).forEach((r, i) => {
    if (!r[1]) return;
    const code = parseInt(r[0], 10) || 0;
    if (code > maxCode) maxCode = code;
    map.set(String(r[1]), {
      code,
      name: r[2] || "",
      phone: r[3] || "",
      discount: parseFloat(r[4]) || 0,
      lastService: r[5] || "",
      photoBefore: r[6] || "",
      photoAfter: r[7] || "",
      rowIndex: i
    });
  });
  clientsCache = { map, maxCode };
  return clientsCache;
}

async function getClientRecord(chatId) {
  try {
    if (!clientsCache) await loadClientsCache();
    return clientsCache.map.get(String(chatId)) || null;
  } catch (e) {
    console.error("getClientRecord failed:", e.message || e);
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
    const sheets = await getSheetsClient();
    const existing = clientsCache.map.get(String(chatId));
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
          range: `${CLIENTS_SHEET_NAME}!A:H`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[newCode, String(chatId), name, phone, 0, "", "", ""]] }
        })
      );
    }
    clientsCache = null;
  } catch (e) {
    console.error("saveClientPhone failed:", e.message || e);
  }
}

async function setClientDiscount(chatId, discountPct) {
  await ensureSheetExists(CLIENTS_SHEET_NAME, CLIENTS_HEADERS);
  if (!clientsCache) await loadClientsCache();
  const existing = clientsCache.map.get(String(chatId));
  if (!existing) return false;
  const sheets = await getSheetsClient();
  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CLIENTS_SHEET_NAME}!E${existing.rowIndex + 2}`,
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
    const existing = clientsCache.map.get(String(chatId));
    if (!existing) return;
    const sheets = await getSheetsClient();
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

// ============================================================
// ХІМІЯ / СКЛАД: авто-списання за послугою + сповіщення про низький залишок
// Стовпці: A Назва, B Одиниця, C Залишок, D Мін. залишок, E Витрата (JSON по кожній послузі)
// ============================================================
const CHEMICALS_HEADERS = ["Назва", "Одиниця", "Залишок", "Мін. залишок", "Витрата (JSON)"];

async function getChemicals() {
  await ensureSheetExists(CHEMICALS_SHEET_NAME, CHEMICALS_HEADERS);
  const sheets = await getSheetsClient();
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
    const sheets = await getSheetsClient();
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
    const sheets = await getSheetsClient();
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
  saveClientPhone,
  setClientDiscount,
  updateClientOrderInfo,
  appendFinanceRow,
  getFinanceBalance,
  getChemicals,
  addChemical,
  updateChemicalStock
};
