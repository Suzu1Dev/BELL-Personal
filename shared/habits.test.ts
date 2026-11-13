import test from "node:test";
import assert from "node:assert/strict";
import {
  cadenceText, defaultShort, editableDay, habitDayState, habitStreak, habitSummary, sidebarStreak, todayHabit, weekStartOf,
  AUTO_HABIT_ID, type Habit, type HabitDoneDay, type HabitViewOptions,
} from "./habits.js";
import { addDays, dayKey, type DayKey } from "./time.js";

const TZ = "Asia/Taipei";
const MONDAY = "2026-10-12";

function habit(extra: Partial<Habit> = {}): Habit {
  return { id: "h", name: "閱讀 20 分鐘", cadence: "daily", targetPerDay: 1, archived: false, order: 0, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", ...extra };
}
const logs = (...days: DayKey[]): HabitDoneDay[] => days.map((day) => ({ day, count: 1 }));
const range = (from: number, to: number, base = MONDAY) => Array.from({ length: to - from + 1 }, (_, index) => addDays(base, from + index));
const options = (today: DayKey = MONDAY, extra: Partial<HabitViewOptions> = {}): HabitViewOptions => ({ today, timeZone: TZ, weekStartsMonday: true, createdDay: "2026-07-01", ...extra });

test("weeks start on Monday by default and on Sunday when the setting is off", () => {
  assert.equal(weekStartOf("2026-10-12"), "2026-10-12"); // Monday
  assert.equal(weekStartOf("2026-10-18"), "2026-10-12"); // Sunday belongs to the week before
  assert.equal(weekStartOf("2026-10-18", false), "2026-10-18");
  assert.equal(weekStartOf("2026-10-14", false), "2026-10-11");
});

test("a daily streak counts back from today, a missed yesterday breaks it, an unfinished today does not", () => {
  const read = habit();
  assert.equal(habitStreak(read, logs(...range(-11, 0)), MONDAY), 12);
  assert.equal(habitStreak(read, logs(...range(-27, -1)), MONDAY), 27, "today not done yet");
  assert.equal(habitStreak(read, logs(...range(-27, -2)), MONDAY), 0, "yesterday missed");
});

test("the local day decides which day a check-in counts for, across the UTC midnight", () => {
  // 00:30 in Taipei on 10/13 is still 10/12 in UTC: the check-in is a 10/13 one.
  const at = "2026-10-12T16:30:00.000Z";
  assert.equal(dayKey(TZ, at), "2026-10-13");
  const read = habit();
  const done = [...logs(...range(-3, 0)), { day: dayKey(TZ, at), count: 1, at }];
  assert.equal(habitStreak(read, done, "2026-10-13"), 5);
  // The UTC date would have broken nothing but would double-count 10/12; the local key keeps it one per day.
  assert.equal(habitStreak(read, [...done, { day: "2026-10-12", count: 1 }], "2026-10-13"), 5);
  // A zone behind UTC: 23:30 on 10/12 in New York is already 10/13 in UTC.
  assert.equal(dayKey("America/New_York", "2026-10-13T03:30:00.000Z"), "2026-10-12");
});

test("weekly quotas count completed weeks; the running week never breaks the streak", () => {
  const move = habit({ cadence: "weekly", timesPerWeek: 3 });
  // Tue/Thu/Sat of the four weeks before this one (the demo data).
  const done = [1, 2, 3, 4].flatMap((week) => [1, 3, 5].map((weekday) => addDays(MONDAY, -7 * week + weekday)));
  assert.equal(habitStreak(move, logs(...done), MONDAY), 4);
  assert.equal(habitStreak(move, logs(...done, MONDAY, "2026-10-13", "2026-10-14"), "2026-10-14"), 5, "this week's goal met counts");
  assert.equal(habitStreak(move, logs(...done.slice(3)), MONDAY), 0, "last week fell short (2 of 3)");
  // Sunday-start weeks group the same days differently: Sun 10/11 opens a new week.
  const sundayWeek = logs("2026-10-05", "2026-10-07", "2026-10-11");
  assert.equal(habitStreak(move, sundayWeek, "2026-10-12", 3660, true), 1, "Monday weeks: 10/5–10/11 holds all three");
  assert.equal(habitStreak(move, sundayWeek, "2026-10-12", 3660, false), 0, "Sunday weeks: 2 in 10/4–10/10, 1 in the running week");
  assert.equal(habitStreak(move, logs("2026-10-04", "2026-10-05", "2026-10-07"), "2026-10-12", 3660, false), 1, "Sunday weeks: 10/4–10/10 met");
});

test("weekday habits skip weekends; weekly days without a check-in rest unless their week fell short", () => {
  const weekdays = habit({ cadence: "weekdays" });
  const sunday = "2026-10-11";
  assert.equal(habitDayState(weekdays, sunday, new Set(), options()), "rest");
  assert.equal(habitDayState(weekdays, "2026-10-09", new Set(), options()), "n");

  const move = habit({ cadence: "weekly", timesPerWeek: 3 });
  const done = new Set(["2026-10-06", "2026-10-08", "2026-10-10"]); // last week met
  assert.equal(habitDayState(move, "2026-10-07", done, options()), "rest");
  assert.equal(habitDayState(move, "2026-10-06", done, options()), "y");
  assert.equal(habitDayState(move, MONDAY, done, options()), "n", "today without a check-in is open");
  assert.equal(habitDayState(move, "2026-09-30", done, options()), "n", "a week that fell short shows misses");
  assert.equal(habitDayState(move, "2026-10-13", done, options()), "off", "the future");
  assert.equal(habitDayState(move, "2026-10-14", new Set(["2026-10-13"]), options("2026-10-15")), "rest", "earlier days of the running week");
  assert.equal(habitDayState(habit(), "2026-06-30", new Set(), options()), "off", "before the habit existed");
});

test("the summary carries the Today shape: week strip, cadence line, streak unit and due", () => {
  const read = habitSummary(habit({ short: "閱讀" }), [...logs(...range(-11, -1)), { day: MONDAY, count: 1, at: "2026-10-11T23:50:00.000Z" }], options());
  assert.deepEqual(read.week, ["y", "y", "y", "y", "y", "y", "y"]);
  assert.equal(read.cadence, "今天 07:50 完成");
  assert.equal(read.streak, 12);
  assert.equal(read.streakUnit, "天");
  assert.equal(read.doneToday, true);
  assert.equal(read.checkedAt, "2026-10-11T23:50:00.000Z");
  assert.deepEqual(Object.keys(todayHabit(read)).sort(), ["cadence", "doneToday", "due", "id", "name", "short", "streak", "streakUnit", "week"]);

  const done = [1, 2, 3, 4].flatMap((week) => [1, 3, 5].map((weekday) => addDays(MONDAY, -7 * week + weekday)));
  const move = habitSummary(habit({ id: "move", name: "運動", cadence: "weekly", timesPerWeek: 3 }), logs(...done), options());
  assert.deepEqual(move.week, ["y", "rest", "y", "rest", "y", "rest", "n"]);
  assert.equal(move.cadence, "每週 3 次 · 0/3");
  assert.equal(move.streakUnit, "週");
  assert.equal(move.streak, 4);
  assert.equal(move.due, true);
  assert.equal(move.short, "運動");

  const diary = habitSummary(habit({ id: "diary", name: "寫日記", hint: "睡前" }), logs(...range(-27, -1)), options());
  assert.equal(diary.cadence, "每天 · 睡前");
  assert.equal(diary.short, "寫日記");
  assert.deepEqual(diary.week, ["y", "y", "y", "y", "y", "y", "n"]);

  // A weekly goal already met this week: nothing is expected today.
  const met = habitSummary(habit({ cadence: "weekly", timesPerWeek: 2 }), logs("2026-10-13", "2026-10-14"), options("2026-10-15"));
  assert.equal(met.due, false);
  assert.equal(met.weekDone, 2);
});

test("the heat strip is five whole weeks ending with the current one", () => {
  const summary = habitSummary(habit(), logs(...range(-3, 0, "2026-10-14")), options("2026-10-14"));
  assert.equal(summary.heat.length, 35);
  assert.equal(summary.heat[0].day, "2026-09-14"); // Monday four weeks before the current week
  assert.equal(summary.heat.at(-1)!.day, "2026-10-18");
  assert.equal(summary.heat.find((cell) => cell.day === "2026-10-14")!.state, "y");
  assert.equal(summary.heat.find((cell) => cell.day === "2026-10-15")!.state, "off");
  assert.equal(summary.heat.find((cell) => cell.day === "2026-10-10")!.state, "n");
  const sunday = habitSummary(habit(), [], options("2026-10-14", { weekStartsMonday: false }));
  assert.equal(sunday.heat[0].day, "2026-09-13");
});

test("cadence lines, default chip labels, the sidebar streak and editable days", () => {
  assert.equal(cadenceText(habit({ cadence: "weekdays" }), { doneToday: false, weekDone: 0, timeZone: TZ }), "平日");
  assert.equal(cadenceText(habit(), { doneToday: true, weekDone: 1, timeZone: TZ }), "今天已完成");
  assert.equal(cadenceText(habit({ id: AUTO_HABIT_ID }), { doneToday: true, weekDone: 1, timeZone: TZ }), "今天已有 GitHub 貢獻");
  assert.equal(cadenceText(habit({ id: AUTO_HABIT_ID }), { doneToday: false, weekDone: 0, timeZone: TZ }), "每天 · GitHub 自動打卡");
  assert.equal(defaultShort("閱讀 20 分鐘"), "閱讀");
  assert.equal(defaultShort("每天喝八杯水"), "每天喝八");
  assert.equal(defaultShort("跑 5 公里"), "跑5公里");
  assert.equal(defaultShort("Gym"), "Gym");

  const base = (streak: number, extra: Partial<ReturnType<typeof habitSummary>> = {}) => ({ ...habitSummary(habit(), [], options()), streak, ...extra });
  assert.equal(sidebarStreak([base(12), base(27), base(4, { cadenceKind: "weekly" }), base(0, { auto: true })]), 12);
  assert.equal(sidebarStreak([base(4, { cadenceKind: "weekly" })]), undefined);

  assert.equal(editableDay(MONDAY, MONDAY), true);
  assert.equal(editableDay("2026-10-13", MONDAY), false, "the future");
  assert.equal(editableDay(addDays(MONDAY, -34), MONDAY), true);
  assert.equal(editableDay(addDays(MONDAY, -35), MONDAY), false);
});
