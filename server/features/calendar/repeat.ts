import type { ManualEvent } from "../../../shared/calendar.js";
import { addDays, dayKey, daysBetween, zonedParts, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";

/**
 * Weekly local events (ManualEvent.repeat) as occurrences. A series row stores
 * its first occurrence; every reader works with what falls in its window.
 *
 * An occurrence keeps the local wall-clock time of the first one (a 10:10 class
 * stays 10:10 in BELLPERSONAL_TZ, DST or not) and its length; an all-day event
 * keeps its length in days. Days are local days, so an occurrence that runs past
 * midnight belongs to the day it starts on (that day is its id and its skip key).
 */

const DAY_MS = 86_400_000;

export interface Occurrence {
  /** The local day the occurrence starts on: its identity within the series and the key of a skip. */
  day: DayKey;
  /** ISO instants; all-day occurrences run from local midnight to the local midnight after their last day. */
  start: string;
  end: string;
}

export interface Expansion {
  occurrences: Occurrence[];
  /** `limit` ran out before the window did (the rest is not expanded). */
  truncated: boolean;
}

/** Whether the series has an occurrence starting on `day` (before skips): the weekday of its first day, from it until `until`. */
export function isOccurrenceDay(event: Pick<ManualEvent, "start" | "repeat">, day: DayKey, timeZone: string): boolean {
  if (!event.repeat) return false;
  const offset = daysBetween(dayKey(timeZone, event.start), day);
  return offset >= 0 && offset % 7 === 0 && (!event.repeat.until || day <= event.repeat.until);
}

/**
 * The occurrences of a weekly event overlapping [from, to) (epoch ms), skipped
 * days left out, at most `limit` weeks looked at, so a huge window or `until`
 * never grows the work. Overlap follows the agenda's rule: it starts before
 * `to` and ends after `from` (a point event counts from `from` on).
 */
export function weeklyOccurrences(event: ManualEvent, from: number, to: number, timeZone: string, limit: number): Expansion {
  const repeat = event.repeat;
  if (!repeat || limit <= 0 || to <= from) return { occurrences: [], truncated: false };
  const startMs = Date.parse(event.start);
  const first = dayKey(timeZone, startMs);
  const skipped = new Set(repeat.skip);

  // Whole days from the first occurrence's start day to its exclusive end, or its length in ms.
  let spanDays = 1;
  let lengthMs = 0;
  if (event.allDay) {
    if (event.end) spanDays = Math.max(1, daysBetween(first, dayKey(timeZone, event.end)));
  } else if (event.end) lengthMs = Math.max(0, Date.parse(event.end) - startMs);
  const reach = event.allDay ? spanDays : Math.ceil(lengthMs / DAY_MS);

  // Weeks that can overlap: starting no later than the window's last day, and no earlier than `reach` days (+1 of slack) before its first.
  const fromDay = dayKey(timeZone, from);
  const lastDay = dayKey(timeZone, to - 1);
  const firstWeek = Math.max(0, Math.ceil(daysBetween(first, addDays(fromDay, -(reach + 1))) / 7));
  let lastWeek = Math.floor(daysBetween(first, lastDay) / 7);
  if (repeat.until) lastWeek = Math.min(lastWeek, Math.floor(daysBetween(first, repeat.until) / 7));

  const clock = zonedParts(timeZone, startMs);
  const secondsMs = startMs % 60_000;
  const occurrences: Occurrence[] = [];
  let week = firstWeek;
  for (let looked = 0; week <= lastWeek && looked < limit; week++, looked++) {
    const day = addDays(first, week * 7);
    if (skipped.has(day)) continue;
    let start: number;
    let end: number;
    if (event.allDay) {
      start = zonedTimeToUtc(timeZone, day).getTime();
      end = zonedTimeToUtc(timeZone, addDays(day, spanDays)).getTime();
    } else {
      start = week === 0 ? startMs : zonedTimeToUtc(timeZone, day, clock.hour, clock.minute).getTime() + secondsMs;
      end = start + lengthMs;
    }
    if (start < to && (end > from || (start === end && start >= from))) occurrences.push({ day, start: new Date(start).toISOString(), end: new Date(end).toISOString() });
  }
  return { occurrences, truncated: week <= lastWeek };
}
