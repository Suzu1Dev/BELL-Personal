import { UNSORTED_COURSE, type Assignment } from "../../../shared/assignments.js";
import { FREE_SLOT_WINDOW, REPEAT_LIMITS, weeklyLabel, type CalendarEvent, type CalendarItem, type FreeSlot, type ManualEvent } from "../../../shared/calendar.js";
import type { ExternalEvent, FeedSubscription } from "../../../shared/events.js";
import { dayBounds, dayKey, isDayKey, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import type { SourceItem } from "../../stores/source-items.js";
import { feedStore } from "../events/feeds.js";
import { nativeDeadlines } from "../lms/native.js";
import { googleEventIdOf } from "./google.js";
import { weeklyOccurrences } from "./repeat.js";
import { calendarService } from "./store.js";

/**
 * Every calendar row in a time window, from three sources merged into one
 * list (CalendarItem): Google events, personal iCal feeds and local events.
 * A local event that was also inserted into Google shows once: the Google
 * copy (what the user may have edited there) carrying the local flags.
 * Events whose title matches a habit keyword get habitLink (健身 → 運動).
 * Pure helpers (free slots, habit matching) are exported for tests.
 */

export const SOURCE_TEXT = {
  google: "Google 行事曆",
  manual: "本機行程",
  ctftime: "CTFtime",
  feeds: "活動訂閱",
  moodle: "NYCU E3",
  moodleGeneric: "Moodle",
  canvas: "Canvas",
} as const;

/** Built-in synonyms so a habit named 運動 is linked from 健身/重訓/跑步 without setup (SPEC §4.7). */
const HABIT_SYNONYMS: Record<string, string[]> = {
  運動: ["運動", "健身", "重訓", "跑步", "慢跑", "游泳", "瑜珈", "瑜伽", "健行", "騎車"],
  閱讀: ["閱讀", "讀書會"],
};

export interface HabitKeywords {
  id: string;
  name: string;
  keywords: string[];
}

/** Active habits and the event words that check them in (the habits table is read, never written). */
export function habitKeywords(ctx: Pick<ModuleContext, "db">): HabitKeywords[] {
  try {
    const rows = ctx.db.personal.db.prepare("SELECT json FROM habits WHERE archived = 0 ORDER BY sort_order").all();
    return rows.flatMap((row) => {
      try {
        const habit = JSON.parse(String(row.json)) as { id?: unknown; name?: unknown; keywords?: unknown };
        if (typeof habit.id !== "string" || typeof habit.name !== "string") return [];
        const own = Array.isArray(habit.keywords) ? habit.keywords.filter((word): word is string => typeof word === "string" && word.trim().length > 0) : [];
        const keywords = own.length ? own : HABIT_SYNONYMS[habit.name] ?? [habit.name];
        return [{ id: habit.id, name: habit.name, keywords: keywords.map((word) => word.trim()) }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** The habit an event title checks in, if any (first habit in user order). */
export function matchHabit(title: string, habits: HabitKeywords[]): HabitKeywords | undefined {
  const text = title.toLowerCase();
  return habits.find((habit) => habit.keywords.some((word) => word && text.includes(word.toLowerCase())));
}

/** ISO instants of a CalendarEvent (all-day DayKeys → local midnights). */
export function eventInstants(event: Pick<CalendarEvent, "start" | "end" | "allDay">, timeZone: string): { start: string; end: string } {
  const toInstant = (value: string) => (isDayKey(value) ? zonedTimeToUtc(timeZone, value).toISOString() : new Date(value).toISOString());
  const start = toInstant(event.start);
  const end = event.end ? toInstant(event.end) : start;
  return { start, end: Date.parse(end) >= Date.parse(start) ? end : start };
}

/** 「工程三館 EC115 · 林志明 · 每週一」: the location, the first line of the notes and, for a weekly event, its repeat. */
function eventMeta(location: string | undefined, note: string | undefined, repeat?: string): string {
  const first = note?.split("\n").map((line) => line.trim()).find(Boolean);
  const short = first && first.length > 40 ? `${first.slice(0, 39)}…` : first;
  return [location, short, repeat].filter(Boolean).join(" · ");
}

/** What a row of a weekly series says about it: the occurrence's day, the series' first day and its stored repeat (what the editor shifts and an undo restores). */
function seriesOf(event: ManualEvent, day: DayKey, timeZone: string): NonNullable<CalendarItem["repeat"]> {
  const { until, skip } = event.repeat ?? {};
  return { freq: "weekly", day, first: dayKey(timeZone, event.start), ...(until ? { until } : {}), ...(skip?.length ? { skip } : {}) };
}

export interface CollectOptions {
  /** Add assignment deadlines (moodle/canvas, not submitted) as `due` rows. */
  deadlines?: boolean;
}

/** Calendar rows overlapping [from, to), sorted by start (all-day first). */
export function collectItems(ctx: ModuleContext, from: string, to: string, options: CollectOptions = {}): CalendarItem[] {
  const timeZone = ctx.config.timeZone;
  const fromTime = Date.parse(from);
  const toTime = Date.parse(to);
  const slack = new Date(fromTime - 14 * 86_400_000).toISOString();
  const overlaps = (start: string, end: string) => Date.parse(start) < toTime && (Date.parse(end) > fromTime || (start === end && Date.parse(start) >= fromTime));
  const habits = habitKeywords(ctx);
  const feedLabels = new Map(feedStore(ctx).list().map((feed: FeedSubscription) => [feed.id, feed.label]));

  const items: CalendarItem[] = [];
  const googleByEventId = new Map<string, CalendarItem>();
  const window = { field: "startsAt" as const, from: slack, to };
  for (const source of ["google-calendar", "ics"] as const) {
    for (const row of ctx.sourceItems.list<CalendarEvent>({ source, kind: "calendar-event", window })) {
      const event = row.value;
      if (!event?.id || !event.title || event.status === "cancelled") continue;
      const { start, end } = eventInstants(event, timeZone);
      if (!overlaps(start, end)) continue;
      const google = source === "google-calendar";
      const item: CalendarItem = {
        id: event.id,
        kind: "event",
        origin: google ? "google" : "ics",
        title: event.title,
        start,
        end,
        allDay: event.allDay,
        meta: eventMeta(event.location, event.description),
        ...(event.location ? { location: event.location } : {}),
        ...(event.description ? { notes: event.description } : {}),
        ...(event.url ? { url: event.url } : {}),
        sourceLabel: google ? SOURCE_TEXT.google : (event.calendarId && feedLabels.get(event.calendarId)) || event.calendarName || SOURCE_TEXT.feeds,
        inGoogle: google,
        ...(google ? { googleEditable: event.editable ?? !event.calendarId?.endsWith(".calendar.google.com") } : {}),
        ...(event.transparent ? { transparent: true } : {}),
      };
      items.push(item);
      const googleId = google ? googleEventIdOf(event) : undefined;
      if (googleId) googleByEventId.set(googleId, item);
    }
  }

  const service = calendarService(ctx);
  /** One row of a local event: the event itself, or one occurrence of a weekly series (`when`). */
  const manualItem = (event: ManualEvent, when: { id: string; start: string; end: string; repeatDay?: DayKey }): CalendarItem => {
    const going = event.origin === "going";
    return {
      id: when.id,
      kind: "event",
      origin: "manual",
      title: event.title,
      start: when.start,
      end: when.end,
      allDay: event.allDay,
      meta: eventMeta(event.location, going ? sourceOfGoing(ctx, event) : event.notes, when.repeatDay ? weeklyLabel(when.repeatDay) : undefined),
      ...(event.location ? { location: event.location } : {}),
      ...(event.notes ? { notes: event.notes } : {}),
      ...(event.url ? { url: event.url } : {}),
      sourceLabel: going ? sourceOfGoing(ctx, event) ?? SOURCE_TEXT.manual : SOURCE_TEXT.manual,
      manualId: event.id,
      ...(when.repeatDay ? { repeat: seriesOf(event, when.repeatDay, timeZone) } : {}),
      inGoogle: !!event.googleEventId || service.isPending(event.id) || service.isInserting(event.id),
      ...(event.origin === "capture" ? { typed: true } : {}),
      ...(event.origin === "capture" && event.pretidy ? { tidied: true } : {}),
      ...(going ? { going: true } : {}),
    };
  };
  for (const event of service.between(from, to)) {
    const end = event.end ?? event.start;
    if (!overlaps(event.start, end)) continue;
    const twin = event.googleEventId ? googleByEventId.get(event.googleEventId) : undefined;
    if (twin) {
      Object.assign(twin, {
        manualId: event.id,
        ...(event.origin === "going" ? { going: true } : {}),
        ...(!twin.url && event.url ? { url: event.url } : {}),
        ...(!twin.notes && event.notes ? { notes: event.notes } : {}),
      });
      continue;
    }
    items.push(manualItem(event, { id: `manual:${event.id}`, start: event.start, end }));
  }
  // Weekly series: only the occurrences in the window, within one budget for the whole read.
  let budget: number = REPEAT_LIMITS.occurrencesPerRead;
  for (const series of service.series(from, to)) {
    const { occurrences, truncated } = weeklyOccurrences(series, fromTime, toTime, timeZone, budget);
    for (const occurrence of occurrences)
      items.push(manualItem(series, { id: `manual:${series.id}:${occurrence.day}`, start: occurrence.start, end: occurrence.end, repeatDay: occurrence.day }));
    budget -= occurrences.length;
    if (truncated || budget <= 0) {
      logEvent("calendar.repeat_capped", { limit: REPEAT_LIMITS.occurrencesPerRead });
      break;
    }
  }

  for (const item of items) {
    const habit = item.allDay ? undefined : matchHabit(item.title, habits);
    if (habit) Object.assign(item, { habitLink: habit.name, habitId: habit.id });
  }

  if (options.deadlines) items.push(...deadlineItems(ctx, from, to));
  return items.sort((a, b) => compareItems(a, b, timeZone));
}

/** The feed or CTFtime label of an event marked 要參加 (from the cached ExternalEvent, else its source). */
function sourceOfGoing(ctx: ModuleContext, event: ManualEvent): string | undefined {
  const ref = event.sourceRef;
  if (!ref) return undefined;
  if (ref.source === "ctftime") return SOURCE_TEXT.ctftime;
  if (ref.source === "feeds") {
    const cached = ctx.sourceItems.get<ExternalEvent>("feeds", ref.externalId)?.value;
    const label = cached?.feedId ? feedStore(ctx).get(cached.feedId)?.label : undefined;
    return label ?? cached?.feedName ?? SOURCE_TEXT.feeds;
  }
  return undefined;
}

/** Assignment deadlines in [from, to) that are not submitted: 「HW3 截止」 · 「作業系統 · NYCU E3」. */
function deadlineItems(ctx: ModuleContext, from: string, to: string): CalendarItem[] {
  const rows: SourceItem<Assignment>[] = [];
  for (const source of ["moodle", "canvas"] as const)
    rows.push(...ctx.sourceItems.list<Assignment>({ source, kind: "assignment", window: { field: "dueAt", from, to } }));
  // Assignments from a teacher's mail or added on #/work (lms module, SPEC-mail-assignments §5.9): 「信件」 / 「手動」.
  const native = nativeDeadlines(ctx, from, to);
  return [...rows.map((row) => row.value), ...native].flatMap((assignment) => {
    if (!assignment?.dueAt || assignment.submission === "submitted" || assignment.submission === "graded") return [];
    const short = assignment.title.split(/[：:]/)[0].trim() || assignment.title;
    const label = native.includes(assignment) ? assignment.site?.label ?? SOURCE_TEXT.manual
      : assignment.origin === "canvas" ? SOURCE_TEXT.canvas : /(^|\.)e3p?\.nycu\.edu\.tw$/.test(hostOf(assignment.url)) ? SOURCE_TEXT.moodle : SOURCE_TEXT.moodleGeneric;
    return [{
      id: `due:${assignment.id}`,
      kind: "due" as const,
      origin: "assignment" as const,
      title: `${short} 截止`,
      start: new Date(assignment.dueAt).toISOString(),
      allDay: false,
      meta: [assignment.courseName === UNSORTED_COURSE ? "" : assignment.courseName, label].filter(Boolean).join(" · "),
      ...(assignment.url ?? assignment.mailRef?.url ? { url: assignment.url ?? assignment.mailRef?.url } : {}),
      sourceLabel: label,
      inGoogle: false,
    }];
  });
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : ""; } catch { return ""; }
}

function compareItems(a: CalendarItem, b: CalendarItem, timeZone: string): number {
  if (a.allDay !== b.allDay && dayKey(timeZone, a.start) === dayKey(timeZone, b.start)) return a.allDay ? -1 : 1;
  return Date.parse(a.start) - Date.parse(b.start) || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1) || a.title.localeCompare(b.title);
}

/** Rows overlapping one local day. */
export function itemsOnDay(items: CalendarItem[], day: DayKey, timeZone: string): CalendarItem[] {
  const { start, end } = dayBounds(timeZone, day);
  const from = Date.parse(start);
  const to = Date.parse(end);
  return items.filter((item) => {
    const itemStart = Date.parse(item.start);
    const itemEnd = Date.parse(item.end ?? item.start);
    return itemStart < to && (itemEnd > from || (itemEnd === itemStart && itemStart >= from));
  });
}

/**
 * Free slots of a day (#/calendar): stretches of at least `minMinutes`
 * between startHour and endHour local time that no timed event covers; for
 * today they start no earlier than now. All-day events, deadlines and events
 * shown as free (顯示為有空) do not block time.
 */
export function freeSlots(items: Pick<CalendarItem, "start" | "end" | "allDay" | "kind" | "transparent">[], day: DayKey, timeZone: string, now: Date, window: { startHour: number; endHour: number; minMinutes: number } = FREE_SLOT_WINDOW): FreeSlot[] {
  const dayStart = zonedTimeToUtc(timeZone, day, window.startHour, 0).getTime();
  const dayEnd = window.endHour >= 24 ? Date.parse(dayBounds(timeZone, day).end) : zonedTimeToUtc(timeZone, day, window.endHour, 0).getTime();
  let cursor = dayKey(timeZone, now) === day ? Math.max(dayStart, now.getTime()) : dayStart;
  if (cursor >= dayEnd) return [];
  const busy = items
    .filter((item) => item.kind === "event" && !item.allDay && item.end && !item.transparent)
    .map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end!) }))
    .filter((block) => block.end > cursor && block.start < dayEnd)
    .sort((a, b) => a.start - b.start);
  const slots: FreeSlot[] = [];
  const add = (start: number, end: number) => {
    const minutes = Math.floor((end - start) / 60_000);
    if (minutes >= window.minMinutes) slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), minutes });
  };
  for (const block of busy) {
    if (block.start > cursor) add(cursor, Math.min(block.start, dayEnd));
    cursor = Math.max(cursor, block.end);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) add(cursor, dayEnd);
  return slots;
}
