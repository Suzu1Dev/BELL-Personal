import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarItem } from "../../../shared/calendar";
import type { TodayHabit } from "../../../shared/today";
import { AgendaTimeline } from "./AgendaTimeline";
import { timelineRows } from "./calendar-model";

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const gym: CalendarItem = {
  id: "google:primary:gym", kind: "event", origin: "google", title: "健身", start: at("2026-10-12T19:30"), end: at("2026-10-12T20:30"),
  allDay: false, meta: "光復校區 體育館", sourceLabel: "Google 行事曆", inGoogle: true, habitLink: "運動", habitId: "habit-move",
};
const habit = (doneToday: boolean): TodayHabit => ({ id: "habit-move", name: "運動", short: "運動", cadence: "每週 3 次 · 0/3", doneToday, week: [], streak: 4, streakUnit: "週" });
const render = (now: string, habits: TodayHabit[]) => renderToStaticMarkup(createElement(AgendaTimeline, {
  rows: timelineRows({ day: "2026-10-12", today: "2026-10-12", items: [gym], free: [], now: Date.parse(at(now)), timeZone: TZ, showPast: true }),
  timeZone: TZ, habits, onCheckIn: () => {},
}));

test("an ended event linked to an open habit offers 打卡「運動」; before it ends the meta says so instead", () => {
  assert.match(render("2026-10-12T18:00", [habit(false)]), /結束後一鍵打卡「運動」/);
  assert.doesNotMatch(render("2026-10-12T18:00", [habit(false)]), /tl-checkin/);
  const ended = render("2026-10-12T21:00", [habit(false)]);
  assert.match(ended, /class="tl-row is-past is-habit is-checkin"/);
  assert.match(ended, /打卡「運動」<\/button>|打卡「運動」<\/span><\/button>/);
  assert.doesNotMatch(render("2026-10-12T21:00", [habit(true)]), /tl-checkin/, "nothing to do once the habit is checked");
});

test("a weekly row shows the repeat mark and its 每週一 meta, and its trash button opens the delete choice", () => {
  const weekly: CalendarItem = {
    id: "manual:os:2026-10-19", kind: "event", origin: "manual", title: "作業系統", start: at("2026-10-19T10:10"), end: at("2026-10-19T12:00"), allDay: false,
    meta: "工程三館 EC115 · 每週一", sourceLabel: "本機行程", manualId: "os", inGoogle: false, repeat: { freq: "weekly", day: "2026-10-19", first: "2026-09-07" },
  };
  const row = (item: CalendarItem) => renderToStaticMarkup(createElement(AgendaTimeline, {
    rows: timelineRows({ day: "2026-10-19", today: "2026-10-12", items: [item], free: [], now: Date.parse(at("2026-10-12T09:00")), timeZone: TZ, showPast: true }),
    timeZone: TZ, onRemove: () => {},
  }));
  const html = row(weekly);
  assert.match(html, /<span><svg[^>]*class="[^"]*tl-repeat[^"]*"[^>]*>.*?<\/svg>工程三館 EC115 · 每週一 · 本機行程<\/span>/);
  assert.match(html, /<button[^>]*class="btn btn-icon btn-sm tl-del"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"|<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*class="btn btn-icon btn-sm tl-del"/);
  const { repeat: _repeat, ...oneOff } = weekly;
  const plain = row({ ...oneOff, id: "manual:os", meta: "工程三館 EC115" });
  assert.doesNotMatch(plain, /tl-repeat|aria-haspopup/, "a one-off event deletes at once");
  assert.match(plain, /class="btn btn-icon btn-sm tl-del"/);
});

test("a local event not in Google offers a pencil before the trash button; Google rows and local copies in Google do not", () => {
  const local: CalendarItem = {
    id: "manual:study", kind: "event", origin: "manual", title: "讀書會", start: at("2026-10-19T19:00"), end: at("2026-10-19T20:00"), allDay: false,
    meta: "圖書館", sourceLabel: "本機行程", manualId: "study", inGoogle: false,
  };
  const row = (item: CalendarItem, edit = true) => renderToStaticMarkup(createElement(AgendaTimeline, {
    rows: timelineRows({ day: "2026-10-19", today: "2026-10-12", items: [item], free: [], now: Date.parse(at("2026-10-12T09:00")), timeZone: TZ, showPast: true }),
    timeZone: TZ, onRemove: () => {}, ...(edit ? { onEdit: () => {} } : {}),
  }));
  const html = row(local);
  assert.match(html, /data-manual="study"/);
  assert.match(html, /<button[^>]*class="btn btn-icon btn-sm tl-edit"[^>]*aria-label="編輯行程「讀書會」"[^>]*>|<button[^>]*aria-label="編輯行程「讀書會」"[^>]*class="btn btn-icon btn-sm tl-edit"/);
  assert.ok(html.indexOf("tl-edit") < html.indexOf("tl-del"), "next to the trash, before it");
  assert.doesNotMatch(row(local, false), /tl-edit/, "the page decides: no handler, no pencil");
  assert.doesNotMatch(row({ ...local, inGoogle: true }), /tl-edit/, "nothing updates a Google copy");
  assert.doesNotMatch(row(gym), /tl-edit/, "Google and iCal rows");
  assert.match(row({ ...local, repeat: { freq: "weekly", day: "2026-10-19", first: "2026-09-07" }, meta: "圖書館 · 每週一" }), /tl-edit/, "a weekly row too");
});
