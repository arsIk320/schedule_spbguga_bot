import test from "node:test";
import assert from "node:assert/strict";
import {
  ScheduleInputError, parseSchedule, validateTimezone, localDateParts,
  lessonsForDate, reminderCandidates, formatReminder,
} from "../src/schedule.mjs";

const line = "Пн | 09:00 | Математика | Иванов И.И. | 305 | Корпус А, 3 этаж";
const settings = { timezone: "Europe/Moscow", lead_minutes: 15 };
const at = time => new Date(`2026-09-14T${time}Z`);

test("парсер сохраняет поля и принимает пустые строки, комментарии и варианты дней", () => {
  const parsed = parseSchedule(`\n# Осень\n${line}\r\nВторник | 10:30 | Физика | Петров | 12 | Первый этаж | нечёт\nwed | 11:00 | Химия | Сидоров | 1 | Лаборатория | EVEN\n7 | 12:00 | Семинар | Анна | 8 | Корпус Б`);
  assert.deepEqual(parsed[0], {
    day: 1, time: "09:00", subject: "Математика", teacher: "Иванов И.И.",
    room: "305", location: "Корпус А, 3 этаж", week: "all",
  });
  assert.deepEqual(parsed.map(x => [x.day, x.week]), [[1, "all"], [2, "odd"], [3, "even"], [7, "all"]]);
});

test("ошибки содержат реальный номер строки; пустые, лишние и неверные поля отклоняются", () => {
  for (const invalid of [
    line.replace("09:00", "9:00"), line.replace("09:00", "24:00"),
    line.replace("09:00", "12:60"), line.replace("Пн", "Пон"),
    line.replace("Математика", " "), `${line} | sometimes`, `${line} | каждую | лишнее`,
    line.replace("Иванов И.И.", "Иванов\u0000"), line.replace("305", "А".repeat(81)),
    "Пн | 09:00 | Математика",
  ]) {
    assert.throws(() => parseSchedule(`# Комментарий\n\n${invalid}`), error => {
      assert.ok(error instanceof ScheduleInputError);
      assert.equal(error.lineNumber, 3);
      assert.match(error.message, /Строка 3:/);
      return true;
    });
  }
  assert.throws(() => parseSchedule(" # Ничего\n\n"), /пустое/);
  assert.throws(() => parseSchedule(null), ScheduleInputError);
  assert.throws(() => parseSchedule("x".repeat(64_001)), /слишком длинное/);
});

test("повтор нормализованной пары отклоняется, разные недели допустимы; лимит 100 пар", () => {
  assert.throws(() => parseSchedule(`${line}\n${line.replace("Пн", "monday").replace("Математика", " Математика ")} | каждую`), /Строка 2:.*повтор/);
  assert.equal(parseSchedule(`${line} | чёт\n${line} | нечёт`).length, 2);
  const hundred = Array.from({ length: 100 }, (_, i) => line.replace("Математика", `Предмет ${i}`));
  assert.equal(parseSchedule(hundred.join("\n")).length, 100);
  assert.throws(() => parseSchedule([...hundred, line].join("\n")), /Строка 101:.*100/);
});

test("часовой пояс проверяется и локальный день корректен на границе Москвы", () => {
  assert.equal(validateTimezone(" Europe/Moscow "), "Europe/Moscow");
  assert.equal(validateTimezone("UTC"), "UTC");
  assert.throws(() => validateTimezone("Moscow/Unknown"), ScheduleInputError);
  assert.throws(() => validateTimezone(""), ScheduleInputError);
  assert.deepEqual(localDateParts(new Date("2026-09-13T21:00:00Z"), "Europe/Moscow"), {
    date: "2026-09-14", day: 1, hour: 0, minute: 0,
  });
  assert.throws(() => localDateParts(new Date("bad"), "Europe/Moscow"), ScheduleInputError);
});

test("напоминание ровно за 15 минут, повторная минута и опоздавший запуск", () => {
  const lessons = parseSchedule(line);
  assert.equal(reminderCandidates(lessons, settings, at("05:44:59")).length, 0);
  const due = reminderCandidates(lessons, settings, at("05:45:00"));
  assert.equal(due.length, 1);
  assert.equal(due[0].minutesUntil, 15);
  assert.equal(due[0].startAt, at("06:00:00").getTime());
  assert.equal(due[0].date, "2026-09-14");
  const late = reminderCandidates(lessons, settings, at("05:46:59"));
  assert.equal(late.length, 1);
  assert.equal(late[0].minutesUntil, 14);
  assert.equal(late[0].key, due[0].key);
  assert.equal(reminderCandidates(lessons, settings, at("05:59:59"))[0].minutesUntil, 1);
  assert.equal(reminderCandidates(lessons, settings, at("06:00:00")).length, 0);
  assert.equal(reminderCandidates(lessons, settings, at("06:00:01")).length, 0);
});

test("настройка 10 минут задаёт новое окно, некорректный интервал отклоняется", () => {
  const lessons = parseSchedule(line);
  assert.equal(reminderCandidates(lessons, { ...settings, lead_minutes: 10 }, at("05:49:59")).length, 0);
  assert.equal(reminderCandidates(lessons, { ...settings, lead_minutes: 10 }, at("05:50:00"))[0].minutesUntil, 10);
  for (const lead of [0, 121, 1.5, "15", NaN]) {
    assert.throws(() => reminderCandidates(lessons, { ...settings, lead_minutes: lead }, at("05:50:00")), ScheduleInputError);
  }
});

test("напоминание приходит до полуночи в воскресенье о понедельнике", () => {
  const lessons = parseSchedule(line.replace("09:00", "00:05"));
  const due = reminderCandidates(lessons, settings, new Date("2026-09-13T20:50:00Z"));
  assert.equal(due.length, 1);
  assert.equal(due[0].date, "2026-09-14");
  assert.equal(due[0].startAt, new Date("2026-09-13T21:05:00Z").getTime());
  assert.equal(reminderCandidates(parseSchedule(line), settings, new Date("2026-09-13T05:45:00Z")).length, 0);
});

test("чётность ISO учитывает начало года, неделю 53 и понедельник", () => {
  const lessons = parseSchedule([
    "Пт | 10:00 | Нечётная | А | 1 | Б | нечёт",
    "Пт | 09:00 | Чётная | А | 1 | Б | чёт",
    "Пн | 10:00 | Нечётная | А | 1 | Б | odd",
    "Пн | 09:00 | Чётная | А | 1 | Б | even",
    "Пн | 08:00 | Каждую | А | 1 | Б",
  ].join("\n"));
  assert.deepEqual(lessonsForDate(lessons, "2021-01-01").map(x => x.subject), ["Нечётная"]); // 2020-W53
  assert.deepEqual(lessonsForDate(lessons, "2021-01-04").map(x => x.subject), ["Каждую", "Нечётная"]); // 2021-W01
  assert.deepEqual(lessonsForDate(lessons, "2021-01-11").map(x => x.subject), ["Каждую", "Чётная"]);
  assert.deepEqual(lessonsForDate(lessons, "2024-12-30").map(x => x.subject), ["Каждую", "Нечётная"]); // 2025-W01
  assert.throws(() => lessonsForDate(lessons, "2026-02-30"), ScheduleInputError);
  assert.throws(() => lessonsForDate(lessons, "14.09.2026"), ScheduleInputError);
});

test("ключ зависит от пары и даты, сохраняется при перестановке и нормализации строк", () => {
  const other = line.replace("Математика", "Физика").replace("305", "306");
  const first = reminderCandidates(parseSchedule(`${line}\n${other}`), settings, at("05:45:00"));
  const reordered = reminderCandidates(parseSchedule(`${other}\n${line.replace("Пн", "понедельник")} | ALL`), settings, at("05:46:00"));
  assert.deepEqual(first.map(x => x.key), reordered.map(x => x.key));
  assert.equal(new Set(first.map(x => x.key)).size, 2);
  const nextWeek = reminderCandidates(parseSchedule(line), settings, new Date("2026-09-21T05:45:00Z"));
  assert.notEqual(first.find(x => x.lesson.subject === "Математика").key, nextWeek[0].key);
  const changed = reminderCandidates(parseSchedule(line.replace("3 этаж", "4 этаж")), settings, at("05:45:00"));
  assert.notEqual(first.find(x => x.lesson.subject === "Математика").key, changed[0].key);
});

test("DST: несуществующее время пропускается, при повторе используется первое вхождение", () => {
  const lessons = parseSchedule("Вс | 02:30 | Пара | Преподаватель | 1 | Корпус");
  const berlin = { timezone: "Europe/Berlin", lead_minutes: 15 };
  assert.equal(reminderCandidates(lessons, berlin, new Date("2026-03-29T00:20:00Z")).length, 0);
  const first = reminderCandidates(lessons, berlin, new Date("2026-10-25T00:15:00Z"));
  assert.equal(first.length, 1);
  assert.equal(first[0].startAt, new Date("2026-10-25T00:30:00Z").getTime());
  assert.equal(reminderCandidates(lessons, berlin, new Date("2026-10-25T01:15:00Z")).length, 0);
});

test("часовые пояса с неполным часом и текст напоминания", () => {
  const due = reminderCandidates(parseSchedule(line), { timezone: "Asia/Kathmandu", lead_minutes: 15 }, at("03:00:00"));
  assert.equal(due.length, 1);
  assert.equal(due[0].startAt, at("03:15:00").getTime());
  const message = formatReminder(due[0]);
  for (const content of ["15 минут", "09:00", "Математика", "Иванов И.И.", "кабинет 305", "Корпус А, 3 этаж"]) {
    assert.ok(message.includes(content));
  }
  assert.match(formatReminder({ ...due[0], minutesUntil: 1 }), /1 минуту/);
  assert.match(formatReminder({ ...due[0], minutesUntil: 2 }), /2 минуты/);
  assert.match(formatReminder({ ...due[0], minutesUntil: 11 }), /11 минут/);
});
