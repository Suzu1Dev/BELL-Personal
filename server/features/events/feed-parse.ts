import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import ical, { type EventInstance, type VEvent } from "node-ical";
import type { FeedKind } from "../../../shared/events.js";
import { addDays, isDayKey, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";
import { AppError } from "../../errors.js";

/**
 * Pure parsers for event subscriptions (no I/O): iCal through node-ical with
 * recurrence expansion (RRULE, EXDATE, RECURRENCE-ID overrides, DST through
 * TZID), RSS/Atom through fast-xml-parser. Feed text is untrusted: HTML is
 * stripped to plain text, strings are truncated, and DOCTYPE entity
 * declarations are refused.
 */

/** One occurrence found in a feed, before it becomes an ExternalEvent or a CalendarEvent. */
export interface ParsedFeedEvent {
  /** Stable across fetches: a hash of the item's uid (and, for a recurring event, the occurrence). */
  key: string;
  title: string;
  /** ISO instant; all-day items start at local midnight in the user's zone. */
  start: string;
  /** ISO instant (exclusive end); all-day items end at a local midnight. */
  end?: string;
  allDay: boolean;
  location?: string;
  url?: string;
  description?: string;
  organizer?: string;
  /** iCal TRANSP:TRANSPARENT: shown as free. */
  transparent?: boolean;
}

export interface ParseWindow {
  /** Occurrences ending before this are dropped. */
  from: Date;
  /** Occurrences starting after this are dropped. */
  to: Date;
  timeZone: string;
}

/** Most occurrences one feed may yield (a daily RRULE over the window stays far below). */
export const FEED_EVENT_LIMIT = 2000;
/**
 * Expansion limits, so one hostile or broken feed cannot hold the event loop:
 * VEVENTs read per feed, recurrence steps from DTSTART to the window's end
 * per VEVENT (a DAILY rule since 1960 stays below; SECONDLY or MINUTELY rules
 * from years ago do not), occurrences expanded per feed, and a time budget.
 */
export const FEED_COMPONENT_LIMIT = 5000;
export const RRULE_STEP_LIMIT = 25_000;
export const FEED_INSTANCE_LIMIT = 20_000;
export const FEED_PARSE_BUDGET_MS = 2000;
const FREQUENCY_MS: Record<string, number> = {
  SECONDLY: 1_000, MINUTELY: 60_000, HOURLY: 3_600_000, DAILY: 86_400_000,
  WEEKLY: 7 * 86_400_000, MONTHLY: 28 * 86_400_000, YEARLY: 365 * 86_400_000,
};
const TEXT_LIMIT = { title: 200, location: 200, description: 500, organizer: 120, url: 2000 } as const;

export function feedKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 16);
}

/**
 * `<p>a&amp;b</p>` → `a&b`: tags dropped, common entities decoded, whitespace
 * collapsed. Linear in the input: the raw value is cut to a small multiple of
 * `max` first, and tag patterns stop at the next `<`, so a run of unbalanced
 * brackets cannot backtrack.
 */
export function plainText(value: unknown, max: number): string | undefined {
  const raw = textOf(value)?.slice(0, Math.max(max * 8, 16_384));
  if (!raw) return undefined;
  const text = raw
    .replace(/<\/?(br|p|div|li|ul|ol|tr|table|h[1-6]|section|article|blockquote)\b[^<>]*>/gi, "\n")
    .replace(/<[^<>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => safeChar(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => safeChar(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : " ";
}

/** node-ical and fast-xml-parser values may be a string, a number or `{ val | #text, params }`. */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textOf(record.val ?? record["#text"] ?? record["@_href"] ?? record.value);
  }
  return undefined;
}

function httpUrl(value: unknown): string | undefined {
  const text = textOf(value)?.trim();
  if (!text || text.length > TEXT_LIMIT.url) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** What a response body is: iCal, RSS or Atom (null for anything else, e.g. an HTML page). */
export function detectFeedKind(text: string): FeedKind | null {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 2000);
  if (/^BEGIN:VCALENDAR/i.test(head)) return "ics";
  if (!head.startsWith("<")) return null;
  if (/<rss[\s>]|<rdf:RDF[\s>]/i.test(head)) return "rss";
  if (/<feed[\s>]/i.test(head)) return "atom";
  return null;
}

export function parseFeed(text: string, kind: FeedKind, window: ParseWindow): ParsedFeedEvent[] {
  return kind === "ics" ? parseIcs(text, window) : parseRssAtom(text, window).events;
}

/* ------------------------------------------------------------------ iCal */

type IcalDate = Date & { dateOnly?: boolean; tz?: string };

/** A date-only value (VALUE=DATE) as the local DayKey it names; node-ical builds those with local-time fields. */
function dateOnlyDay(date: IcalDate): DayKey {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * Every VEVENT occurrence that overlaps the window. Recurring events are
 * expanded (EXDATE removed, RECURRENCE-ID overrides applied); times with a
 * TZID keep their wall-clock time across DST changes; all-day events are
 * placed on the same calendar day in the user's zone; cancelled events and
 * cancelled overrides are dropped.
 */
export function parseIcs(text: string, window: ParseWindow): ParsedFeedEvent[] {
  let data: ReturnType<typeof ical.sync.parseICS>;
  try {
    data = ical.sync.parseICS(text.length > PREFILTER_ABOVE ? prefilterIcs(text, window) : text);
  } catch {
    throw new AppError(422, "這個 iCal 訂閱的內容無法解析。");
  }
  const events: ParsedFeedEvent[] = [];
  // Expand a little wider than the window: an all-day occurrence is matched on its UTC date.
  const from = new Date(window.from.getTime() - 86_400_000);
  const to = new Date(window.to.getTime() + 86_400_000);
  const started = performance.now();
  let components = 0;
  let expanded = 0;
  for (const component of Object.values(data)) {
    if (!component || (component as { type?: string }).type !== "VEVENT") continue;
    if (++components > FEED_COMPONENT_LIMIT || expanded > FEED_INSTANCE_LIMIT || performance.now() - started > FEED_PARSE_BUDGET_MS) break;
    const event = component as VEvent;
    if (!event.start || String(event.status ?? "").toUpperCase() === "CANCELLED") continue;
    if (recurrenceSteps(event, to) > RRULE_STEP_LIMIT) continue;
    let instances: EventInstance[];
    try {
      instances = ical.expandRecurringEvent(event, { from, to, expandOngoing: true });
    } catch {
      continue;
    }
    expanded += instances.length;
    // Text fields are cleaned once per VEVENT (and once per override), not once per occurrence.
    const fields = new Map<VEvent, Omit<ParsedFeedEvent, "key" | "start" | "end" | "allDay">>();
    for (const instance of instances) {
      const source = instance.event as VEvent;
      if (String(source.status ?? "").toUpperCase() === "CANCELLED") continue;
      const occurrence = toOccurrence(instance, window.timeZone);
      if (!occurrence) continue;
      if (!overlapsWindow(occurrence, window)) continue;
      let text = fields.get(source);
      if (!text) {
        text = {
          title: plainText(instance.summary ?? source.summary, TEXT_LIMIT.title) ?? "（未命名活動）",
          ...optional("location", plainText(source.location ?? event.location, TEXT_LIMIT.location)),
          ...optional("url", httpUrl(source.url ?? event.url)),
          ...optional("description", plainText(source.description ?? event.description, TEXT_LIMIT.description)),
          ...optional("organizer", organizerName(source.organizer ?? event.organizer)),
          ...(String(source.transparency ?? event.transparency ?? "").toUpperCase() === "TRANSPARENT" ? { transparent: true } : {}),
        };
        fields.set(source, text);
      }
      const { title, ...rest } = text;
      events.push({
        key: feedKey(event.uid ?? title, instance.isRecurring || instance.isOverride ? occurrence.start : ""),
        title,
        ...occurrence,
        ...rest,
      });
      if (events.length >= FEED_EVENT_LIMIT) return sortByStart(events);
    }
  }
  return sortByStart(events);
}

/** iCal bodies above this size (a personal calendar's whole history) are cut to the VEVENTs that can touch the window first. */
const PREFILTER_ABOVE = 1_000_000;
const DAY_MS = 86_400_000;

const compactDay = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");

/**
 * Drops VEVENT blocks that cannot overlap the window, before node-ical parses
 * them: one-off events that start after it, or end (start, without DTEND)
 * before it, with two days of margin for time zones. Recurring masters,
 * RDATE and RECURRENCE-ID blocks, DURATION events and blocks without a
 * readable DTSTART are kept. Calendar-level blocks (VTIMEZONE) are untouched.
 */
export function prefilterIcs(text: string, window: ParseWindow): string {
  const fromDay = compactDay(new Date(window.from.getTime() - 2 * DAY_MS));
  const toDay = compactDay(new Date(window.to.getTime() + 2 * DAY_MS));
  const parts: string[] = [];
  let index = 0;
  for (;;) {
    const begin = text.indexOf("BEGIN:VEVENT", index);
    const end = begin < 0 ? -1 : text.indexOf("END:VEVENT", begin);
    if (begin < 0 || end < 0) {
      parts.push(text.slice(index));
      break;
    }
    const stop = end + "END:VEVENT".length;
    parts.push(text.slice(index, begin));
    const block = text.slice(begin, stop);
    if (mayOverlap(block.replace(/\r?\n[ \t]/g, ""), fromDay, toDay)) parts.push(block);
    index = stop;
  }
  return parts.join("");
}

function mayOverlap(block: string, fromDay: string, toDay: string): boolean {
  if (/^(RRULE|RDATE|RECURRENCE-ID|DURATION)[;:]/m.test(block)) return true;
  const start = /^DTSTART[^:\r\n]*:(\d{8})/m.exec(block)?.[1];
  if (!start) return true;
  if (start > toDay) return false;
  const end = /^DTEND[^:\r\n]*:(\d{8})/m.exec(block)?.[1];
  return (end ?? start) >= fromDay;
}

/**
 * About how many recurrence steps node-ical would walk from DTSTART to `until`
 * (0 without an RRULE): the rule is enumerated from its start, so a SECONDLY
 * rule from years ago costs millions of steps even when the window is small.
 */
function recurrenceSteps(event: VEvent, until: Date): number {
  const options = event.rrule?.options;
  if (!options) return 0;
  const count = Number(options.count);
  if (Number.isInteger(count) && count > 0) return count;
  const step = FREQUENCY_MS[String(options.freq ?? "").toUpperCase()];
  if (!step) return 0;
  const interval = Math.max(1, Number(options.interval) || 1);
  const start = event.start instanceof Date ? event.start.getTime() : Date.parse(String(event.start));
  const ruleEnd = options.until ? Date.parse(String(options.until instanceof Date ? options.until.toISOString() : options.until)) : Number.NaN;
  const end = Number.isFinite(ruleEnd) ? Math.min(ruleEnd, until.getTime()) : until.getTime();
  if (!Number.isFinite(start) || end <= start) return 0;
  return (end - start) / (step * interval);
}

function toOccurrence(instance: EventInstance, timeZone: string): { start: string; end?: string; allDay: boolean } | undefined {
  const start = instance.start as IcalDate;
  const end = instance.end as IcalDate | undefined;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return undefined;
  if (instance.isFullDay) {
    const firstDay = dateOnlyDay(start);
    const endDay = end instanceof Date && !Number.isNaN(end.getTime()) ? dateOnlyDay(end) : addDays(firstDay, 1);
    const lastDay = isDayKey(endDay) && endDay > firstDay ? endDay : addDays(firstDay, 1);
    return {
      start: zonedTimeToUtc(timeZone, firstDay).toISOString(),
      end: zonedTimeToUtc(timeZone, lastDay).toISOString(),
      allDay: true,
    };
  }
  const endTime = end instanceof Date && end.getTime() > start.getTime() ? end.toISOString() : undefined;
  return { start: start.toISOString(), ...(endTime ? { end: endTime } : {}), allDay: false };
}

function organizerName(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "object" && value !== null) {
    const params = (value as { params?: { CN?: unknown } }).params;
    const name = plainText(params?.CN, TEXT_LIMIT.organizer);
    if (name) return name.replace(/^"|"$/g, "");
  }
  const text = textOf(value)?.replace(/^mailto:/i, "");
  return text ? plainText(text, TEXT_LIMIT.organizer) : undefined;
}

/* ------------------------------------------------------------- RSS / Atom */

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "item" || name === "entry" || name === "link",
});

/**
 * RSS 2.0 / RDF / Atom items that describe a dated event. The date comes from
 * the RSS event module (`ev:startdate`, `ev:enddate`, `ev:location`) or xCal
 * (`dtstart`), else from the first 「2026/10/24 09:00 ~ 17:00」-style date in
 * the summary or content (KKTIX and most Taiwanese event sites). Items with
 * no event date (plain news posts) are skipped: a publication date is not an
 * event date.
 */
export function parseRssAtom(text: string, window: ParseWindow): { kind: "rss" | "atom"; title?: string; events: ParsedFeedEvent[] } {
  if (/<!ENTITY/i.test(text.slice(0, 20_000))) throw new AppError(422, "這個訂閱的內容格式不受支援。");
  let doc: Record<string, any>;
  try {
    doc = xml.parse(text) as Record<string, any>;
  } catch {
    throw new AppError(422, "這個 RSS／Atom 訂閱的內容無法解析。");
  }
  const atom = doc.feed;
  const channel = doc.rss?.channel ?? doc.RDF?.channel;
  const kind: "rss" | "atom" = atom ? "atom" : "rss";
  const entries: Record<string, any>[] = atom ? (atom.entry ?? []) : [...(channel?.item ?? []), ...(doc.RDF?.item ?? [])];
  if (!atom && !channel) throw new AppError(422, "這個網址不是 RSS、Atom 或 iCal 訂閱。");
  const feedTitle = plainText(atom ? atom.title : channel?.title, TEXT_LIMIT.organizer);
  const events: ParsedFeedEvent[] = [];
  for (const entry of entries) {
    const title = plainText(entry.title, TEXT_LIMIT.title);
    if (!title) continue;
    const body = [entry.summary, entry.description, entry.content, entry.encoded].map((value) => plainText(value, 8000)).filter(Boolean).join("\n");
    const when = explicitWhen(entry, window.timeZone) ?? findDateRange(body, window.timeZone, window.from);
    if (!when) continue;
    if (!overlapsWindow(when, window)) continue;
    const link = atomLink(entry.link) ?? httpUrl(entry.link) ?? httpUrl(entry.guid);
    const id = textOf(entry.id) ?? textOf(entry.guid) ?? link ?? title;
    events.push({
      key: feedKey(id),
      title,
      ...when,
      ...optional("location", plainText(entry.location, TEXT_LIMIT.location) ?? findLocation(body)),
      ...optional("url", link),
      ...optional("description", plainText(textOf(entry.summary) ?? textOf(entry.description) ?? textOf(entry.content), TEXT_LIMIT.description)),
      ...optional("organizer", plainText(entry.author?.name ?? entry.creator ?? entry.organizer, TEXT_LIMIT.organizer) ?? feedTitle),
    });
    if (events.length >= FEED_EVENT_LIMIT) break;
  }
  return { kind, ...(feedTitle ? { title: feedTitle } : {}), events: sortByStart(events) };
}

function atomLink(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const links = value.filter((link) => link && typeof link === "object") as Record<string, unknown>[];
  const alternate = links.find((link) => !link["@_rel"] || link["@_rel"] === "alternate") ?? links[0];
  return alternate ? httpUrl(alternate["@_href"]) : undefined;
}

/** `ev:startdate` / `ev:enddate` (RSS event module) or xCal `dtstart` / `dtend`. */
function explicitWhen(entry: Record<string, any>, timeZone: string): { start: string; end?: string; allDay: boolean } | undefined {
  const start = parseInstant(textOf(entry.startdate ?? entry.dtstart), timeZone);
  if (!start) return undefined;
  const end = parseInstant(textOf(entry.enddate ?? entry.dtend), timeZone);
  if (start.allDay) {
    const endDay = end?.allDay && end.day > start.day ? addDays(end.day, 1) : addDays(start.day, 1);
    return { start: start.iso, end: zonedTimeToUtc(timeZone, endDay).toISOString(), allDay: true };
  }
  return { start: start.iso, ...(end && Date.parse(end.iso) > Date.parse(start.iso) ? { end: end.iso } : {}), allDay: false };
}

/** An ISO date-time (with or without offset; without one it is local time) or a bare date. */
function parseInstant(value: string | undefined, timeZone: string): { iso: string; allDay: boolean; day: DayKey } | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const dateOnly = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (dateOnly) {
    const day = `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
    return isDayKey(day) ? { iso: zonedTimeToUtc(timeZone, day).toISOString(), allDay: true, day } : undefined;
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
  if (local) {
    const day = `${local[1]}-${local[2]}-${local[3]}`;
    if (!isDayKey(day)) return undefined;
    return { iso: zonedTimeToUtc(timeZone, day, Number(local[4]), Number(local[5])).toISOString(), allDay: false, day };
  }
  const time = Date.parse(text);
  if (Number.isNaN(time)) return undefined;
  const iso = new Date(time).toISOString();
  return { iso, allDay: false, day: iso.slice(0, 10) };
}

const DATE = String.raw`(\d{4})\s*[/.\-年]\s*(\d{1,2})\s*[/.\-月]\s*(\d{1,2})\s*日?`;
const WEEKDAY = String.raw`(?:\s*[（(][^）)]{1,4}[）)])?`;
const TIME = String.raw`(\d{1,2})[:：](\d{2})`;
const OFFSET = String.raw`(?:\s*\(?\s*(?:GMT|UTC)?\s*([+-])(\d{2}):?(\d{2})\s*\)?)?`;
const RANGE = String.raw`\s*(?:~|～|〜|–|—|-|至|到)\s*`;
const DATE_RANGE = new RegExp(
  `${DATE}${WEEKDAY}(?:\\s*${TIME}${OFFSET})?(?:${RANGE}(?:${DATE}${WEEKDAY}\\s*)?(?:${TIME}${OFFSET})?)?`,
);

/**
 * The first 「YYYY/MM/DD HH:MM」 date in free text, with an optional range end
 * (「~ 17:00」, 「~ 2026/10/25 18:00」) and an optional offset (「(+0800)」).
 * Without an offset the time is local to the user's zone; without a time the
 * event is all-day.
 */
export function findDateRange(text: string, timeZone: string, _notBefore?: Date): { start: string; end?: string; allDay: boolean } | undefined {
  const match = DATE_RANGE.exec(text);
  if (!match) return undefined;
  const [, y1, m1, d1, h1, min1, sign1, oh1, om1, y2, m2, d2, h2, min2, sign2, oh2, om2] = match;
  const startDay = dayOf(y1, m1, d1);
  if (!startDay) return undefined;
  if (h1 === undefined) {
    const endDay = (y2 && dayOf(y2, m2, d2)) || startDay;
    const lastDay = endDay >= startDay ? endDay : startDay;
    return { start: zonedTimeToUtc(timeZone, startDay).toISOString(), end: zonedTimeToUtc(timeZone, addDays(lastDay, 1)).toISOString(), allDay: true };
  }
  const start = instantAt(startDay, h1, min1, sign1, oh1, om1, timeZone);
  if (!start) return undefined;
  const endDay = (y2 && dayOf(y2, m2, d2)) || startDay;
  const end = h2 !== undefined ? instantAt(endDay, h2, min2, sign2 ?? sign1, oh2 ?? oh1, om2 ?? om1, timeZone) : undefined;
  return { start, ...(end && Date.parse(end) > Date.parse(start) ? { end } : {}), allDay: false };
}

function dayOf(year: string | undefined, month: string | undefined, day: string | undefined): DayKey | undefined {
  if (!year || !month || !day) return undefined;
  const key = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isDayKey(key) ? key : undefined;
}

function instantAt(day: DayKey, hour: string, minute: string, sign: string | undefined, offsetHours: string | undefined, offsetMinutes: string | undefined, timeZone: string): string | undefined {
  const h = Number(hour);
  const m = Number(minute);
  if (h > 24 || m > 59) return undefined;
  if (sign && offsetHours) {
    const offset = (Number(offsetHours) * 60 + Number(offsetMinutes ?? 0)) * (sign === "-" ? -1 : 1);
    const [y, mo, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, mo - 1, d, h, m) - offset * 60_000).toISOString();
  }
  return zonedTimeToUtc(timeZone, day, h, m).toISOString();
}

/** 「地點：中研院人文館」 / 「Location: …」 in free text. */
export function findLocation(text: string): string | undefined {
  const match = /(?:活動地點|地點|地址|場地|Location|Venue)\s*[:：]\s*([^\n]{1,120})/i.exec(text);
  return match ? plainText(match[1], TEXT_LIMIT.location) : undefined;
}

/** An occurrence that ends after the window starts (an instant event exactly at its start counts) and starts before it ends. */
function overlapsWindow(event: { start: string; end?: string }, window: ParseWindow): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end ?? event.start);
  if (start > window.to.getTime()) return false;
  return end > window.from.getTime() || start >= window.from.getTime();
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function sortByStart(events: ParsedFeedEvent[]): ParsedFeedEvent[] {
  return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
