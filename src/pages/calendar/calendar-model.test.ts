import test from "node:test";
import assert from "node:assert/strict";
import type { CalendarItem, FreeSlot } from "../../../shared/calendar";
import { dayTitle, hourRange, monthHeading, nowOffset, prefillText, shiftDay, slotHours, syncedLabel, timelineRows, weekBlocks } from "./calendar-model";

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const NOW = Date.parse(at("2026-10-12T08:42"));

const event = (id: string, start: string, end: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  id, kind: "event", origin: "google", title: id, start: at(start), end: at(end), allDay: false, meta: "", sourceLabel: "Google 行事曆", inGoogle: true, ...extra,
});
const slot = (start: string, end: string): FreeSlot => ({ start: at(start), end: at(end), minutes: (Date.parse(at(end)) - Date.parse(at(start))) / 60_000 });

test("timeline: all-day first, the 現在 line before the first future row, the free slot paired with Today's gap, soon on the next event", () => {
  const items: CalendarItem[] = [
    event("作業系統", "2026-10-12T10:10", "2026-10-12T12:00"),
    event("健身", "2026-10-12T19:30", "2026-10-12T20:30"),
    { ...event("HW3 截止", "2026-10-12T23:59", "2026-10-12T23:59"), kind: "due", origin: "assignment", end: undefined },
    { ...event("光復節", "2026-10-12T00:00", "2026-10-13T00:00"), allDay: true },
  ];
  const gap = { start: at("2026-10-12T15:30"), end: at("2026-10-12T19:30"), hours: 4, forItemId: "moodle:30512", label: "適合寫 HW3" };
  const rows = timelineRows({ day: "2026-10-12", today: "2026-10-12", items, free: [slot("2026-10-12T15:30", "2026-10-12T19:30")], now: NOW, timeZone: TZ, gap });
  assert.deepEqual(rows.map((row) => (row.type === "item" ? row.item.id : row.type)), ["光復節", "now", "作業系統", "gap", "健身", "HW3 截止"]);
  const next = rows.find((row) => row.type === "item" && row.item.id === "作業系統");
  assert.equal(next?.type === "item" && next.soon, "1 小時 28 分後");
  const gapRow = rows.find((row) => row.type === "gap");
  assert.equal(gapRow?.type === "gap" && gapRow.match?.label, "適合寫 HW3");
  assert.equal(gapRow?.type === "gap" && gapRow.hours, "4");
});

test("timeline: more than two past rows fold until 顯示; a slot starting now follows the 現在 line; other days have no 現在", () => {
  const late = Date.parse(at("2026-10-12T16:00"));
  const items = [
    event("a", "2026-10-12T08:00", "2026-10-12T09:00"),
    event("b", "2026-10-12T10:00", "2026-10-12T11:00"),
    event("c", "2026-10-12T12:00", "2026-10-12T13:00"),
    event("d", "2026-10-12T19:00", "2026-10-12T20:00"),
  ];
  const free = [slot("2026-10-12T16:00", "2026-10-12T19:00")];
  const folded = timelineRows({ day: "2026-10-12", today: "2026-10-12", items, free, now: late, timeZone: TZ });
  assert.deepEqual(folded.map((row) => row.type === "item" ? row.item.id : row.type === "fold" ? `fold:${row.count}` : row.type), ["fold:3", "now", "gap", "d"]);
  const open = timelineRows({ day: "2026-10-12", today: "2026-10-12", items, free, now: late, timeZone: TZ, showPast: true });
  assert.deepEqual(open.map((row) => row.type === "item" ? `${row.item.id}${row.past ? "·past" : ""}` : row.type), ["a·past", "b·past", "c·past", "now", "gap", "d"]);
  const tomorrow = timelineRows({ day: "2026-10-13", today: "2026-10-12", items: [event("x", "2026-10-13T09:00", "2026-10-13T10:00")], free: [], now: late, timeZone: TZ });
  assert.deepEqual(tomorrow.map((row) => row.type), ["item"]);
  const evening = timelineRows({ day: "2026-10-12", today: "2026-10-12", items: [event("a", "2026-10-12T08:00", "2026-10-12T09:00")], free: [], now: Date.parse(at("2026-10-12T22:00")), timeZone: TZ });
  assert.deepEqual(evening.map((row) => row.type), ["item", "now"], "after the last row, 現在 closes the day");
});

test("week grid: hour range widens for early and late events; overlapping events take lanes", () => {
  const days = [{ day: "2026-10-12", items: [event("early", "2026-10-12T06:30", "2026-10-12T07:30"), event("late", "2026-10-12T22:30", "2026-10-12T23:45")] }];
  assert.deepEqual(hourRange(days, TZ), { start: 6, end: 24 });
  assert.deepEqual(hourRange([{ day: "2026-10-12", items: [] }], TZ), { start: 7, end: 23 });

  const blocks = weekBlocks("2026-10-12", [
    event("a", "2026-10-12T09:00", "2026-10-12T11:00"),
    event("b", "2026-10-12T10:00", "2026-10-12T10:30"),
    event("c", "2026-10-12T10:15", "2026-10-12T12:00"),
    event("d", "2026-10-12T13:00", "2026-10-12T13:10"),
  ], TZ, 7, 23, NOW);
  const byId = Object.fromEntries(blocks.map((block) => [block.item.id, block]));
  assert.deepEqual([byId.a.top, byId.a.height, byId.a.lane, byId.a.lanes], [120, 120, 0, 3]);
  assert.deepEqual([byId.b.lane, byId.c.lane], [1, 2]);
  assert.deepEqual([byId.d.top, byId.d.height, byId.d.lanes], [360, 24, 1], "short events stay readable");
  assert.equal(nowOffset("2026-10-12", TZ, 7, 23, NOW), 102);
  assert.equal(nowOffset("2026-10-12", TZ, 9, 23, NOW), undefined);
});

test("phrases: titles, anchors, hours, sync times, palette prefill", () => {
  assert.equal(dayTitle("2026-10-25"), "10/25（日）");
  assert.equal(monthHeading("2026-11-13"), "2026 年 11 月");
  assert.equal(shiftDay("2026-10-12", "day", -1), "2026-10-11");
  assert.equal(shiftDay("2026-10-12", "week", 1), "2026-10-19");
  assert.equal(shiftDay("2026-01-31", "month", 1), "2026-02-28");
  assert.equal(shiftDay("2026-01-15", "month", -1), "2025-12-15");
  assert.deepEqual([slotHours(240), slotHours(150), slotHours(100)], ["4", "2.5", "1.5"]);
  assert.equal(syncedLabel(at("2026-10-12T08:12"), "2026-10-12", TZ), "08:12");
  assert.equal(syncedLabel(at("2026-10-11T22:10"), "2026-10-12", TZ), "昨天 22:10");
  assert.equal(syncedLabel(at("2026-10-09T22:10"), "2026-10-12", TZ), "10/9 22:10");
  assert.equal(prefillText("2026-10-12", "2026-10-12", TZ), "+");
  assert.equal(prefillText("2026-10-14", "2026-10-12", TZ), "+10/14 ");
  assert.equal(prefillText("2026-10-12", "2026-10-12", TZ, slot("2026-10-12T15:30", "2026-10-12T19:30")), "+今天 15:30-16:30 ");
  assert.equal(prefillText("2026-10-14", "2026-10-12", TZ, slot("2026-10-14T21:20", "2026-10-14T23:00")), "+10/14 21:20-22:20 ");
});

test("timeline: Today's gap that starts now pairs with the slot this page computed a moment later", () => {
  const evening = Date.parse(at("2026-10-12T17:03"));
  const gap = { start: new Date(Date.parse(at("2026-10-12T17:01")) + 50_000).toISOString(), end: at("2026-10-12T19:30"), hours: 2, forItemId: "moodle:30512", label: "適合寫 HW3" };
  const rows = timelineRows({ day: "2026-10-12", today: "2026-10-12", items: [event("健身", "2026-10-12T19:30", "2026-10-12T20:30")], free: [slot("2026-10-12T17:03", "2026-10-12T19:30")], now: evening, timeZone: TZ, gap });
  const gapRow = rows.find((row) => row.type === "gap");
  assert.equal(gapRow?.type === "gap" && gapRow.match?.forItemId, "moodle:30512", "排進 is offered, not 新增行程");
  const later = timelineRows({ day: "2026-10-12", today: "2026-10-12", items: [], free: [slot("2026-10-12T20:30", "2026-10-12T23:00")], now: evening, timeZone: TZ, gap });
  assert.equal(later[1]?.type === "gap" && later[1].match, undefined, "a slot after the gap stays a plain slot");
});
