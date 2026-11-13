import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarDay, CalendarItem } from "../../../shared/calendar";
import { addDays } from "../../../shared/time";
import { MonthGrid } from "./MonthGrid";

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const NOW = Date.parse(at("2026-10-12T09:00"));

test("MonthGrid renders 35 aligned day cells, outside-month markers, overflow count, and selected-day agenda", () => {
  const busyItems: CalendarItem[] = [1, 2, 3, 4, 5].map((n) => ({
    id: `google:primary:ev${n}`,
    kind: "event",
    origin: "google",
    title: `專題會議 ${n}`,
    start: at(`2026-10-12T1${n}:00`),
    end: at(`2026-10-12T1${n}:45`),
    allDay: false,
    meta: "工程三館",
    location: "工程三館",
    sourceLabel: "Google 行事曆",
    inGoogle: true,
    googleEditable: true,
  }));

  const days: CalendarDay[] = Array.from({ length: 35 }, (_, idx) => {
    const day = addDays("2026-09-28", idx);
    return {
      day,
      items: day === "2026-10-12" ? busyItems : [],
      free: [],
    };
  });

  const html = renderToStaticMarkup(createElement(MonthGrid, {
    days,
    anchorDay: "2026-10-12",
    selectedDay: "2026-10-12",
    today: "2026-10-12",
    timeZone: TZ,
    now: NOW,
    googleCanWrite: true,
    onSelectDay: () => {},
    onOpenDay: () => {},
    onCreateOnDay: () => {},
    onEdit: () => {},
    onRemove: () => {},
  }));

  assert.equal((html.match(/class="mo-cell[\s"]/g) ?? []).length, 35, "35 day cells in 5-week October matrix");
  assert.match(html, /is-outside/, "September/November padding days are marked outside");
  assert.match(html, /\+2 筆/, "5 items show 3 pills + '+2 筆' overflow");
  assert.match(html, /專題會議 5/, "Selected-Day Inspector renders all 5 items in full AgendaTimeline");
  assert.match(html, /編輯行程「專題會議 1」/, "Google Calendar events are directly editable when googleCanWrite is true");
});
