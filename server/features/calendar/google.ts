import { createHash } from "node:crypto";
import { calendar, type calendar_v3 } from "@googleapis/calendar";
import type { CalendarEvent, ManualEvent } from "../../../shared/calendar.js";
import { addDays, dayBounds, dayKey, isDayKey, todayKey, zonedTimeToUtc } from "../../../shared/time.js";
import { AppError } from "../../errors.js";
import { googleCapabilities, googleClient, googleConnected } from "../../google/auth.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import type { SourceItemInput } from "../../stores/source-items.js";
import { needsReconnect, ReconnectRequiredError, SourceSync, type SyncContext, type SyncOutcome } from "../../sync.js";
import { plainText } from "../events/feed-parse.js";

/**
 * Google Calendar through googleClient(ctx) (HTTP via ctx.fetch):
 *  - GoogleCalendarSync (`google-calendar`, every 5 min): calendarList.list,
 *    then events.list per selected calendar from yesterday to 30 days ahead
 *    (singleEvents, orderBy startTime), stored as CalendarEvent with startsAt.
 *    All-day events keep their DayKeys and start at local midnight in
 *    BELLPERSONAL_TZ for window queries.
 *  - insertGoogleEvent / deleteGoogleEvent: the primary calendar, for
 *    加入行事曆, 要參加 and 排進 (deferred by the action queue or the module).
 */

export const GOOGLE_CALENDAR_INTERVAL_MS = 5 * 60_000;
const MAX_CALENDAR_PAGES = 4;
const MAX_EVENT_PAGES = 8;
type GoogleContext = Pick<ModuleContext, "config" | "vault" | "fetch" | "now">;

function statusOf(error: unknown): number | undefined {
  const value = error as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  const status = value?.response?.status ?? value?.status ?? value?.code;
  return typeof status === "number" ? status : typeof status === "string" && /^\d{3}$/.test(status) ? Number(status) : undefined;
}

/** The `reason` of a Google API error (error.errors[0].reason), e.g. rateLimitExceeded or insufficientPermissions. */
function reasonOf(error: unknown): string | undefined {
  const value = error as { errors?: Array<{ reason?: unknown }>; response?: { data?: { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } } } } | null;
  const reason = value?.response?.data?.error?.errors?.[0]?.reason ?? value?.errors?.[0]?.reason ?? value?.response?.data?.error?.status;
  return typeof reason === "string" ? reason : undefined;
}

/** 403 reasons that mean "slow down", not "the grant is wrong" (Calendar API error guide: retry with backoff). */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED"]);
/** 403 reasons that mean the grant does not cover the call. */
const AUTH_REASONS = new Set(["insufficientPermissions", "authError", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "PERMISSION_DENIED"]);

/**
 * A Calendar API failure as a zh-TW error. Only a dead or narrowed grant asks
 * to reconnect (401, invalid_grant, a 403 about scopes); a 403 rate or quota
 * limit is retried later like a 429, and any other 403 (an event the user may
 * not change) is a plain error.
 */
export function googleCalendarError(error: unknown, write: boolean): Error {
  if (error instanceof AppError) return error;
  if (needsReconnect(error)) return new ReconnectRequiredError("Google 行事曆需要重新連線。");
  const status = statusOf(error);
  if (status === 401) return new ReconnectRequiredError("Google 行事曆需要重新連線。");
  if (status === 403) {
    const reason = reasonOf(error);
    const message = (error as { message?: unknown } | null)?.message;
    if (reason && RATE_LIMIT_REASONS.has(reason)) return new AppError(429, "Google 行事曆暫時限制請求頻率，稍後會自動重試。");
    if (!reason || AUTH_REASONS.has(reason) || (typeof message === "string" && /insufficient authentication scopes/i.test(message)))
      return new ReconnectRequiredError(write ? "Google 行事曆沒有允許新增行程，請重新連線並勾選行事曆權限。" : "Google 行事曆拒絕讀取，請重新連線並勾選行事曆權限。");
    return new AppError(502, write ? "Google 行事曆拒絕了這個行程，請到 Google 行事曆確認。" : "Google 行事曆拒絕讀取其中一個行事曆，稍後會自動重試。");
  }
  if (status === 429) return new AppError(429, "Google 行事曆暫時限制請求頻率，稍後再試。");
  if ((error as { name?: string } | null)?.name === "AbortError") return new AppError(504, "Google 行事曆回應逾時，稍後再試。");
  return new AppError(502, write ? "Google 行事曆沒有回應，請稍後再試。" : "Google 行事曆暫時沒有回應，稍後會自動重試。");
}

/** Whether 加入行事曆 can reach Google: connected with calendar.events. */
export async function googleCanWrite(ctx: Pick<ModuleContext, "vault">): Promise<boolean> {
  try {
    return (await googleConnected(ctx)) && (await googleCapabilities(ctx)).calendarWrite;
  } catch {
    return false;
  }
}

/** One API event → CalendarEvent, or null (cancelled, declined, no usable time). */
export function mapGoogleEvent(
  raw: calendar_v3.Schema$Event,
  calendarRef: { id: string; name?: string; editable?: boolean },
  now: Date,
): CalendarEvent | null {
  if (!raw.id || raw.status === "cancelled") return null;
  if (raw.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined")) return null;
  const allDay = !!raw.start?.date;
  let start: string;
  let end: string;
  if (allDay) {
    if (!isDayKey(raw.start?.date)) return null;
    start = raw.start!.date!;
    end = isDayKey(raw.end?.date) && raw.end!.date! > start ? raw.end!.date! : addDays(start, 1);
  } else {
    const startTime = Date.parse(raw.start?.dateTime ?? "");
    if (Number.isNaN(startTime)) return null;
    const endTime = Date.parse(raw.end?.dateTime ?? "");
    start = new Date(startTime).toISOString();
    end = new Date(Number.isNaN(endTime) || endTime < startTime ? startTime : endTime).toISOString();
  }
  const location = plainText(raw.location ?? undefined, 200);
  const description = plainText(raw.description ?? undefined, 500);
  const title = plainText(raw.summary ?? undefined, 200) ?? "（無標題）";
  return {
    id: `google:${calendarRef.id}:${raw.id}`,
    origin: "google",
    calendarId: calendarRef.id,
    ...(calendarRef.name ? { calendarName: calendarRef.name } : {}),
    title,
    start,
    end,
    allDay,
    ...(location ? { location } : {}),
    ...(raw.htmlLink ? { url: raw.htmlLink } : {}),
    ...(description ? { description } : {}),
    // 「顯示為有空」: on the calendar, but it does not take up free time.
    ...(raw.transparency === "transparent" ? { transparent: true } : {}),
    ...(calendarRef.editable !== undefined ? { editable: calendarRef.editable } : {}),
    status: raw.status === "tentative" ? "tentative" : "confirmed",
    updatedAt: raw.updated && !Number.isNaN(Date.parse(raw.updated)) ? new Date(raw.updated).toISOString() : now.toISOString(),
  };
}

/** Extracts { calendarId, eventId } from `google:<calendarId>:<eventId>`. */
export function parseGoogleEventKey(id: string): { calendarId: string; eventId: string } | undefined {
  if (!id.startsWith("google:")) return undefined;
  const rest = id.slice("google:".length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0 || sep >= rest.length - 1) return undefined;
  return { calendarId: rest.slice(0, sep), eventId: rest.slice(sep + 1) };
}

/** The Google event id inside a CalendarEvent id (`google:<calendar>:<event id>`). */
export function googleEventIdOf(event: Pick<CalendarEvent, "id">): string | undefined {
  if (!event.id.startsWith("google:")) return undefined;
  return event.id.slice(event.id.lastIndexOf(":") + 1) || undefined;
}

export class GoogleCalendarSync extends SourceSync {
  private readonly pastDays: number;
  private readonly futureDays: number;

  constructor(
    private readonly ctx: ModuleContext,
    options: { intervalMs?: number; pastDays?: number; futureDays?: number } = {},
  ) {
    super({ id: "google-calendar", state: ctx.syncState, intervalMs: options.intervalMs ?? GOOGLE_CALENDAR_INTERVAL_MS, fetch: ctx.fetch, now: ctx.now });
    this.pastDays = options.pastDays ?? 1;
    this.futureDays = options.futureDays ?? 30;
  }

  /** calendar.readonly reads every calendar; calendar.events alone still reads the primary one (events.list). */
  async configured(): Promise<boolean> {
    if (!(await googleConnected(this.ctx))) return false;
    const capabilities = await googleCapabilities(this.ctx);
    return capabilities.calendarRead || capabilities.calendarWrite;
  }

  protected async run({ signal, now }: SyncContext): Promise<SyncOutcome> {
    const timeZone = this.ctx.config.timeZone;
    const api = calendar({ version: "v3", auth: await googleClient(this.ctx) });
    const today = todayKey(timeZone, now);
    const timeMin = dayBounds(timeZone, addDays(today, -this.pastDays)).start;
    const timeMax = dayBounds(timeZone, addDays(today, this.futureDays)).end;
    const calendars: calendar_v3.Schema$CalendarListEntry[] = [];
    if (!(await googleCapabilities(this.ctx)).calendarRead) {
      // calendarList.list needs calendar.readonly; with calendar.events alone, read the primary calendar.
      calendars.push({ id: "primary", primary: true, accessRole: "owner" });
    } else {
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_CALENDAR_PAGES; page++) {
          const response = await api.calendarList.list({ maxResults: 250, ...(pageToken ? { pageToken } : {}) }, { signal });
          calendars.push(...(response.data.items ?? []));
          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        throw googleCalendarError(error, false);
      }
    }
    const selected = calendars.filter((entry) => entry.id && !entry.deleted && !entry.hidden && (entry.primary || entry.selected));
    const inputs: SourceItemInput<CalendarEvent>[] = [];
    for (const entry of selected) {
      const writable = Boolean(
        entry.primary
          || entry.accessRole === "owner"
          || entry.accessRole === "writer"
          || (!entry.accessRole && !entry.id!.endsWith(".calendar.google.com")),
      );
      const ref = { id: entry.id!, name: entry.summaryOverride ?? entry.summary ?? undefined, editable: writable };
      const fetched: SourceItemInput<CalendarEvent>[] = [];
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_EVENT_PAGES; page++) {
          const response = await api.events.list({
            calendarId: entry.id!, timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 250, showDeleted: false,
            ...(pageToken ? { pageToken } : {}),
          }, { signal });
          for (const raw of response.data.items ?? []) {
            const event = mapGoogleEvent(raw, ref, now);
            if (!event) continue;
            const startsAt = event.allDay ? zonedTimeToUtc(timeZone, event.start).toISOString() : event.start;
            fetched.push({ kind: "calendar-event", externalId: event.id, value: event, startsAt, updatedAt: event.updatedAt });
          }
          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }
        inputs.push(...fetched);
      } catch (error) {
        if (signal.aborted) throw error;
        const mapped = googleCalendarError(error, false);
        // One other calendar failing (a shared calendar, a throttled call) keeps its cached events; the primary or a dead grant fails the sync.
        if (entry.primary || mapped instanceof ReconnectRequiredError) throw mapped;
        logEvent("google-calendar.calendar_skipped", { status: mapped instanceof AppError ? mapped.status : null });
        for (const row of this.ctx.sourceItems.list<CalendarEvent>({ source: "google-calendar", kind: "calendar-event" }))
          if (row.value.calendarId === ref.id) inputs.push({ kind: "calendar-event", externalId: row.externalId, value: row.value, startsAt: row.startsAt });
      }
    }
    this.ctx.sourceItems.replace("google-calendar", "calendar-event", inputs);
    return { items: inputs.length };
  }
}

/** The request body for a local event on the primary calendar (all-day events by date in BELLPERSONAL_TZ). */
export function googleEventBody(event: ManualEvent, timeZone: string): calendar_v3.Schema$Event {
  const description = [event.notes, event.url].filter(Boolean).join("\n\n") || undefined;
  const base = {
    summary: event.title,
    ...(event.location ? { location: event.location } : {}),
    ...(description ? { description } : {}),
  };
  if (event.allDay) {
    const first = dayKey(timeZone, event.start);
    const endDay = event.end ? dayKey(timeZone, event.end) : addDays(first, 1);
    return { ...base, start: { date: first }, end: { date: endDay > first ? endDay : addDays(first, 1) } };
  }
  const end = event.end ?? new Date(Date.parse(event.start) + 3_600_000).toISOString();
  return { ...base, start: { dateTime: event.start, timeZone }, end: { dateTime: end, timeZone } };
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

/**
 * The Google event id for a local event: `bell` + 26 base32hex characters of
 * SHA-256(local id), within Google's rules (a–v and 0–9, 5–1024 characters).
 * The same local event always gets the same id, so an insert retried after a
 * timeout whose request did reach Google cannot create a second copy.
 */
export function googleEventIdFor(localId: string): string {
  const digest = createHash("sha256").update(`bell-personal:${localId}`).digest();
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32HEX[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `bell${out}`;
}

/**
 * events.insert on the primary calendar with the local event's own id;
 * returns the Google event id. A 409 means an earlier attempt already
 * created it (a timeout after Google answered): that event is reused, and
 * restored if it was deleted since.
 */
export async function insertGoogleEvent(ctx: GoogleContext, event: ManualEvent, signal: AbortSignal): Promise<string> {
  const id = googleEventIdFor(event.id);
  const requestBody = googleEventBody(event, ctx.config.timeZone);
  try {
    const api = calendar({ version: "v3", auth: await googleClient(ctx) });
    try {
      const response = await api.events.insert({ calendarId: "primary", requestBody: { ...requestBody, id } }, { signal });
      return response.data.id ?? id;
    } catch (error) {
      if (statusOf(error) !== 409) throw error;
      const existing = await api.events.get({ calendarId: "primary", eventId: id }, { signal });
      if (existing.data.status === "cancelled")
        await api.events.update({ calendarId: "primary", eventId: id, sendUpdates: "none", requestBody: { ...requestBody, status: "confirmed" } }, { signal });
      return id;
    }
  } catch (error) {
    throw googleCalendarError(error, true);
  }
}

/** events.delete on the primary calendar; an event already gone (404/410) counts as deleted. */
export async function deleteGoogleEvent(ctx: GoogleContext, googleEventId: string, signal: AbortSignal): Promise<void> {
  return deleteGoogleEventOnCalendar(ctx, "primary", googleEventId, signal);
}

/** events.delete on a specific Google calendar; 404/410 counts as deleted. */
export async function deleteGoogleEventOnCalendar(
  ctx: GoogleContext,
  calendarId: string,
  googleEventId: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const api = calendar({ version: "v3", auth: await googleClient(ctx) });
    await api.events.delete({ calendarId, eventId: googleEventId, sendUpdates: "none" }, { signal });
  } catch (error) {
    const status = statusOf(error);
    if (status === 404 || status === 410) return;
    throw googleCalendarError(error, true);
  }
}

/**
 * Updates an already-synced local event's copy on Google's primary calendar.
 * If the Google copy was deleted externally (404/410), re-inserts it cleanly.
 */
export async function updateGoogleEvent(ctx: GoogleContext, event: ManualEvent, signal: AbortSignal): Promise<string> {
  const googleEventId = event.googleEventId ?? googleEventIdFor(event.id);
  const requestBody = googleEventBody(event, ctx.config.timeZone);
  try {
    const api = calendar({ version: "v3", auth: await googleClient(ctx) });
    try {
      await api.events.update({
        calendarId: "primary",
        eventId: googleEventId,
        sendUpdates: "none",
        requestBody: { ...requestBody, status: "confirmed" },
      }, { signal });
      return googleEventId;
    } catch (error) {
      const status = statusOf(error);
      if (status !== 404 && status !== 410) throw error;
      return await insertGoogleEvent(ctx, event, signal);
    }
  } catch (error) {
    throw googleCalendarError(error, true);
  }
}

/**
 * Patches a native Google Calendar event in place using `events.patch` so
 * attendees, Google Meet links, reminders, and colorId on Google Calendar stay intact.
 */
export async function patchNativeGoogleEvent(
  ctx: GoogleContext,
  calendarId: string,
  eventId: string,
  next: CalendarEvent,
  signal: AbortSignal,
): Promise<void> {
  const timeZone = ctx.config.timeZone;
  const requestBody: calendar_v3.Schema$Event = {
    summary: next.title,
    location: next.location ?? "",
    description: next.description ?? "",
    ...(next.allDay
      ? {
          start: { date: next.start, dateTime: null as unknown as undefined },
          end: { date: next.end, dateTime: null as unknown as undefined },
        }
      : {
          start: { date: null as unknown as undefined, dateTime: next.start, timeZone },
          end: { date: null as unknown as undefined, dateTime: next.end, timeZone },
        }),
  };
  try {
    const api = calendar({ version: "v3", auth: await googleClient(ctx) });
    await api.events.patch({ calendarId, eventId, sendUpdates: "none", requestBody }, { signal });
  } catch (error) {
    throw googleCalendarError(error, true);
  }
}

/**
 * Restores a deleted native Google Calendar event (Undo of DELETE /api/calendar/google-events):
 * Google keeps deleted events in `cancelled` status under the same eventId, so `patch` with
 * `status: "confirmed"` revives it in place; if 404, inserts a fresh event on that calendar.
 */
export async function restoreNativeGoogleEvent(
  ctx: GoogleContext,
  snapshot: CalendarEvent,
  signal: AbortSignal,
): Promise<CalendarEvent> {
  const parsed = parseGoogleEventKey(snapshot.id);
  const calendarId = parsed?.calendarId ?? snapshot.calendarId ?? "primary";
  const eventId = parsed?.eventId;
  const timeZone = ctx.config.timeZone;
  const requestBody: calendar_v3.Schema$Event = {
    summary: snapshot.title,
    ...(snapshot.location ? { location: snapshot.location } : {}),
    ...(snapshot.description ? { description: snapshot.description } : {}),
    status: "confirmed",
    ...(snapshot.allDay
      ? { start: { date: snapshot.start }, end: { date: snapshot.end } }
      : { start: { dateTime: snapshot.start, timeZone }, end: { dateTime: snapshot.end, timeZone } }),
  };
  try {
    const api = calendar({ version: "v3", auth: await googleClient(ctx) });
    if (eventId) {
      try {
        const revived = await api.events.patch({ calendarId, eventId, sendUpdates: "none", requestBody }, { signal });
        return mapGoogleEvent(
          revived.data.id ? revived.data : { ...requestBody, id: eventId },
          { id: calendarId, name: snapshot.calendarName, editable: snapshot.editable ?? true },
          ctx.now(),
        ) ?? snapshot;
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
      }
    }
    const inserted = await api.events.insert({ calendarId, requestBody }, { signal });
    return mapGoogleEvent(
      inserted.data,
      { id: calendarId, name: snapshot.calendarName, editable: snapshot.editable ?? true },
      ctx.now(),
    ) ?? { ...snapshot, id: `google:${calendarId}:${inserted.data.id ?? eventId ?? "restored"}` };
  } catch (error) {
    throw googleCalendarError(error, true);
  }
}
