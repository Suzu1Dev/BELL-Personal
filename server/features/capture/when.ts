import { addDays, dayKey, isDayKey, localTime } from "../../../shared/time.js";
import { dayLabel, monthDayWeek } from "../../../shared/today-format.js";

/**
 * 「明天 09:00」, 「今天」, 「10/25（日）13:30」: the when-part of every capture
 * toast (已加入待辦「…」· {when}, 已整理成「…」· {when}), so both read the same.
 */
export function whenPhrase(instant: string, allDay: boolean, now: Date, timeZone: string): string {
  const day = dayKey(timeZone, isDayKey(instant) ? `${instant}T12:00:00Z` : instant);
  const today = dayKey(timeZone, now);
  const at = isDayKey(instant) ? `${instant}T04:00:00Z` : instant;
  const near = day === today || day === addDays(today, 1);
  const date = near ? dayLabel(timeZone, at, now) : monthDayWeek(timeZone, at);
  if (allDay) return date;
  // 「明天 09:00」 but 「10/25（日）13:30」: the full-width bracket already separates.
  return near ? `${date} ${localTime(timeZone, instant)}` : `${date}${localTime(timeZone, instant)}`;
}
