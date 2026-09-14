const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_TIMEZONE = "Europe/Moscow";
const MAX_LESSONS = 100;
const formatters = new Map();

export class ScheduleInputError extends Error {
  constructor(message, lineNumber) {
    super(lineNumber ? `Строка ${lineNumber}: ${message}` : message);
    this.name = "ScheduleInputError";
    if (lineNumber) this.lineNumber = lineNumber;
  }
}

const days = new Map([
  ["пн", 1], ["понедельник", 1], ["mon", 1], ["monday", 1], ["1", 1],
  ["вт", 2], ["вторник", 2], ["tue", 2], ["tuesday", 2], ["2", 2],
  ["ср", 3], ["среда", 3], ["wed", 3], ["wednesday", 3], ["3", 3],
  ["чт", 4], ["четверг", 4], ["thu", 4], ["thursday", 4], ["4", 4],
  ["пт", 5], ["пятница", 5], ["fri", 5], ["friday", 5], ["5", 5],
  ["сб", 6], ["суббота", 6], ["sat", 6], ["saturday", 6], ["6", 6],
  ["вс", 7], ["воскресенье", 7], ["sun", 7], ["sunday", 7], ["7", 7],
]);

const weeks = new Map([
  ["all", "all"], ["каждую", "all"], ["каждую неделю", "all"],
  ["все", "all"], ["обе", "all"], ["еженедельно", "all"],
  ["odd", "odd"], ["нечет", "odd"], ["нечетная", "odd"],
  ["нечетная неделя", "odd"], ["нечетную", "odd"],
  ["even", "even"], ["чет", "even"], ["четная", "even"],
  ["четная неделя", "even"], ["четную", "even"],
]);

function alias(value) {
  return value.toLowerCase().replaceAll("ё", "е").replace(/\.$/, "");
}

function normalizedField(value, name, maxLength, lineNumber) {
  const field = value.trim().normalize("NFC").replace(/[ \t]+/g, " ");
  if (!field) throw new ScheduleInputError(`поле «${name}» не может быть пустым.`, lineNumber);
  if (field.length > maxLength) {
    throw new ScheduleInputError(`поле «${name}» должно быть не длиннее ${maxLength} символов.`, lineNumber);
  }
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(field)) {
    throw new ScheduleInputError(`поле «${name}» содержит недопустимые управляющие символы.`, lineNumber);
  }
  return field;
}

function lessonIdentity(lesson) {
  return JSON.stringify([
    lesson.day, lesson.time, lesson.subject, lesson.teacher,
    lesson.room, lesson.location, lesson.week,
  ]);
}

export function parseSchedule(text) {
  if (typeof text !== "string") throw new ScheduleInputError("Пришли расписание текстом.");
  if (text.length > 64_000) throw new ScheduleInputError("Расписание слишком длинное: максимум 64 000 символов.");

  const lessons = [];
  const seen = new Set();
  for (const [index, line] of text.split(/\r\n?|\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lineNumber = index + 1;
    if (lessons.length >= MAX_LESSONS) {
      throw new ScheduleInputError(`можно добавить не больше ${MAX_LESSONS} пар.`, lineNumber);
    }
    const columns = line.split("|");
    if (columns.length !== 6 && columns.length !== 7) {
      throw new ScheduleInputError("нужны 6 полей через |: день | время | предмет | преподаватель | кабинет | расположение. Седьмое поле — каждую, нечёт или чёт.", lineNumber);
    }
    const dayText = normalizedField(columns[0], "день", 20, lineNumber);
    const day = days.get(alias(dayText));
    if (!day) throw new ScheduleInputError("неизвестный день. Укажи Пн, Вт, Ср, Чт, Пт, Сб или Вс.", lineNumber);

    const time = normalizedField(columns[1], "время", 5, lineNumber);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new ScheduleInputError("время должно быть в формате ЧЧ:ММ, например 09:00 (от 00:00 до 23:59).", lineNumber);
    }
    const weekText = columns.length === 7 ? normalizedField(columns[6], "неделя", 30, lineNumber) : "all";
    const week = weeks.get(alias(weekText));
    if (!week) throw new ScheduleInputError("неделя должна быть «каждую», «нечёт» или «чёт». Чётность — по номеру недели ISO.", lineNumber);

    const lesson = {
      day,
      time,
      subject: normalizedField(columns[2], "предмет", 120, lineNumber),
      teacher: normalizedField(columns[3], "преподаватель", 120, lineNumber),
      room: normalizedField(columns[4], "кабинет", 80, lineNumber),
      location: normalizedField(columns[5], "расположение", 240, lineNumber),
      week,
    };
    const identity = lessonIdentity(lesson);
    if (seen.has(identity)) throw new ScheduleInputError("эта пара уже есть в расписании; удали повтор.", lineNumber);
    seen.add(identity);
    lessons.push(lesson);
  }
  if (!lessons.length) throw new ScheduleInputError("Расписание пустое. Добавь хотя бы одну пару.");
  return lessons;
}

export function validateTimezone(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) {
    throw new ScheduleInputError("Укажи часовой пояс, например Europe/Moscow.");
  }
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    throw new ScheduleInputError("Неизвестный часовой пояс. Пример: Europe/Moscow.");
  }
}

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    const canonical = validateTimezone(timezone);
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: canonical,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    });
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value);
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function instantParts(date, timezone) {
  const instant = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(instant.getTime())) throw new ScheduleInputError("Некорректные дата и время.");
  const fields = {};
  for (const { type, value } of formatterFor(timezone).formatToParts(instant)) {
    if (type !== "literal") fields[type] = value;
  }
  return {
    date: `${fields.year.padStart(4, "0")}-${fields.month}-${fields.day}`,
    hour: Number(fields.hour), minute: Number(fields.minute), second: Number(fields.second),
  };
}

function parseDate(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new ScheduleInputError("Дата должна быть в формате ГГГГ-ММ-ДД.");
  }
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateString) {
    throw new ScheduleInputError("Такой календарной даты не существует.");
  }
  return date;
}

export function localDateParts(date, timezone = DEFAULT_TIMEZONE) {
  const parts = instantParts(date, timezone);
  return {
    date: parts.date,
    day: parseDate(parts.date).getUTCDay() || 7,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function isoWeekNumber(date) {
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(thursday);
  yearStart.setUTCMonth(0, 1);
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

export function lessonsForDate(lessons, dateString) {
  const date = parseDate(dateString);
  const day = date.getUTCDay() || 7;
  const parity = isoWeekNumber(date) % 2 ? "odd" : "even";
  return lessons
    .filter(lesson => lesson.day === day && (lesson.week === "all" || lesson.week === parity))
    .sort((a, b) => a.time.localeCompare(b.time) || a.subject.localeCompare(b.subject, "ru"));
}

function offsetsForDate(dateString, timezone) {
  const midday = new Date(`${dateString}T12:00:00.000Z`).getTime();
  const offsets = new Set();
  // Probe either side of a possible offset change, including half-hour DST changes.
  for (const shift of [-36 * 60 * MINUTE_MS, 0, 36 * 60 * MINUTE_MS]) {
    const instant = midday + shift;
    const parts = instantParts(instant, timezone);
    const clockAsUtc = parseDate(parts.date).getTime()
      + parts.hour * 60 * MINUTE_MS + parts.minute * MINUTE_MS + parts.second * 1000;
    offsets.add(clockAsUtc - instant);
  }
  return [...offsets];
}

function localStartAt(dateString, time, timezone, offsets) {
  const [hour, minute] = time.split(":").map(Number);
  const clockAsUtc = parseDate(dateString).getTime() + hour * 60 * MINUTE_MS + minute * MINUTE_MS;
  const matches = offsets.map(offset => clockAsUtc - offset).filter(instant => {
    const parts = instantParts(instant, timezone);
    return parts.date === dateString && parts.hour === hour && parts.minute === minute && parts.second === 0;
  });
  // A skipped DST time has no occurrence; a repeated time uses the first occurrence.
  return matches.length ? Math.min(...matches) : null;
}

function reminderKey(lesson, dateString) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(lessonIdentity(lesson))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${dateString}:${hash.toString(16).padStart(16, "0")}`;
}

export function reminderCandidates(lessons, settings = {}, now = new Date()) {
  const timezone = settings.timezone ?? DEFAULT_TIMEZONE;
  const leadMinutes = settings.lead_minutes ?? 15;
  if (!Number.isInteger(leadMinutes) || leadMinutes < 1 || leadMinutes > 120) {
    throw new ScheduleInputError("Напоминание можно установить за целое число минут от 1 до 120.");
  }
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const today = localDateParts(new Date(nowMs), timezone).date;
  const tomorrow = parseDate(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const candidates = [];
  for (const date of [today, tomorrow.toISOString().slice(0, 10)]) {
    const scheduled = lessonsForDate(lessons, date);
    if (!scheduled.length) continue;
    const offsets = offsetsForDate(date, timezone);
    for (const lesson of scheduled) {
      const startAt = localStartAt(date, lesson.time, timezone, offsets);
      if (startAt === null) continue;
      const remaining = startAt - nowMs;
      if (remaining > 0 && remaining <= leadMinutes * MINUTE_MS) {
        candidates.push({
          key: reminderKey(lesson, date), lesson, date, startAt,
          minutesUntil: Math.ceil(remaining / MINUTE_MS),
        });
      }
    }
  }
  return candidates.sort((a, b) => a.startAt - b.startAt || a.key.localeCompare(b.key));
}

export function formatReminder(candidate) {
  const { lesson, minutesUntil } = candidate;
  const lastTwo = minutesUntil % 100;
  const last = minutesUntil % 10;
  const unit = lastTwo >= 11 && lastTwo <= 14 ? "минут"
    : last === 1 ? "минуту" : last >= 2 && last <= 4 ? "минуты" : "минут";
  return [
    `🔔 Пара через ${minutesUntil} ${unit} — в ${lesson.time}`,
    `📚 ${lesson.subject}`,
    `👤 Преподаватель: ${lesson.teacher}`,
    `🚪 Иди в кабинет ${lesson.room}`,
    `📍 ${lesson.location}`,
  ].join("\n");
}
