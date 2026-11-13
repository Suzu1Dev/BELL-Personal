import test from "node:test";
import assert from "node:assert/strict";
import { habitSummary, type Habit, type HabitsResponse } from "../../../shared/habits";
import { addDays } from "../../../shared/time";
import { mockupToday } from "../../lib/today.fixture";
import {
  emptyHabitForm, flipSummary, formFromSummary, habitBody, habitKey, habitsLeft, heatCellAction, heatFocusTarget, menuOpensUp, moveHabit, parseKeywords,
  replaceSummary, shortDay, toggleTodayHabit, validateHabitForm, weekColumn, weekdayHeads,
} from "./model";

const MONDAY = "2026-10-12";
function summary(extra: Partial<Habit> = {}, days: string[] = []) {
  const habit: Habit = { id: "read", name: "閱讀 20 分鐘", cadence: "daily", targetPerDay: 1, archived: false, order: 0, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", ...extra };
  return habitSummary(habit, days.map((day) => ({ day, count: 1 })), { today: MONDAY, timeZone: "Asia/Taipei", weekStartsMonday: true, createdDay: "2026-07-01" });
}

test("toggling a habit on Today flips its dot and streak and recomputes habitsLeft once", () => {
  const before = mockupToday();
  const checked = toggleTodayHabit(before, "journal", true);
  const journal = checked.habits.find((habit) => habit.id === "journal")!;
  assert.equal(journal.doneToday, true);
  assert.equal(journal.week[6], "y");
  assert.equal(journal.streak, 28);
  assert.equal(checked.counts.habitsLeft, 1);
  assert.equal(toggleTodayHabit(checked, "journal", true), checked, "re-applying to data that already shows it is a no-op");
  assert.equal(before.counts.habitsLeft, 2, "the input is not mutated");

  const unchecked = toggleTodayHabit(before, "read", false);
  assert.deepEqual([unchecked.habits[0].doneToday, unchecked.habits[0].week[6], unchecked.habits[0].streak], [false, "n", 11]);
  assert.equal(unchecked.counts.habitsLeft, 3);
  const weekly = toggleTodayHabit(before, "workout", true).habits[1];
  assert.equal(weekly.streak, 4, "weekly streaks wait for the server");

  // The server's answer replaces the optimistic guess.
  const server = { ...before.habits[2], doneToday: true, cadence: "今天 22:10 完成", streak: 28, week: before.habits[2].week.map(() => "y" as const) };
  assert.equal(toggleTodayHabit(before, "journal", true, server).habits[2].cadence, "今天 22:10 完成");
  assert.equal(toggleTodayHabit(before, "missing", true), before);
  assert.equal(habitsLeft([{ ...before.habits[1], due: false }]), 0, "a weekly goal already met is not left");
});

test("page rows flip today's heat cell and the week count", () => {
  const move = summary({ id: "move", name: "運動", cadence: "weekly", timesPerWeek: 3 }, [addDays(MONDAY, -6)]);
  const checked = flipSummary(move, true);
  assert.equal(checked.heat.find((cell) => cell.day === MONDAY)?.state, "y");
  assert.equal(checked.weekDone, 1);
  assert.equal(checked.doneToday, true);
  assert.equal(flipSummary(checked, true), checked);
  assert.equal(flipSummary(checked, false).heat.find((cell) => cell.day === MONDAY)?.state, "n");
});

test("server answers replace rows and move them between active and archived", () => {
  const read = summary();
  const move = summary({ id: "move", name: "運動" });
  const data: HabitsResponse = { day: MONDAY, weekStartsMonday: true, githubAuto: false, githubDays: 0, habits: [read, move], archived: [] };
  const renamed = replaceSummary(data, { ...read, name: "閱讀" });
  assert.deepEqual(renamed.habits.map((item) => item.name), ["閱讀", "運動"]);
  const archived = replaceSummary(data, { ...move, archived: true });
  assert.deepEqual([archived.habits.map((item) => item.id), archived.archived.map((item) => item.id)], [["read"], ["move"]]);
  const restored = replaceSummary(archived, { ...move, archived: false });
  assert.deepEqual([restored.habits.map((item) => item.id), restored.archived.length], [["read", "move"], 0]);
});

test("ordering, keys and weekday columns", () => {
  assert.deepEqual(moveHabit(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveHabit(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.equal(moveHabit(["a", "b"], "a", -1), undefined);
  assert.equal(moveHabit(["a", "b"], "b", 1), undefined);
  assert.equal(habitKey(0), 1);
  assert.equal(habitKey(8), 9);
  assert.equal(habitKey(9), undefined);
  assert.deepEqual(weekdayHeads(true), ["一", "二", "三", "四", "五", "六", "日"]);
  assert.deepEqual(weekdayHeads(false), ["日", "一", "二", "三", "四", "五", "六"]);
  assert.equal(weekColumn(MONDAY, true), 0);
  assert.equal(weekColumn("2026-10-18", true), 6);
  assert.equal(weekColumn("2026-10-18", false), 0);
});

test("the habit form validates the name and the 2–4 character label and builds the body", () => {
  assert.deepEqual(validateHabitForm(emptyHabitForm()), { name: "required" });
  assert.deepEqual(validateHabitForm({ ...emptyHabitForm(), name: "冥想", short: "冥" }), { short: "length" });
  assert.deepEqual(validateHabitForm({ ...emptyHabitForm(), name: "冥想", short: "早上冥想" }), {});
  assert.deepEqual(parseKeywords(" 健身、跑步, 重訓，健身 "), ["健身", "跑步", "重訓"]);
  assert.deepEqual(habitBody({ ...emptyHabitForm(), name: " 運動 ", cadence: "weekly", timesPerWeek: 3, keywords: "健身 跑步" }), {
    name: "運動", cadence: "weekly", timesPerWeek: 3, short: "", hint: "", keywords: ["健身", "跑步"],
  });
  assert.deepEqual(habitBody({ ...emptyHabitForm(), name: "寫程式", short: "程式", hint: "x" }, true), { name: "寫程式", short: "程式" });

  const form = formFromSummary(summary({ hint: "睡前", keywords: ["健身"] }));
  assert.deepEqual(form, { name: "閱讀 20 分鐘", cadence: "daily", timesPerWeek: 3, short: "", hint: "睡前", keywords: "健身" });
  assert.equal(formFromSummary(summary({ short: "讀書" })).short, "讀書");
});

test("the ⋯ menu opens down while it fits, and up near the bottom edge or the phone quickbar", () => {
  const menu = { menuHeight: 160, viewportHeight: 800 };
  assert.equal(menuOpensUp({ ...menu, buttonTop: 300, buttonBottom: 336 }), false, "room below");
  assert.equal(menuOpensUp({ ...menu, buttonTop: 700, buttonBottom: 736 }), true, "the last row of a long list");
  assert.equal(menuOpensUp({ ...menu, buttonTop: 560, buttonBottom: 596, bottomEdge: 736 }), true, "fits the viewport but the quickbar would cover it");
  assert.equal(menuOpensUp({ ...menu, buttonTop: 560, buttonBottom: 596 }), false, "the same row on a desktop fits");
  assert.equal(menuOpensUp({ menuHeight: 300, viewportHeight: 420, buttonTop: 150, buttonBottom: 186, topEdge: 56 }), false, "a short window: more room below, stay down");
  assert.equal(menuOpensUp({ menuHeight: 300, viewportHeight: 420, buttonTop: 300, buttonBottom: 336, topEdge: 56 }), true, "more room above the button than below");
});

test("a heat cell checks a day in or takes it back; future days, days before the habit, too old days and the automatic habit do nothing", () => {
  const row = summary({}, [addDays(MONDAY, -2)]);
  const cell = (day: string) => row.heat.find((item) => item.day === day)!;
  assert.equal(row.heat[0].day, "2026-09-14", "five weeks, the current one last");
  assert.equal(heatCellAction(cell(MONDAY), MONDAY, false), "check");
  assert.equal(heatCellAction(cell(addDays(MONDAY, -2)), MONDAY, false), "uncheck");
  assert.equal(heatCellAction(cell(addDays(MONDAY, 1)), MONDAY, false), undefined, "tomorrow is off");
  assert.equal(heatCellAction(cell(MONDAY), MONDAY, true), undefined, "the automatic habit is never pressed");
  assert.equal(heatCellAction({ day: addDays(MONDAY, -35), state: "n" }, MONDAY, false), undefined, "the server takes 35 days back at most");
  assert.equal(heatCellAction({ day: addDays(MONDAY, -34), state: "rest" }, MONDAY, false), "check", "a rest day can still be checked in");

  const young: Habit = { id: "new", name: "新的", cadence: "daily", targetPerDay: 1, archived: false, order: 1, createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" };
  const fresh = habitSummary(young, [], { today: MONDAY, timeZone: "Asia/Taipei", weekStartsMonday: true, createdDay: "2026-10-08" });
  const dayBefore = fresh.heat.find((item) => item.day === "2026-10-07")!;
  assert.equal(dayBefore.state, "off");
  assert.equal(heatCellAction(dayBefore, MONDAY, false), undefined, "before the habit existed");
  assert.equal(heatCellAction(fresh.heat.find((item) => item.day === "2026-10-08")!, MONDAY, false), "check", "its first day");
});

test("heat-strip focus: ← → a day, ↑ ↓ a week, Home and End, skipping days that cannot be pressed and stopping at the edges", () => {
  const row = summary();
  const pressable = (item: (typeof row.heat)[number]) => heatCellAction(item, MONDAY, false) !== undefined;
  const move = (from: string, key: string) => heatFocusTarget(row.heat, pressable, from, key);
  assert.equal(move(MONDAY, "ArrowLeft"), addDays(MONDAY, -1));
  assert.equal(move(MONDAY, "ArrowUp"), addDays(MONDAY, -7));
  assert.equal(move(MONDAY, "ArrowRight"), MONDAY, "the rest of this week is in the future: stay");
  assert.equal(move(MONDAY, "ArrowDown"), MONDAY);
  assert.equal(move(addDays(MONDAY, -8), "ArrowDown"), addDays(MONDAY, -1));
  assert.equal(move("2026-09-16", "ArrowUp"), "2026-09-16", "the first week has nothing above it");
  assert.equal(move("2026-09-20", "ArrowRight"), "2026-09-21", "the end of a week runs on into the next");
  assert.equal(move(MONDAY, "Home"), "2026-09-14");
  assert.equal(move("2026-09-14", "End"), MONDAY);
  assert.equal(move(MONDAY, "Enter"), undefined, "other keys are left alone");
  assert.equal(move(MONDAY, "a"), undefined);
  assert.equal(heatFocusTarget(row.heat, () => false, MONDAY, "ArrowLeft"), undefined, "nothing to move to");
  assert.equal(shortDay("2026-11-03"), "11/3");
});
