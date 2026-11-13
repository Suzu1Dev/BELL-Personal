/**
 * Pure helpers behind #/calendar (tested in calendar-model.test.ts): the day
 * timeline (now line, free slots, folded past rows), the week grid layout
 * (hour range, overlapping events side by side) and the small date phrases.
 * Every helper takes the IANA zone from the server's answer; the browser's
 * own zone is never used for a day.
 */
import type { CalendarItem, CalendarPageView, FreeSlot } from "../../../shared/calendar";
import { addDays, dayKey, daysBetween, localTime, zonedParts, zonedTimeToUtc, type DayKey } from "../../../shared/time";
import type { TodayGap } from "../../../shared/today";
import { monthDay } from "../../../shared/today-format";
import { CALENDAR, CALENDAR_MODEL, CALENDAR_PREFILL, calendarCopy } from "../../copy/calendar";
import type { OnboardingLocale } from "../../copy/onboarding";

const MINUTE = 60_000;

/** 「10/12（一）」 for a DayKey. */
export function dayTitle(day: DayKey): string {
  const [, month, date] = day.split("-").map(Number);
  return CALENDAR_MODEL.dayTitle(`${month}/${date}`, CALENDAR_MODEL.weekday(day));
}

/** 「10/12」 for a DayKey. */
export function dayShort(day: DayKey): string {
  const [, month, date] = day.split("-").map(Number);
  return `${month}/${date}`;
}

/** 「2026 年 11 月」 or 「November 2026」 for a DayKey. */
export function monthHeading(day: DayKey): string {
  const [year, month] = day.split("-").map(Number);
  return CALENDAR.monthHeading(year, month);
}

/** Shifts a DayKey by `deltaMonths`, clamping end-of-month dates cleanly (e.g. Jan 31 + 1 month → Feb 28). */
export function shiftMonth(day: DayKey, deltaMonths: number): DayKey {
  const [year, month, date] = day.split("-").map(Number);
  const totalMonths = year * 12 + (month - 1) + deltaMonths;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth0 = ((totalMonths % 12) + 12) % 12;
  const maxDate = new Date(Date.UTC(nextYear, nextMonth0 + 1, 0)).getUTCDate();
  const clampedDate = Math.min(date, maxDate);
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth0 + 1).padStart(2, "0")}-${String(clampedDate).padStart(2, "0")}`;
}

/** The anchor after ‹ or ›: one day, one week, or one month. */
export function shiftDay(day: DayKey, view: CalendarPageView, direction: -1 | 1): DayKey {
  if (view === "month") return shiftMonth(day, direction);
  return addDays(day, (view === "week" ? 7 : 1) * direction);
}

/** 「4」, 「1.5」: whole or half hours of a slot (as the Today gap counts them). */
export function slotHours(minutes: number): string {
  const hours = Math.floor(minutes / 30) / 2;
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/** When a source last synced: 「08:12」 today, 「昨天 22:10」, else 「10/9 22:10」. */
export function syncedLabel(iso: string, today: DayKey, timeZone: string, locale?: OnboardingLocale): string {
  const parts = zonedParts(timeZone, iso);
  const day = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const time = localTime(timeZone, iso);
  const ago = daysBetween(day, today);
  if (ago <= 0) return time;
  const copy = calendarCopy(locale).calendar;
  if (ago === 1) return copy.yesterdayAt(time);
  return copy.dateAt(`${parts.month}/${parts.day}`, time);
}

/** The palette prefill for 新增行程: 「+」 today, 「+10/14 」 another day, 「+今天 15:30-16:30 」 inside a free slot. */
export function prefillText(day: DayKey, today: DayKey, timeZone: string, slot?: FreeSlot): string {
  const date = day === today ? CALENDAR_PREFILL.today : dayShort(day);
  if (slot) {
    const start = Date.parse(slot.start);
    const end = Math.min(Date.parse(slot.end), start + 60 * MINUTE);
    return CALENDAR_PREFILL.slot(date, localTime(timeZone, start), localTime(timeZone, end));
  }
  return day === today ? CALENDAR_PREFILL.plain : CALENDAR_PREFILL.day(date);
}

export function localizeCalendarItem(item: CalendarItem): CalendarItem {
  const locale = calendarCopy();
  const zh = calendarCopy("zh-TW").calendarModel;
  const sourceLabels = new Map<string, string>();
  for (const key of Object.keys(zh.sourceLabels) as Array<keyof typeof zh.sourceLabels>) sourceLabels.set(zh.sourceLabels[key], locale.calendarModel.sourceLabels[key]);
  const weeklyLabels = new Map<string, string>();
  for (const day of ["2024-01-07", "2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06"]) weeklyLabels.set(calendarCopy("zh-TW").calendarModel.weeklyLabel(day), locale.calendarModel.weeklyLabel(day));
  const title = item.title === zh.untitledGoogleEvent
    ? locale.calendarModel.untitledGoogleEvent
    : item.kind === "due" && item.title.endsWith(" 截止")
      ? locale.calendarModel.dueItemTitle(item.title.slice(0, -3))
      : item.title;
  return {
    ...item,
    title,
    sourceLabel: sourceLabels.get(item.sourceLabel) ?? item.sourceLabel,
    meta: item.meta.split(" · ").map((part) => weeklyLabels.get(part) ?? sourceLabels.get(part) ?? part).join(" · "),
  };
}

function relativeStart(start: string, now: Date, timeZone: string): string {
  const copy = CALENDAR_MODEL.relativeStart;
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, start));
  if (days >= 1) return days === 1 ? copy.tomorrowAt(localTime(timeZone, start)) : copy.dateAt(monthDay(timeZone, start), localTime(timeZone, start));
  const minutes = Math.max(0, Math.round((Date.parse(start) - now.getTime()) / MINUTE));
  if (minutes < 60) return copy.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? copy.hoursMinutes(hours, rest) : copy.hours(hours);
}

export const isPast = (item: Pick<CalendarItem, "start" | "end" | "kind">, now: number) =>
  Date.parse(item.kind === "due" ? item.start : item.end ?? item.start) <= now;

export type TimelineRow =
  | { type: "item"; key: string; item: CalendarItem; past: boolean; soon?: string }
  | { type: "gap"; key: string; slot: FreeSlot; hours: string; match?: TodayGap }
  | { type: "now"; key: string; time: string }
  | { type: "fold"; key: string; count: number };

export interface TimelineInput {
  day: DayKey;
  today: DayKey;
  items: CalendarItem[];
  free: FreeSlot[];
  now: number;
  timeZone: string;
  /** Today's 排進 slot from GET /api/today, paired with the free slot that contains it. */
  gap?: TodayGap;
  /** Show the past rows instead of 「已結束 N 個 · 顯示」 (SPEC §4.8: more than 2 fold). */
  showPast?: boolean;
}

/**
 * The rows of one day in agenda grammar: all-day rows first, then timed
 * events, deadlines and free slots by start time; on today the 現在 line
 * sits before the first future row, the next event gets 「1 小時 28 分後」,
 * and more than two past rows fold into one.
 */
export function timelineRows(input: TimelineInput): TimelineRow[] {
  const { free, now, timeZone } = input;
  const items = input.items.map(localizeCalendarItem);
  const isToday = input.day === input.today;
  const allDay = items.filter((item) => item.allDay);
  const timed = items.filter((item) => !item.allDay);
  type Entry = { start: number; row: Extract<TimelineRow, { type: "item" | "gap" }> };
  const entries: Entry[] = [
    ...timed.map((item) => ({ start: Date.parse(item.start), row: { type: "item" as const, key: item.id, item, past: isPast(item, now) } })),
    ...free.map((slot) => {
      const start = Date.parse(slot.start);
      // Today's gap and this page's slot are computed at different moments when the gap starts now, so pair them by overlap.
      const gapStart = input.gap ? Date.parse(input.gap.start) : NaN;
      const gapEnd = input.gap?.end ? Date.parse(input.gap.end) : gapStart + 1;
      const match = input.gap && gapStart < Date.parse(slot.end) && gapEnd > start ? input.gap : undefined;
      return { start, row: { type: "gap" as const, key: `gap:${slot.start}`, slot, hours: slotHours(slot.minutes), ...(match ? { match } : {}) } };
    }),
  ].sort((a, b) => a.start - b.start || (a.row.type === "gap" ? 1 : -1));

  if (isToday) {
    const next = entries.find((entry) => entry.row.type === "item" && entry.row.item.kind === "event" && entry.start > now);
    if (next && next.row.type === "item") next.row.soon = relativeStart(next.row.item.start, new Date(now), timeZone);
  }

  const rows: TimelineRow[] = allDay.map((item) => ({ type: "item", key: item.id, item, past: false }));
  const past = isToday ? entries.filter((entry) => entry.row.type === "item" && entry.row.past) : [];
  const fold = past.length > 2 && !input.showPast;
  let nowPlaced = !isToday;
  let foldPlaced = false;
  for (const entry of entries) {
    if (!nowPlaced && (entry.start > now || (entry.row.type === "gap" && entry.start >= now))) {
      rows.push({ type: "now", key: "now", time: localTime(timeZone, now) });
      nowPlaced = true;
    }
    if (fold && entry.row.type === "item" && entry.row.past) {
      if (!foldPlaced) rows.push({ type: "fold", key: "fold", count: past.length });
      foldPlaced = true;
      continue;
    }
    rows.push(entry.row);
  }
  const dayEnd = Date.parse(zonedTimeToUtc(timeZone, addDays(input.day, 1)).toISOString());
  if (!nowPlaced && now < dayEnd) rows.push({ type: "now", key: "now", time: localTime(timeZone, now) });
  return rows;
}

/* --------------------------------------------------------------- week grid */

export interface WeekBlock {
  item: CalendarItem;
  /** Minutes from the grid's first hour. */
  top: number;
  height: number;
  lane: number;
  lanes: number;
  past: boolean;
}

/** The grid's hours: 07:00–23:00, widened to fit earlier or later events of the week. */
export function hourRange(days: { day: DayKey; items: CalendarItem[] }[], timeZone: string): { start: number; end: number } {
  let start = 7;
  let end = 23;
  for (const { day, items } of days) {
    for (const item of items) {
      if (item.allDay) continue;
      const begin = Date.parse(item.start);
      const finish = Date.parse(item.end ?? item.start);
      const dayStart = Date.parse(zonedTimeToUtc(timeZone, day).toISOString());
      const fromMidnight = (instant: number) => Math.max(0, Math.min(24 * 60, (instant - dayStart) / MINUTE));
      start = Math.min(start, Math.floor(fromMidnight(begin) / 60));
      end = Math.max(end, Math.ceil(fromMidnight(Math.max(finish, begin + 30 * MINUTE)) / 60));
    }
  }
  return { start: Math.max(0, start), end: Math.min(24, Math.max(end, start + 1)) };
}

/**
 * Timed rows of one day placed on the grid: minutes from `startHour`
 * (clipped to the day), at least 24 minutes tall, overlapping events split
 * into lanes.
 */
export function weekBlocks(day: DayKey, items: CalendarItem[], timeZone: string, startHour: number, endHour: number, now: number): WeekBlock[] {
  const origin = Date.parse(zonedTimeToUtc(timeZone, day, startHour, 0).toISOString());
  const limit = (endHour - startHour) * 60;
  const placed = items
    .filter((item) => !item.allDay)
    .map((item) => {
      const start = (Date.parse(item.start) - origin) / MINUTE;
      const end = item.kind === "due" ? start : (Date.parse(item.end ?? item.start) - origin) / MINUTE;
      const top = Math.max(0, Math.min(limit - 24, start));
      const bottom = Math.max(top + 24, Math.min(limit, item.kind === "due" ? top + 24 : end));
      return { item, top, height: bottom - top, lane: 0, lanes: 1, past: isPast(item, now) };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);
  // Clusters of overlapping blocks share their width; each block takes the first free lane.
  let cluster: typeof placed = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((block) => block.lane + 1));
    for (const block of cluster) block.lanes = lanes;
  };
  for (const block of placed) {
    if (block.top >= clusterEnd && cluster.length) { close(); cluster = []; }
    const laneEnds: number[] = [];
    for (const other of cluster) laneEnds[other.lane] = Math.max(laneEnds[other.lane] ?? -Infinity, other.top + other.height);
    let lane = 0;
    while (laneEnds[lane] !== undefined && laneEnds[lane] > block.top) lane++;
    block.lane = lane;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.top + block.height);
  }
  if (cluster.length) close();
  return placed;
}

/** Minutes from the grid's first hour to now, when now falls inside that day's grid. */
export function nowOffset(day: DayKey, timeZone: string, startHour: number, endHour: number, now: number): number | undefined {
  const origin = Date.parse(zonedTimeToUtc(timeZone, day, startHour, 0).toISOString());
  const minutes = (now - origin) / MINUTE;
  return minutes >= 0 && minutes <= (endHour - startHour) * 60 ? minutes : undefined;
}
