import type { CalendarItem } from "../../../shared/calendar.js";
import { addDays, dayBounds, localTime } from "../../../shared/time.js";
import type { AgendaContribution, LaterEventContribution, TodayContribution, TodayInput } from "../../../shared/today.js";
import type { ModuleContext } from "../../modules.js";
import { collectItems, itemsOnDay } from "./agenda.js";

/** 明天與之後 looks this far ahead (SPEC §4.5). */
const LATER_DAYS = 14;

/**
 * The calendar's part of #/today (local reads only):
 *  - agenda: today's events (Google, iCal, local), with habitLink when the
 *    title matches a habit (健身 → 運動); deadlines are their owners' rows;
 *  - nextUp: tomorrow's timed events (the core adds today's agenda);
 *  - later.events: the first calendar event tomorrow (or the next day that
 *    has one; an occurrence of a weekly class is a calendar event like a
 *    Google one, so the 課表 never fills the list), plus every one-off local
 *    event within 14 days (要參加, accepted suggestions, captures), as
 *    「09:00 計算機網路」 · 「工程三館 EC122 · Google 行事曆」.
 * The free slot is computed by the core from these agenda rows.
 */
export function calendarToday(ctx: ModuleContext, input: TodayInput): TodayContribution {
  const { day, timeZone } = input;
  const from = dayBounds(timeZone, day).start;
  const to = dayBounds(timeZone, addDays(day, LATER_DAYS)).end;
  const items = collectItems(ctx, from, to);

  const agenda: AgendaContribution[] = itemsOnDay(items, day, timeZone).map((item) => ({
    start: item.start,
    ...(item.end && item.end !== item.start ? { end: item.end } : {}),
    title: item.title,
    meta: item.meta,
    kind: "event",
    ...(item.habitLink ? { habitLink: item.habitLink } : {}),
    ...(item.habitId ? { habitId: item.habitId } : {}),
    ...(item.allDay ? { allDay: true } : {}),
    ...(item.transparent ? { transparent: true } : {}),
  }));

  const tomorrowStart = Date.parse(dayBounds(timeZone, addDays(day, 1)).start);
  const tomorrow = itemsOnDay(items, addDays(day, 1), timeZone);
  const nextUp = tomorrow.filter((item) => !item.allDay).map((item) => ({ start: item.start, title: item.title }));

  const future = items.filter((item) => Date.parse(item.start) >= tomorrowStart);
  const firstCalendar = future.find((item) => !!item.repeat || (item.origin !== "manual" && !item.manualId));
  const later = new Map<string, LaterEventContribution>();
  for (const item of [...(firstCalendar ? [firstCalendar] : []), ...future.filter((entry) => entry.manualId && !entry.repeat)])
    if (!later.has(item.id)) later.set(item.id, laterRow(item, timeZone));

  return { agenda, nextUp, later: { events: [...later.values()] } };
}

function laterRow(item: CalendarItem, timeZone: string): LaterEventContribution {
  return {
    start: item.start,
    title: item.allDay ? item.title : `${localTime(timeZone, item.start)} ${item.title}`,
    meta: [item.location, item.sourceLabel].filter(Boolean).join(" · "),
  };
}
