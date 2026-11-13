import test from "node:test";
import assert from "node:assert/strict";
import { habitDueOn, habitStreak } from "./habits.js";
import { nextMilestone, projectProgress } from "./projects.js";

test("habit streaks count due days back from today without breaking on an unfinished today", () => {
  const daily = { cadence: "daily" as const, targetPerDay: 1 };
  const logs = ["2026-10-09", "2026-10-10", "2026-10-11"].map((day) => ({ day, count: 1 }));
  assert.equal(habitStreak(daily, logs, "2026-10-12"), 3, "today not done yet");
  assert.equal(habitStreak(daily, [...logs, { day: "2026-10-12", count: 1 }], "2026-10-12"), 4);
  assert.equal(habitStreak(daily, logs, "2026-10-13"), 0, "yesterday missed");
  assert.equal(habitStreak({ ...daily, targetPerDay: 2 }, logs, "2026-10-12"), 0);
  // Weekdays skip the weekend: Fri 10-09 and Mon 10-12 are consecutive due days.
  const weekdays = { cadence: "weekdays" as const, targetPerDay: 1 };
  assert.equal(habitDueOn(weekdays, "2026-10-11"), false);
  assert.equal(habitStreak(weekdays, [{ day: "2026-10-09", count: 1 }, { day: "2026-10-12", count: 1 }], "2026-10-12"), 2);
  // Weekly: 2 days per ISO week; the current week may still be in progress.
  const weekly = { cadence: "weekly" as const, targetPerDay: 1, timesPerWeek: 2 };
  const weeks = ["2026-09-29", "2026-10-01", "2026-10-06", "2026-10-08"].map((day) => ({ day, count: 1 }));
  assert.equal(habitStreak(weekly, weeks, "2026-10-12"), 2);
});

test("project progress is manual when set, otherwise milestone-based; next milestone is the earliest open one", () => {
  const milestones = [
    { id: "a", title: "設計", done: true },
    { id: "b", title: "實作", done: false, dueDay: "2026-10-20" },
    { id: "c", title: "測試", done: false, dueDay: "2026-10-15" },
    { id: "d", title: "發布", done: false },
  ];
  assert.equal(projectProgress({ milestones }), 25);
  assert.equal(projectProgress({ milestones, progress: 140 }), 100);
  assert.equal(projectProgress({ milestones: [] }), 0);
  assert.equal(nextMilestone({ milestones })?.id, "c");
  assert.equal(nextMilestone({ milestones: [{ id: "x", title: "x", done: false }] })?.id, "x");
  assert.equal(nextMilestone({ milestones: [{ id: "x", title: "x", done: true }] }), undefined);
});
