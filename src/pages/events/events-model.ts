/**
 * Pure helpers behind #/events (tested in events-model.test.ts): filter
 * counts, the date grouping (進行中 · 這週 · 下週 · 之後), the date block and
 * the time phrases of an EventCard. Days are computed in the server's zone.
 */
import type { EventFilter, EventListItem, EventSuggestionItem, EventsResponse } from "../../../shared/events";
import { addDays, dayKey, daysBetween, localTime, weekdayOf, type DayKey } from "../../../shared/time";
import { dayLabel, durationText, monthDay, monthDayWeek } from "../../../shared/today-format";
import { eventsCopy } from "../../copy/events";
import { onboardingLocale, type OnboardingLocale } from "../../copy/onboarding";

export type EventEntry =
  | { type: "event"; id: string; start: string; end?: string; item: EventListItem }
  | { type: "suggestion"; id: string; start: string; end?: string; item: EventSuggestionItem };

export type EventBucket = "now" | "week" | "next" | "later";
export const EVENT_BUCKETS: EventBucket[] = ["now", "week", "next", "later"];

/** Every card, nearest first: external events and the events found in mail. */
export function allEntries(data: Pick<EventsResponse, "events" | "suggestions">): EventEntry[] {
  const entries: EventEntry[] = [
    ...data.events.map((item) => ({ type: "event" as const, id: item.id, start: item.start, ...(item.end ? { end: item.end } : {}), item })),
    ...data.suggestions.map((item) => ({ type: "suggestion" as const, id: item.id, start: item.start, ...(item.end ? { end: item.end } : {}), item })),
  ];
  return entries.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
}

export function matchesFilter(entry: EventEntry, filter: EventFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "mail": return entry.type === "suggestion";
    case "going": return entry.type === "event" && entry.item.going;
    case "ctf": return entry.type === "event" && entry.item.category === "ctf";
    case "community": return entry.type === "event" && entry.item.category === "community";
  }
}

export function filterCounts(entries: EventEntry[]): Record<EventFilter, number> {
  const filters: EventFilter[] = ["all", "going", "ctf", "community", "mail"];
  return Object.fromEntries(filters.map((filter) => [filter, entries.filter((entry) => matchesFilter(entry, filter)).length])) as Record<EventFilter, number>;
}

/** Monday of the week containing `day`. */
function mondayOf(day: DayKey): DayKey {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** 進行中 (started, not ended), 這週 (until Sunday), 下週, 之後. */
export function bucketOf(entry: Pick<EventEntry, "start" | "end">, now: number, timeZone: string): EventBucket {
  const start = Date.parse(entry.start);
  if (start <= now) return "now";
  const today = dayKey(timeZone, now);
  const days = daysBetween(mondayOf(today), dayKey(timeZone, entry.start));
  if (days < 7) return "week";
  if (days < 14) return "next";
  return "later";
}

export function groupEntries(entries: EventEntry[], now: number, timeZone: string): { bucket: EventBucket; entries: EventEntry[] }[] {
  return EVENT_BUCKETS
    .map((bucket) => ({ bucket, entries: entries.filter((entry) => bucketOf(entry, now, timeZone) === bucket) }))
    .filter((group) => group.entries.length > 0);
}

/** The date block: 「10/17」 over 「週六」 (or 今天 / 明天). */
export function dateBlock(start: string, now: number, timeZone: string, locale: OnboardingLocale = onboardingLocale()): { date: string; label: string } {
  return { date: monthDay(timeZone, start), label: dayLabel(timeZone, start, new Date(now), locale) };
}

/** The right-hand phrase: 進行中, 「今天 14:00」, 「明天 08:00」, 「還有 5 天」. */
export function untilText(entry: Pick<EventEntry, "start">, now: number, timeZone: string, locale: OnboardingLocale = onboardingLocale()): { label: string; muted: boolean } {
  const { events: EVENTS } = eventsCopy(locale);
  const start = Date.parse(entry.start);
  if (start <= now) return { label: EVENTS.ongoing, muted: false };
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, entry.start));
  if (days === 0) return { label: EVENTS.today(localTime(timeZone, entry.start)), muted: false };
  if (days === 1) return { label: EVENTS.tomorrow(localTime(timeZone, entry.start)), muted: false };
  return { label: EVENTS.daysLeft(days), muted: true };
}

/** 「08:00 起 48 小時」, 「13:30 起 4 小時」, 「整天」, 「連續 3 天」. */
export function timeText(item: { start: string; end?: string; allDay: boolean }, timeZone: string, locale: OnboardingLocale = onboardingLocale()): string {
  const { events: EVENTS } = eventsCopy(locale);
  if (item.allDay) {
    if (!item.end) return EVENTS.allDay;
    const days = daysBetween(dayKey(timeZone, item.start), dayKey(timeZone, Date.parse(item.end) - 1)) + 1;
    return days > 1 ? EVENTS.allDays(days) : EVENTS.allDay;
  }
  const time = localTime(timeZone, item.start);
  if (!item.end) return EVENTS.starts(time);
  const minutes = Math.round((Date.parse(item.end) - Date.parse(item.start)) / 60_000);
  return minutes > 0 ? EVENTS.lasts(time, durationText(minutes, locale)) : EVENTS.starts(time);
}

/** The meta line under a card's title. */
export function metaLine(entry: EventEntry, timeZone: string, locale: OnboardingLocale = onboardingLocale()): string {
  const { events: EVENTS } = eventsCopy(locale);
  if (entry.type === "suggestion") {
    const item = entry.item;
    return [timeText(item, timeZone, locale), item.location, item.origin ? EVENTS.from(item.origin) : undefined].filter(Boolean).join(" · ");
  }
  const item = entry.item;
  const place = item.online ? EVENTS.online : item.location;
  const extra = item.category === "ctf"
    ? [item.format, typeof item.weight === "number" ? EVENTS.weight(item.weight) : undefined]
    : [item.organizer && !item.sourceLabel.includes(item.organizer) ? item.organizer : undefined];
  return [timeText(item, timeZone, locale), place, ...extra, item.sourceLabel].filter(Boolean).join(" · ");
}

/**
 * What 解釋這個 sends for an event, as plain text: the title, then the date
 * and time, the place and who runs it (the list has no description).
 */
export function explainEventText(entry: EventEntry, timeZone: string, locale: OnboardingLocale = onboardingLocale()): string {
  const { events: EVENTS } = eventsCopy(locale);
  const item = entry.item;
  const when = `${monthDayWeek(timeZone, item.start, locale)} ${timeText(item, timeZone, locale)}`;
  const place = entry.type === "event" && entry.item.online ? EVENTS.online : item.location;
  const lines = [when, place ? EVENTS.explain.place(place) : undefined];
  if (entry.type === "suggestion") {
    if (entry.item.origin) lines.push(EVENTS.from(entry.item.origin));
  } else {
    const event = entry.item;
    if (event.organizer) lines.push(EVENTS.explain.organizer(event.organizer));
    if (event.category === "ctf" && event.format) lines.push(event.format);
    lines.push(EVENTS.explain.source(event.sourceLabel));
  }
  return [item.title.trim(), lines.filter(Boolean).join("\n")].join("\n\n");
}
