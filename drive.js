const { google } = require("googleapis");
const { Readable } = require("stream");
const sheetsApi = require("./sheets");

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const BOT_TOKEN = process.env.BOT_TOKEN;

function isEnabled() {
  return Boolean(FOLDER_ID);
}

let driveClientPromise = null;
async function getDrive() {
  if (driveClientPromise) return driveClientPromise;
  driveClientPromise = (async () => {
    const authClient = await sheetsApi.getAuthClient();
    return google.drive({ version: "v3", auth: authClient });
  })();
  return driveClientPromise;
}

// Завантажує фото з Telegram (за file_id) у спільну Drive-папку, відкриває
// перегляд за посиланням і повертає готову формулу =IMAGE(...) для клітинки
// таблиці. Повертає null, якщо модуль вимкнено або щось пішло не так —
// у такому разі виклик-код просто зберігає file_id як і раніше (без картинки).
async function uploadTelegramPhoto(fileId, filename) {
  if (!isEnabled()) return null;
  try {
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileInfo = await fileInfoRes.json();
    if (!fileInfo.ok) {
      console.error("Drive upload: Telegram getFile failed:", fileInfo);
      return null;
    }
    const filePath = fileInfo.result.file_path;

    const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    if (!fileRes.ok) {
      console.error("Drive upload: downloading photo from Telegram failed:", fileRes.status);
      return null;
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    const drive = await getDrive();
    const created = await drive.files.create({
      requestBody: { name: filename, parents: [FOLDER_ID] },
      media: { mimeType: "image/jpeg", body: Readable.from(buffer) },
      fields: "id"
    });
    const driveFileId = created.data.id;

    // Без публічного доступу на перегляд формула IMAGE() у таблиці не зможе
    // завантажити файл — Sheets звертається до посилання анонімно.
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: { role: "reader", type: "anyone" }
    });

    return `=IMAGE("https://drive.google.com/uc?export=view&id=${driveFileId}")`;
  } catch (e) {
    console.error("uploadTelegramPhoto failed:", e.message || e);
    return null;
  }
}

module.exports = { isEnabled, uploadTelegramPhoto };
