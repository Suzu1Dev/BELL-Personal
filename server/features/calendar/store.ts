import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CALENDAR_LIMITS, MANUAL_EVENT_LIMITS, MANUAL_EVENT_ORIGINS, REPEAT_LIMITS,
  type CalendarEvent, type CalendarEventUpdateRequest, type EventRepeat, type EventRepeatInput,
  type GoogleCalendarEventUpdateRequest, type ManualEvent,
} from "../../../shared/calendar.js";
import { ACTION_COMMIT_MS } from "../../../shared/limits.js";
import { SOURCE_IDS, type SourceRef } from "../../../shared/sources.js";
import { addDays, dayKey, isDayKey, weekdayOf, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";
import type { DocTable } from "../../db/database.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import {
  deleteGoogleEvent, deleteGoogleEventOnCalendar, googleCanWrite, googleEventIdOf, insertGoogleEvent,
  parseGoogleEventKey, patchNativeGoogleEvent, restoreNativeGoogleEvent, updateGoogleEvent,
} from "./google.js";
import { isOccurrenceDay } from "./repeat.js";

/**
 * Local events (personal.sqlite manual_events) and their optional Google
 * copy. One CalendarService per database (calendarService(ctx)) owns the
 * DocTable and its trash registration, so the calendar module, the events
 * module (要參加) and the capture module (快速記下 → 行程) share it instead of
 * opening a second DocTable on the same table.
 */

const iso = z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "時間格式不正確" });
const dayKeySchema = z.string().refine(isDayKey, { message: "日期格式不正確" });

/** What a create request (POST /api/calendar/events, a capture) may ask of a repeat: weekly, optionally until a local day. */
export const eventRepeatInputSchema = z.object({ freq: z.literal("weekly"), until: dayKeySchema.optional() }).strict();

/** What PATCH /api/calendar/events/:id may ask of a repeat: the create fields plus the deleted occurrences (復原 of an edit puts them back). */
export const eventRepeatPatchSchema = z.object({
  freq: z.literal("weekly"),
  until: dayKeySchema.optional(),
  skip: z.array(dayKeySchema).max(REPEAT_LIMITS.skipDays).optional(),
}).strict();

export const manualEventSchema: z.ZodType<ManualEvent> = z.object({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(MANUAL_EVENT_LIMITS.title),
  start: iso,
  end: iso.optional(),
  allDay: z.boolean(),
  location: z.string().max(MANUAL_EVENT_LIMITS.location).optional(),
  url: z.string().max(2000).optional(),
  notes: z.string().max(MANUAL_EVENT_LIMITS.notes).optional(),
  sourceRef: z.object({ source: z.enum(SOURCE_IDS), externalId: z.string().max(600), url: z.string().max(2000).optional() }).optional(),
  googleEventId: z.string().max(1024).optional(),
  origin: z.enum(MANUAL_EVENT_ORIGINS).optional(),
  itemId: z.string().max(600).optional(),
  originalText: z.string().max(MANUAL_EVENT_LIMITS.originalText).optional(),
  tidiedAt: iso.optional(),
  repeat: z.object({ freq: z.literal("weekly"), until: dayKeySchema.optional(), skip: z.array(dayKeySchema).max(REPEAT_LIMITS.skipDays).optional() }).optional(),
  pretidy: z.object({
    title: z.string().max(MANUAL_EVENT_LIMITS.title),
    notes: z.string().max(MANUAL_EVENT_LIMITS.notes).optional(),
    location: z.string().max(MANUAL_EVENT_LIMITS.location).optional(),
  }).optional(),
  createdAt: iso,
  updatedAt: iso,
});

/** What callers pass to create a local event. Times are ISO instants (all-day: local midnights, end exclusive). */
export interface NewManualEvent {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  url?: string;
  notes?: string;
  sourceRef?: SourceRef;
  origin?: ManualEvent["origin"];
  itemId?: string;
  /** Quick capture: the sentence the title was read from. */
  originalText?: string;
  /** A weekly event: every week on the weekday of `start`, never added to Google Calendar. */
  repeat?: EventRepeatInput;
}

const clip = (value: string | undefined, max: number) => {
  const text = value?.trim();
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined;
};

/** Sets or clears (null, "" or blank) an optional text field. */
function assignText(event: ManualEvent, key: "location" | "notes", value: string | null | undefined, max: number): void {
  if (value === undefined) return;
  const text = clip(value ?? undefined, max);
  if (text) event[key] = text;
  else delete event[key];
}

/** The end is not before the start and the event is not longer than two weeks (instants in ms). */
function assertSpan(start: number, end: number | undefined): void {
  if (end === undefined) return;
  if (Number.isNaN(end) || end < start) throw new AppError(400, "行程的結束時間必須在開始之後。");
  if (end - start > CALENDAR_LIMITS.maxEventHours * 3_600_000) throw new AppError(400, "一個行程最長兩週。");
}

/** The start and end a request states: ISO instants, or (all-day) local days with `end` the last day, inclusive. */
export interface RequestedTimes {
  start: string;
  end?: string;
  allDay: boolean;
}

/**
 * Turns the times of a request (POST and PATCH /api/calendar/events) into stored instants: an all-day event runs from the
 * local midnight of its first day to the one after its last; a timed event keeps its instants. The one place that parses them.
 */
export function resolveTimes(timeZone: string, input: RequestedTimes): { start: string; end?: string } {
  if (input.allDay) {
    const firstDay = isDayKey(input.start) ? input.start : undefined;
    const lastDay = input.end === undefined ? firstDay : isDayKey(input.end) ? input.end : undefined;
    if (!firstDay || !lastDay || lastDay < firstDay) throw new AppError(400, "整天行程請用 YYYY-MM-DD 指定日期。");
    return { start: zonedTimeToUtc(timeZone, firstDay).toISOString(), end: zonedTimeToUtc(timeZone, addDays(lastDay, 1)).toISOString() };
  }
  if (!iso.safeParse(input.start).success || isDayKey(input.start)) throw new AppError(400, "行程的開始時間格式不正確。");
  if (input.end !== undefined && (!iso.safeParse(input.end).success || isDayKey(input.end))) throw new AppError(400, "行程的結束時間格式不正確。");
  return { start: new Date(input.start).toISOString(), ...(input.end !== undefined ? { end: new Date(input.end).toISOString() } : {}) };
}

/** The stored times of an event as a request states them in `allDay` mode (so a PATCH that names only some of them keeps the others). */
function requestedTimes(event: ManualEvent, allDay: boolean, timeZone: string): { start: string; end?: string } {
  if (!allDay) return { start: event.start, ...(event.end ? { end: event.end } : {}) };
  const first = dayKey(timeZone, event.start);
  const last = event.end ? dayKey(timeZone, Date.parse(event.end) - 1) : first;
  return { start: first, end: last < first ? first : last };
}

export class CalendarService {
  readonly events: DocTable<ManualEvent>;
  /** Google inserts waiting for their undo window (POST /api/calendar/events, …/google, capture). */
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; controller: AbortController }>();
  private readonly running = new Set<Promise<void>>();
  /** Inserts on their way to Google (no longer pending, no googleEventId yet). */
  private readonly inserting = new Set<string>();

  constructor(private readonly ctx: ModuleContext, private readonly commitMs = ACTION_COMMIT_MS) {
    this.events = ctx.db.personal.docs<ManualEvent>({
      table: "manual_events",
      label: "行程",
      schema: manualEventSchema,
      columns: (event) => ({ starts_at: event.start, ends_at: event.end ?? null, created_at: event.createdAt }),
    }, ctx.trash);
  }

  /** Validates and stores a local event. */
  create(input: NewManualEvent): ManualEvent {
    const start = Date.parse(input.start);
    if (Number.isNaN(start)) throw new AppError(400, "行程的開始時間格式不正確。");
    const end = input.end ? Date.parse(input.end) : undefined;
    assertSpan(start, end);
    const until = input.repeat?.until;
    if (until && until < dayKey(this.ctx.config.timeZone, start)) throw new AppError(400, "「直到」的日期不能早於第一次行程。");
    const title = clip(input.title, MANUAL_EVENT_LIMITS.title);
    if (!title) throw new AppError(400, "請輸入行程名稱。");
    const now = this.ctx.now().toISOString();
    const location = clip(input.location, MANUAL_EVENT_LIMITS.location);
    const notes = clip(input.notes, MANUAL_EVENT_LIMITS.notes);
    return this.events.put({
      id: randomUUID(),
      title,
      start: new Date(start).toISOString(),
      ...(end !== undefined && end > start ? { end: new Date(end).toISOString() } : {}),
      allDay: !!input.allDay,
      ...(location ? { location } : {}),
      ...(input.url ? { url: input.url.slice(0, 2000) } : {}),
      ...(notes ? { notes } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.originalText ? { originalText: input.originalText.slice(0, MANUAL_EVENT_LIMITS.originalText) } : {}),
      ...(input.repeat ? { repeat: { freq: "weekly" as const, ...(until ? { until } : {}) } } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * PATCH /api/calendar/events/:id: the fields given change, the rest stays. A weekly event is one row, so its edit is the
   * whole series' (its `start` is the first occurrence and gives the weekday). Refused with 409 once the event is in Google
   * Calendar or its insert is pending or on its way: nothing updates a Google copy.
   *
   * The owner's wording wins over 自動整理, as in TodoStore.update: a new title, place or note ends the typed sentence
   * (`originalText`, which 整理 would read instead of the edit) and 復原整理 (`pretidy`, which would put the old words back).
   */
  update(id: string, patch: CalendarEventUpdateRequest, options: { allowGoogle?: boolean } = {}): ManualEvent {
    const event = this.events.get(id, { strict: true });
    if (!event) throw new AppError(404, "找不到這個行程，可能已經刪除。");
    if (!options.allowGoogle && (event.googleEventId || this.isPending(id) || this.isInserting(id)))
      throw new AppError(409, "這個行程已經送到 Google 行事曆，請到 Google 行事曆修改。");
    if (Object.values(patch).every((value) => value === undefined)) return event;
    const timeZone = this.ctx.config.timeZone;
    const next: ManualEvent = { ...event, updatedAt: this.ctx.now().toISOString() };

    if (patch.title !== undefined) {
      const title = clip(patch.title, MANUAL_EVENT_LIMITS.title);
      if (!title) throw new AppError(400, "請輸入行程名稱。");
      next.title = title;
    }
    assignText(next, "location", patch.location, MANUAL_EVENT_LIMITS.location);
    assignText(next, "notes", patch.notes, MANUAL_EVENT_LIMITS.notes);

    next.allDay = patch.allDay ?? event.allDay;
    if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
      const current = requestedTimes(event, next.allDay, timeZone);
      const when = resolveTimes(timeZone, {
        start: patch.start ?? current.start,
        end: patch.end === undefined ? current.end : patch.end ?? undefined,
        allDay: next.allDay,
      });
      const start = Date.parse(when.start);
      const end = when.end === undefined ? undefined : Date.parse(when.end);
      assertSpan(start, end);
      next.start = when.start;
      if (when.end !== undefined && end! > start) next.end = when.end;
      else delete next.end;
    }

    let repeat: EventRepeat | undefined = event.repeat;
    if (patch.repeat !== undefined) {
      const skip = patch.repeat?.skip ?? event.repeat?.skip;
      repeat = patch.repeat ? { freq: "weekly", ...(patch.repeat.until ? { until: patch.repeat.until } : {}), ...(skip ? { skip } : {}) } : undefined;
    }
    if (repeat) {
      const first = dayKey(timeZone, next.start);
      if (repeat.until && repeat.until < first) throw new AppError(400, "「直到」的日期不能早於第一次行程。");
      // A deleted occurrence only means something on the series' weekday: moving the series to another weekday forgets them.
      const weekday = weekdayOf(first);
      const skip = [...new Set(repeat.skip ?? [])].filter((day) => weekdayOf(day) === weekday).sort();
      next.repeat = { freq: "weekly", ...(repeat.until ? { until: repeat.until } : {}), ...(skip.length ? { skip } : {}) };
    } else {
      delete next.repeat;
    }

    if (patch.start !== undefined) {
      // A series began in the past by definition: only a first day far ahead is refused, like a new event's far-off day.
      const ahead = Date.parse(next.start) - this.ctx.now().getTime();
      const limit = CALENDAR_LIMITS.futureDays * 86_400_000;
      if (ahead > limit || (!next.repeat && -ahead > limit)) throw new AppError(400, "日期超出可設定的範圍。");
    }

    if (next.title !== event.title || next.location !== event.location || next.notes !== event.notes) {
      delete next.originalText;
      delete next.pretidy;
    }
    return this.events.put(next);
  }

  get(id: string): ManualEvent | undefined {
    return this.events.get(id);
  }

  /** One-off local events overlapping [from, to) (a week of slack for long events); weekly series come from series(). */
  between(from: string, to: string): ManualEvent[] {
    const slack = new Date(Date.parse(from) - CALENDAR_LIMITS.maxEventHours * 3_600_000).toISOString();
    return this.events.list({ where: "starts_at >= ? AND starts_at < ?", params: [slack, to], orderBy: "starts_at" })
      .filter((event) => !event.repeat)
      .filter((event) => Date.parse(event.end ?? event.start) >= Date.parse(from) || Date.parse(event.start) >= Date.parse(from));
  }

  /**
   * Weekly series that can have an occurrence in [from, to): those whose first
   * occurrence starts before `to` (however long ago) and that have not ended
   * more than the longest event before `from`. The index window of between()
   * cannot find them, because only their first occurrence is indexed.
   */
  series(from: string, to: string): ManualEvent[] {
    const earliestEnd = addDays(dayKey(this.ctx.config.timeZone, from), -(CALENDAR_LIMITS.maxEventHours / 24 + 1));
    return this.events.list({
      where: "json_type(json, '$.repeat') = 'object' AND starts_at < ? AND (json_extract(json, '$.repeat.until') IS NULL OR json_extract(json, '$.repeat.until') >= ?)",
      params: [to, earliestEnd],
      orderBy: "starts_at",
    });
  }

  /** 只刪這一次: one occurrence of a weekly event does not happen (idempotent). */
  skipOccurrence(id: string, skipDay: DayKey): ManualEvent {
    const event = this.requireSeries(id, skipDay);
    const skip = [...new Set([...(event.repeat?.skip ?? []), skipDay])].sort();
    if (skip.length > REPEAT_LIMITS.skipDays) throw new AppError(400, "這個每週行程已經跳過太多次了，請刪除後重新建立。");
    return this.events.put({ ...event, repeat: { ...event.repeat!, skip }, updatedAt: this.ctx.now().toISOString() });
  }

  /** Puts a skipped occurrence back (復原 of 只刪這一次; idempotent). */
  restoreOccurrence(id: string, skipDay: DayKey): ManualEvent {
    const event = this.requireSeries(id, skipDay);
    const { skip: _skip, ...repeat } = event.repeat!;
    const rest = (event.repeat?.skip ?? []).filter((entry) => entry !== skipDay);
    return this.events.put({ ...event, repeat: { ...repeat, ...(rest.length ? { skip: rest } : {}) }, updatedAt: this.ctx.now().toISOString() });
  }

  private requireSeries(id: string, occurrenceDay: DayKey): ManualEvent {
    const event = this.events.get(id, { strict: true });
    if (!event) throw new AppError(404, "找不到這個行程，可能已經刪除。");
    if (!event.repeat) throw new AppError(400, "這不是每週行程。");
    if (!isOccurrenceDay(event, occurrenceDay, this.ctx.config.timeZone)) throw new AppError(400, "這一天沒有這個每週行程。");
    return event;
  }

  /** The event 要參加 created for a queue item (`ctftime:2846`), if any. */
  goingFor(itemId: string): ManualEvent | undefined {
    return this.events.list({ where: "json_extract(json, '$.itemId') = ? AND json_extract(json, '$.origin') = 'going'", params: [itemId], limit: 1 })[0];
  }

  /** Every local event made by 要參加, by queue item id. */
  goingByItem(): Map<string, ManualEvent> {
    const list = this.events.list({ where: "json_extract(json, '$.origin') = 'going'", orderBy: "starts_at" });
    return new Map(list.filter((event) => event.itemId).map((event) => [event.itemId!, event]));
  }

  /** Removes a local event without a trash copy (undo of the action that created it). */
  discard(id: string): void {
    this.cancelPending(id);
    this.ctx.db.personal.db.prepare("DELETE FROM manual_events WHERE id = ?").run(id);
  }

  /** Connected with calendar.events (加入行事曆 can reach Google). */
  canWriteGoogle(): Promise<boolean> {
    return googleCanWrite(this.ctx);
  }

  /** Inserts the local event into Google and remembers the Google id; a deleted event is skipped, and a weekly series stays in BELL (undefined). */
  async pushToGoogle(id: string, signal: AbortSignal): Promise<string | undefined> {
    const event = this.events.get(id);
    if (!event || event.repeat) return undefined;
    if (event.googleEventId) return event.googleEventId;
    const googleEventId = await insertGoogleEvent(this.ctx, event, signal);
    const current = this.events.get(id);
    if (!current) {
      // Undone while the insert was in flight: take the copy back out.
      await deleteGoogleEvent(this.ctx, googleEventId, signal).catch(() => {});
      return undefined;
    }
    this.events.put({ ...current, googleEventId, updatedAt: this.ctx.now().toISOString() });
    logEvent("calendar.google_inserted", { origin: current.origin ?? "capture" });
    return googleEventId;
  }

  /** Deletes the Google copy of a local event and forgets its id (and removes any cached twin in source_items). */
  async removeFromGoogle(id: string, signal: AbortSignal): Promise<boolean> {
    if (this.cancelPending(id)) return true;
    const event = this.events.get(id);
    if (!event?.googleEventId) return false;
    await deleteGoogleEvent(this.ctx, event.googleEventId, signal);
    this.dropCachedGoogleByEventId(event.googleEventId);
    const current = this.events.get(id);
    if (current) {
      const { googleEventId: _removed, ...rest } = current;
      this.events.put({ ...rest, updatedAt: this.ctx.now().toISOString() });
    }
    return true;
  }

  /**
   * Two-way edit of a local event: updates SQLite and, if the event is pending or
   * already in Google Calendar, reschedules or updates its Google Calendar copy
   * in lockstep (rolling back the local edit if Google refuses).
   */
  async updateWithGoogle(id: string, patch: CalendarEventUpdateRequest, signal: AbortSignal): Promise<ManualEvent> {
    if (this.isInserting(id)) await Promise.allSettled([...this.running]);
    const before = this.events.get(id, { strict: true });
    if (!before) throw new AppError(404, "找不到這個行程，可能已經刪除。");

    if (this.isPending(id)) {
      const next = this.update(id, patch, { allowGoogle: true });
      if (next.repeat) this.cancelPending(id);
      else this.reschedule(id);
      return next;
    }

    if (!before.googleEventId) return this.update(id, patch);

    if (!(await this.canWriteGoogle())) {
      throw new AppError(409, "這個行程已經送到 Google 行事曆，請到 Google 行事曆修改。");
    }
    if (Object.values(patch).every((value) => value === undefined)) return before;

    const next = this.update(id, patch, { allowGoogle: true });
    try {
      if (next.repeat) {
        // Turning a synced event into a weekly class moves it back to BELL-only series storage.
        await deleteGoogleEvent(this.ctx, before.googleEventId, signal);
        this.dropCachedGoogleByEventId(before.googleEventId);
        const { googleEventId: _removed, ...withoutGoogle } = next;
        return this.events.put(withoutGoogle);
      }
      const googleEventId = await updateGoogleEvent(this.ctx, next, signal);
      const updated = googleEventId !== next.googleEventId ? this.events.put({ ...next, googleEventId }) : next;
      this.syncCachedGoogleTwin(updated);
      return updated;
    } catch (error) {
      this.events.put(before);
      throw error;
    }
  }

  /**
   * Directly edits a native Google Calendar event (`google:<calendarId>:<eventId>`)
   * from BELL Personal, updating both Google Calendar v3 and the local source_items cache.
   */
  async updateNativeGoogle(patch: Omit<GoogleCalendarEventUpdateRequest, "id"> & { id: string }, signal: AbortSignal): Promise<CalendarEvent> {
    const parsed = parseGoogleEventKey(patch.id);
    if (!parsed) throw new AppError(400, "Google 行程編號格式不正確。");
    if (!(await this.canWriteGoogle())) {
      throw new AppError(503, "請先在「連線與設定」連接 Google 行事曆，並允許修改行程。");
    }
    const cachedRow = this.ctx.sourceItems.get<CalendarEvent>("google-calendar", patch.id);
    if (!cachedRow) throw new AppError(404, "找不到這個 Google 行程，請重新同步後再試。");
    const current = cachedRow.value;
    if (current.editable === false) throw new AppError(403, "這個日曆是唯讀訂閱，無法直接修改。");

    const timeZone = this.ctx.config.timeZone;
    const allDay = patch.allDay ?? current.allDay;
    let start = current.start;
    let end = current.end;

    if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
      const currentStartReq = allDay
        ? (isDayKey(current.start) ? current.start : dayKey(timeZone, current.start))
        : (isDayKey(current.start) ? zonedTimeToUtc(timeZone, current.start, 9, 0).toISOString() : current.start);
      const currentEndReq = allDay
        ? (isDayKey(current.end) ? addDays(current.end, -1) : dayKey(timeZone, Date.parse(current.end) - 1))
        : (isDayKey(current.end) ? zonedTimeToUtc(timeZone, current.end, 10, 0).toISOString() : current.end);
      const resolved = resolveTimes(timeZone, {
        start: patch.start ?? currentStartReq,
        end: patch.end === undefined ? currentEndReq : patch.end ?? undefined,
        allDay,
      });
      const startMs = Date.parse(resolved.start);
      const endMs = resolved.end ? Date.parse(resolved.end) : undefined;
      assertSpan(startMs, endMs);
      if (allDay) {
        start = dayKey(timeZone, resolved.start);
        const endExclusive = resolved.end ? dayKey(timeZone, resolved.end) : addDays(start, 1);
        end = endExclusive > start ? endExclusive : addDays(start, 1);
      } else {
        start = resolved.start;
        end = resolved.end && endMs! > startMs ? resolved.end : resolved.start;
      }
    }

    const title = patch.title !== undefined ? clip(patch.title, MANUAL_EVENT_LIMITS.title) : current.title;
    if (!title) throw new AppError(400, "請輸入行程名稱。");
    const location = patch.location === undefined ? current.location : clip(patch.location ?? undefined, MANUAL_EVENT_LIMITS.location);
    const description = patch.notes === undefined ? current.description : clip(patch.notes ?? undefined, MANUAL_EVENT_LIMITS.notes);

    const next: CalendarEvent = {
      ...current,
      title,
      start,
      end,
      allDay,
      updatedAt: this.ctx.now().toISOString(),
    };
    if (location) next.location = location;
    else delete next.location;
    if (description) next.description = description;
    else delete next.description;

    await patchNativeGoogleEvent(this.ctx, parsed.calendarId, parsed.eventId, next, signal);
    const startsAt = next.allDay ? zonedTimeToUtc(timeZone, next.start).toISOString() : next.start;
    this.ctx.sourceItems.upsert("google-calendar", [{
      kind: "calendar-event",
      externalId: next.id,
      value: next,
      startsAt,
      updatedAt: next.updatedAt,
    }]);
    return next;
  }

  /** Deletes a native Google Calendar event and removes it from the local cache, returning its snapshot for Undo. */
  async deleteNativeGoogle(id: string, signal: AbortSignal): Promise<CalendarEvent | undefined> {
    const parsed = parseGoogleEventKey(id);
    if (!parsed) throw new AppError(400, "Google 行程編號格式不正確。");
    if (!(await this.canWriteGoogle())) {
      throw new AppError(503, "請先在「連線與設定」連接 Google 行事曆，並允許刪除行程。");
    }
    const cached = this.ctx.sourceItems.get<CalendarEvent>("google-calendar", id)?.value;
    if (cached?.editable === false) throw new AppError(403, "這個日曆是唯讀訂閱，無法直接刪除。");
    await deleteGoogleEventOnCalendar(this.ctx, parsed.calendarId, parsed.eventId, signal);
    this.ctx.sourceItems.remove("google-calendar", [id]);
    return cached;
  }

  /** Restores a deleted native Google Calendar event (Undo) and puts it back into source_items. */
  async restoreNativeGoogle(snapshot: CalendarEvent, signal: AbortSignal): Promise<CalendarEvent> {
    if (!(await this.canWriteGoogle())) {
      throw new AppError(503, "請先在「連線與設定」連接 Google 行事曆。");
    }
    const restored = await restoreNativeGoogleEvent(this.ctx, snapshot, signal);
    const startsAt = restored.allDay ? zonedTimeToUtc(this.ctx.config.timeZone, restored.start).toISOString() : restored.start;
    this.ctx.sourceItems.upsert("google-calendar", [{
      kind: "calendar-event",
      externalId: restored.id,
      value: restored,
      startsAt,
      updatedAt: restored.updatedAt,
    }]);
    return restored;
  }

  private dropCachedGoogleByEventId(googleEventId: string): void {
    const matches = this.ctx.sourceItems.list<CalendarEvent>({ source: "google-calendar", kind: "calendar-event" })
      .filter((row) => googleEventIdOf(row.value) === googleEventId)
      .map((row) => row.externalId);
    if (matches.length) this.ctx.sourceItems.remove("google-calendar", matches);
  }

  private syncCachedGoogleTwin(event: ManualEvent): void {
    if (!event.googleEventId) return;
    const timeZone = this.ctx.config.timeZone;
    const rows = this.ctx.sourceItems.list<CalendarEvent>({ source: "google-calendar", kind: "calendar-event" })
      .filter((row) => googleEventIdOf(row.value) === event.googleEventId);
    if (!rows.length) return;
    const start = event.allDay ? dayKey(timeZone, event.start) : event.start;
    const end = event.allDay
      ? (event.end ? dayKey(timeZone, event.end) : addDays(start, 1))
      : (event.end ?? new Date(Date.parse(event.start) + 3_600_000).toISOString());
    const startsAt = event.allDay ? zonedTimeToUtc(timeZone, start).toISOString() : start;
    this.ctx.sourceItems.upsert("google-calendar", rows.map((row) => {
      const next: CalendarEvent = {
        ...row.value,
        title: event.title,
        start,
        end,
        allDay: event.allDay,
        updatedAt: event.updatedAt,
      };
      if (event.location) next.location = event.location;
      else delete next.location;
      if (event.notes) next.description = event.notes;
      else delete next.description;
      return {
        kind: "calendar-event" as const,
        externalId: row.externalId,
        value: next,
        startsAt,
        updatedAt: event.updatedAt,
      };
    }));
  }

  /**
   * The Google insert of a local event created outside the action queue
   * (POST /api/calendar/events): it waits ACTION_COMMIT_MS so an undo
   * (DELETE) cancels it before anything reaches Google. A weekly series is
   * never inserted: nothing is left pending for it.
   */
  deferPush(id: string): void {
    this.cancelPending(id);
    if (this.events.get(id)?.repeat) return;
    const controller = new AbortController();
    const timer = setTimeout(() => { void this.commit(id); }, this.commitMs);
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(id, { timer, controller });
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * The Google insert has started and not settled: the event is neither
   * pending nor carrying its googleEventId yet, but a local rewrite now would
   * not reach Google (自動整理 and 復原整理 treat it as in Google).
   */
  isInserting(id: string): boolean {
    return this.inserting.has(id);
  }

  /**
   * Moves a waiting Google insert to `delayMs` from now (default: a fresh undo
   * window). Quick capture's 自動整理 postpones it while the model rewrites
   * the event, then starts a fresh window, so Google gets the tidied title
   * once. False when nothing was waiting (already inserted, cancelled, local only).
   */
  reschedule(id: string, delayMs = this.commitMs): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.commit(id); }, delayMs);
    (entry.timer as { unref?: () => void }).unref?.();
    return true;
  }

  /** Cancels a waiting Google insert; true when one was waiting. */
  cancelPending(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    return true;
  }

  /** Shutdown: send the waiting inserts now. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending.keys()].map((id) => this.commit(id)));
    await Promise.allSettled([...this.running]);
  }

  /** Tests: drop the waiting inserts. */
  dropPending(): void {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
    this.pending.clear();
  }

  private async commit(id: string): Promise<void> {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.inserting.add(id);
    const task = this.pushToGoogle(id, AbortSignal.any([entry.controller.signal, AbortSignal.timeout(20_000)]))
      .then(() => undefined)
      .catch((error: unknown) => {
        // The local event stays; 加入行事曆 on #/events or the calendar can try again.
        logEvent("calendar.google_insert_failed", { errorClass: error instanceof Error ? error.name : typeof error });
      })
      .finally(() => { this.inserting.delete(id); });
    this.running.add(task);
    try { await task; } finally { this.running.delete(task); }
  }
}

const services = new WeakMap<object, CalendarService>();

/** The CalendarService of this database (created on first use; the trash restorer is registered once). */
export function calendarService(ctx: ModuleContext): CalendarService {
  let service = services.get(ctx.db.personal);
  if (!service) {
    service = new CalendarService(ctx);
    services.set(ctx.db.personal, service);
  }
  return service;
}
