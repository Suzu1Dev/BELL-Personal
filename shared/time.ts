/**
 * Day arithmetic in the user's time zone. The host clock is UTC while the user
 * lives in Asia/Taipei, so a "day" is never computed from Date#getDate():
 * every helper takes the IANA zone explicitly. Pure: no Node APIs.
 *
 * Instants are ISO 8601 UTC strings ("2026-10-12T16:00:00.000Z").
 * Days are local calendar dates "YYYY-MM-DD" (DayKey).
 */
export const DEFAULT_TIME_ZONE = "Asia/Taipei";

/** A local calendar date, "YYYY-MM-DD". */
export type DayKey = string;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

function toDate(instant: Date | string | number): Date {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid instant");
  return date;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone }); return true; } catch { return false; }
}

export function isDayKey(value: unknown): value is DayKey {
  if (typeof value !== "string") return false;
  const match = DAY_KEY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

/** Wall-clock fields of an instant in a zone. */
export function zonedParts(timeZone: string, instant: Date | string | number) {
  const values: Record<string, string> = {};
  for (const part of parts(timeZone).formatToParts(toDate(instant))) values[part.type] = part.value;
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday),
  };
}

/** Minutes the zone is ahead of UTC at that instant (Asia/Taipei: 480). */
export function timeZoneOffsetMinutes(timeZone: string, instant: Date | string | number): number {
  const date = toDate(instant);
  const p = zonedParts(timeZone, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** The local day an instant falls on. */
export function dayKey(timeZone: string, instant: Date | string | number): DayKey {
  const p = zonedParts(timeZone, instant);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Today in the user's zone, not the host's. */
export function todayKey(timeZone: string, now: Date = new Date()): DayKey {
  return dayKey(timeZone, now);
}

function assertDay(day: DayKey): [number, number, number] {
  if (!isDayKey(day)) throw new RangeError(`Invalid day: ${String(day)}`);
  const [, y, m, d] = DAY_KEY.exec(day)!;
  return [Number(y), Number(m), Number(d)];
}

/** Calendar arithmetic on local days; independent of any zone. */
export function addDays(day: DayKey, days: number): DayKey {
  const [y, m, d] = assertDay(day);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (to − from). */
export function daysBetween(from: DayKey, to: DayKey): number {
  const [y1, m1, d1] = assertDay(from);
  const [y2, m2, d2] = assertDay(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: DayKey): number {
  const [y, m, d] = assertDay(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The instant a local wall-clock time occurs. Times inside a DST gap move forward. */
export function zonedTimeToUtc(timeZone: string, day: DayKey, hour = 0, minute = 0): Date {
  const [y, m, d] = assertDay(day);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const first = timeZoneOffsetMinutes(timeZone, guess);
  let result = guess - first * 60_000;
  const second = timeZoneOffsetMinutes(timeZone, result);
  if (second !== first) result = guess - second * 60_000;
  return new Date(result);
}

/** [start, end) of a local day as UTC instants; 23 or 25 hours long across DST changes. */
export function dayBounds(timeZone: string, day: DayKey): { start: string; end: string } {
  return {
    start: zonedTimeToUtc(timeZone, day).toISOString(),
    end: zonedTimeToUtc(timeZone, addDays(day, 1)).toISOString(),
  };
}

/** "HH:MM" of an instant in the zone. */
export function localTime(timeZone: string, instant: Date | string | number): string {
  const p = zonedParts(timeZone, instant);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
