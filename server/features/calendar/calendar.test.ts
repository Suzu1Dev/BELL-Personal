import test from "node:test";
import assert from "node:assert/strict";
import type { CalendarEvent, CalendarResponse, ManualEvent } from "../../../shared/calendar.js";
import type { QueueCandidate, TodayPayload } from "../../../shared/today.js";
import { queueAction } from "../../../shared/today-format.js";
import { appContext } from "../../app.js";
import type { FeatureModule } from "../../modules.js";
import type { CoreServices } from "../../services.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { eventsModule } from "../events/index.js";
import { freeSlots, habitKeywords, matchHabit } from "./agenda.js";
import { ReconnectRequiredError } from "../../sync.js";
import { AppError } from "../../errors.js";
import { largestFreeSlot } from "../../../shared/today-logic.js";
import { GoogleCalendarSync, googleCalendarError, googleEventBody, googleEventIdFor, insertGoogleEvent, mapGoogleEvent } from "./google.js";
import { captureModule } from "../capture/index.js";
import { ideasModule } from "../ideas/index.js";
import { todosModule } from "../todos/index.js";
import { calendarModule } from "./index.js";
import { calendarService } from "./store.js";
import { connectGoogle, fakeNetwork, taipei } from "./testing.js";

const NOW = new Date(taipei("2026-10-12T08:42"));
const TZ = "Asia/Taipei";

function setup(t: test.TestContext, network = fakeNetwork(), now: () => Date = () => NOW) {
  const services = testServices(t, { seams: { fetch: network.fetch, now } });
  return { services, network };
}

async function serve(t: test.TestContext, services: CoreServices, modules: FeatureModule[] = [calendarModule, eventsModule], commitMs = 60_000) {
  const server = await startTestServer(t, services, { modules, today: { moduleTimeoutMs: 2_000, commitMs } });
  t.after(() => calendarService(services).dropPending());
  return server;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function googleEvent(id: string, start: string, end: string, summary: string, extra: Record<string, unknown> = {}) {
  return { id, status: "confirmed", summary, start: { dateTime: start }, end: { dateTime: end }, htmlLink: `https://calendar.google.com/event?eid=${id}`, updated: "2026-10-10T00:00:00Z", ...extra };
}

/** The mockup day in Google Calendar (SPEC §13). */
function mockupGoogle() {
  return {
    calendars: [
      { id: "suzu1dev@gmail.com", summary: "Suzu", primary: true, selected: true },
      { id: "holidays@group.v.calendar.google.com", summary: "台灣節日", selected: true },
      { id: "hidden@group.calendar.google.com", summary: "Hidden", selected: false },
    ],
    events: {
      "suzu1dev@gmail.com": [
        googleEvent("os", "2026-10-12T10:10:00+08:00", "2026-10-12T12:00:00+08:00", "作業系統", { location: "工程三館 EC115", description: "<p>林志明</p>" }),
        googleEvent("study", "2026-10-12T14:00:00+08:00", "2026-10-12T15:30:00+08:00", "OS 讀書會 · Ch.5", { location: "浩然圖書館 討論室 B" }),
        googleEvent("gym", "2026-10-12T19:30:00+08:00", "2026-10-12T20:30:00+08:00", "健身", { location: "光復校區 體育館" }),
        googleEvent("net", "2026-10-13T09:00:00+08:00", "2026-10-13T10:50:00+08:00", "計算機網路", { location: "工程三館 EC122" }),
        googleEvent("declined", "2026-10-12T16:00:00+08:00", "2026-10-12T17:00:00+08:00", "不去的會", { attendees: [{ self: true, responseStatus: "declined" }] }),
        googleEvent("cancelled", "2026-10-12T16:00:00+08:00", "2026-10-12T17:00:00+08:00", "取消", { status: "cancelled" }),
      ],
      "holidays@group.v.calendar.google.com": [
        { id: "holiday", status: "confirmed", summary: "光復節補假", start: { date: "2026-10-26" }, end: { date: "2026-10-27" } },
      ],
      "hidden@group.calendar.google.com": [googleEvent("nope", "2026-10-12T09:00:00+08:00", "2026-10-12T10:00:00+08:00", "不該出現")],
    },
  };
}

function seedHabits(services: CoreServices) {
  const insert = services.db.personal.db.prepare("INSERT INTO habits (id, json, updated_at, archived, sort_order, created_at) VALUES (?, ?, ?, 0, ?, ?)");
  const stamp = "2026-10-01T00:00:00.000Z";
  insert.run("habit-read", JSON.stringify({ id: "habit-read", name: "閱讀 20 分鐘", cadence: "daily", targetPerDay: 1, archived: false, order: 0, createdAt: stamp, updatedAt: stamp }), stamp, 0, stamp);
  insert.run("habit-move", JSON.stringify({ id: "habit-move", name: "運動", cadence: "weekly", timesPerWeek: 3, targetPerDay: 1, keywords: ["健身", "重訓", "跑步"], archived: false, order: 1, createdAt: stamp, updatedAt: stamp }), stamp, 1, stamp);
}

test("Google Calendar sync: selected calendars, yesterday … +30 days, all-day events in BELLPERSONAL_TZ", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  const source = new GoogleCalendarSync(services);
  assert.equal(await source.configured(), false, "not connected → 尚未設定");
  await connectGoogle(services);
  assert.equal(await source.configured(), true);
  const status = await source.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.equal(status.items, 5);

  const lists = network.requests.filter((request) => request.url.pathname.endsWith("/events"));
  assert.deepEqual(lists.map((request) => decodeURIComponent(request.url.pathname.split("/")[4])), ["suzu1dev@gmail.com", "holidays@group.v.calendar.google.com"], "the unselected calendar is not read");
  const params = lists[0].url.searchParams;
  assert.equal(params.get("timeMin"), "2026-10-10T16:00:00.000Z", "from the start of yesterday in Asia/Taipei");
  assert.equal(params.get("timeMax"), "2026-11-11T16:00:00.000Z", "to the end of today + 30 days");
  assert.equal(params.get("singleEvents"), "true");
  assert.equal(params.get("orderBy"), "startTime");
  assert.ok(lists.every((request) => request.headers.authorization === "Bearer ya29.valid"));

  const rows = services.sourceItems.list<CalendarEvent>({ source: "google-calendar", kind: "calendar-event" });
  const holiday = rows.find((row) => row.value.title === "光復節補假")!;
  assert.deepEqual([holiday.value.allDay, holiday.value.start, holiday.value.end], [true, "2026-10-26", "2026-10-27"]);
  assert.equal(holiday.startsAt, "2026-10-25T16:00:00.000Z", "an all-day event starts at local midnight");
  const os = rows.find((row) => row.value.title === "作業系統")!.value;
  assert.deepEqual([os.id, os.start, os.end, os.location, os.description], ["google:suzu1dev@gmail.com:os", "2026-10-12T02:10:00.000Z", "2026-10-12T04:00:00.000Z", "工程三館 EC115", "林志明"]);
  assert.ok(!rows.some((row) => ["不去的會", "取消", "不該出現"].includes(row.value.title)));

  // A rejected token: 需要重新連線, and the cached rows stay for the stale view.
  network.google.failWith = 401;
  const failed = await source.sync();
  assert.equal(failed.state, "needs_reconnect");
  assert.equal(services.sourceItems.count("google-calendar"), 5);
});

test("mapGoogleEvent and the insert body handle all-day and timed events", () => {
  assert.equal(mapGoogleEvent({ id: "x", start: {}, end: {} }, { id: "c" }, NOW), null);
  const multi = mapGoogleEvent({ id: "trip", summary: "旅行", start: { date: "2026-10-24" }, end: { date: "2026-10-27" } }, { id: "c" }, NOW)!;
  assert.deepEqual([multi.start, multi.end, multi.allDay, multi.title], ["2026-10-24", "2026-10-27", true, "旅行"]);
  const local: ManualEvent = { id: "m", title: "停修申請截止", start: "2026-10-29T16:00:00.000Z", end: "2026-10-30T16:00:00.000Z", allDay: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  assert.deepEqual(googleEventBody(local, TZ), { summary: "停修申請截止", start: { date: "2026-10-30" }, end: { date: "2026-10-31" } });
  const timed: ManualEvent = { ...local, allDay: false, start: "2026-10-25T05:30:00.000Z", end: undefined, location: "中研院", notes: "來自 KKTIX", url: "https://sitcon.org" };
  assert.deepEqual(googleEventBody(timed, TZ), {
    summary: "停修申請截止", location: "中研院", description: "來自 KKTIX\n\nhttps://sitcon.org",
    start: { dateTime: "2026-10-25T05:30:00.000Z", timeZone: TZ }, end: { dateTime: "2026-10-25T06:30:00.000Z", timeZone: TZ },
  });
});

test("free slots: 07:00–23:00 minus timed events, at least 90 minutes, from now on today", () => {
  const event = (start: string, end: string) => ({ start: taipei(start), end: taipei(end), allDay: false, kind: "event" as const });
  const items = [
    event("2026-10-12T10:10", "2026-10-12T12:00"),
    event("2026-10-12T14:00", "2026-10-12T15:30"),
    event("2026-10-12T19:30", "2026-10-12T20:30"),
    { start: taipei("2026-10-12T00:00"), end: taipei("2026-10-13T00:00"), allDay: true, kind: "event" as const },
    { start: taipei("2026-10-12T23:59"), allDay: false, kind: "due" as const },
  ];
  const today = freeSlots(items, "2026-10-12", TZ, NOW);
  assert.deepEqual(today.map((slot) => [slot.start, slot.end, slot.minutes]), [
    [taipei("2026-10-12T12:00"), taipei("2026-10-12T14:00"), 120],
    [taipei("2026-10-12T15:30"), taipei("2026-10-12T19:30"), 240],
    [taipei("2026-10-12T20:30"), taipei("2026-10-12T23:00"), 150],
  ], "08:42–10:10 is only 88 minutes");
  const tomorrow = freeSlots([event("2026-10-13T09:00", "2026-10-13T10:50")], "2026-10-13", TZ, NOW);
  assert.deepEqual(tomorrow.map((slot) => [slot.start, slot.minutes]), [[taipei("2026-10-13T07:00"), 120], [taipei("2026-10-13T10:50"), 730]]);
  assert.deepEqual(freeSlots([], "2026-10-12", TZ, new Date(taipei("2026-10-12T22:00"))), [], "less than 90 minutes left");
  assert.deepEqual(freeSlots([event("2026-10-14T06:00", "2026-10-14T23:30")], "2026-10-14", TZ, NOW), []);
});

test("habit keywords: the habit's own words, built-in synonyms for 運動, else its name", (t) => {
  const { services } = setup(t);
  seedHabits(services);
  const habits = habitKeywords(services);
  assert.equal(matchHabit("健身", habits)?.id, "habit-move");
  assert.equal(matchHabit("晨間跑步", habits)?.name, "運動");
  assert.equal(matchHabit("作業系統", habits), undefined);
  assert.equal(matchHabit("閱讀 20 分鐘 · 共讀", habits)?.id, "habit-read");
});

test("today(): agenda with habit links, nextUp tomorrow, later.events; the core pairs the free slot", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  seedHabits(services);
  await new GoogleCalendarSync(services).sync();
  const gapModule: FeatureModule = {
    name: "lms-stub",
    setup: () => ({
      today: () => ({
        queue: [{ id: "moodle:30512", kind: "assignment", source: "moodle", title: "作業系統 HW3：CPU Scheduling 模擬", meta: ["NYCU E3"], actions: [queueAction("open", { label: "開啟 E3" }), queueAction("submitted"), queueAction("snooze")], hints: { dueAt: taipei("2026-10-12T23:59"), hardDeadline: true } }],
        gapCandidates: [{ itemId: "moodle:30512", label: "適合寫 HW3", dueAt: taipei("2026-10-12T23:59"), estimateMinutes: 180 }],
      }),
    }),
  };
  const server = await serve(t, services, [calendarModule, eventsModule, gapModule]);
  const response = await server.call("GET", "/api/today");
  assert.equal(response.status, 200, response.text);
  const today = response.json as TodayPayload;
  assert.deepEqual(today.agenda.items.map((item) => [item.title, item.meta, item.habitLink ?? null]), [
    ["作業系統", "工程三館 EC115 · 林志明", null],
    ["OS 讀書會 · Ch.5", "浩然圖書館 討論室 B", null],
    ["健身", "光復校區 體育館", "運動"],
  ]);
  assert.equal(today.agenda.items[2].habitId, "habit-move");
  assert.deepEqual(today.agenda.gap && [today.agenda.gap.start, today.agenda.gap.hours, today.agenda.gap.forItemId, today.agenda.gap.label],
    [taipei("2026-10-12T15:30"), 4, "moodle:30512", "適合寫 HW3"]);
  assert.deepEqual(today.nextUp, { start: taipei("2026-10-12T10:10"), title: "作業系統" });
  assert.deepEqual(today.later.events[0], { date: "10/13", label: "明天", title: "09:00 計算機網路", meta: "工程三館 EC122 · Google 行事曆", start: taipei("2026-10-13T09:00") });
  assert.ok(today.later.events.every((event) => event.title !== "光復節補假"), "only the first calendar event from tomorrow on");
  const calendarSource = today.sources.find((source) => source.id === "google-calendar");
  assert.equal(calendarSource?.state, "ok");
  assert.equal(calendarSource?.label, "Google 行事曆");
});

test("加入行事曆 on a mail suggestion: local event now, Google insert after the undo window, revert after", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const server = await serve(t, services, [calendarModule], 60);
  const suggestion = services.suggestions.create({
    kind: "event", title: "SITCON 秋季交流會", origin: "KKTIX 報名成功信",
    payload: { title: "SITCON 秋季交流會", start: taipei("2026-10-25T13:30"), end: taipei("2026-10-25T17:30"), allDay: false, location: "中研院人文館" },
    sourceRef: { source: "gmail", externalId: "18c2d1c0b9a8f7e6", url: "https://mail.google.com/mail/u/0/#inbox/18c2d1c0b9a8f7e6" },
  });
  const itemId = `ai:${suggestion.id}`;

  // Undo inside the window: nothing reaches Google and the local event is gone.
  const first = await server.call("POST", "/api/actions", { body: { itemId, action: "calendar" } });
  assert.equal(first.status, 202, first.text);
  const local = calendarService(services).events.list();
  assert.equal(local.length, 1);
  assert.deepEqual([local[0].title, local[0].origin, local[0].itemId, local[0].location, local[0].notes], ["SITCON 秋季交流會", "suggestion", itemId, "中研院人文館", "來自 KKTIX 報名成功信"]);
  assert.equal(services.suggestions.get(suggestion.id)?.resultId, local[0].id);
  const undo = await server.call("DELETE", `/api/actions/${first.json.actionId}`, { body: {} });
  assert.equal(undo.status, 200, undo.text);
  await wait(120);
  assert.equal(network.google.inserted.length, 0);
  assert.equal(calendarService(services).events.count(), 0);
  assert.equal(services.suggestions.get(suggestion.id)?.status, "pending");

  // Let it commit: one insert on the primary calendar, the Google id remembered.
  const second = await server.call("POST", "/api/actions", { body: { itemId, action: "calendar" } });
  assert.equal(second.status, 202, second.text);
  await wait(200);
  assert.equal(network.google.inserted.length, 1);
  const insert = network.requests.find((request) => request.method === "POST" && request.url.pathname.endsWith("/events"))!;
  assert.equal(insert.url.pathname, "/calendar/v3/calendars/primary/events");
  assert.deepEqual(network.google.inserted[0].start, { dateTime: taipei("2026-10-25T13:30"), timeZone: TZ });
  const stored = calendarService(services).events.list()[0];
  assert.equal(stored.googleEventId, googleEventIdFor(stored.id), "the insert carried the local event's own id");
  const status = await server.call("GET", `/api/actions/${second.json.actionId}`);
  assert.equal(status.json.state, "committed");

  // Undo after the commit deletes the Google copy, then the local event.
  const revert = await server.call("DELETE", `/api/actions/${second.json.actionId}`, { body: {} });
  assert.equal(revert.status, 200, revert.text);
  assert.deepEqual(network.google.deleted, [stored.googleEventId]);
  assert.equal(calendarService(services).events.count(), 0);
});

test("加入行事曆 without Google (or with calendar.addToGoogle off) stays local; a failed insert puts the row back", async (t) => {
  const network = fakeNetwork({ google: { failWith: 503 } });
  const { services } = setup(t, network);
  const server = await serve(t, services, [calendarModule], 40);
  const make = (title: string) => services.suggestions.create({ kind: "event", title, payload: { title, start: taipei("2026-10-25T13:30"), allDay: false } });

  const offline = make("沒有 Google");
  const local = await server.call("POST", "/api/actions", { body: { itemId: `ai:${offline.id}`, action: "calendar" } });
  assert.equal(local.status, 202, local.text);
  await wait(100);
  assert.equal((await server.call("GET", `/api/actions/${local.json.actionId}`)).json.state, "applied", "no remote write at all");
  assert.equal(calendarService(services).events.count(), 1);

  await connectGoogle(services);
  const failing = make("Google 失敗");
  const accepted = await server.call("POST", "/api/actions", { body: { itemId: `ai:${failing.id}`, action: "calendar" } });
  assert.equal(accepted.status, 202);
  await wait(150);
  const status = await server.call("GET", `/api/actions/${accepted.json.actionId}`);
  assert.equal(status.json.state, "failed");
  assert.match(status.json.error, /Google 行事曆/);
  assert.equal(services.suggestions.get(failing.id)?.status, "pending", "the row comes back");
  assert.equal(calendarService(services).events.count(), 1, "the failed event's local copy is removed");

  services.settings.update({ "calendar.addToGoogle": false });
  const off = make("設定關閉");
  const plain = await server.call("POST", "/api/actions", { body: { itemId: `ai:${off.id}`, action: "calendar" } });
  assert.equal((await server.call("GET", `/api/actions/${plain.json.actionId}`)).json.state, "applied");

  const bad = services.suggestions.create({ kind: "event", title: "壞的", payload: { title: "", start: "nope" } });
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: `ai:${bad.id}`, action: "calendar" } })).status, 400);
});

test("POST /api/suggestions/:id/accept for an event inserts into Google right away", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const server = await serve(t, services, [calendarModule]);
  const suggestion = services.suggestions.create({ kind: "event", title: "讀書會", payload: { title: "讀書會", start: "2026-10-20", allDay: true } });
  const accepted = await server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: {} });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.suggestion.status, "accepted");
  assert.equal(accepted.json.result.google, "inserted");
  assert.equal(accepted.json.result.event.googleEventId, googleEventIdFor(accepted.json.result.event.id));
  assert.deepEqual(network.google.inserted[0].start, { date: "2026-10-20" });
  assert.deepEqual(network.google.inserted[0].end, { date: "2026-10-21" });
  assert.deepEqual([accepted.json.result.event.start, accepted.json.result.event.end], ["2026-10-19T16:00:00.000Z", "2026-10-20T16:00:00.000Z"], "local midnights, not UTC");
});

test("排進 a free slot: a time block titled with the row, for any source; refused without times", async (t) => {
  const { services, network } = setup(t, fakeNetwork({ google: mockupGoogle() }));
  await connectGoogle(services);
  services.settings.update({ "calendar.addToGoogle": false });
  const row: QueueCandidate = {
    id: "moodle:30512", kind: "assignment", source: "moodle", title: "作業系統 HW3：CPU Scheduling 模擬", meta: ["NYCU E3"],
    actions: [queueAction("open"), queueAction("submitted"), queueAction("snooze")], url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=30512",
    hints: { dueAt: taipei("2026-10-12T23:59"), hardDeadline: true },
  };
  const lms: FeatureModule = { name: "lms-stub", setup: () => ({ today: () => ({ queue: [row] }) }) };
  const server = await serve(t, services, [calendarModule, lms]);
  assert.equal((await server.call("GET", "/api/today")).status, 200);
  const missing = await server.call("POST", "/api/actions", { body: { itemId: row.id, action: "schedule" } });
  assert.equal(missing.status, 400);
  const scheduled = await server.call("POST", "/api/actions", { body: { itemId: row.id, action: "schedule", params: { start: taipei("2026-10-12T15:30"), end: taipei("2026-10-12T18:30") } } });
  assert.equal(scheduled.status, 202, scheduled.text);
  const [block] = calendarService(services).events.list();
  assert.deepEqual([block.title, block.start, block.end, block.origin, block.itemId], ["作業系統 HW3：CPU Scheduling 模擬", taipei("2026-10-12T15:30"), taipei("2026-10-12T18:30"), "schedule", "moodle:30512"]);
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.ok(today.agenda.items.some((item) => item.title === "作業系統 HW3：CPU Scheduling 模擬"), "the block is on the agenda");
  assert.equal(today.queue.flatMap((group) => group.items).some((item) => item.id === row.id), true, "排進 does not close the row");
  const undo = await server.call("DELETE", `/api/actions/${scheduled.json.actionId}`, { body: {} });
  assert.equal(undo.status, 200, undo.text);
  assert.equal(calendarService(services).events.count(), 0);
  assert.equal(network.google.inserted.length, 0);
});

test("GET /api/calendar: day and week views, deadlines, free slots, a local event and its Google twin shown once", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  seedHabits(services);
  await new GoogleCalendarSync(services).sync();
  services.sourceItems.upsert("moodle", [{
    kind: "assignment", externalId: "30512", dueAt: taipei("2026-10-12T23:59"),
    value: { id: "moodle:30512", origin: "moodle", externalId: "30512", courseName: "作業系統", title: "HW3：CPU Scheduling 模擬", dueAt: taipei("2026-10-12T23:59"), submission: "not-submitted", url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=30512", updatedAt: NOW.toISOString() },
  }]);
  const service = calendarService(services);
  const twin = service.create({ title: "OS 讀書會 · Ch.5", start: taipei("2026-10-12T14:00"), end: taipei("2026-10-12T15:30"), origin: "capture" });
  service.events.put({ ...twin, googleEventId: "study" });
  service.create({ title: "Balsn CTF 2026", start: taipei("2026-10-17T08:00"), end: taipei("2026-10-19T08:00"), origin: "going", itemId: "ctftime:2846", location: "線上" });
  const server = await serve(t, services);

  const day = (await server.call("GET", "/api/calendar")).json as CalendarResponse;
  assert.deepEqual([day.view, day.from, day.to, day.today, day.days.length], ["day", "2026-10-12", "2026-10-12", "2026-10-12", 1]);
  const items = day.days[0].items;
  assert.deepEqual(items.map((item) => [item.title, item.kind, item.origin]), [
    ["作業系統", "event", "google"], ["OS 讀書會 · Ch.5", "event", "google"], ["健身", "event", "google"], ["HW3 截止", "due", "assignment"],
  ]);
  assert.equal(items[1].manualId, twin.id, "the local twin's flags ride on the Google copy");
  assert.equal(items[3].meta, "作業系統 · NYCU E3");
  assert.equal(items[2].habitLink, "運動");
  assert.deepEqual(day.days[0].free.map((slot) => slot.minutes), [120, 240, 150]);
  assert.deepEqual(day.google, { connected: true, canWrite: true });
  assert.deepEqual(day.sources.map((source) => [source.id, source.state]), [["google-calendar", "ok"], ["ics", "off"]]);

  const week = (await server.call("GET", "/api/calendar?view=week&day=2026-10-15")).json as CalendarResponse;
  assert.deepEqual([week.from, week.to, week.days.length], ["2026-10-12", "2026-10-18", 7]);
  const saturday = week.days.find((entry) => entry.day === "2026-10-17")!;
  assert.deepEqual(saturday.items.map((item) => [item.title, item.going, item.sourceLabel]), [["Balsn CTF 2026", true, "本機行程"]]);
  assert.ok(week.days.find((entry) => entry.day === "2026-10-18")!.items.some((item) => item.title === "Balsn CTF 2026"), "a two-day event shows on both days");
  services.settings.update({ weekStartsMonday: false });
  const sundayWeek = (await server.call("GET", "/api/calendar?view=week&day=2026-10-15")).json as CalendarResponse;
  assert.deepEqual([sundayWeek.from, sundayWeek.to], ["2026-10-11", "2026-10-17"]);
  assert.deepEqual(sundayWeek.days[0].free, [], "past days have no free slots");

  assert.equal((await server.call("GET", "/api/calendar?day=2026-13-01")).status, 400);
  assert.equal((await server.call("GET", "/api/calendar?view=month")).status, 200);
  assert.equal((await server.call("GET", "/api/calendar?view=year")).status, 400);
});

test("POST /api/calendar/events: a local event, the Google insert deferred, DELETE cancels or deletes it", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const server = await serve(t, services);
  const created = await server.call("POST", "/api/calendar/events", { body: { title: "跟教授 meeting", start: taipei("2026-10-13T15:00") } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.google, "pending");
  assert.equal(created.json.message, "已加入行程「跟教授 meeting」· 明天 15:00");
  assert.equal(created.json.event.end, taipei("2026-10-13T16:00"), "one hour by default");
  assert.equal(created.json.undoPath, `/api/calendar/events/${created.json.event.id}`);
  const cancelled = await server.call("DELETE", created.json.undoPath, { body: {} });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.google, true);
  assert.ok(cancelled.json.undoToken);
  await calendarService(services).flush();
  assert.equal(network.google.inserted.length, 0, "the insert never left");

  const allDay = await server.call("POST", "/api/calendar/events", { body: { title: "停修申請截止", start: "2026-10-30" } });
  assert.equal(allDay.status, 201, allDay.text);
  assert.deepEqual([allDay.json.event.allDay, allDay.json.event.start, allDay.json.event.end], [true, "2026-10-29T16:00:00.000Z", "2026-10-30T16:00:00.000Z"]);
  await calendarService(services).flush();
  assert.deepEqual(network.google.inserted.map((event) => event.start), [{ date: "2026-10-30" }]);
  const deleted = await server.call("DELETE", allDay.json.undoPath, { body: {} });
  assert.equal(deleted.status, 200);
  assert.deepEqual(network.google.deleted, [googleEventIdFor(allDay.json.event.id)]);
  const restored = await server.call("POST", "/api/trash/restore", { body: { token: deleted.json.undoToken } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(calendarService(services).get(allDay.json.event.id)?.googleEventId, undefined, "the restored copy is local only");

  for (const body of [{ title: "", start: taipei("2026-10-13T15:00") }, { title: "x", start: "明天" }, { title: "x", start: taipei("2026-10-13T15:00"), end: taipei("2026-10-13T14:00") }, { title: "x", start: "2026-10-30", end: "2026-10-29" }, { title: "x", start: taipei("2026-10-13T15:00"), extra: 1 }])
    assert.equal((await server.call("POST", "/api/calendar/events", { body })).status, 400, JSON.stringify(body));
  assert.equal((await server.call("DELETE", "/api/calendar/events/missing", { body: {} })).status, 404);

  services.settings.update({ "calendar.addToGoogle": false });
  const localOnly = await server.call("POST", "/api/calendar/events", { body: { title: "本機", start: taipei("2026-10-14T10:00"), end: taipei("2026-10-14T11:00") } });
  assert.equal(localOnly.json.google, "none");
  const push = await server.call("POST", `/api/calendar/events/${localOnly.json.event.id}/google`, { body: {} });
  assert.equal(push.status, 202);
  assert.equal((await server.call("POST", `/api/calendar/events/${localOnly.json.event.id}/google`, { body: {} })).status, 409);
  const unpush = await server.call("DELETE", push.json.undoPath, { body: {} });
  assert.deepEqual(unpush.json, { removed: true });
  appContext(server.app);
});

test("Calendar 403s: rate and quota limits retry later, scope problems ask to reconnect, other refusals are plain errors", () => {
  const forbidden = (reason?: string, message = "Forbidden") => Object.assign(new Error(message), { status: 403, response: { status: 403, data: { error: { code: 403, errors: reason ? [{ reason }] : [] } } } });
  for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]) {
    const mapped = googleCalendarError(forbidden(reason), false);
    assert.ok(mapped instanceof AppError && !(mapped instanceof ReconnectRequiredError) && mapped.status === 429, reason);
  }
  assert.ok(googleCalendarError(forbidden("insufficientPermissions"), false) instanceof ReconnectRequiredError);
  assert.ok(googleCalendarError(forbidden(undefined, "Request had insufficient authentication scopes."), false) instanceof ReconnectRequiredError);
  assert.ok(googleCalendarError(forbidden(), true) instanceof ReconnectRequiredError, "a 403 that says nothing more still asks to reconnect");
  const other = googleCalendarError(forbidden("forbiddenForNonOrganizer"), true);
  assert.ok(other instanceof AppError && !(other instanceof ReconnectRequiredError) && other.status === 502);
});

test("one throttled shared calendar keeps its cached events; the primary and the rest still sync", async (t) => {
  const google = mockupGoogle();
  const network = fakeNetwork({ google });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const source = new GoogleCalendarSync(services);
  t.after(() => source.close());
  assert.equal((await source.sync()).state, "ok");
  network.google.failCalendar = { "holidays@group.v.calendar.google.com": { status: 403, reason: "rateLimitExceeded" } };
  google.events["suzu1dev@gmail.com"].push(googleEvent("new", "2026-10-12T21:00:00+08:00", "2026-10-12T22:00:00+08:00", "新行程"));
  const status = await source.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  const titles = services.sourceItems.list<CalendarEvent>({ source: "google-calendar", kind: "calendar-event" }).map((row) => row.value.title);
  assert.ok(titles.includes("光復節補假"), "the throttled calendar's events stay");
  assert.ok(titles.includes("新行程"));
  network.google.failCalendar = { "suzu1dev@gmail.com": { status: 403, reason: "rateLimitExceeded" } };
  const primary = await source.sync();
  assert.equal(primary.state, "error", "the primary calendar failing fails the sync, as a retry, not 需要重新連線");
});

test("calendar.events without calendar.readonly: 讀取行事曆 is missing, and the primary calendar still syncs without calendarList", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services, ["email", "openid", "https://www.googleapis.com/auth/calendar.events"]);
  const source = new GoogleCalendarSync(services);
  t.after(() => source.close());
  assert.equal(await source.configured(), true);
  const status = await source.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.equal(network.requests.filter((request) => request.url.pathname.endsWith("/calendarList")).length, 0);
  assert.deepEqual(network.requests.filter((request) => request.url.pathname.endsWith("/events")).map((request) => decodeURIComponent(request.url.pathname.split("/")[4])), ["primary"]);
  const server = await serve(t, services, [calendarModule]);
  const day = (await server.call("GET", "/api/calendar?view=day")).json as CalendarResponse;
  assert.deepEqual(day.google, { connected: true, canWrite: true });
});

test("events.insert sends the local event's own id; a retry after a lost answer reuses (or restores) the first copy", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const id = googleEventIdFor("local-1");
  assert.match(id, /^bell[0-9a-v]{26}$/);
  assert.equal(googleEventIdFor("local-1"), id, "stable");
  assert.notEqual(googleEventIdFor("local-2"), id);
  const event: ManualEvent = { id: "local-1", title: "跟教授 meeting", start: taipei("2026-10-13T15:00"), end: taipei("2026-10-13T16:00"), allDay: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  const signal = new AbortController().signal;
  assert.equal(await insertGoogleEvent(services, event, signal), id);
  assert.equal(network.google.inserted[0].id, id);
  // The first answer was lost (a timeout): the same insert again is a 409, and the existing event is used.
  assert.equal(await insertGoogleEvent(services, event, signal), id);
  assert.equal(Object.keys(network.google.byId).length, 1);
  assert.deepEqual(network.google.updated, []);
  // Deleted from Google (undo), then added again: the cancelled event is restored.
  network.google.byId[id] = { ...network.google.byId[id], status: "cancelled" };
  assert.equal(await insertGoogleEvent(services, event, signal), id);
  assert.deepEqual(network.google.updated, [id]);
  assert.equal(network.google.byId[id].status, "confirmed");
});

test("events shown as free (顯示為有空, TRANSP:TRANSPARENT) do not block free slots or Today's gap", () => {
  const free = mapGoogleEvent(googleEvent("lib", "2026-10-12T13:00:00+08:00", "2026-10-12T18:00:00+08:00", "圖書館開放", { transparency: "transparent" }), { id: "primary" }, NOW)!;
  assert.equal(free.transparent, true);
  assert.equal(mapGoogleEvent(googleEvent("os", "2026-10-12T13:00:00+08:00", "2026-10-12T14:00:00+08:00", "OS"), { id: "primary" }, NOW)!.transparent, undefined);
  const block = { kind: "event" as const, allDay: false, start: taipei("2026-10-12T09:00"), end: taipei("2026-10-12T22:00") };
  assert.deepEqual(freeSlots([{ ...block, transparent: true }], "2026-10-12", TZ, NOW).length, 1, "the all-day reminder leaves the afternoon free");
  assert.deepEqual(freeSlots([block], "2026-10-12", TZ, NOW).filter((slot) => slot.minutes >= 90 && Date.parse(slot.start) < Date.parse(taipei("2026-10-12T22:00"))), []);
  const agenda = [{ ...block, title: "圖書館開放", meta: "", past: false, transparent: true }];
  assert.ok(largestFreeSlot(agenda, NOW, TZ), "Today's gap ignores it too");
  assert.equal(largestFreeSlot([{ ...agenda[0], transparent: false }], NOW, TZ), undefined);
});

test("two concurrent accepts of one event suggestion run the acceptor once", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const server = await serve(t, services, [calendarModule]);
  const suggestion = services.suggestions.create({ kind: "event", title: "讀書會", payload: { title: "讀書會", start: "2026-10-20", allDay: true } });
  const [a, b] = await Promise.all([
    server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: {} }),
    server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: {} }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(calendarService(services).events.count(), 1);
  assert.equal(network.google.inserted.length, 1);
});

test("an accepted suggestion dismissed while the acceptor ran takes its event back", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let inserting!: () => void;
  const started = new Promise<void>((resolve) => { inserting = resolve; });
  const fetch: typeof network.fetch = async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && String(input).includes("/calendar/v3/calendars/primary/events")) { inserting(); await held; }
    return network.fetch(input, init);
  };
  const services = testServices(t, { seams: { fetch, now: () => NOW } });
  await connectGoogle(services);
  const server = await serve(t, services, [calendarModule]);
  const suggestion = services.suggestions.create({ kind: "event", title: "讀書會", payload: { title: "讀書會", start: "2026-10-20", allDay: true } });
  const accepting = server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: {} });
  await started;
  services.suggestions.decide(suggestion.id, "dismissed"); // 略過 on Today while Google is slow
  release();
  const accepted = await accepting;
  assert.equal(accepted.status, 409);
  assert.equal(calendarService(services).events.count(), 0, "the acceptor's local event is removed again");
  assert.equal(network.google.deleted.length, 1, "and its Google copy");
});

test("capture → event waits the undo window like POST /api/calendar/events, and its record is never a Today row", async (t) => {
  const network = fakeNetwork({ google: mockupGoogle() });
  const { services } = setup(t, network);
  await connectGoogle(services);
  const server = await serve(t, services, [calendarModule, todosModule, ideasModule, captureModule, eventsModule]);
  const created = await server.call("POST", "/api/capture", { body: { text: "明天下午三點 跟教授 meeting" } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.undoPath, `/api/calendar/events/${created.json.id}`);
  assert.equal(network.google.inserted.length, 0, "nothing reached Google before the undo window");
  assert.equal(calendarService(services).isPending(created.json.id), true);
  assert.equal((await server.call("DELETE", created.json.undoPath, { body: {} })).status, 200);
  await calendarService(services).flush();
  assert.equal(network.google.inserted.length, 0, "復原 inside the window sends nothing");

  // A crash between creating capture's record and deciding it leaves it pending: it is not a row to decide.
  services.suggestions.create({ kind: "event", title: "加入行事曆：跟教授 meeting", payload: { title: "跟教授 meeting", start: taipei("2026-10-13T15:00"), allDay: false }, origin: "快速記下" });
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.ok(!today.queue.flatMap((group) => group.items).some((item) => item.source === "ai"));
  assert.equal(today.counts.nav?.events ?? 0, 0);
  assert.equal(((await server.call("GET", "/api/events")).json as { suggestions: unknown[] }).suggestions.length, 0);
});
