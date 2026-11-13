/**
 * Pure phrasing for capture previews, palette options, chips and toasts
 * (SPEC-ux §4.6, §6.6): 「明天 10/13（二）09:00」, 「10/13（二）09:00」,
 * 「明天 09:00–10:00」. Every day is read in the server's zone.
 */
import type { CaptureParse } from "../../../shared/capture-parse";
import type { CaptureParseOption, CaptureRequest, CaptureSearchResult } from "../../../shared/connect";
import { addDays, dayKey, isDayKey, localTime, zonedTimeToUtc, type DayKey } from "../../../shared/time";
import { durationText, monthDay, monthDayWeek } from "../../../shared/today-format";
import { CAPTURE, CAPTURE_DAYS, CAPTURE_TOASTS, PALETTE_CAPTURE, captureWeekday, captureWeeklyLabel } from "../../copy/capture";
import { onboardingLocale } from "../../copy/onboarding";

/** 昨天 / 今天 / 明天 / 後天, or undefined further out. */
export function relativeDay(day: DayKey, today: DayKey): string | undefined {
  if (day === addDays(today, -1)) return CAPTURE_DAYS.yesterday;
  if (day === today) return CAPTURE_DAYS.today;
  if (day === addDays(today, 1)) return CAPTURE_DAYS.tomorrow;
  if (day === addDays(today, 2)) return CAPTURE_DAYS.dayAfter;
  return undefined;
}

/** 「10/13（二）」 or "10/13 (Tue)" for a local day. */
export function dateLabel(day: DayKey, timeZone: string): string {
  const instant = zonedTimeToUtc(timeZone, day, 12);
  return onboardingLocale() === "en" ? `${monthDay(timeZone, instant)} (${captureWeekday(day)})` : monthDayWeek(timeZone, instant);
}

function withTime(date: string, time = ""): string {
  if (!time) return date;
  return `${date}${onboardingLocale() === "en" || !date.endsWith("）") ? " " : ""}${time}`;
}

export function captureDuration(minutes: number): string {
  if (onboardingLocale() !== "en") return durationText(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

interface Moment {
  day: DayKey;
  time?: string;
  endTime?: string;
}

/** The local day and times a parse or an AI option points at. */
export function momentOf(item: Pick<CaptureParse, "type" | "start" | "end" | "due" | "allDay">, timeZone: string): Moment | undefined {
  const main = item.type === "event" ? item.start : item.type === "todo" ? item.due : undefined;
  if (!main) return undefined;
  if (isDayKey(main) || item.allDay) return { day: isDayKey(main) ? main : dayKey(timeZone, main) };
  const end = item.type === "event" && item.end && !isDayKey(item.end) ? localTime(timeZone, item.end) : undefined;
  return { day: dayKey(timeZone, main), time: localTime(timeZone, main), ...(end ? { endTime: end } : {}) };
}

/** What the previews read of a parse or an AI option: its moment, and the weekly repeat of a 行程. */
type Whenable = Pick<CaptureParse, "type" | "start" | "end" | "due" | "allDay" | "repeat">;

/** 「每週一重複」 for a 行程 that repeats (the weekday is the first day's), else undefined. */
export function repeatPreview(item: Whenable, timeZone: string): string | undefined {
  const moment = item.type === "event" && item.repeat ? momentOf(item, timeZone) : undefined;
  return moment ? CAPTURE.repeatPreview(captureWeeklyLabel(moment.day)) : undefined;
}

/** 「明天 10/13（二）09:00」 (the preview and the palette meta); an event adds its end: 「…09:00–10:00」, and 「· 每週二重複」 when it repeats. */
export function whenLabel(item: Whenable, timeZone: string, now: Date): string | undefined {
  const moment = momentOf(item, timeZone);
  if (!moment) return undefined;
  const relative = relativeDay(moment.day, dayKey(timeZone, now));
  const time = moment.time ? `${moment.time}${moment.endTime ? `–${moment.endTime}` : ""}` : "";
  const when = `${relative ? `${relative} ` : ""}${withTime(dateLabel(moment.day, timeZone), time)}`;
  const repeat = repeatPreview(item, timeZone);
  return repeat ? `${when} · ${repeat}` : when;
}

/** The short form for a second option: 「明天 09:00–10:00」 or 「10/25（日）13:30」. */
export function shortWhen(item: Whenable, timeZone: string, now: Date): string | undefined {
  const moment = momentOf(item, timeZone);
  if (!moment) return undefined;
  const relative = relativeDay(moment.day, dayKey(timeZone, now));
  const time = moment.time ? `${moment.time}${moment.endTime ? `–${moment.endTime}` : ""}` : "";
  const when = relative ? withTime(relative, time) : withTime(dateLabel(moment.day, timeZone), time);
  const repeat = repeatPreview(item, timeZone);
  return repeat ? `${when} · ${repeat}` : when;
}

/** The parse-row chip: 「10/13（二）09:00」. */
export function chipLabel(item: Pick<CaptureParse, "type" | "start" | "end" | "due" | "allDay">, timeZone: string): string | undefined {
  const moment = momentOf(item, timeZone);
  if (!moment) return undefined;
  return withTime(dateLabel(moment.day, timeZone), `${moment.time ?? ""}${moment.endTime ? `–${moment.endTime}` : ""}`);
}

/**
 * The toast after a capture (SPEC-ux §10): 「已加入待辦「交報告」· 明天 09:00」. A weekly 行程 reads
 * 「已加入每週行程「計算機網路」· 每週三 14:00」, with 「只存在 BELL」 when Google would otherwise have got it.
 */
export function captureToast(item: Pick<CaptureParse, "type" | "title" | "start" | "end" | "due" | "allDay" | "repeat">, timeZone: string, now: Date, options: { localOnly?: boolean } = {}): string {
  if (item.type === "idea") return CAPTURE_TOASTS.idea;
  const moment = momentOf({ ...item, end: undefined }, timeZone);
  if (item.type === "event" && item.repeat && moment) {
    const weekly = CAPTURE_TOASTS.eventWeekly(item.title, `${captureWeeklyLabel(moment.day)}${moment.time ? ` ${moment.time}` : ""}`);
    return options.localOnly ? `${weekly} · ${CAPTURE.localOnly}` : weekly;
  }
  let when: string | undefined;
  if (moment) {
    const relative = relativeDay(moment.day, dayKey(timeZone, now));
    const date = relative === CAPTURE_DAYS.today || relative === CAPTURE_DAYS.tomorrow ? relative : dateLabel(moment.day, timeZone);
    when = withTime(date, moment.time);
  }
  return item.type === "event" ? CAPTURE_TOASTS.event(item.title, when ?? "") : CAPTURE_TOASTS.todo(item.title, when);
}

/** The palette meta line of the rule option. */
export function optionMeta(item: Whenable & Pick<CaptureParse, "location" | "tags">, timeZone: string, now: Date): string {
  if (item.type === "idea") return PALETTE_CAPTURE.metaIdea(item.tags);
  const when = whenLabel(item, timeZone, now);
  if (item.type === "todo") return PALETTE_CAPTURE.metaTodo(when);
  return PALETTE_CAPTURE.metaEvent(when ?? "", item.location);
}

/** POST /api/capture body for a parse (explicit fields, so the server stores exactly what the preview showed). */
export function captureRequest(text: string, item: CaptureParse | (CaptureParseOption & { tags?: string[]; durationMinutes?: number }), suggestionId?: string): CaptureRequest & { suggestionId?: string } {
  return {
    text,
    type: item.type,
    title: item.title,
    allDay: item.allDay,
    ...(item.start ? { start: item.start } : {}),
    ...(item.end ? { end: item.end } : {}),
    ...(item.due ? { due: item.due } : {}),
    ...(item.location ? { location: item.location } : {}),
    ...(item.tags?.length ? { tags: item.tags } : {}),
    ...(item.type === "todo" && item.durationMinutes ? { estimateMinutes: item.durationMinutes } : {}),
    ...(item.type === "event" && "repeat" in item && item.repeat ? { repeat: item.repeat } : {}),
    ...(suggestionId ? { suggestionId } : {}),
  };
}

/** Vague words (下週「找時間」) are understood but are not a date: never marked. */
const VAGUE_MARKER = /^(?:找個?時間|有空的時候|有空時|有空|改天)$/;

/**
 * The input highlights (`mark`): the date, time, length and place tokens,
 * neighbours joined across spaces so 「明天 9:00」 is one mark. The deadline
 * words the parser removes with a date (「要在」周日「前」, "before" Friday)
 * join it, so the user sees what left the title; other markers (找時間) do not.
 */
export function inputMarks(parse: Pick<CaptureParse, "spans" | "type">, text: string): Array<{ start: number; end: number }> {
  if (parse.type === "idea") return [];
  const marks: Array<{ start: number; end: number }> = [];
  const timed = (index: number) => parse.spans[index]?.kind === "date" || parse.spans[index]?.kind === "time";
  const gap = (from: number, to: number) => /^\s*$/.test(text.slice(from, to));
  parse.spans.forEach((span, index) => {
    if (span.kind === "tag") return;
    if (span.kind === "marker") {
      const previous = parse.spans[index - 1];
      const next = parse.spans[index + 1];
      const leadsIn = timed(index + 1) && gap(span.end, next.start);
      const follows = timed(index - 1) && gap(previous.end, span.start);
      if ((!leadsIn && !follows) || VAGUE_MARKER.test(text.slice(span.start, span.end))) return;
    }
    const last = marks.at(-1);
    if (last && gap(last.end, span.start)) last.end = span.end;
    else marks.push({ start: span.start, end: span.end });
  });
  return marks;
}

/** A search result's meta line: 「待辦 · 明天 09:00」, 「靈感 · 10/9」, 「專案 · 20%」. */
export function searchMeta(result: CaptureSearchResult, timeZone: string, now: Date): string {
  const today = dayKey(timeZone, now);
  if (result.kind === "todo") {
    if (result.done) return PALETTE_CAPTURE.searchMeta.done;
    if (!result.dueDay) return PALETTE_CAPTURE.searchMeta.todo;
    const relative = relativeDay(result.dueDay, today);
    const date = relative ?? dateLabel(result.dueDay, timeZone);
    return `${PALETTE_CAPTURE.searchMeta.todo} · ${withTime(date, result.dueTime)}`;
  }
  if (result.kind === "idea") {
    if (!result.at) return PALETTE_CAPTURE.searchMeta.idea;
    const day = dayKey(timeZone, result.at);
    return `${PALETTE_CAPTURE.searchMeta.idea} · ${relativeDay(day, today) ?? dateLabel(day, timeZone)}`;
  }
  return result.pct !== undefined ? `${PALETTE_CAPTURE.searchMeta.project} · ${PALETTE_CAPTURE.searchPct(result.pct)}` : PALETTE_CAPTURE.searchMeta.project;
}
