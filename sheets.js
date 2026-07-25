const { google } = require("googleapis");

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Заказы";
const CACHE_TTL_MS = 60 * 1000;

let sheetsClientPromise = null;
let ordersCache = null;
let ordersCacheTime = 0;

function getSheetsClient() {
  if (sheetsClientPromise) return sheetsClientPromise;
  sheetsClientPromise = (async () => {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        // Работает и с буквальными \n внутри строки, и с настоящими переносами строк —
        // так что не важно, как именно вы вставили ключ в переменную окружения.
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

// Номер столбца (1-based) -> буква A1-нотации (1 -> A, 27 -> AA и т.д.)
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function appendOrderRow(row) {
  return withRetry(async () => {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  });
}

// rowIndex — 0-based индекс заказа в массиве (как раньше в GAS-версии),
// colIndex — 1-based номер колонки (6 = цена, 7 = статус).
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
        range: `${SHEET_NAME}!A2:G`
      })
    );
    const rows = (res.data.values || []).filter((r) => r[0]);
    ordersCache = rows;
    ordersCacheTime = now;
    return rows;
  } catch (e) {
    console.error("getOrdersData failed after retries:", e.message || e);
    // При временной недоступности Sheets отдаём последний известный кэш,
    // а не пустой список — админка не "обнуляется" из-за одного сбоя сети.
    return ordersCache || [];
  }
}

module.exports = { appendOrderRow, updateOrderCell, getOrdersData, invalidateOrdersCache };
