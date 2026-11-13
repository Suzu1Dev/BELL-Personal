import assert from "node:assert/strict";
import test from "node:test";
import { REPEAT_LIMITS, type CalendarResponse, type ManualEvent } from "../../../shared/calendar.js";
import type { CaptureResponse } from "../../../shared/connect.js";
import type { TodayPayload } from "../../../shared/today.js";
import type { FeatureModule } from "../../modules.js";
import type { CoreServices } from "../../services.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { captureModule } from "../capture/index.js";
import { ideasModule } from "../ideas/index.js";
import { todosModule } from "../todos/index.js";
import { collectItems } from "./agenda.js";
import { calendarModule } from "./index.js";
import { isOccurrenceDay, weeklyOccurrences } from "./repeat.js";
import { calendarService } from "./store.js";
import { connectGoogle, fakeNetwork, taipei } from "./testing.js";

const TZ = "Asia/Taipei";
const STAMP = "2026-09-01T00:00:00.000Z";
/** Monday 2026-10-12 08:42 in Taipei. */
const NOW = new Date(taipei("2026-10-12T08:42"));

/* ------------------------------------------------------------------ expansion (pure) */

const series = (extra: Partial<ManualEvent> & Pick<ManualEvent, "start">): ManualEvent => ({
  id: "s1", title: "作業系統", allDay: false, repeat: { freq: "weekly" }, createdAt: STAMP, updatedAt: STAMP, ...extra,
});
const span = (from: string, to: string) => [Date.parse(taipei(from)), Date.parse(taipei(to))] as const;
const daysIn = (event: ManualEvent, from: string, to: string, limit = 100) => weeklyOccurrences(event, ...span(from, to), TZ, limit).occurrences.map((occurrence) => occurrence.day);

test("a series that began months ago has its occurrences in a later window, at the same wall-clock time", () => {
  const os = series({ start: taipei("2026-03-02T10:10"), end: taipei("2026-03-02T12:00") }); // a Monday
  assert.deepEqual(weeklyOccurrences(os, ...span("2026-10-19T00:00", "2026-10-26T00:00"), TZ, 100).occurrences, [
    { day: "2026-10-19", start: taipei("2026-10-19T10:10"), end: taipei("2026-10-19T12:00") },
  ]);
  assert.deepEqual(daysIn(os, "2026-10-05T00:00", "2026-11-02T00:00"), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.deepEqual(daysIn(os, "2026-03-02T00:00", "2026-03-03T00:00"), ["2026-03-02"], "the first occurrence itself");
  assert.deepEqual(daysIn(os, "2026-02-23T00:00", "2026-03-02T00:00"), [], "nothing before it started");
  assert.deepEqual(daysIn(os, "2026-10-19T11:00", "2026-10-19T11:30"), ["2026-10-19"], "a window inside a class still has it");
  assert.deepEqual(daysIn(os, "2026-10-19T12:00", "2026-10-19T13:00"), [], "…but not once it ended");
});

test("until is inclusive, skipped days do not happen, and a stored skip never changes the weekday", () => {
  const term = series({ start: taipei("2026-09-07T10:10"), end: taipei("2026-09-07T12:00"), repeat: { freq: "weekly", until: "2026-10-19", skip: ["2026-10-12"] } });
  assert.deepEqual(daysIn(term, "2026-10-05T00:00", "2026-11-09T00:00"), ["2026-10-05", "2026-10-19"], "10/12 skipped; 10/19 is the last day; 10/26 is past it");
  const early = series({ start: taipei("2026-09-07T10:10"), repeat: { freq: "weekly", until: "2026-10-18" } });
  assert.deepEqual(daysIn(early, "2026-10-05T00:00", "2026-11-09T00:00"), ["2026-10-05", "2026-10-12"], "an until between two weeks ends at the earlier one");
  assert.equal(isOccurrenceDay(term, "2026-10-12", TZ), true, "a skipped day is still one of the series' days");
  assert.equal(isOccurrenceDay(term, "2026-10-13", TZ), false, "another weekday");
  assert.equal(isOccurrenceDay(term, "2026-10-26", TZ), false, "after until");
  assert.equal(isOccurrenceDay(term, "2026-08-31", TZ), false, "before the first day");
  assert.equal(isOccurrenceDay({ start: term.start }, "2026-10-12", TZ), false, "not a series");
});

test("all-day series keep their length in days, and a long occurrence that began before the window is still in it", () => {
  const trip = series({ allDay: true, start: taipei("2026-09-04T00:00"), end: taipei("2026-09-06T00:00") }); // every Friday and Saturday
  assert.deepEqual(weeklyOccurrences(trip, ...span("2026-10-10T00:00", "2026-10-11T00:00"), TZ, 100).occurrences, [
    { day: "2026-10-09", start: taipei("2026-10-09T00:00"), end: taipei("2026-10-11T00:00") },
  ]);
  assert.deepEqual(daysIn(trip, "2026-10-11T00:00", "2026-10-16T00:00"), [], "Sunday to Thursday is free");
});

test("an occurrence that crosses midnight belongs to the day it starts on", () => {
  const night = series({ start: taipei("2026-10-02T23:00"), end: taipei("2026-10-03T01:00") }); // every Friday 23:00–01:00
  assert.deepEqual(daysIn(night, "2026-10-10T00:00", "2026-10-11T00:00"), ["2026-10-09"], "Saturday holds the tail of Friday's");
  assert.deepEqual(daysIn(night, "2026-10-09T00:00", "2026-10-10T00:00"), ["2026-10-09"]);
  assert.deepEqual(daysIn(night, "2026-10-11T00:00", "2026-10-12T00:00"), []);
});

test("a window or an until that is huge expands at most `limit` weeks", () => {
  const os = series({ start: taipei("2026-03-02T10:10"), end: taipei("2026-03-02T12:00") });
  const capped = weeklyOccurrences(os, ...span("2026-01-01T00:00", "2036-01-01T00:00"), TZ, 10);
  assert.equal(capped.occurrences.length, 10);
  assert.equal(capped.truncated, true);
  assert.equal(weeklyOccurrences(os, ...span("2026-03-01T00:00", "2026-03-20T00:00"), TZ, 10).truncated, false);
  const forever = series({ start: taipei("2026-03-02T10:10"), repeat: { freq: "weekly", until: "9999-12-31" } });
  assert.equal(weeklyOccurrences(forever, ...span("2026-10-19T00:00", "2026-10-26T00:00"), TZ, 10).occurrences.length, 1, "one week of window, one occurrence");
  assert.deepEqual(weeklyOccurrences(os, ...span("2026-10-19T00:00", "2026-10-26T00:00"), TZ, 0), { occurrences: [], truncated: false });
  assert.deepEqual(weeklyOccurrences(os, ...span("2026-10-26T00:00", "2026-10-19T00:00"), TZ, 10), { occurrences: [], truncated: false });
});

test("the wall-clock time holds across a DST change in another zone (the length stays too)", () => {
  const ny = series({ start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:00:00.000Z" }); // Monday 09:00–10:00 EDT
  const starts = weeklyOccurrences(ny, Date.parse("2026-10-26T00:00:00-04:00"), Date.parse("2026-11-10T00:00:00-05:00"), "America/New_York", 10).occurrences;
  assert.deepEqual(starts.map((occurrence) => [occurrence.day, occurrence.start, occurrence.end]), [
    ["2026-10-26", "2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z"],
    ["2026-11-02", "2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z"],
    ["2026-11-09", "2026-11-09T14:00:00.000Z", "2026-11-09T15:00:00.000Z"],
  ]);
});

/* ------------------------------------------------------------------ the calendar module */

function setup(t: test.TestContext, network = fakeNetwork()) {
  const services = testServices(t, { seams: { fetch: network.fetch, now: () => NOW } });
  return { services, network };
}

async function serve(t: test.TestContext, services: CoreServices, modules: FeatureModule[] = [calendarModule]) {
  const server = await startTestServer(t, services, { modules, today: { moduleTimeoutMs: 2_000, commitMs: 60_000 } });
  t.after(() => calendarService(services).dropPending());
  return server;
}

const weekly = (title: string, start: string, end: string, extra: { until?: string; location?: string } = {}) => ({
  title, start: taipei(start), end: taipei(end), ...(extra.location ? { location: extra.location } : {}),
  repeat: { freq: "weekly" as const, ...(extra.until ? { until: extra.until } : {}) },
});

function seedHabit(services: CoreServices) {
  services.db.personal.db.prepare("INSERT INTO habits (id, json, updated_at, archived, sort_order, created_at) VALUES (?, ?, ?, 0, 0, ?)")
    .run("habit-move", JSON.stringify({ id: "habit-move", name: "運動", cadence: "weekly", timesPerWeek: 3, targetPerDay: 1, keywords: ["健身"], archived: false, order: 0, createdAt: STAMP, updatedAt: STAMP }), STAMP, STAMP);
}

test("GET /api/calendar: a class that began weeks ago shows in next week's views, one row (and id) per occurrence", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const os = service.create(weekly("作業系統", "2026-09-07T10:10", "2026-09-07T12:00", { location: "工程三館 EC115" }));
  service.create(weekly("計算機網路", "2026-09-09T09:00", "2026-09-09T10:50", { until: "2026-10-21" }));
  const server = await serve(t, services);

  const week = (await server.call("GET", "/api/calendar?view=week&day=2026-10-19")).json as CalendarResponse;
  const monday = week.days[0];
  assert.equal(monday.day, "2026-10-19");
  const [row] = monday.items;
  assert.deepEqual(
    [row.id, row.title, row.manualId, row.repeat, row.meta, row.sourceLabel, row.inGoogle, row.start, row.end],
    [`manual:${os.id}:2026-10-19`, "作業系統", os.id, { freq: "weekly", day: "2026-10-19", first: "2026-09-07" }, "工程三館 EC115 · 每週一", "本機行程", false, taipei("2026-10-19T10:10"), taipei("2026-10-19T12:00")],
  );
  assert.deepEqual(monday.free.map((slot) => slot.minutes), [190, 660], "the class takes its hours out of the free time");
  assert.deepEqual(week.days[2].items.map((item) => [item.title, item.meta]), [["計算機網路", "每週三"]], "until 10/21 is inclusive");

  const next = (await server.call("GET", "/api/calendar?view=week&day=2026-10-26")).json as CalendarResponse;
  assert.deepEqual(next.days.flatMap((day) => day.items.map((item) => item.id)), [`manual:${os.id}:2026-10-26`], "the ended class is gone, the other one is still there");
  const day = (await server.call("GET", "/api/calendar?view=day&day=2026-11-02")).json as CalendarResponse;
  assert.deepEqual(day.days[0].items.map((item) => item.title), ["作業系統"]);
});

test("series() finds a series however long ago it began, skips ended ones, and between() never returns a series", (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const active = service.create(weekly("作業系統", "2026-03-02T10:10", "2026-03-02T12:00"));
  const ended = service.create(weekly("舊課", "2026-03-02T10:10", "2026-03-02T12:00", { until: "2026-06-15" }));
  const justEnded = service.create(weekly("剛結束", "2026-03-02T10:10", "2026-03-02T12:00", { until: "2026-10-12" }));
  const later = service.create(weekly("下學期", "2027-02-22T10:10", "2027-02-22T12:00"));
  const oneOff = service.create({ title: "讀書會", start: taipei("2026-10-20T19:00"), end: taipei("2026-10-20T20:00") });
  const from = taipei("2026-10-19T00:00");
  const to = taipei("2026-10-26T00:00");
  assert.deepEqual(service.series(from, to).map((event) => event.id).sort(), [active.id, justEnded.id].sort(), "the ended class and the class of next year are not read");
  assert.ok(!service.series(from, to).some((event) => event.id === ended.id || event.id === later.id));
  assert.deepEqual(service.between(taipei("2026-03-01T00:00"), taipei("2026-03-08T00:00")), [], "its first week holds the series row, not an event");
  assert.deepEqual(service.between(from, to).map((event) => event.id), [oneOff.id]);
});

test("Today shows today's class with 每週一, habit-links it, and later.events lists one class, not the whole 課表", async (t) => {
  const { services } = setup(t);
  seedHabit(services);
  const service = calendarService(services);
  service.create(weekly("健身", "2026-09-07T07:00", "2026-09-07T08:00")); // Monday, ended before 08:42
  service.create(weekly("作業系統", "2026-09-07T10:10", "2026-09-07T12:00", { location: "工程三館 EC115" }));
  service.create(weekly("計算機網路", "2026-09-08T09:00", "2026-09-08T10:50")); // Tuesday
  service.create(weekly("專題會議", "2026-09-08T14:00", "2026-09-08T15:00"));
  service.create({ title: "讀書會", start: taipei("2026-10-14T19:00"), end: taipei("2026-10-14T20:00"), origin: "capture" });
  const server = await serve(t, services);
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.deepEqual(today.agenda.items.map((item) => [item.title, item.meta, item.habitLink ?? null, item.past]), [
    ["健身", "每週一", "運動", true],
    ["作業系統", "工程三館 EC115 · 每週一", null, false],
  ], "an ended class still offers 打卡 through its habit link");
  assert.equal(today.agenda.items[0].habitId, "habit-move");
  assert.equal(today.nextUp?.title, "作業系統");
  assert.deepEqual(today.later.events.map((event) => event.title), ["09:00 計算機網路", "19:00 讀書會"], "tomorrow's first class and the one-off event; not 專題會議 nor next week's classes");
});

test("every occurrence of 健身 links its habit, with an id of its own", async (t) => {
  const { services } = setup(t);
  seedHabit(services);
  const gym = calendarService(services).create(weekly("健身", "2026-09-08T19:30", "2026-09-08T20:30"));
  const items = collectItems(services, taipei("2026-10-12T00:00"), taipei("2026-10-26T00:00"));
  assert.deepEqual(items.map((item) => [item.id, item.habitLink, item.habitId]), [
    [`manual:${gym.id}:2026-10-13`, "運動", "habit-move"],
    [`manual:${gym.id}:2026-10-20`, "運動", "habit-move"],
  ]);
});

test("a huge window reads at most REPEAT_LIMITS.occurrencesPerRead occurrences", (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  for (const title of ["A", "B", "C"]) service.create(weekly(title, "2026-09-07T10:10", "2026-09-07T12:00"));
  const items = collectItems(services, taipei("2000-01-01T00:00"), taipei("2060-01-01T00:00"));
  assert.equal(items.length, REPEAT_LIMITS.occurrencesPerRead);
  assert.equal(collectItems(services, taipei("2026-10-12T00:00"), taipei("2026-10-26T00:00")).length, 6, "three classes, two weeks");
});

test("POST /api/calendar/events with repeat: a weekly event that stays in BELL, with Google connected and addToGoogle on", async (t) => {
  const network = fakeNetwork();
  const { services } = setup(t, network);
  await connectGoogle(services);
  const service = calendarService(services);
  const server = await serve(t, services);
  const created = await server.call("POST", "/api/calendar/events", {
    body: { title: "計算機網路", start: taipei("2026-10-14T14:00"), end: taipei("2026-10-14T16:00"), addToGoogle: true, repeat: { freq: "weekly", until: "2026-12-23" } },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.google, "none", "no pending insert, no error");
  assert.equal(created.json.message, "已加入每週行程「計算機網路」· 每週三 14:00");
  assert.deepEqual(created.json.event.repeat, { freq: "weekly", until: "2026-12-23" });
  const id = created.json.event.id as string;
  assert.equal(service.isPending(id), false);
  await service.flush();
  assert.equal(network.google.inserted.length, 0, "nothing reached Google");

  // Not even when asked: the route refuses, and the service ignores a push or a deferral.
  const push = await server.call("POST", `/api/calendar/events/${id}/google`, { body: {} });
  assert.equal(push.status, 409);
  assert.equal(push.json.error, "每週行程只存在 BELL，不會加入 Google 行事曆。");
  assert.equal(await service.pushToGoogle(id, AbortSignal.timeout(1_000)), undefined);
  service.deferPush(id);
  assert.equal(service.isPending(id), false);
  assert.equal(network.google.inserted.length, 0);
  assert.equal(service.get(id)?.googleEventId, undefined);

  const allDay = await server.call("POST", "/api/calendar/events", { body: { title: "社團日", start: "2026-10-16", repeat: { freq: "weekly" } } });
  assert.equal(allDay.status, 201, allDay.text);
  assert.equal(allDay.json.message, "已加入每週行程「社團日」· 每週五");
  assert.deepEqual([allDay.json.event.allDay, allDay.json.event.start, allDay.json.event.end], [true, taipei("2026-10-16T00:00"), taipei("2026-10-17T00:00")]);

  for (const repeat of [{ freq: "daily" }, { freq: "weekly", until: "明天" }, { freq: "weekly", until: "2026-10-13" }, { freq: "weekly", skip: ["2026-10-21"] }, { freq: "weekly", every: 2 }, {}])
    assert.equal((await server.call("POST", "/api/calendar/events", { body: { title: "x", start: taipei("2026-10-14T14:00"), repeat } })).status, 400, JSON.stringify(repeat));
});

test("只刪這一次 skips one occurrence and 復原 brings it back; deleting the series is undone through the trash", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const os = service.create(weekly("作業系統", "2026-10-19T10:10", "2026-10-19T12:00"));
  const oneOff = service.create({ title: "讀書會", start: taipei("2026-10-20T19:00"), end: taipei("2026-10-20T20:00") });
  const server = await serve(t, services);
  const titlesOf = async (day: string) => ((await server.call("GET", `/api/calendar?view=week&day=${day}`)).json as CalendarResponse).days.flatMap((entry) => entry.items.filter((item) => item.manualId === os.id).map((item) => item.id));
  const id = (day: string) => `manual:${os.id}:${day}`;
  assert.deepEqual(await titlesOf("2026-10-26"), [id("2026-10-26")]);

  const skipped = await server.call("POST", `/api/calendar/events/${os.id}/skip`, { body: { day: "2026-10-26" } });
  assert.equal(skipped.status, 200, skipped.text);
  assert.deepEqual(skipped.json, { skipped: "2026-10-26", undoPath: `/api/calendar/events/${os.id}/skip/2026-10-26` });
  assert.deepEqual(await titlesOf("2026-10-26"), [], "that Monday is free");
  assert.deepEqual(await titlesOf("2026-10-19"), [id("2026-10-19")], "the week before is untouched");
  assert.deepEqual(await titlesOf("2026-11-02"), [id("2026-11-02")], "and the week after");
  assert.equal((await server.call("POST", `/api/calendar/events/${os.id}/skip`, { body: { day: "2026-10-26" } })).status, 200, "twice is the same as once");
  assert.deepEqual(service.get(os.id)?.repeat, { freq: "weekly", skip: ["2026-10-26"] });

  for (const [path, body, status] of [
    [`/api/calendar/events/${os.id}/skip`, { day: "2026-10-27" }, 400],
    [`/api/calendar/events/${os.id}/skip`, { day: "2026-10-12" }, 400],
    [`/api/calendar/events/${os.id}/skip`, { day: "明天" }, 400],
    [`/api/calendar/events/${os.id}/skip`, { day: "2026-11-02", extra: 1 }, 400],
    [`/api/calendar/events/${oneOff.id}/skip`, { day: "2026-10-20" }, 400],
    ["/api/calendar/events/missing/skip", { day: "2026-10-26" }, 404],
  ] as const) assert.equal((await server.call("POST", path, { body })).status, status, `${path} ${JSON.stringify(body)}`);

  const undone = await server.call("DELETE", skipped.json.undoPath, { body: {} });
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual(await titlesOf("2026-10-26"), [id("2026-10-26")], "復原 puts the occurrence back");
  assert.deepEqual(service.get(os.id)?.repeat, { freq: "weekly" }, "and the stored skip list is empty again");
  assert.equal((await server.call("DELETE", skipped.json.undoPath, { body: {} })).status, 200, "undoing twice is harmless");

  // 刪除整個每週行程: the standard delete, with the trash token that restores the series, skips included.
  await server.call("POST", `/api/calendar/events/${os.id}/skip`, { body: { day: "2026-11-02" } });
  const removed = await server.call("DELETE", `/api/calendar/events/${os.id}`, { body: {} });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(removed.json.google, false);
  assert.ok(removed.json.undoToken);
  assert.deepEqual(await titlesOf("2026-10-26"), [], "every week is gone");
  assert.deepEqual(await titlesOf("2026-10-19"), []);
  const restored = await server.call("POST", "/api/trash/restore", { body: { token: removed.json.undoToken } });
  assert.equal(restored.status, 200, restored.text);
  assert.deepEqual(await titlesOf("2026-10-26"), [id("2026-10-26")]);
  assert.deepEqual(await titlesOf("2026-11-02"), [], "the skipped Monday stays skipped after the restore");
});

test("capture: 「每週一 10:10 …」 creates a weekly event that never goes to Google; the parse row decides when it names its own start", async (t) => {
  const network = fakeNetwork();
  const { services } = setup(t, network);
  await connectGoogle(services);
  const service = calendarService(services);
  const server = await serve(t, services, [calendarModule, todosModule, ideasModule, captureModule]);

  const created = await server.call("POST", "/api/capture", { body: { text: "每週一 10:10 作業系統 @EC115" } });
  assert.equal(created.status, 201, created.text);
  const response = created.json as CaptureResponse;
  assert.equal(response.type, "event");
  assert.equal(response.message, "已加入每週行程「作業系統」· 每週一 10:10");
  const stored = service.get(response.id)!;
  assert.deepEqual([stored.title, stored.location, stored.start, stored.repeat, stored.origin], ["作業系統", "EC115", taipei("2026-10-12T10:10"), { freq: "weekly" }, "capture"]);
  assert.equal(stored.notes, undefined, "no 「來自 快速記下」 on a row that shows every week");
  assert.equal(service.isPending(response.id), false, "no Google insert is waiting");
  await service.flush();
  assert.equal(network.google.inserted.length, 0);
  assert.equal((await server.call("DELETE", response.undoPath, { body: {} })).status, 200, "復原 deletes the series");
  assert.equal(service.get(response.id), undefined);

  // The 重複 chip was turned off: an explicit start without `repeat` is one event, whatever the text says (and it goes to Google).
  const off = await server.call("POST", "/api/capture", { body: { text: "每週一 10:10 作業系統", type: "event", title: "作業系統", start: taipei("2026-10-12T10:10"), end: taipei("2026-10-12T11:10"), allDay: false } });
  assert.equal(off.status, 201, off.text);
  assert.equal(service.get(off.json.id)?.repeat, undefined);
  assert.equal(service.get(off.json.id)?.notes, "來自 快速記下", "a one-off capture keeps its source note");
  assert.equal(service.isPending(off.json.id), true);

  // Turned on from the chip, with a 直到 day.
  const on = await server.call("POST", "/api/capture", {
    body: { text: "週三 14:00 計算機網路", type: "event", title: "計算機網路", start: taipei("2026-10-14T14:00"), end: taipei("2026-10-14T16:00"), allDay: false, repeat: { freq: "weekly", until: "2026-12-23" } },
  });
  assert.equal(on.status, 201, on.text);
  assert.deepEqual(service.get(on.json.id)?.repeat, { freq: "weekly", until: "2026-12-23" });
  assert.equal(service.isPending(on.json.id), false);

  const before = await server.call("POST", "/api/capture", { body: { text: "x", type: "event", title: "計算機網路", start: taipei("2026-10-14T14:00"), end: taipei("2026-10-14T15:00"), allDay: false, repeat: { freq: "weekly", until: "2026-10-01" } } });
  assert.equal(before.status, 400);
  assert.match(before.json.error, /直到/);
  assert.equal(service.events.count(), 2, "nothing was created by the refused request");
});
