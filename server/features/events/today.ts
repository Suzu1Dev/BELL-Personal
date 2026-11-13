import { EVENT_DECIDE_DAYS, type ExternalEvent } from "../../../shared/events.js";
import { CAPTURE_ORIGIN } from "../../../shared/suggestions.js";
import { addDays, dayBounds, dayKey, daysBetween, localTime } from "../../../shared/time.js";
import type { QueueCandidate, QueueItem, TodayContribution, TodayInput } from "../../../shared/today.js";
import { durationText, monthDayWeek, queueAction, timeWhen } from "../../../shared/today-format.js";
import type { ModuleContext } from "../../modules.js";
import { calendarService } from "../calendar/store.js";
import { suggestionIsMoot } from "../../today/suggestions.js";
import { upcomingEvents, type UpcomingEvent } from "./catalog.js";

/** 明天與之後 horizon (SPEC §4.5). */
const LATER_DAYS = 14;
/**
 * Rows sent to the core, nearest first. The core shows two event.decide rows
 * and three later events; a busy feed (or 2000 occurrences from one) must not
 * pass the contribution caps and drop every event row.
 */
export const EVENT_QUEUE_CAP = 50;
export const LATER_EVENTS_CAP = 100;

/**
 * The events module's part of #/today:
 *  - queue: `event.decide` rows 「{name}，要參加嗎？」 for CTFs (weight ≥
 *    ctftime.minWeight) and feed events starting within 7 days that are not
 *    marked 要參加 (the core keeps the two nearest, in 可以等);
 *  - later.events: those events and the rest within 14 days (hidden while
 *    their row is open in the queue); events marked 要參加 come from the
 *    calendar's local events instead;
 *  - nav.events: new suggestions — events found in mail waiting for a decision.
 */
export function eventsToday(ctx: ModuleContext, input: TodayInput): TodayContribution {
  const { now, timeZone, day } = input;
  const going = calendarService(ctx).goingByItem();
  const events = upcomingEvents(ctx, now, LATER_DAYS + 1).filter((entry) => !going.has(entry.itemId));
  const decideUntil = now.getTime() + EVENT_DECIDE_DAYS * 86_400_000;
  const queue = events
    .filter((entry) => Date.parse(entry.event.start) > now.getTime() && Date.parse(entry.event.start) <= decideUntil)
    .slice(0, EVENT_QUEUE_CAP)
    .map((entry) => decideRow(entry, now, timeZone));
  const laterFrom = Date.parse(dayBounds(timeZone, addDays(day, 1)).start);
  const laterEvents = events
    .filter((entry) => Date.parse(entry.event.start) >= laterFrom)
    .slice(0, LATER_EVENTS_CAP)
    .map((entry) => ({
      start: entry.event.start,
      title: entry.event.title,
      meta: [placeOf(entry.event), entry.sourceLabel].filter(Boolean).join(" · "),
      itemId: entry.itemId,
    }));
  const pending = ctx.suggestions.list({ status: "pending", kind: "event", limit: 200 })
    .filter((suggestion) => suggestion.origin !== CAPTURE_ORIGIN && !suggestionIsMoot(suggestion, input)).length;
  return { queue, later: { events: laterEvents }, nav: { events: pending } };
}

function placeOf(event: ExternalEvent): string | undefined {
  if (event.online) return "線上";
  return event.location || undefined;
}

/** 「10/17（六）08:00 起 48 小時」, 「10/30（五） 整天」. */
export function eventWhenText(event: ExternalEvent, timeZone: string): string {
  if (event.allDay) {
    const end = event.end ? Date.parse(event.end) : Number.NaN;
    const days = Number.isNaN(end) ? 1 : Math.max(1, daysBetween(dayKey(timeZone, event.start), dayKey(timeZone, new Date(end - 1))) + 1);
    return days > 1 ? `${monthDayWeek(timeZone, event.start)}起 ${days} 天` : `${monthDayWeek(timeZone, event.start)} 整天`;
  }
  const start = `${monthDayWeek(timeZone, event.start)}${localTime(timeZone, event.start)}`;
  if (!event.end) return start;
  const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60_000);
  return minutes > 0 ? `${start} 起 ${durationText(minutes)}` : start;
}

/** `.when`: 「還有 5 天」 (muted), tomorrow 「明天 08:00」, today 「14:00」. */
export function eventWhen(event: ExternalEvent, now: Date, timeZone: string): NonNullable<QueueItem["when"]> {
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, event.start));
  if (days >= 2) return { label: `還有 ${days} 天`, tone: "muted", mono: false };
  return timeWhen(event.start, now, timeZone);
}

/** SPEC §4.3 event.decide: 「Balsn CTF 2026，要參加嗎？」 · 「CTFtime · 10/17（六）08:00 起 48 小時 · 線上 · 權重 55」. */
export function decideRow(entry: UpcomingEvent, now: Date, timeZone: string): QueueCandidate {
  const { event } = entry;
  const extra = entry.category === "ctf"
    ? (typeof event.weight === "number" ? [`權重 ${Math.round(event.weight)}`] : [])
    : (event.organizer && event.organizer !== entry.sourceLabel ? [event.organizer] : []);
  const place = placeOf(event);
  return {
    id: entry.itemId,
    kind: "event.decide",
    source: entry.source === "ctftime" ? "ctftime" : "feed",
    title: `${event.title}，要參加嗎？`,
    subject: event.title,
    meta: [entry.sourceLabel, eventWhenText(event, timeZone), ...(place ? [place] : []), ...extra],
    when: eventWhen(event, now, timeZone),
    actions: [queueAction("going"), queueAction("dismiss")],
    ...(event.url ? { url: event.url } : {}),
    hints: { startsAt: event.start, fingerprint: event.start },
  };
}
