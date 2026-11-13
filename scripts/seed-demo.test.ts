import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { MailMessage } from "../shared/mail.js";
import { habitStreak } from "../shared/habits.js";
import { openDatabases } from "../server/db/database.js";
import { createServices } from "../server/services.js";
import { SourceItemStore } from "../server/stores/source-items.js";
import { SyncStateStore } from "../server/stores/sync-state.js";
import { startTestServer, tempDir, testConfig } from "../server/test-helpers.js";
import { todayPayloadSchema } from "../server/today/schema.js";
import { defaultSeedNow, parseSeedArgs, seedDemo } from "./seed-demo.js";
import { demoAssignmentMail } from "./seed-demo-assignments.js";
import { seedKit } from "./seed-demo-kit.js";
import { demoArchivedMail } from "./seed-demo-mail.js";

const TZ = "Asia/Taipei";
const MOCKUP_NOW = new Date("2026-10-12T08:42:00+08:00");
/** The mockup's 13 inbox conversations plus each team's additions (SPEC-mail-assignments §13). */
const MAIL_ROWS = 13 + demoArchivedMail(seedKit({ now: MOCKUP_NOW, timeZone: TZ })).length + demoAssignmentMail(seedKit({ now: MOCKUP_NOW, timeZone: TZ })).length;

function habitLogs(db: ReturnType<typeof openDatabases>, habitId: string) {
  return db.personal.db.prepare("SELECT day, count FROM habit_logs WHERE habit_id = ? ORDER BY day").all(habitId).map((row) => ({ day: String(row.day), count: Number(row.count) }));
}

test("the demo seed writes the mockup day relative to --now", (t) => {
  const dir = join(tempDir(t), "data");
  const db = openDatabases(dir);
  t.after(() => db.close());
  const summary = seedDemo(db, { now: MOCKUP_NOW, timeZone: TZ });
  assert.equal(summary.day, "2026-10-12");
  assert.deepEqual(summary.sourceItems, {
    "gmail/mail": MAIL_ROWS, "google-calendar/calendar-event": 4, "moodle/assignment": 3, "github/github-item": 6,
    "github/contribution-day": 60, "ctftime/external-event": 3, "feeds/external-event": 2, "weather/weather": 1,
  });
  const items = new SourceItemStore(db.sources);
  const mails = items.list<MailMessage>({ source: "gmail" }).map((item) => item.value);
  assert.equal(mails.filter((mail) => mail.unread).length, 12, "SPEC §13: inbox unread 12");
  assert.equal(mails.find((mail) => mail.id === "18c2f0a1b2c3d4e5")?.triage?.priority, "high");
  assert.equal(mails.find((mail) => mail.id === "18c2e9d0a1b2c3f6")?.triage?.bill?.dueDay, "2026-10-20");
  assert.equal(items.get("moodle", "30512")?.dueAt, "2026-10-12T15:59:00.000Z", "HW3 due 23:59 Taipei");
  assert.equal(items.list({ source: "google-calendar", window: { field: "startsAt", from: "2026-10-11T16:00:00.000Z", to: "2026-10-12T16:00:00.000Z" } }).length, 3, "three events today");
  assert.equal(items.get("ctftime", "ctftime:2846")?.startsAt, "2026-10-17T00:00:00.000Z");
  assert.deepEqual(new SyncStateStore(db.sources).all().map((row) => [row.source, row.state]).sort(), [
    ["ctftime", "ok"], ["feeds", "ok"], ["github", "ok"], ["gmail", "ok"], ["google-calendar", "ok"], ["moodle", "ok"], ["weather", "ok"],
  ]);
  assert.equal(db.personal.db.prepare("SELECT COUNT(*) AS n FROM todos WHERE status = 'open'").get()!.n, 4, "nav 待辦 4");
  assert.equal(habitStreak({ cadence: "daily", targetPerDay: 1 }, habitLogs(db, "habit-read"), "2026-10-12"), 12);
  assert.equal(habitStreak({ cadence: "weekly", targetPerDay: 1, timesPerWeek: 3 }, habitLogs(db, "habit-move"), "2026-10-12"), 4);
  assert.equal(habitStreak({ cadence: "daily", targetPerDay: 1 }, habitLogs(db, "habit-diary"), "2026-10-12"), 27);
  assert.equal(db.personal.db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE day = '2026-10-12' AND closes = 1").get()!.n, 3);
  assert.equal(JSON.parse(String(db.personal.db.prepare("SELECT json FROM daily_briefs WHERE id = '2026-10-12'").get()!.json)).source, "ai");
  assert.equal(JSON.parse(String(db.settings.db.prepare("SELECT json FROM app_settings WHERE key = 'weather.location'").get()!.json)).name, "新竹");

  // Re-running on another day moves everything instead of duplicating it.
  const later = seedDemo(db, { now: new Date("2026-11-03T08:42:00+08:00"), timeZone: TZ });
  assert.equal(later.day, "2026-11-03");
  assert.equal(items.count("gmail"), MAIL_ROWS);
  assert.equal(db.personal.db.prepare("SELECT COUNT(*) AS n FROM local_assignments").get()!.n, 2, "re-running replaces the native assignments");
  const classes = db.personal.db.prepare("SELECT json FROM manual_events").all().map((row) => JSON.parse(String(row.json)) as { title: string; start: string; repeat?: unknown });
  assert.deepEqual(classes.map((event) => [event.title, event.repeat]), [["機率與統計", { freq: "weekly" }]], "one weekly class (every Thursday, 14:10), not duplicated by the second run");
  assert.equal(classes[0].start, "2026-10-08T06:10:00.000Z", "it moved with --now: the Thursday four weeks before this week's, 14:10 in Taipei");
  assert.equal(items.get("moodle", "30512")?.dueAt, "2026-11-03T15:59:00.000Z");
  assert.equal(db.personal.db.prepare("SELECT COUNT(*) AS n FROM action_log").get()!.n, 3);
  assert.equal(habitStreak({ cadence: "daily", targetPerDay: 1 }, habitLogs(db, "habit-read"), "2026-11-03"), 12);
});

test("seeded data already drives the core parts of GET /api/today", async (t) => {
  const dir = tempDir(t);
  const config = testConfig(dir);
  const db = openDatabases(config.dataDir);
  seedDemo(db, { now: MOCKUP_NOW, timeZone: TZ });
  db.close();
  const services = createServices(config, { now: () => MOCKUP_NOW });
  t.after(() => services.close());
  const server = await startTestServer(t, services);
  const response = await server.call("GET", "/api/today");
  assert.equal(response.status, 200);
  assert.ok(todayPayloadSchema.safeParse(response.json).success);
  const payload = response.json;
  assert.deepEqual(payload.queue[1].items.map((item: { id: string }) => item.id), ["ai:sg-sitcon-autumn", "ai:sg-hw5-os"], "the pending AI suggestions are core rows");
  assert.deepEqual(payload.queue[1].items[0].meta, ["SITCON 秋季交流會", "10/25（日）13:30", "中研院人文館", "來自 KKTIX 報名成功信"]);
  assert.deepEqual([payload.counts.open, payload.counts.handled, payload.counts.total], [2, 3, 5]);
  assert.deepEqual(payload.counts.handledBy, { reply: 1, done: 2, snooze: 0, calendar: 0 });
  assert.equal(payload.handled.length, 3);
});

test("seed arguments: defaults to today 08:42 in the zone; validates --now and --tz", () => {
  assert.equal(defaultSeedNow(TZ, new Date("2026-10-12T20:00:00.000Z")).toISOString(), "2026-10-13T00:42:00.000Z", "already 10/13 in Taipei");
  const parsed = parseSeedArgs(["--data-dir", "/tmp/x", "--now", "2026-10-12T08:42:00+08:00"], {});
  assert.equal(parsed.dataDir, "/tmp/x");
  assert.equal(parsed.now.toISOString(), "2026-10-12T00:42:00.000Z");
  assert.equal(parsed.timeZone, TZ);
  assert.throws(() => parseSeedArgs(["--now", "yesterday"], {}), /ISO/);
  assert.throws(() => parseSeedArgs(["--tz", "Mars/Base"], {}), /IANA/);
  assert.throws(() => parseSeedArgs(["--data-dir"], {}), /需要一個值/);
});
