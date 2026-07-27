const { google } = require("googleapis");
const sheetsApi = require("./sheets");

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "";
const WORK_START = parseInt(process.env.WORK_HOURS_START || "9", 10);
const WORK_END = parseInt(process.env.WORK_HOURS_END || "18", 10);
const SLOT_MINUTES = parseInt(process.env.SLOT_DURATION_MIN || "120", 10);
const DAYS_AHEAD = parseInt(process.env.CALENDAR_DAYS_AHEAD || "5", 10);
const TIMEZONE = "Europe/Kyiv";

function isEnabled() {
  return Boolean(CALENDAR_ID);
}

let calendarClientPromise = null;
async function getCalendar() {
  if (calendarClientPromise) return calendarClientPromise;
  calendarClientPromise = (async () => {
    const authClient = await sheetsApi.getAuthClient();
    return google.calendar({ version: "v3", auth: authClient });
  })();
  return calendarClientPromise;
}

const WEEKDAY_UA = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function buildCandidateSlots() {
  const slots = [];
  const now = new Date();
  for (let d = 0; d < DAYS_AHEAD; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() + d);
    for (let h = WORK_START; h < WORK_END; h += SLOT_MINUTES / 60) {
      const start = new Date(day);
      start.setHours(Math.floor(h), (h % 1) * 60, 0, 0);
      if (start <= now) continue; // не пропонуємо час, що вже минув
      const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
      slots.push({ start, end });
    }
  }
  return slots;
}

function formatSlotLabel(start) {
  const weekday = WEEKDAY_UA[start.getDay()];
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");
  return `${weekday}, ${hh}:${mm}`;
}

// Повертає до `limit` вільних слотів (не перетинаються із зайнятими подіями календаря).
async function getAvailableSlots(limit = 8) {
  if (!isEnabled()) return [];
  try {
    const calendar = await getCalendar();
    const candidates = buildCandidateSlots();
    if (!candidates.length) return [];
    const timeMin = candidates[0].start.toISOString();
    const timeMax = candidates[candidates.length - 1].end.toISOString();

    const fb = await calendar.freebusy.query({
      requestBody: { timeMin, timeMax, timeZone: TIMEZONE, items: [{ id: CALENDAR_ID }] }
    });
    const busy = (fb.data.calendars[CALENDAR_ID] && fb.data.calendars[CALENDAR_ID].busy) || [];

    const free = candidates.filter((slot) => {
      return !busy.some((b) => {
        const bStart = new Date(b.start);
        const bEnd = new Date(b.end);
        return slot.start < bEnd && slot.end > bStart; // перетин
      });
    });

    return free.slice(0, limit).map((slot) => ({
      startISO: slot.start.toISOString(),
      endISO: slot.end.toISOString(),
      label: formatSlotLabel(slot.start)
    }));
  } catch (e) {
    console.error("getAvailableSlots failed:", e.message || e);
    return [];
  }
}

// Бронює подію в календарі — назва мастера/послуги в описі.
async function bookSlot(startISO, endISO, summary, description) {
  if (!isEnabled()) return null;
  try {
    const calendar = await getCalendar();
    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary,
        description,
        start: { dateTime: startISO, timeZone: TIMEZONE },
        end: { dateTime: endISO, timeZone: TIMEZONE }
      }
    });
    return res.data.id || null;
  } catch (e) {
    console.error("bookSlot failed:", e.message || e);
    return null;
  }
}

module.exports = { isEnabled, getAvailableSlots, bookSlot };
