import test from "node:test";
import assert from "node:assert/strict";
import type { CalendarDay, CalendarItem } from "../../../shared/calendar";
import { createFields, editorFields, isEditable, isRemovable, planCreate, planEdit, withAllDay, withDay, withEdits, type EditorFields } from "./event-editor";

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const midnight = (day: string) => at(`${day}T00:00`);

const oneOff: CalendarItem = {
  id: "manual:ev1", kind: "event", origin: "manual", title: "讀書會", start: at("2026-10-14T19:00"), end: at("2026-10-14T20:00"), allDay: false,
  meta: "浩然圖書館 · 帶筆電", location: "浩然圖書館", sourceLabel: "本機行程", manualId: "ev1", inGoogle: false, typed: true,
};
/** Monday 10/26, the 8th week of a class that began 9/7, with 10/19 deleted. */
const classRow: CalendarItem = {
  id: "manual:os:2026-10-26", kind: "event", origin: "manual", title: "作業系統", start: at("2026-10-26T10:10"), end: at("2026-10-26T12:00"), allDay: false,
  meta: "EC115 · 每週一", location: "EC115", sourceLabel: "本機行程", manualId: "os", inGoogle: false,
  repeat: { freq: "weekly", day: "2026-10-26", first: "2026-09-07", skip: ["2026-10-19"] },
};
const allDayRow: CalendarItem = {
  id: "manual:due", kind: "event", origin: "manual", title: "停修申請截止", start: midnight("2026-10-30"), end: midnight("2026-10-31"), allDay: true,
  meta: "本機行程", sourceLabel: "本機行程", manualId: "due", inGoogle: false,
};

const plan = (item: CalendarItem, change: Partial<EditorFields>) => {
  const base = editorFields(item, TZ);
  return planEdit(item, base, { ...base, ...change }, TZ);
};
const edit = (item: CalendarItem, change: Partial<EditorFields>) => {
  const result = plan(item, change);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.edit;
};
const refusal = (item: CalendarItem, change: Partial<EditorFields>) => {
  const result = plan(item, change);
  assert.equal(result.ok, false, JSON.stringify(change));
  return result.ok ? undefined : result;
};

test("the fields of a row: local days and clock times, an all-day row's last day, a point in time", () => {
  assert.deepEqual(editorFields(oneOff, TZ), { title: "讀書會", day: "2026-10-14", endDay: "2026-10-14", start: "19:00", end: "20:00", allDay: false, location: "浩然圖書館", notes: "", repeat: false, until: "" });
  assert.deepEqual(editorFields(allDayRow, TZ), { title: "停修申請截止", day: "2026-10-30", endDay: "2026-10-30", start: "", end: "", allDay: true, location: "", notes: "", repeat: false, until: "" });
  const trip: CalendarItem = { ...allDayRow, start: midnight("2026-10-30"), end: midnight("2026-11-02") };
  assert.equal(editorFields(trip, TZ).endDay, "2026-11-01", "the row ends at the midnight after its last day");
  const overnight: CalendarItem = { ...oneOff, start: at("2026-10-17T08:00"), end: at("2026-10-19T08:00") };
  assert.deepEqual([editorFields(overnight, TZ).endDay, editorFields(overnight, TZ).end], ["2026-10-19", "08:00"]);
  assert.deepEqual([editorFields({ ...oneOff, end: oneOff.start }, TZ).end, editorFields({ ...oneOff, end: undefined }, TZ).endDay], ["", "2026-10-14"], "no end time");
  const fields = editorFields({ ...classRow, repeat: { ...classRow.repeat!, until: "2026-12-21" } }, TZ);
  assert.deepEqual([fields.repeat, fields.until, fields.day], [true, "2026-12-21", "2026-10-26"]);
  assert.equal(isEditable(oneOff), true);
  assert.equal(isEditable({ ...oneOff, inGoogle: true }), false, "without Google write scope");
  assert.equal(isEditable({ ...oneOff, inGoogle: true }, true), true, "two-way sync when Google write scope is granted");
  assert.equal(isEditable({ ...oneOff, manualId: undefined }), false, "Google and iCal rows without write scope");
  const nativeWritable: CalendarItem = { ...oneOff, id: "google:primary:g1", origin: "google", manualId: undefined, inGoogle: true, googleEditable: true };
  const nativeReadonly: CalendarItem = { ...oneOff, id: "google:hol:h1", origin: "google", manualId: undefined, inGoogle: true, googleEditable: false };
  assert.equal(isEditable(nativeWritable, true), true, "writable native Google event");
  assert.equal(isEditable(nativeReadonly, true), false, "read-only holiday Google calendar");
  assert.equal(isRemovable(nativeWritable, true), true);
  assert.equal(isRemovable(nativeReadonly, true), false);
  assert.equal(isEditable({ ...oneOff, kind: "due" }), false);
});

test("only the fields that changed are sent, with the previous value for 復原", () => {
  assert.equal(edit(oneOff, {}), null, "nothing changed: no request");
  assert.equal(edit(oneOff, { title: "  讀書會 ", location: "浩然圖書館 " }), null, "spaces only are no change");

  const title = edit(oneOff, { title: " OS 讀書會 " })!;
  assert.deepEqual(title.patch, { title: "OS 讀書會" });
  assert.deepEqual(title.undo, { title: "讀書會" });
  assert.equal(title.next.title, "OS 讀書會");

  const place = edit(oneOff, { location: "" })!;
  assert.deepEqual(place.patch, { location: null }, "a cleared place is null");
  assert.deepEqual(place.undo, { location: "浩然圖書館" });
  assert.equal(edit({ ...oneOff, location: undefined, meta: "帶筆電" }, { location: "圖書館" })!.undo.location, null, "復原 clears a place that was added");

  const end = edit(oneOff, { end: "21:30" })!;
  assert.deepEqual(end.patch, { end: at("2026-10-14T21:30") }, "the end time alone: the start is not sent");
  assert.deepEqual(end.undo, { end: at("2026-10-14T20:00") });
  const start = edit(oneOff, { start: "18:00" })!;
  assert.deepEqual(start.patch, { start: at("2026-10-14T18:00") });

  const noEnd = edit(oneOff, { end: "" })!;
  assert.deepEqual([noEnd.patch, noEnd.undo], [{ end: null }, { end: at("2026-10-14T20:00") }], "an empty end time is an event with no end");
  assert.deepEqual(edit({ ...oneOff, end: oneOff.start }, { end: "20:00" })!.undo, { end: null }, "and 復原 takes the end away again");
});

test("a new day moves the start and the end together; the date is the browser-independent local day", () => {
  const moved = edit(oneOff, withDay(editorFields(oneOff, TZ), "2026-10-15"))!;
  assert.deepEqual(moved.patch, { start: at("2026-10-15T19:00"), end: at("2026-10-15T20:00") });
  assert.deepEqual(moved.undo, { start: at("2026-10-14T19:00"), end: at("2026-10-14T20:00") });
  assert.deepEqual([moved.next.id, moved.next.start, moved.next.end], ["manual:ev1", at("2026-10-15T19:00"), at("2026-10-15T20:00")]);
  const trip = editorFields({ ...oneOff, start: at("2026-10-17T08:00"), end: at("2026-10-19T08:00") }, TZ);
  assert.deepEqual([withDay(trip, "2026-10-24").endDay, withDay(trip, "").endDay], ["2026-10-26", ""], "a two-day event keeps its length");
});

test("all-day: days instead of instants; 全天 on and off send all three fields", () => {
  const moved = edit(allDayRow, { day: "2026-11-02", endDay: "2026-11-03" })!;
  assert.deepEqual(moved.patch, { start: "2026-11-02", end: "2026-11-03" }, "the last day is inclusive");
  assert.deepEqual(moved.undo, { start: "2026-10-30", end: "2026-10-30" });
  assert.deepEqual([moved.next.start, moved.next.end], [midnight("2026-11-02"), midnight("2026-11-04")]);

  const timed = edit(allDayRow, withAllDay(editorFields(allDayRow, TZ), false))!;
  assert.deepEqual(timed.patch, { allDay: false, start: at("2026-10-30T09:00"), end: at("2026-10-30T10:00") });
  assert.deepEqual(timed.undo, { allDay: true, start: "2026-10-30", end: "2026-10-30" });
  assert.equal(timed.next.allDay, false);

  const whole = edit(oneOff, { allDay: true })!;
  assert.deepEqual(whole.patch, { allDay: true, start: "2026-10-14", end: "2026-10-14" });
  assert.deepEqual(whole.undo, { allDay: false, start: at("2026-10-14T19:00"), end: at("2026-10-14T20:00") });
  assert.deepEqual([whole.next.allDay, whole.next.start, whole.next.end], [true, midnight("2026-10-14"), midnight("2026-10-15")]);
  assert.deepEqual(withAllDay(editorFields(oneOff, TZ), true).start, "19:00", "the times stay while 全天 is on, so turning it off again is no change");
  assert.equal(edit(oneOff, withAllDay(withAllDay(editorFields(oneOff, TZ), true), false)), null);
});

test("refusals: no title, no date, end before start, an end time missing across days, too long", () => {
  assert.equal(refusal(oneOff, { title: "  " })?.field, "title");
  assert.deepEqual(refusal(oneOff, { end: "18:30" }), { ok: false, error: "結束時間要晚於開始時間。", field: "end" });
  assert.equal(refusal(oneOff, { end: "19:00" })?.field, "end", "an end equal to the start has no length");
  assert.equal(refusal(oneOff, { start: "21:00" })?.field, "end", "moving the start past the end");
  assert.equal(refusal(oneOff, { day: "" })?.field, "day");
  assert.equal(refusal(oneOff, { start: "" })?.field, "start");
  assert.equal(refusal(oneOff, { endDay: "2026-10-13" })?.field, "endDay");
  assert.equal(refusal(oneOff, { endDay: "2026-10-15", end: "" })?.field, "end", "a multi-day event needs its end time");
  assert.equal(refusal(oneOff, { endDay: "2026-11-30" })?.error, "一個行程最長兩週。");
  assert.equal(refusal(allDayRow, { endDay: "2026-10-29" })?.field, "endDay");
  assert.equal(refusal(allDayRow, { endDay: "2026-12-30" })?.field, "endDay");
  // Times that did not change are not checked again: a title edit never waits on them.
  const odd: CalendarItem = { ...oneOff, end: at("2026-10-14T18:00") };
  assert.deepEqual(edit(odd, { title: "OS 讀書會" })?.patch, { title: "OS 讀書會" });
  assert.deepEqual(edit(oneOff, { endDay: "2026-10-15", end: "09:00" })?.patch, { end: at("2026-10-15T09:00") }, "an event may run past midnight");
});

test("a weekly row: the whole series moves by the days the opened occurrence moved, and 復原 brings the deleted days back", () => {
  const time = edit(classRow, { start: "13:10", end: "15:00" })!;
  assert.deepEqual(time.patch, { start: at("2026-09-07T13:10"), end: at("2026-09-07T15:00") }, "the series' first day, at the new time");
  assert.deepEqual(time.undo, { start: at("2026-09-07T10:10"), end: at("2026-09-07T12:00"), repeat: { freq: "weekly", skip: ["2026-10-19"] } });
  assert.deepEqual([time.next.id, time.next.start, time.next.repeat], ["manual:os:2026-10-26", at("2026-10-26T13:10"), classRow.repeat]);

  // Next week's Monday moves to Tuesday: every week does.
  const tuesday = edit(classRow, withDay(editorFields(classRow, TZ), "2026-10-27"))!;
  assert.deepEqual(tuesday.patch, { start: at("2026-09-08T10:10"), end: at("2026-09-08T12:00") }, "9/7 + 1 day; no repeat in the patch: the series stays weekly");
  assert.deepEqual(tuesday.undo, { start: at("2026-09-07T10:10"), end: at("2026-09-07T12:00"), repeat: { freq: "weekly", skip: ["2026-10-19"] } });
  assert.deepEqual([tuesday.next.id, tuesday.next.meta, tuesday.next.repeat], ["manual:os:2026-10-27", "EC115 · 每週二", { freq: "weekly", day: "2026-10-27", first: "2026-09-08" }], "the row reads Tuesday and the Monday skip is gone");

  const place = edit(classRow, { location: "EC122", title: "OS" })!;
  assert.deepEqual(place.patch, { title: "OS", location: "EC122" });
  assert.deepEqual(place.undo, { title: "作業系統", location: "EC115" }, "a title edit sends no repeat back");
  assert.equal(place.next.meta, "EC122 · 每週一");

  const until = edit(classRow, { until: "2026-12-21" })!;
  assert.deepEqual(until.patch, { repeat: { freq: "weekly", until: "2026-12-21" } }, "no skip: the server keeps the deleted days");
  assert.deepEqual(until.undo, { repeat: { freq: "weekly", skip: ["2026-10-19"] } });
  const open = edit({ ...classRow, repeat: { ...classRow.repeat!, until: "2026-12-21" } }, { until: "" })!;
  assert.deepEqual(open.patch, { repeat: { freq: "weekly" } });
  assert.deepEqual(open.undo, { repeat: { freq: "weekly", until: "2026-12-21", skip: ["2026-10-19"] } });
  assert.equal(refusal(classRow, { until: "2026-09-01" })?.error, "「直到」的日期不能早於第一次行程。", "before the first day of the series");
  assert.equal(refusal(classRow, { until: "nope" })?.field, "until");
  assert.equal(refusal(classRow, { ...withDay(editorFields(classRow, TZ), "2026-12-28"), until: "2026-10-30" })?.field, "until", "moved so far that the series would start after its 直到");
  assert.deepEqual(edit(classRow, { until: "2026-10-20" })?.patch, { repeat: { freq: "weekly", until: "2026-10-20" } }, "ending the series before this week is allowed");

  // Off: one event, on the opened day (not the series' first day).
  const off = edit(classRow, { repeat: false })!;
  assert.deepEqual(off.patch, { start: at("2026-10-26T10:10"), end: at("2026-10-26T12:00"), repeat: null });
  assert.deepEqual(off.undo, { start: at("2026-09-07T10:10"), end: at("2026-09-07T12:00"), repeat: { freq: "weekly", skip: ["2026-10-19"] } });
  assert.deepEqual([off.next.id, off.next.repeat, off.next.meta], ["manual:os", undefined, "EC115"]);
  const first: CalendarItem = { ...classRow, repeat: { freq: "weekly", day: "2026-09-07", first: "2026-09-07" }, start: at("2026-09-07T10:10"), end: at("2026-09-07T12:00") };
  assert.deepEqual(edit(first, { repeat: false })!.patch, { repeat: null }, "the first occurrence is already where the event stays");
});

test("a one-off event turns weekly: the repeat and its 直到 are sent, 復原 sends null", () => {
  const weekly = edit(oneOff, { repeat: true, until: "2026-12-30" })!;
  assert.deepEqual(weekly.patch, { repeat: { freq: "weekly", until: "2026-12-30" } });
  assert.deepEqual(weekly.undo, { repeat: null });
  assert.deepEqual([weekly.next.id, weekly.next.meta, weekly.next.repeat], ["manual:ev1:2026-10-14", "浩然圖書館 · 帶筆電 · 每週三", { freq: "weekly", day: "2026-10-14", first: "2026-10-14", until: "2026-12-30" }]);
  assert.deepEqual(edit(oneOff, { repeat: true })!.patch, { repeat: { freq: "weekly" } });
  assert.equal(refusal(oneOff, { repeat: true, until: "2026-10-13" })?.field, "until");
  assert.equal(edit(oneOff, { until: "2026-12-30" }), null, "a 直到 with 每週重複 off is nothing");
  // Moved and repeated in one go: the new day is the first day.
  assert.equal(refusal(oneOff, { ...withDay(editorFields(oneOff, TZ), "2026-10-21"), repeat: true, until: "2026-10-20" })?.field, "until", "a 直到 before the moved first day is refused");
});

test("the row as it will read: the note stays, the place and weekday are rebuilt, a rewrite ends 復原整理's mark", () => {
  const noted: CalendarItem = { ...classRow, meta: "EC115 · 林志明 · 每週一" };
  assert.equal(edit(noted, { location: "" })!.next.meta, "林志明 · 每週一");
  assert.equal(edit(noted, withDay(editorFields(noted, TZ), "2026-10-28"))!.next.meta, "EC115 · 林志明 · 每週三");
  assert.equal(edit({ ...oneOff, location: undefined, meta: "" }, { location: "圖書館" })!.next.meta, "圖書館");
  const tidied: CalendarItem = { ...oneOff, tidied: true };
  assert.equal(edit(tidied, { start: "18:00" })!.next.tidied, true, "a new time keeps 復原整理");
  assert.equal(edit(tidied, { title: "OS 讀書會" })!.next.tidied, undefined, "new words end it");
  assert.equal(edit(oneOff, { title: "OS 讀書會" })!.next.typed, true, "the other flags stay");
});

test("withEdits: the edited row leaves its day for the day it starts on; a multi-day row shows on each day it covers", () => {
  const day = (key: string, items: CalendarItem[]): CalendarDay => ({ day: key, items, free: [] });
  const other: CalendarItem = { ...oneOff, id: "manual:ev2", manualId: "ev2", title: "別的行程" };
  const days = [day("2026-10-14", [oneOff, other]), day("2026-10-15", []), day("2026-10-16", [])];
  const moved = edit(oneOff, withDay(editorFields(oneOff, TZ), "2026-10-15"))!;
  const result = withEdits(days, new Map([[oneOff.id, moved.next]]), TZ);
  assert.deepEqual(result.map((entry) => entry.items.map((item) => item.title)), [["別的行程"], ["讀書會"], []]);
  assert.equal(withEdits(days, new Map(), TZ), days, "nothing edited: the same days");

  const trip = edit(oneOff, { endDay: "2026-10-15", end: "09:00" })!;
  const spanning = withEdits(days, new Map([[oneOff.id, trip.next]]), TZ);
  assert.deepEqual(spanning.map((entry) => entry.items.map((item) => item.title)), [["別的行程", "讀書會"], ["讀書會"], []]);

  // A row that moves out of the window just leaves it.
  const away = edit(oneOff, withDay(editorFields(oneOff, TZ), "2026-12-01"))!;
  assert.deepEqual(withEdits(days, new Map([[oneOff.id, away.next]]), TZ).map((entry) => entry.items.length), [1, 0, 0]);
});

test("withEdits: once the reloaded list holds the edited row, it is not shown twice", () => {
  const day = (key: string, items: CalendarItem[]): CalendarDay => ({ day: key, items, free: [] });
  const moved = edit(oneOff, withDay(editorFields(oneOff, TZ), "2026-10-15"))!;
  // The server's own answer for the same row (same id and times as the edited one).
  const reloaded = day("2026-10-15", [{ ...moved.next }]);
  const result = withEdits([day("2026-10-14", []), reloaded], new Map([[oneOff.id, moved.next]]), TZ);
  assert.deepEqual(result.map((entry) => entry.items.length), [0, 1]);

  // A weekly row that moved to another weekday changes its id: the old one goes, the reloaded new one is not doubled.
  const tuesday = edit(classRow, withDay(editorFields(classRow, TZ), "2026-10-27"))!;
  const week = [day("2026-10-26", [classRow]), day("2026-10-27", [{ ...tuesday.next }])];
  assert.deepEqual(withEdits(week, new Map([[classRow.id, tuesday.next]]), TZ).map((entry) => entry.items.map((item) => item.id)), [[], ["manual:os:2026-10-27"]]);
});

test("notes editing, native Google event id preservation, and structured planCreate", () => {
  const nativeRow: CalendarItem = {
    id: "google:primary:g101",
    kind: "event",
    origin: "google",
    title: "導生聚",
    start: at("2026-10-20T12:00"),
    end: at("2026-10-20T13:30"),
    allDay: false,
    meta: "工程三館 · 帶報告",
    location: "工程三館",
    notes: "帶報告\nhttps://meet.google.com/abc",
    sourceLabel: "Google 行事曆",
    inGoogle: true,
    googleEditable: true,
  };
  const notesChanged = edit(nativeRow, { notes: "改帶投影片" })!;
  assert.deepEqual(notesChanged.patch, { notes: "改帶投影片" });
  assert.deepEqual(notesChanged.undo, { notes: "帶報告\nhttps://meet.google.com/abc" });
  assert.equal(notesChanged.next.id, "google:primary:g101", "native Google event keeps its google:... id");
  assert.equal(notesChanged.next.meta, "工程三館 · 改帶投影片");

  const slotPrefill = createFields("2026-10-14", TZ, { start: at("2026-10-14T15:30"), end: at("2026-10-14T18:00") });
  assert.deepEqual([slotPrefill.start, slotPrefill.end], ["15:30", "16:30"]);
  const created = planCreate({ ...slotPrefill, title: "  專題討論 ", location: " EC115 ", notes: " 帶實驗數據 " }, TZ, true);
  assert.ok(created.ok);
  assert.deepEqual(created.body, {
    title: "專題討論",
    start: at("2026-10-14T15:30"),
    end: at("2026-10-14T16:30"),
    allDay: false,
    location: "EC115",
    notes: "帶實驗數據",
    addToGoogle: true,
  });
});
