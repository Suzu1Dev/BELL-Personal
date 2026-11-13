import { z } from "zod";
import { CONNECT_LIMITS, type FeedSummary } from "../../../shared/connect.js";
import type { CalendarEvent } from "../../../shared/calendar.js";
import { FEED_KINDS, FEED_TARGETS, type ExternalEvent, type FeedKind, type FeedSubscription, type FeedTarget } from "../../../shared/events.js";
import type { SourceId } from "../../../shared/sources.js";
import { dayKey } from "../../../shared/time.js";
import type { DocTable } from "../../db/database.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import { ResponseTooLargeError, safeFetch, type HttpRequestInit, type HttpResponse } from "../../sync.js";
import { detectFeedKind, parseFeed, type ParsedFeedEvent, type ParseWindow } from "./feed-parse.js";

/**
 * Feed subscriptions (personal.sqlite event_feeds, PERSONAL v3) and what both
 * feed sources share: URL rules, the vault for secret URLs, one fetch +
 * parse, and the mapping of parsed items to ExternalEvent (#/events, source
 * `feeds`) or CalendarEvent (the agenda, source `ics`).
 */

const iso = z.string().refine((value) => !Number.isNaN(Date.parse(value)));

export const feedSchema: z.ZodType<FeedSubscription> = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(CONNECT_LIMITS.feedLabel),
  url: z.string().max(CONNECT_LIMITS.url),
  kind: z.enum(FEED_KINDS),
  enabled: z.boolean(),
  secret: z.boolean().optional(),
  target: z.enum(FEED_TARGETS).optional(),
  createdAt: iso,
  lastSyncedAt: iso.nullable().optional(),
  lastError: z.string().max(300).nullable().optional(),
  updatedAt: iso.optional(),
});

const stores = new WeakMap<object, DocTable<FeedSubscription>>();

/** The one DocTable over event_feeds per database (shared by the events and calendar modules). */
export function feedStore(ctx: Pick<ModuleContext, "db">): DocTable<FeedSubscription> {
  let store = stores.get(ctx.db.personal);
  if (!store) {
    store = ctx.db.personal.docs<FeedSubscription>({
      table: "event_feeds",
      label: "訂閱",
      schema: feedSchema,
      columns: (feed) => ({ enabled: feed.enabled ? 1 : 0, target: feed.target ?? "events", created_at: feed.createdAt }),
    });
    stores.set(ctx.db.personal, store);
  }
  return store;
}

export function feedTarget(feed: Pick<FeedSubscription, "target" | "kind">): FeedTarget {
  return feed.kind === "ics" && feed.target === "calendar" ? "calendar" : "events";
}

/** The source a subscription's items are cached under. */
export function feedSource(target: FeedTarget): Extract<SourceId, "feeds" | "ics"> {
  return target === "calendar" ? "ics" : "feeds";
}

export function enabledFeeds(ctx: Pick<ModuleContext, "db">, target: FeedTarget): FeedSubscription[] {
  return feedStore(ctx).list({ where: "enabled = 1 AND target = ?", params: [target], orderBy: "created_at" })
    .filter((feed) => feedTarget(feed) === target);
}

/* -------------------------------------------------------------- URL rules */

export const vaultName = (feedId: string) => `ics.${feedId}`;

/** webcal:// → https://; only https, no credentials in the URL. */
export function normalizeFeedUrl(input: string): URL {
  const text = input.trim().replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try { url = new URL(text); } catch { throw new AppError(400, "訂閱網址格式不正確，請貼上完整的網址（https:// 開頭）。"); }
  if (url.protocol !== "https:") throw new AppError(400, "訂閱網址必須使用 HTTPS。");
  if (url.username || url.password) throw new AppError(400, "訂閱網址不可包含帳號密碼。");
  url.hash = "";
  return url;
}

/**
 * Whether a URL carries a credential: a query string, a 「private」 or
 * 「secret」 path (Google's secret iCal address), or a long token-like path
 * segment (Outlook, iCloud). Such URLs live only in the vault.
 */
export function isSecretUrl(url: URL): boolean {
  if (url.search.length > 1) return true;
  if (/private|secret|token|apikey|api_key|auth/i.test(url.pathname)) return true;
  return url.pathname.split("/").some((segment) => /^[A-Za-z0-9_-]{24,}(\.ics)?$/.test(segment) && /\d/.test(segment));
}

/** What the UI may show: host + path for public feeds, the host alone for secret ones. */
export function urlHint(url: URL, secret: boolean): string {
  if (secret) return url.host;
  const hint = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  return hint.length > 80 ? `${hint.slice(0, 79)}…` : hint;
}

/** Personal calendars (Google's secret address, Outlook, iCloud) go on the agenda; everything else is an event feed. */
export function detectTarget(url: URL, kind: FeedKind): FeedTarget {
  if (kind !== "ics") return "events";
  const host = url.host.toLowerCase();
  if (host === "calendar.google.com" && url.pathname.startsWith("/calendar/ical/")) return "calendar";
  if (/(^|\.)outlook\.(office365|live)\.com$/.test(host) && url.pathname.includes("/calendar/")) return "calendar";
  if (/^p\d+-caldav\.icloud\.com$/.test(host)) return "calendar";
  return "events";
}

/** The URL to fetch: the vault's copy for a secret feed. */
export async function feedFetchUrl(ctx: Pick<ModuleContext, "vault">, feed: FeedSubscription): Promise<string> {
  if (!feed.secret) return feed.url;
  const stored = await ctx.vault.get<string>(vaultName(feed.id));
  if (typeof stored !== "string") throw new AppError(503, "這個訂閱的網址已無法讀取，請刪除後重新加入。");
  return stored;
}

/* ----------------------------------------------------------- fetch + parse */

export type FeedHttp = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/**
 * Response caps: an event feed carries upcoming items, but a personal
 * calendar's iCal export (Google's secret address) holds every event the
 * calendar ever had and can pass 5 MB after a few years.
 */
export const FEED_MAX_BYTES = 5_000_000;
export const CALENDAR_FEED_MAX_BYTES = 30_000_000;

/** An http function for routes (outside a SourceSync): safeFetch with a 15 s deadline. */
export function routeHttp(ctx: Pick<ModuleContext, "fetch">, signal: AbortSignal = AbortSignal.timeout(20_000)): FeedHttp {
  return (url, init) => safeFetch(ctx.fetch, url, signal, { maxBytes: FEED_MAX_BYTES, ...init });
}

/** A text decoder for a charset label, or undefined for an unknown one (or WHATWG's "replacement"). */
function decoderFor(label: string | undefined, fatal: boolean): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    const decoder = new TextDecoder(label.trim().toLowerCase(), { fatal });
    return decoder.encoding === "replacement" ? undefined : decoder;
  } catch {
    return undefined;
  }
}

/**
 * A feed body as text: a byte-order mark, else the Content-Type charset,
 * else (XML only) the `<?xml … encoding="big5"?>` declaration, else UTF-8.
 * A declared charset the bytes do not fit (a Big5 file served as UTF-8) falls
 * through to the next one. iCal is UTF-8 by RFC 5545, so only XML is sniffed.
 */
export function decodeFeedBody(body: Buffer, contentType: string | null): string {
  const bom = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? "utf-8"
    : body[0] === 0xfe && body[1] === 0xff ? "utf-16be"
      : body[0] === 0xff && body[1] === 0xfe ? "utf-16le" : undefined;
  const header = /;\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? "")?.[1];
  const head = body.subarray(0, 300).toString("latin1");
  const declared = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  for (const label of [bom, header, declared, "utf-8"]) {
    const decoder = decoderFor(label, true);
    if (!decoder) continue;
    try { return decoder.decode(body); } catch { /* the bytes do not fit this charset */ }
  }
  return new TextDecoder("utf-8").decode(body);
}

/**
 * Fetches and parses one subscription. Errors are zh-TW AppErrors that say
 * what failed (a 404, a page that is not a feed, an unparseable body, a body
 * over the cap). `calendar` allows the larger cap of a personal calendar export.
 */
export async function fetchFeed(http: FeedHttp, url: string, window: ParseWindow, expected?: FeedKind, options: { calendar?: boolean } = {}): Promise<{ kind: FeedKind; events: ParsedFeedEvent[] }> {
  let response: HttpResponse;
  try {
    response = await http(url, {
      headers: { accept: "text/calendar, application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5" },
      ...(options.calendar ? { maxBytes: CALENDAR_FEED_MAX_BYTES } : {}),
    });
  } catch (error) {
    if (!(error instanceof ResponseTooLargeError)) throw error;
    throw new AppError(413, options.calendar
      ? "這個行事曆太大，無法用 iCal 網址訂閱，請改用「連接 Google」同步行事曆。"
      : "這個訂閱的內容太大，無法讀取。");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new AppError(502, `訂閱網址拒絕存取（HTTP ${response.status}），請確認網址是否正確。`);
    if (response.status === 404 || response.status === 410) throw new AppError(502, `找不到這個訂閱（HTTP ${response.status}），可能已經移除。`);
    if (response.status === 429) throw new AppError(429, "訂閱網址暫時限制請求頻率，稍後會自動重試。");
    throw new AppError(502, `訂閱網址回應 HTTP ${response.status}，稍後會自動重試。`);
  }
  const text = decodeFeedBody(response.body, response.headers.get("content-type"));
  const kind = detectFeedKind(text);
  if (!kind) throw new AppError(422, "這個網址不是 RSS、Atom 或 iCal 訂閱。");
  if (expected && expected !== kind && !(expected !== "ics" && kind !== "ics"))
    throw new AppError(422, "這個網址的格式和指定的類型不同。");
  return { kind, events: parseFeed(text, kind, window) };
}

/** #/events item for a parsed feed occurrence: id `<ics|feed>:<feed id>:<key>`. */
export function toExternalEvent(feed: FeedSubscription, kind: FeedKind, event: ParsedFeedEvent, now: Date): ExternalEvent {
  const origin = kind === "ics" ? "ics" : "feed";
  return {
    id: `${origin}:${feed.id}:${event.key}`,
    origin,
    feedId: feed.id,
    feedName: feed.label,
    title: event.title,
    start: event.start,
    end: event.end ?? null,
    allDay: event.allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(event.organizer ? { organizer: event.organizer } : {}),
    ...(event.description ? { description: event.description } : {}),
    updatedAt: now.toISOString(),
  };
}

/** Agenda item for a personal-calendar feed: all-day events keep DayKeys (CalendarEvent convention). */
export function toCalendarEvent(feed: FeedSubscription, event: ParsedFeedEvent, timeZone: string, now: Date): CalendarEvent {
  const start = event.allDay ? dayKey(timeZone, event.start) : event.start;
  const end = event.allDay
    ? dayKey(timeZone, event.end ?? event.start)
    : event.end ?? new Date(Date.parse(event.start) + 3_600_000).toISOString();
  return {
    id: `ics:${feed.id}:${event.key}`,
    origin: "ics",
    calendarId: feed.id,
    calendarName: feed.label,
    title: event.title,
    start,
    end,
    allDay: event.allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(event.description ? { description: event.description } : {}),
    ...(event.transparent ? { transparent: true } : {}),
    status: "confirmed",
    updatedAt: now.toISOString(),
  };
}

/* --------------------------------------------------------------- summaries */

export function summarizeFeed(feed: FeedSubscription, events: number): FeedSummary {
  let hint = feed.url;
  try { hint = urlHint(new URL(feed.url), !!feed.secret); } catch { /* stored as a hint already */ }
  return {
    id: feed.id,
    label: feed.label,
    kind: feed.kind,
    urlHint: hint,
    secret: !!feed.secret,
    enabled: feed.enabled,
    createdAt: feed.createdAt,
    lastSyncedAt: feed.lastSyncedAt ?? null,
    lastError: feed.lastError ?? null,
    events,
    target: feedTarget(feed),
  };
}
