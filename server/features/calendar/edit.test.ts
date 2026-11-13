import assert from "node:assert/strict";
import test from "node:test";
import type { CalendarResponse, ManualEvent } from "../../../shared/calendar.js";
import type { FeatureModule } from "../../modules.js";
import type { CoreServices } from "../../services.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { collectItems } from "./agenda.js";
import { GoogleCalendarSync, googleEventIdFor } from "./google.js";
import { calendarModule } from "./index.js";
import { calendarService } from "./store.js";
import { connectGoogle, fakeNetwork, taipei } from "./testing.js";

/** Monday 2026-10-12 08:42 in Taipei. */
const NOW = new Date(taipei("2026-10-12T08:42"));
const GOOGLE_REFUSAL = "這個行程已經送到 Google 行事曆，請到 Google 行事曆修改。";

function setup(t: test.TestContext, network = fakeNetwork()) {
  const services = testServices(t, { seams: { fetch: network.fetch, now: () => NOW } });
  return { services, network };
}

async function serve(t: test.TestContext, services: CoreServices, modules: FeatureModule[] = [calendarModule]) {
  const server = await startTestServer(t, services, { modules, today: { moduleTimeoutMs: 2_000, commitMs: 60_000 } });
  t.after(() => calendarService(services).dropPending());
  const patch = (id: string, body: unknown) => server.call("PATCH", `/api/calendar/events/${id}`, { body });
  return { server, patch };
}

const weekly = (title: string, start: string, end: string, extra: { until?: string; location?: string } = {}) => ({
  title, start: taipei(start), end: taipei(end), ...(extra.location ? { location: extra.location } : {}),
  repeat: { freq: "weekly" as const, ...(extra.until ? { until: extra.until } : {}) },
});

/** The local days of a series' occurrences between two local days (inclusive start, exclusive end). */
function occurrenceDays(services: CoreServices, id: string, from: string, to: string): string[] {
  return collectItems(services, taipei(`${from}T00:00`), taipei(`${to}T00:00`))
    .filter((item) => item.manualId === id)
    .map((item) => (item.repeat ? item.repeat.day : item.id));
}

test("PATCH changes the time, title and place of a one-off event and answers with the stored event", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const created = service.create({ title: "讀書會", start: taipei("2026-10-14T19:00"), end: taipei("2026-10-14T20:00"), notes: "帶筆電", url: "https://example.com/e" });
  const { server, patch } = await serve(t, services);

  const moved = await patch(created.id, { title: "  OS 讀書會 ", start: taipei("2026-10-15T14:00"), end: taipei("2026-10-15T15:30"), location: "浩然圖書館" });
  assert.equal(moved.status, 200, moved.text);
  const event = moved.json as ManualEvent;
  assert.deepEqual(
    [event.title, event.start, event.end, event.allDay, event.location, event.notes, event.url, event.id],
    ["OS 讀書會", taipei("2026-10-15T14:00"), taipei("2026-10-15T15:30"), false, "浩然圖書館", "帶筆電", "https://example.com/e", created.id],
  );
  assert.deepEqual(service.get(created.id), event, "what the route returned is what is stored");

  const week = (await server.call("GET", "/api/calendar?view=week&day=2026-10-12")).json as CalendarResponse;
  const rows = week.days.flatMap((day) => day.items.filter((item) => item.manualId === created.id).map((item) => [day.day, item.title, item.start, item.meta]));
  assert.deepEqual(rows, [["2026-10-15", "OS 讀書會", taipei("2026-10-15T14:00"), "浩然圖書館 · 帶筆電"]], "the calendar shows it on its new day");

  // Only what is named changes; null (or blank) clears a field; end: null makes it a point in time.
  const cleared = (await patch(created.id, { location: null, notes: "  ", end: null })).json as ManualEvent;
  assert.deepEqual([cleared.title, cleared.start, cleared.end, cleared.location, cleared.notes], ["OS 讀書會", taipei("2026-10-15T14:00"), undefined, undefined, undefined]);
  assert.equal(cleared.updatedAt, NOW.toISOString());

  // A patch that names nothing changes nothing.
  assert.deepEqual((await patch(created.id, {})).json, cleared);
});

test("PATCH validates: title, end after start, the longest event, strict bodies, unknown events", async (t) => {
  const { services } = setup(t);
  const created = calendarService(services).create({ title: "讀書會", start: taipei("2026-10-14T19:00"), end: taipei("2026-10-14T20:00") });
  const { patch } = await serve(t, services);

  const bad = async (body: unknown, status: number, message?: RegExp | string) => {
    const response = await patch(created.id, body);
    assert.equal(response.status, status, `${JSON.stringify(body)} → ${response.text}`);
    if (message) assert.match(response.json.error, message instanceof RegExp ? message : new RegExp(message));
  };
  await bad({ title: "   " }, 400, "請輸入行程名稱");
  await bad({ title: "字".repeat(201) }, 400, "行程名稱最多 200 個字");
  await bad({ location: "字".repeat(201) }, 400, "地點最多 200 個字");
  await bad({ end: taipei("2026-10-14T18:00") }, 400, "行程的結束時間必須在開始之後。");
  await bad({ start: taipei("2026-10-14T21:00") }, 400, "行程的結束時間必須在開始之後。");
  await bad({ end: taipei("2026-10-30T19:00") }, 400, "一個行程最長兩週。");
  await bad({ start: "明天" }, 400, "行程的開始時間格式不正確。");
  await bad({ start: "2026-10-15" }, 400, "行程的開始時間格式不正確。");
  await bad({ start: taipei("2030-01-01T10:00"), end: taipei("2030-01-01T11:00") }, 400, "日期超出可設定的範圍。");
  await bad({ start: taipei("2020-01-01T10:00"), end: taipei("2020-01-01T11:00") }, 400, "日期超出可設定的範圍。");
  await bad({ allDay: true }, 200);
  await bad({ allDay: false, start: "2026-10-16" }, 400, "行程的開始時間格式不正確。");
  await bad({ title: "x", extra: 1 }, 400);
  await bad({ title: 5 }, 400);
  await bad({ repeat: { freq: "daily" } }, 400);
  await bad({ repeat: { freq: "weekly", every: 2 } }, 400);
  await bad({ repeat: { freq: "weekly", until: "2026-10-13" } }, 400, "「直到」的日期不能早於第一次行程。");
  await bad({ repeat: { freq: "weekly", until: "明天" } }, 400);
  assert.equal((await patch("missing", { title: "x" })).status, 404);
  assert.equal((await patch("missing", { title: "x" })).json.error, "找不到這個行程，可能已經刪除。");

  // The refused requests changed nothing but the 全天 toggle that was valid.
  const stored = calendarService(services).get(created.id)!;
  assert.deepEqual([stored.title, stored.allDay, stored.start, stored.end], ["讀書會", true, taipei("2026-10-14T00:00"), taipei("2026-10-15T00:00")], "全天 turned the day into a whole day");
});

test("PATCH an all-day event: days in, local midnights out; 全天 on and off keep a valid span", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const day = service.create({ title: "停修申請截止", start: taipei("2026-10-30T00:00"), end: taipei("2026-10-31T00:00"), allDay: true });
  const { patch } = await serve(t, services);

  const moved = (await patch(day.id, { start: "2026-11-02", end: "2026-11-04" })).json as ManualEvent;
  assert.deepEqual([moved.allDay, moved.start, moved.end], [true, taipei("2026-11-02T00:00"), taipei("2026-11-05T00:00")], "the last day is inclusive");
  assert.equal((await patch(day.id, { start: taipei("2026-11-02T00:00") })).status, 400, "instants are not days");
  assert.equal((await patch(day.id, { start: "2026-11-09" })).status, 400, "a start after the kept last day");
  const single = (await patch(day.id, { start: "2026-11-09", end: null })).json as ManualEvent;
  assert.deepEqual([single.start, single.end], [taipei("2026-11-09T00:00"), taipei("2026-11-10T00:00")], "no end: that one day");

  const timed = (await patch(day.id, { allDay: false, start: taipei("2026-11-09T10:00"), end: taipei("2026-11-09T11:00") })).json as ManualEvent;
  assert.deepEqual([timed.allDay, timed.start, timed.end], [false, taipei("2026-11-09T10:00"), taipei("2026-11-09T11:00")]);
  const back = (await patch(day.id, { allDay: true, start: "2026-11-09", end: "2026-11-09" })).json as ManualEvent;
  assert.deepEqual([back.allDay, back.start, back.end], [true, taipei("2026-11-09T00:00"), taipei("2026-11-10T00:00")]);
  // Toggling alone converts what is there: the day of the start, the last day of the end.
  const twoDays = (await patch(day.id, { end: "2026-11-10" })).json as ManualEvent;
  assert.equal(twoDays.end, taipei("2026-11-11T00:00"));
  const asTimed = (await patch(day.id, { allDay: false })).json as ManualEvent;
  assert.deepEqual([asTimed.allDay, asTimed.start, asTimed.end], [false, taipei("2026-11-09T00:00"), taipei("2026-11-11T00:00")]);
  const asDays = (await patch(day.id, { allDay: true })).json as ManualEvent;
  assert.deepEqual([asDays.allDay, asDays.start, asDays.end], [true, taipei("2026-11-09T00:00"), taipei("2026-11-11T00:00")]);
});

test("PATCH adds a repeat to a one-off event and clears it again", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const created = service.create({ title: "讀書會", start: taipei("2026-10-14T19:00"), end: taipei("2026-10-14T20:00") });
  const { patch } = await serve(t, services);
  assert.deepEqual(occurrenceDays(services, created.id, "2026-10-12", "2026-11-09"), [`manual:${created.id}`]);

  const weeklyNow = await patch(created.id, { repeat: { freq: "weekly", until: "2026-11-04" } });
  assert.equal(weeklyNow.status, 200, weeklyNow.text);
  assert.deepEqual((weeklyNow.json as ManualEvent).repeat, { freq: "weekly", until: "2026-11-04" });
  assert.deepEqual(occurrenceDays(services, created.id, "2026-10-12", "2026-11-16"), ["2026-10-14", "2026-10-21", "2026-10-28", "2026-11-04"], "every Wednesday until the 直到 day, inclusive");

  assert.equal((await patch(created.id, { repeat: { freq: "weekly", until: "2026-10-13" } })).status, 400, "a 直到 before the first day");
  assert.equal((await patch(created.id, { start: taipei("2026-11-11T19:00"), end: taipei("2026-11-11T20:00") })).status, 400, "moving the first day past the kept 直到");
  const open = (await patch(created.id, { repeat: { freq: "weekly" } })).json as ManualEvent;
  assert.deepEqual(open.repeat, { freq: "weekly" }, "no until: for ever");

  const once = await patch(created.id, { repeat: null, start: taipei("2026-10-21T19:00"), end: taipei("2026-10-21T20:00") });
  assert.equal(once.status, 200, once.text);
  assert.equal((once.json as ManualEvent).repeat, undefined);
  assert.deepEqual(occurrenceDays(services, created.id, "2026-10-12", "2026-11-16"), [`manual:${created.id}`], "one event again, on the day it was moved to");
  assert.equal(occurrenceDays(services, created.id, "2026-10-12", "2026-10-19").length, 0);
});

test("editing a series edits every week: the weekday follows its start, skipped days on another weekday are dropped", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const os = service.create({ ...weekly("作業系統", "2026-09-07T10:10", "2026-09-07T12:00", { location: "EC115" }), origin: "capture" });
  service.skipOccurrence(os.id, "2026-10-19");
  const { server, patch } = await serve(t, services);
  assert.deepEqual(occurrenceDays(services, os.id, "2026-10-12", "2026-11-02"), ["2026-10-12", "2026-10-26"], "10/19 is deleted");

  // The time changes for every week, past ones included (the series has one time).
  const later = await patch(os.id, { start: taipei("2026-09-07T13:10"), end: taipei("2026-09-07T15:00") });
  assert.equal(later.status, 200, later.text);
  assert.deepEqual((later.json as ManualEvent).repeat, { freq: "weekly", skip: ["2026-10-19"] }, "a time edit keeps the deleted Monday");
  const week = (await server.call("GET", "/api/calendar?view=week&day=2026-10-26")).json as CalendarResponse;
  assert.deepEqual(week.days[0].items.map((item) => [item.title, item.start, item.end, item.repeat]), [
    ["作業系統", taipei("2026-10-26T13:10"), taipei("2026-10-26T15:00"), { freq: "weekly", day: "2026-10-26", first: "2026-09-07", skip: ["2026-10-19"] }],
  ]);

  // The weekday changes with the start: Mondays become Tuesdays, and the deleted Monday is forgotten.
  const tuesday = await patch(os.id, { start: taipei("2026-09-08T10:10"), end: taipei("2026-09-08T12:00") });
  assert.equal(tuesday.status, 200, tuesday.text);
  assert.deepEqual((tuesday.json as ManualEvent).repeat, { freq: "weekly" }, "the stale skip is gone");
  assert.deepEqual(occurrenceDays(services, os.id, "2026-10-12", "2026-11-09"), ["2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"], "next week's Monday moved to Tuesday");
  const next = (await server.call("GET", "/api/calendar?view=week&day=2026-10-26")).json as CalendarResponse;
  assert.deepEqual(next.days[0].items, [], "Monday 10/26 is free");
  assert.deepEqual(next.days[1].items.map((item) => [item.title, item.meta, item.start]), [["作業系統", "EC115 · 每週二", taipei("2026-10-27T10:10")]]);

  // A skip sent with the repeat replaces the stored ones, and only the days on the weekday stay.
  const replaced = (await patch(os.id, { repeat: { freq: "weekly", skip: ["2026-10-27", "2026-11-03", "2026-10-26", "2026-10-27"] } })).json as ManualEvent;
  assert.deepEqual(replaced.repeat, { freq: "weekly", skip: ["2026-10-27", "2026-11-03"] });
  assert.deepEqual(occurrenceDays(services, os.id, "2026-10-26", "2026-11-09"), [], "both Tuesdays are deleted");
  assert.deepEqual(((await patch(os.id, { repeat: { freq: "weekly", until: "2026-12-01" } })).json as ManualEvent).repeat, { freq: "weekly", until: "2026-12-01", skip: ["2026-10-27", "2026-11-03"] }, "no skip: the deleted days stay");
  assert.deepEqual(((await patch(os.id, { repeat: { freq: "weekly", skip: [] } })).json as ManualEvent).repeat, { freq: "weekly" }, "an empty list forgets them");
  assert.equal((await patch(os.id, { repeat: { freq: "weekly", skip: ["明天"] } })).status, 400);
});

test("a series that began more than a year ago stays editable; only a first day far ahead is refused", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const old = service.create(weekly("日文", "2025-05-05T18:30", "2025-05-05T20:00"));
  const { patch } = await serve(t, services);
  const moved = await patch(old.id, { start: taipei("2025-05-05T19:00"), end: taipei("2025-05-05T20:30") });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await patch(old.id, { start: taipei("2028-05-01T19:00"), end: taipei("2028-05-01T20:30") })).status, 400);
  // As a one-off at that old day it is out of range, like creating one there.
  assert.equal((await patch(old.id, { repeat: null })).status, 200, "no new start named: nothing to range-check");
  assert.equal((await patch(old.id, { repeat: null, start: taipei("2025-05-05T19:00"), end: taipei("2025-05-05T20:30") })).status, 400);
});

test("復原 of an edit is the previous values sent back: time, weekday and the deleted days", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const os = service.create({ ...weekly("作業系統", "2026-09-07T10:10", "2026-09-07T12:00"), location: "EC115" });
  service.skipOccurrence(os.id, "2026-10-19");
  const one = service.create({ title: "讀書會", start: taipei("2026-10-14T19:00"), end: taipei("2026-10-14T20:00") });
  const { patch } = await serve(t, services);
  const unstamped = (event: ManualEvent | undefined) => { const { updatedAt: _updatedAt, ...rest } = event!; return rest; };

  const seriesBefore = service.get(os.id)!;
  await patch(os.id, { title: "OS", start: taipei("2026-09-09T10:10"), end: taipei("2026-09-09T12:00"), location: null, repeat: { freq: "weekly", until: "2026-12-30" } });
  assert.deepEqual(service.get(os.id)?.repeat, { freq: "weekly", until: "2026-12-30" }, "the Monday that was deleted is forgotten on a Wednesday");
  const undone = await patch(os.id, {
    title: seriesBefore.title, start: seriesBefore.start, end: seriesBefore.end, location: seriesBefore.location,
    repeat: { freq: "weekly", skip: seriesBefore.repeat!.skip },
  });
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual(unstamped(service.get(os.id)), unstamped(seriesBefore));
  assert.deepEqual(occurrenceDays(services, os.id, "2026-10-12", "2026-11-02"), ["2026-10-12", "2026-10-26"], "10/19 is still deleted");

  const oneBefore = service.get(one.id)!;
  await patch(one.id, { title: "OS 讀書會", location: "圖書館", end: null, repeat: { freq: "weekly" } });
  const undoOne = await patch(one.id, { title: oneBefore.title, location: null, end: oneBefore.end, repeat: null });
  assert.equal(undoOne.status, 200, undoOne.text);
  assert.deepEqual(unstamped(service.get(one.id)), unstamped(oneBefore));
});

test("two-way Google sync: PATCH updates Google Calendar in lockstep when connected, reschedules pending inserts, and refuses 409 only without write scope", async (t) => {
  const network = fakeNetwork();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const inserting = new Promise<void>((resolve) => { started = resolve; });
  let holdInsert = false;
  const fetch: typeof network.fetch = async (input, init) => {
    if (holdInsert && (init?.method ?? "GET").toUpperCase() === "POST" && String(input).includes("/calendar/v3/calendars/primary/events")) { started(); await held; }
    return network.fetch(input, init);
  };
  const services = testServices(t, { seams: { fetch, now: () => NOW } });
  await connectGoogle(services);
  const service = calendarService(services);
  const { patch } = await serve(t, services);
  const make = (title: string) => service.create({ title, start: taipei("2026-10-14T19:00"), end: taipei("2026-10-14T20:00") });

  // Already in Google: updates SQLite AND pushes events.update to Google Calendar.
  const inGoogle = make("在 Google 裡");
  const gid = googleEventIdFor(inGoogle.id);
  assert.equal(await service.pushToGoogle(inGoogle.id, AbortSignal.timeout(5_000)), gid);
  const syncedEdit = await patch(inGoogle.id, { title: "雙向同步改名", location: "浩然圖書館" });
  assert.equal(syncedEdit.status, 200, syncedEdit.text);
  assert.equal(service.get(inGoogle.id)?.title, "雙向同步改名");
  assert.deepEqual(network.google.updated, [gid]);
  assert.equal(network.google.byId[gid]?.summary, "雙向同步改名");
  assert.equal(network.google.byId[gid]?.location, "浩然圖書館");

  // Waiting for its undo window: updates SQLite and keeps insert pending with fresh text.
  const pending = make("等一下進 Google");
  service.deferPush(pending.id);
  const pendingEdit = await patch(pending.id, { title: "送出前改名" });
  assert.equal(pendingEdit.status, 200, pendingEdit.text);
  assert.equal(service.isPending(pending.id), true);
  assert.equal(service.get(pending.id)?.title, "送出前改名");
  assert.equal(service.cancelPending(pending.id), true);

  // On its way: waits for insert to finish, then updates Google cleanly.
  const sending = make("正在進 Google");
  holdInsert = true;
  service.deferPush(sending.id);
  assert.equal(service.reschedule(sending.id, 0), true);
  await inserting;
  assert.equal(service.isInserting(sending.id), true);
  const inFlightPatch = patch(sending.id, { title: "送達後改名" });
  release();
  const inFlightDone = await inFlightPatch;
  assert.equal(inFlightDone.status, 200, inFlightDone.text);
  assert.equal(service.get(sending.id)?.title, "送達後改名");
  assert.equal(network.google.byId[googleEventIdFor(sending.id)]?.summary, "送達後改名");

  // Read-only Google grant (no calendar.events write scope) still refuses 409.
  await connectGoogle(services, ["email", "openid", "https://www.googleapis.com/auth/calendar.readonly"]);
  const refused = await patch(inGoogle.id, { title: "沒有寫入權限" });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, GOOGLE_REFUSAL);
});

test("month view and native Google Calendar two-way edit, delete, and Undo restore", async (t) => {
  const network = fakeNetwork({
    google: {
      calendars: [
        { id: "primary", primary: true, summary: "主日曆", accessRole: "owner" },
        { id: "tw@holiday.calendar.google.com", selected: true, summary: "台灣節日", accessRole: "reader" },
      ],
      events: {
        primary: [{
          id: "g101",
          summary: "教授導生聚",
          location: "工程三館",
          description: "記得帶報告",
          status: "confirmed",
          start: { dateTime: taipei("2026-10-20T12:00") },
          end: { dateTime: taipei("2026-10-20T13:30") },
        }],
        "tw@holiday.calendar.google.com": [{
          id: "hol1",
          summary: "光復節補假",
          status: "confirmed",
          start: { date: "2026-10-26" },
          end: { date: "2026-10-27" },
        }],
      },
    },
  });
  const services = testServices(t, { seams: { fetch: network.fetch, now: () => NOW } });
  await connectGoogle(services);
  const { server } = await serve(t, services);

  // Sync Google Calendar into source_items.
  await new GoogleCalendarSync(services).sync();

  // Month view covers full aligned weeks (Monday 2026-09-28 .. Sunday 2026-11-01 = 35 days).
  const monthRes = await server.call("GET", "/api/calendar?view=month&day=2026-10-12");
  assert.equal(monthRes.status, 200, monthRes.text);
  const month = monthRes.json as CalendarResponse;
  assert.equal(month.view, "month");
  assert.equal(month.from, "2026-09-28");
  assert.equal(month.to, "2026-11-01");
  assert.equal(month.days.length, 35);

  const oct20 = month.days.find((d) => d.day === "2026-10-20")!;
  const lunch = oct20.items.find((item) => item.id === "google:primary:g101")!;
  assert.ok(lunch, "native Google event appears in month view");
  assert.equal(lunch.googleEditable, true);
  assert.equal(lunch.notes, "記得帶報告");

  const oct26 = month.days.find((d) => d.day === "2026-10-26")!;
  const holiday = oct26.items.find((item) => item.id === "google:tw@holiday.calendar.google.com:hol1")!;
  assert.ok(holiday);
  assert.equal(holiday.googleEditable, false, "subscribed holiday calendar is read-only");

  // Read-only Google event cannot be edited or deleted.
  assert.equal((await server.call("PATCH", "/api/calendar/google-events", { body: { id: holiday.id, title: "改節日" } })).status, 403);
  assert.equal((await server.call("DELETE", "/api/calendar/google-events", { body: { id: holiday.id } })).status, 403);

  // Direct edit of writable native Google Calendar event updates Google + local cache immediately.
  const edited = await server.call("PATCH", "/api/calendar/google-events", {
    body: {
      id: lunch.id,
      title: "林教授導生聚",
      location: "交大二餐",
      notes: "帶專題簡報",
      start: taipei("2026-10-21T12:30"),
      end: taipei("2026-10-21T14:00"),
    },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(network.google.byId["g101"]?.summary, "林教授導生聚");
  assert.equal(network.google.byId["g101"]?.location, "交大二餐");
  assert.equal(network.google.byId["g101"]?.description, "帶專題簡報");

  const afterMove = (await server.call("GET", "/api/calendar?view=day&day=2026-10-21")).json as CalendarResponse;
  assert.equal(afterMove.days[0].items[0]?.title, "林教授導生聚");

  // Delete native Google Calendar event + Undo restore.
  const deleted = await server.call("DELETE", "/api/calendar/google-events", { body: { id: lunch.id } });
  assert.equal(deleted.status, 200, deleted.text);
  assert.ok(deleted.json.snapshot);
  assert.ok(network.google.deleted.includes("g101"));
  const afterDelete = (await server.call("GET", "/api/calendar?view=day&day=2026-10-21")).json as CalendarResponse;
  assert.equal(afterDelete.days[0].items.length, 0);

  const restored = await server.call("POST", "/api/calendar/google-events/restore", { body: { snapshot: deleted.json.snapshot } });
  assert.equal(restored.status, 200, restored.text);
  const afterRestore = (await server.call("GET", "/api/calendar?view=day&day=2026-10-21")).json as CalendarResponse;
  assert.equal(afterRestore.days[0].items[0]?.title, "林教授導生聚");
});

test("a new title, place or note ends 整理's typed sentence and 復原整理; a new time does not", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const tidied = (title: string) => {
    const event = service.create({ title, start: taipei("2026-10-14T15:00"), end: taipei("2026-10-14T16:00"), location: "工程三館", origin: "capture", originalText: "明天下午三點 跟教授 meeting @工程三館" });
    return service.events.put({ ...event, tidiedAt: NOW.toISOString(), pretidy: { title: "跟教授 meeting 明天下午三點", location: "工程三館" } });
  };
  const { patch } = await serve(t, services);

  const time = tidied("跟教授 meeting");
  const keeps = (await patch(time.id, { start: taipei("2026-10-15T15:00"), end: taipei("2026-10-15T16:00"), repeat: { freq: "weekly" }, title: "跟教授 meeting", location: "工程三館" })).json as ManualEvent;
  assert.deepEqual([keeps.originalText, keeps.pretidy?.title, keeps.tidiedAt], ["明天下午三點 跟教授 meeting @工程三館", "跟教授 meeting 明天下午三點", NOW.toISOString()], "the same words again, a new day and a repeat");

  for (const [name, body] of [["title", { title: "跟林教授 meeting" }], ["location", { location: "資訊館" }], ["location cleared", { location: null }], ["notes", { notes: "帶筆電" }]] as const) {
    const event = tidied("跟教授 meeting");
    const changed = (await patch(event.id, body)).json as ManualEvent;
    assert.deepEqual([changed.originalText, changed.pretidy], [undefined, undefined], name);
  }
});

test("a weekly class's rows carry its series: first day, 直到 and the deleted days", async (t) => {
  const { services } = setup(t);
  const service = calendarService(services);
  const os = service.create(weekly("作業系統", "2026-09-07T10:10", "2026-09-07T12:00", { until: "2026-12-21" }));
  service.skipOccurrence(os.id, "2026-10-26");
  service.skipOccurrence(os.id, "2026-10-19");
  const rows = collectItems(services, taipei("2026-10-12T00:00"), taipei("2026-11-09T00:00")).map((item) => item.repeat);
  assert.deepEqual(rows, [
    { freq: "weekly", day: "2026-10-12", first: "2026-09-07", until: "2026-12-21", skip: ["2026-10-19", "2026-10-26"] },
    { freq: "weekly", day: "2026-11-02", first: "2026-09-07", until: "2026-12-21", skip: ["2026-10-19", "2026-10-26"] },
  ]);
});
