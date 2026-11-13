import test from "node:test";
import assert from "node:assert/strict";
import type { ContributionDay } from "../../../shared/github.js";
import { AUTO_HABIT_ID, type HabitSummary, type HabitsResponse } from "../../../shared/habits.js";
import { addDays } from "../../../shared/time.js";
import type { TodayPayload } from "../../../shared/today.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { habitKeywordLinks, habitsModule } from "./index.js";

/** Monday 2026-10-12 08:42 in Taipei. */
const MORNING = new Date("2026-10-12T00:42:00.000Z");

async function server(t: test.TestContext, now = MORNING, env: NodeJS.ProcessEnv = {}) {
  let clock = now;
  const services = testServices(t, { env, seams: { now: () => clock } });
  const app = await startTestServer(t, services, { modules: [habitsModule] });
  return { ...app, setNow: (next: Date) => { clock = next; } };
}

const create = async (app: Awaited<ReturnType<typeof server>>, body: Record<string, unknown>) => {
  const response = await app.call("POST", "/api/habits", { body });
  assert.equal(response.status, 201, response.text);
  return response.json as HabitSummary;
};

function seedLogs(app: Awaited<ReturnType<typeof server>>, habitId: string, days: string[]) {
  const insert = app.services.db.personal.db.prepare("INSERT INTO habit_logs (habit_id, day, count, note, created_at, updated_at) VALUES (?, ?, 1, NULL, ?, ?)");
  for (const day of days) insert.run(habitId, day, `${day}T14:00:00.000Z`, `${day}T14:00:00.000Z`);
}

test("habits are created, validated, listed in order, edited and reordered", async (t) => {
  const app = await server(t);
  const read = await create(app, { name: "閱讀 20 分鐘", short: "閱讀" });
  const move = await create(app, { name: "運動", cadence: "weekly", timesPerWeek: 3, keywords: ["健身", "重訓"] });
  const diary = await create(app, { name: "寫日記", hint: "睡前", short: "" });
  assert.equal(read.short, "閱讀");
  assert.equal(read.cadence, "每天");
  assert.equal(move.cadence, "每週 3 次 · 0/3");
  assert.equal(move.streakUnit, "週");
  assert.equal(diary.cadence, "每天 · 睡前");
  assert.equal(diary.short, "寫日記", "no short label → the first word, cut to 4");

  const invalid = [
    [{ name: "" }, /請輸入習慣名稱/],
    [{ name: "冥想", short: "冥" }, /短名稱請用 2–4 個字/],
    [{ name: "冥想", short: "早上冥想十分" }, /短名稱請用 2–4 個字/],
    [{ name: "冥想", cadence: "weekly" }, /一週幾次/],
    [{ name: "冥想", cadence: "weekly", timesPerWeek: 8 }, /每週次數/],
    [{ name: "冥想", color: "red" }, /color|Unrecognized/],
  ] as const;
  for (const [body, message] of invalid) {
    const response = await app.call("POST", "/api/habits", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(response.json.error, message);
  }

  let list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  assert.deepEqual(list.habits.map((habit) => habit.name), ["閱讀 20 分鐘", "運動", "寫日記"]);
  assert.equal(list.day, "2026-10-12");
  assert.equal(list.githubAuto, false);

  const renamed = await app.call("PATCH", `/api/habits/${move.id}`, { body: { name: "運動 30 分鐘", cadence: "daily" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.cadence, "每天");
  assert.equal(renamed.json.timesPerWeek, undefined);
  assert.equal((await app.call("PATCH", `/api/habits/${read.id}`, { body: { cadence: "weekly" } })).status, 400, "weekly needs a count");
  assert.equal((await app.call("PATCH", `/api/habits/${read.id}`, { body: { short: "" } })).json.short, "閱讀", "cleared short falls back to the name");

  const ordered = await app.call("PUT", "/api/habits/order", { body: { ids: [diary.id, read.id] } });
  assert.equal(ordered.status, 200);
  assert.deepEqual((ordered.json as HabitsResponse).habits.map((habit) => habit.id), [diary.id, read.id, move.id]);
  assert.equal((await app.call("PUT", "/api/habits/order", { body: { ids: ["missing"] } })).status, 404);

  const archived = await app.call("PATCH", `/api/habits/${read.id}`, { body: { archived: true } });
  assert.equal(archived.json.archived, true);
  list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  assert.deepEqual(list.habits.map((habit) => habit.id), [diary.id, move.id]);
  assert.deepEqual(list.archived.map((habit) => habit.id), [read.id]);
  await app.call("PATCH", `/api/habits/${read.id}`, { body: { archived: false } });
  list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  assert.deepEqual(list.habits.map((habit) => habit.id), [diary.id, move.id, read.id], "a restored habit goes last");
  await app.call("PATCH", `/api/habits/${move.id}`, { body: { keywords: ["健身", "跑步"] } });
  assert.deepEqual(habitKeywordLinks(app.services), [{ habitId: move.id, name: "運動 30 分鐘", keywords: ["健身", "跑步"] }]);
});

test("check-in and undo write one habit_logs row per local day", async (t) => {
  const app = await server(t);
  const read = await create(app, { name: "閱讀 20 分鐘" });
  seedLogs(app, read.id, Array.from({ length: 11 }, (_, index) => addDays("2026-10-12", index - 11)));

  const checked = await app.call("POST", `/api/habits/${read.id}/check`, { body: {} });
  assert.equal(checked.status, 200);
  assert.equal(checked.json.doneToday, true);
  assert.equal(checked.json.streak, 12);
  assert.equal(checked.json.cadence, "今天 08:42 完成");
  assert.equal(checked.json.checkedAt, MORNING.toISOString());
  // Idempotent: a second check keeps one row and its first time.
  app.setNow(new Date("2026-10-12T01:00:00.000Z"));
  assert.equal((await app.call("POST", `/api/habits/${read.id}/check`, { body: {} })).json.cadence, "今天 08:42 完成");
  const rows = app.services.db.personal.db.prepare("SELECT day, count FROM habit_logs WHERE habit_id = ? AND day = ?").all(read.id, "2026-10-12");
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ day: "2026-10-12", count: 1 }]);

  const unchecked = await app.call("DELETE", `/api/habits/${read.id}/check`, { body: {} });
  assert.equal(unchecked.json.doneToday, false);
  assert.equal(unchecked.json.streak, 11, "today undone does not break the streak");
  assert.equal(unchecked.json.previousAt, MORNING.toISOString(), "the undo needs the original time");
  assert.equal((await app.call("DELETE", `/api/habits/${read.id}/check`, { body: {} })).json.previousAt, undefined, "nothing to remove");
  // The undo toast puts the original time back.
  const restored = await app.call("POST", `/api/habits/${read.id}/check`, { body: { at: MORNING.toISOString() } });
  assert.equal(restored.json.cadence, "今天 08:42 完成");
  assert.equal((await app.call("POST", `/api/habits/${read.id}/check`, { body: { at: "2026-10-10T00:00:00.000Z" } })).status, 400, "time on another day");

  const backfill = await app.call("POST", `/api/habits/${read.id}/check`, { body: { day: "2026-09-20" } });
  assert.equal(backfill.status, 200);
  assert.equal(backfill.json.heat.find((cell: { day: string }) => cell.day === "2026-09-20")?.state, "y");
  assert.equal((await app.call("POST", `/api/habits/${read.id}/check`, { body: { day: "2026-10-13" } })).status, 400, "the future");
  assert.equal((await app.call("POST", `/api/habits/${read.id}/check`, { body: { day: "2026-09-01" } })).status, 400, "beyond the heat strip");
  assert.equal((await app.call("POST", `/api/habits/${read.id}/check`, { body: { day: "10/12" } })).status, 400);
  assert.equal((await app.call("POST", "/api/habits/missing/check", { body: {} })).status, 404);
});

test("the day of a check-in follows BELLPERSONAL_TZ, not the host's UTC date", async (t) => {
  // 00:30 on Tuesday 10/13 in Taipei; still Monday 10/12 in UTC.
  const app = await server(t, new Date("2026-10-12T16:30:00.000Z"));
  const read = await create(app, { name: "閱讀" });
  seedLogs(app, read.id, ["2026-10-10", "2026-10-11", "2026-10-12"]);
  const checked = await app.call("POST", `/api/habits/${read.id}/check`, { body: {} });
  assert.equal(checked.json.cadence, "今天 00:30 完成");
  assert.equal(checked.json.streak, 4);
  const row = app.services.db.personal.db.prepare("SELECT day FROM habit_logs WHERE habit_id = ? ORDER BY day DESC LIMIT 1").get(read.id);
  assert.equal(row?.day, "2026-10-13");

  // New York: 23:30 on Monday 10/12 local is 03:30 UTC on Tuesday.
  const ny = await server(t, new Date("2026-10-13T03:30:00.000Z"), { BELLPERSONAL_TZ: "America/New_York" });
  const run = await create(ny, { name: "跑步" });
  const nyChecked = await ny.call("POST", `/api/habits/${run.id}/check`, { body: {} });
  assert.equal(nyChecked.json.cadence, "今天 23:30 完成");
  assert.equal(ny.services.db.personal.db.prepare("SELECT day FROM habit_logs WHERE habit_id = ?").get(run.id)?.day, "2026-10-12");
});

test("delete moves a habit to the trash and restore brings its history back", async (t) => {
  const app = await server(t);
  const read = await create(app, { name: "閱讀" });
  seedLogs(app, read.id, ["2026-10-10", "2026-10-11"]);
  const deleted = await app.call("DELETE", `/api/habits/${read.id}`, { body: {} });
  assert.equal(deleted.status, 200);
  assert.ok(deleted.json.undoToken);
  assert.equal(((await app.call("GET", "/api/habits")).json as HabitsResponse).habits.length, 0);
  assert.equal((await app.call("DELETE", `/api/habits/${read.id}`, { body: {} })).status, 404);
  const restored = await app.call("POST", "/api/trash/restore", { body: { token: deleted.json.undoToken } });
  assert.equal(restored.status, 200);
  const list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  assert.equal(list.habits[0].streak, 2);
});

test("today() contributes habits, their week strips and the sidebar streak", async (t) => {
  const app = await server(t);
  const read = await create(app, { name: "閱讀 20 分鐘", short: "閱讀" });
  const move = await create(app, { name: "運動", cadence: "weekly", timesPerWeek: 3 });
  const diary = await create(app, { name: "寫日記", short: "日記", hint: "睡前" });
  // The habits were created "today": move their creation back so history counts.
  app.services.db.personal.db.prepare("UPDATE habits SET json = json_set(json, '$.createdAt', '2026-07-01T00:00:00.000Z')").run();
  seedLogs(app, read.id, Array.from({ length: 11 }, (_, index) => addDays("2026-10-12", index - 11)));
  seedLogs(app, diary.id, Array.from({ length: 27 }, (_, index) => addDays("2026-10-12", index - 27)));
  seedLogs(app, move.id, [1, 2, 3, 4].flatMap((week) => [1, 3, 5].map((weekday) => addDays("2026-10-12", -7 * week + weekday))));
  await app.call("POST", `/api/habits/${read.id}/check`, { body: {} });

  const today = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.deepEqual(today.habits.map((habit) => [habit.short, habit.streak, habit.streakUnit, habit.doneToday]), [
    ["閱讀", 12, "天", true], ["運動", 4, "週", false], ["日記", 27, "天", false],
  ]);
  assert.deepEqual(today.habits[1].week, ["y", "rest", "y", "rest", "y", "rest", "n"]);
  assert.equal(today.habits[0].cadence, "今天 08:42 完成");
  assert.equal(today.counts.habitsLeft, 2);
  assert.equal(today.sidebar?.streakDays, 12);

  await app.call("PATCH", `/api/habits/${diary.id}`, { body: { archived: true } });
  const after = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(after.habits.length, 2, "archived habits leave Today");
  assert.equal(after.counts.habitsLeft, 1);
});

test("the automatic GitHub habit follows the contribution calendar and cannot be checked by hand", async (t) => {
  const app = await server(t);
  const days: ContributionDay[] = Array.from({ length: 10 }, (_, index) => ({ date: addDays("2026-10-12", index - 9), count: index === 3 ? 0 : 2 }));
  app.services.sourceItems.replace("github", "contribution-day", days.map((value) => ({ kind: "contribution-day" as const, externalId: value.date, value })));

  let list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  assert.equal(list.habits.length, 0, "off by default");
  assert.equal(list.githubDays, 10);
  app.services.settings.update({ "habits.githubAuto": true });
  list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  const auto = list.habits.find((habit) => habit.id === AUTO_HABIT_ID)!;
  assert.equal(auto.auto, true);
  assert.equal(auto.name, "GitHub 有貢獻");
  assert.equal(auto.doneToday, true);
  assert.equal(auto.streak, 6, "the day with no contribution (10/6) breaks it");
  assert.equal(auto.cadence, "今天已有 GitHub 貢獻");
  assert.equal((await app.call("POST", `/api/habits/${AUTO_HABIT_ID}/check`, { body: {} })).status, 409);
  assert.equal((await app.call("DELETE", `/api/habits/${AUTO_HABIT_ID}`, { body: {} })).status, 400);
  assert.equal((await app.call("PATCH", `/api/habits/${AUTO_HABIT_ID}`, { body: { archived: true } })).status, 400);

  const renamed = await app.call("PATCH", `/api/habits/${AUTO_HABIT_ID}`, { body: { name: "寫程式", short: "程式" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.short, "程式");
  const read = await create(app, { name: "閱讀" });
  list = (await app.call("GET", "/api/habits")).json as HabitsResponse;
  assert.deepEqual(list.habits.map((habit) => habit.id), [read.id, AUTO_HABIT_ID], "the automatic habit stays last until moved");

  const today = (await app.call("GET", "/api/today")).json as TodayPayload;
  assert.ok(today.habits.some((habit) => habit.id === AUTO_HABIT_ID && habit.doneToday));
  assert.equal(today.sidebar?.streakDays, 0, "the automatic habit is not the sidebar streak");

  app.services.settings.update({ "habits.githubAuto": false });
  assert.equal((await app.call("GET", `/api/habits`)).json.habits.length, 1);
  assert.equal((await app.call("POST", `/api/habits/${AUTO_HABIT_ID}/check`, { body: {} })).status, 404);
});

test("at most 30 active habits", async (t) => {
  const app = await server(t);
  for (let index = 0; index < 30; index++) await create(app, { name: `習慣 ${index}` });
  const refused = await app.call("POST", "/api/habits", { body: { name: "再一個" } });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /最多 30 個/);
});
