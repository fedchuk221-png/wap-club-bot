const { google } = require("googleapis");
const sheetsApi = require("./sheets");

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "";
const WORK_START = parseInt(process.env.WORK_HOURS_START || "9", 10);
const WORK_END = parseInt(process.env.WORK_HOURS_END || "18", 10);
const SLOT_MINUTES = parseInt(process.env.SLOT_DURATION_MIN || "120", 10);
const MAX_DAYS_AHEAD = parseInt(process.env.CALENDAR_DAYS_AHEAD || "30", 10);
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

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Нд, 1=Пн, ...
  const diff = (day === 0 ? -6 : 1) - day; // зсув до понеділка
  d.setDate(d.getDate() + diff);
  return d;
}

// 7 дат (Пн-Нд) для тижня зі зсувом weekOffset відносно поточного тижня.
function getWeekDays(weekOffset) {
  const monday = startOfWeek(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    days.push(d);
  }
  return days;
}

function maxBookableDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + MAX_DAYS_AHEAD);
  return d;
}

// Усі робочі слоти конкретного дня — і вільні, і зайняті (busy: true/false),
// щоб показати обидва кольори замість лише вільних часів.
async function getDaySlots(dateISO) {
  if (!isEnabled()) return [];
  try {
    const calendar = await getCalendar();
    const dayStart = new Date(`${dateISO}T00:00:00`);
    const raw = [];
    for (let h = WORK_START; h < WORK_END; h += SLOT_MINUTES / 60) {
      const start = new Date(dayStart);
      start.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
      const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
      raw.push({ start, end });
    }
    if (!raw.length) return [];

    const fb = await calendar.freebusy.query({
      requestBody: {
        timeMin: raw[0].start.toISOString(),
        timeMax: raw[raw.length - 1].end.toISOString(),
        timeZone: TIMEZONE,
        items: [{ id: CALENDAR_ID }]
      }
    });
    const busyRanges = (fb.data.calendars[CALENDAR_ID] && fb.data.calendars[CALENDAR_ID].busy) || [];
    const now = new Date();

    return raw.map((slot) => {
      const past = slot.start <= now;
      const overlapsBusy = busyRanges.some((b) => {
        const bStart = new Date(b.start);
        const bEnd = new Date(b.end);
        return slot.start < bEnd && slot.end > bStart;
      });
      const hh = String(slot.start.getHours()).padStart(2, "0");
      const mm = String(slot.start.getMinutes()).padStart(2, "0");
      return {
        startISO: slot.start.toISOString(),
        endISO: slot.end.toISOString(),
        label: `${hh}:${mm}`,
        busy: past || overlapsBusy
      };
    });
  } catch (e) {
    console.error("getDaySlots failed:", e.message || e);
    return [];
  }
}

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

// Звільняє слот при скасуванні заявки — щоб час знову став доступний іншим клієнтам.
async function deleteEvent(eventId) {
  if (!isEnabled() || !eventId) return false;
  try {
    const calendar = await getCalendar();
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
    return true;
  } catch (e) {
    // Подія могла бути вже видалена вручну — це не критична помилка.
    console.error("deleteEvent failed:", e.message || e);
    return false;
  }
}

module.exports = { isEnabled, getWeekDays, maxBookableDate, getDaySlots, bookSlot, deleteEvent, MAX_DAYS_AHEAD };
