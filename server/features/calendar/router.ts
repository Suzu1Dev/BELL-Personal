import { Router } from "express";
import { z } from "zod";
import {
  CALENDAR_EVENT_STATUSES, CALENDAR_LIMITS, CALENDAR_PAGE_VIEWS, MANUAL_EVENT_LIMITS, weeklyLabel,
  type CalendarEvent, type CalendarEventCreateResponse, type CalendarEventDeleteResponse, type CalendarEventSkipResponse, type CalendarEventUpdateRequest, type CalendarGoogleInsertResponse,
  type CalendarResponse, type CalendarSourceState, type GoogleCalendarEventDeleteResponse, type GoogleCalendarEventUpdateRequest, type ManualEvent,
} from "../../../shared/calendar.js";
import type { SourceStatus } from "../../../shared/sources.js";
import { addDays, dayBounds, daysBetween, isDayKey, localTime, todayKey, weekdayOf, type DayKey } from "../../../shared/time.js";
import { monthDayWeek } from "../../../shared/today-format.js";
import { AppError } from "../../errors.js";
import { googleCapabilities, googleConnected } from "../../google/auth.js";
import type { ModuleContext } from "../../modules.js";
import type { SourceSync } from "../../sync.js";
import { todaySource } from "../../today/service.js";
import { enabledFeeds } from "../events/feeds.js";
import { cancelTidy } from "../capture/tidy.js";
import { collectItems, freeSlots, itemsOnDay } from "./agenda.js";
import { calendarService, eventRepeatInputSchema, eventRepeatPatchSchema, resolveTimes } from "./store.js";

/**
 * /api/calendar (the #/calendar page and quick capture):
 *   GET    /                       ?view=day|week|month&day=YYYY-MM-DD → CalendarResponse
 *   POST   /events                 CalendarEventCreateRequest → 201 CalendarEventCreateResponse
 *   PATCH  /events/:id             CalendarEventUpdateRequest → ManualEvent (two-way updates Google copy when synced)
 *   DELETE /events/:id             {} → CalendarEventDeleteResponse (trash token for 復原; removes Google copy too)
 *   POST   /events/:id/skip        { day } → CalendarEventSkipResponse (只刪這一次 of a weekly event)
 *   DELETE /events/:id/skip/:day   {} → { restored } (復原 of that)
 *   POST   /events/:id/google      {} → 202 CalendarGoogleInsertResponse (deferred insert; never for a weekly event)
 *   DELETE /events/:id/google      {} → { removed } (cancel the insert or delete the Google copy)
 *   PATCH  /google-events          GoogleCalendarEventUpdateRequest → CalendarEvent (two-way edit of native Google event)
 *   DELETE /google-events          { id } → GoogleCalendarEventDeleteResponse (deletes native Google event + snapshot for Undo)
 *   POST   /google-events/restore  { snapshot } → { event: CalendarEvent } (restores deleted native Google event)
 */

const createSchema = z.object({
  title: z.string().trim().min(1).max(MANUAL_EVENT_LIMITS.title),
  start: z.string().min(1).max(40),
  end: z.string().min(1).max(40).optional(),
  allDay: z.boolean().optional(),
  location: z.string().trim().max(MANUAL_EVENT_LIMITS.location).optional(),
  notes: z.string().trim().max(MANUAL_EVENT_LIMITS.notes).optional(),
  url: z.string().trim().url().max(2000).refine((value) => /^https?:\/\//i.test(value), { message: "網址必須是 http(s)" }).optional(),
  addToGoogle: z.boolean().optional(),
  repeat: eventRepeatInputSchema.optional(),
}).strict();

const text = (label: string, max: number) => z.string().trim().max(max, { message: `${label}最多 ${max} 個字。` });

const updateSchema = z.object({
  title: z.string().trim().min(1, { message: "請輸入行程名稱。" }).max(MANUAL_EVENT_LIMITS.title, { message: `行程名稱最多 ${MANUAL_EVENT_LIMITS.title} 個字。` }).optional(),
  start: z.string().min(1).max(40).optional(),
  end: z.string().min(1).max(40).nullable().optional(),
  allDay: z.boolean().optional(),
  location: text("地點", MANUAL_EVENT_LIMITS.location).nullable().optional(),
  notes: text("備註", MANUAL_EVENT_LIMITS.notes).nullable().optional(),
  repeat: eventRepeatPatchSchema.nullable().optional(),
}).strict() satisfies z.ZodType<CalendarEventUpdateRequest>;

const idParam = z.string().regex(/^[\w-]{1,100}$/);
const dayParam = z.string().refine(isDayKey, { message: "日期格式不正確" });

const googleUpdateSchema = z.object({
  id: z.string().min(1).max(600),
  title: z.string().trim().min(1, { message: "請輸入行程名稱。" }).max(MANUAL_EVENT_LIMITS.title, { message: `行程名稱最多 ${MANUAL_EVENT_LIMITS.title} 個字。` }).optional(),
  start: z.string().min(1).max(40).optional(),
  end: z.string().min(1).max(40).nullable().optional(),
  allDay: z.boolean().optional(),
  location: text("地點", MANUAL_EVENT_LIMITS.location).nullable().optional(),
  notes: text("備註", MANUAL_EVENT_LIMITS.notes).nullable().optional(),
}).strict() satisfies z.ZodType<GoogleCalendarEventUpdateRequest>;

const googleSnapshotSchema: z.ZodType<CalendarEvent> = z.object({
  id: z.string().min(1).max(600),
  origin: z.literal("google"),
  calendarId: z.string().max(400).optional(),
  calendarName: z.string().max(400).optional(),
  title: z.string().min(1).max(MANUAL_EVENT_LIMITS.title),
  start: z.string().min(1).max(40),
  end: z.string().min(1).max(40),
  allDay: z.boolean(),
  location: z.string().max(MANUAL_EVENT_LIMITS.location).optional(),
  url: z.string().max(2000).optional(),
  description: z.string().max(MANUAL_EVENT_LIMITS.notes).optional(),
  status: z.enum(CALENDAR_EVENT_STATUSES),
  transparent: z.boolean().optional(),
  editable: z.boolean().optional(),
  updatedAt: z.string().min(1).max(40),
}).strict();

export function calendarRouter(ctx: ModuleContext, sources: { google: SourceSync; ics: SourceSync }): Router {
  const router = Router();
  const service = calendarService(ctx);

  router.get("/", async (req, res) => {
    const query = z.object({
      view: z.enum(CALENDAR_PAGE_VIEWS).default("day"),
      day: z.string().refine(isDayKey, { message: "日期格式不正確" }).optional(),
    }).loose().parse(req.query);
    const timeZone = ctx.config.timeZone;
    const now = ctx.now();
    const today = todayKey(timeZone, now);
    const day = query.day ?? today;
    if (Math.abs(daysBetween(today, day)) > CALENDAR_LIMITS.futureDays) throw new AppError(400, "日期超出可查詢的範圍。");
    const weekStartsMonday = ctx.settings.value("weekStartsMonday");
    const bounds = query.view === "month"
      ? monthBounds(day, weekStartsMonday)
      : query.view === "week"
        ? { first: weekStart(day, weekStartsMonday), last: addDays(weekStart(day, weekStartsMonday), 6) }
        : { first: day, last: day };
    const { first, last } = bounds;
    const items = collectItems(ctx, dayBounds(timeZone, first).start, dayBounds(timeZone, last).end, { deadlines: true });
    const days = Array.from({ length: daysBetween(first, last) + 1 }, (_, index) => {
      const key = addDays(first, index);
      const onDay = itemsOnDay(items, key, timeZone);
      return { day: key, items: onDay, free: key < today ? [] : freeSlots(onDay, key, timeZone, now) };
    });
    const connected = await googleConnected(ctx).catch(() => false);
    const capabilities = connected ? await googleCapabilities(ctx).catch(() => ({ calendarRead: false, calendarWrite: false })) : { calendarRead: false, calendarWrite: false };
    const body: CalendarResponse = {
      view: query.view,
      from: first,
      to: last,
      day,
      today,
      now: now.toISOString(),
      timeZone,
      weekStartsMonday,
      days,
      sources: await Promise.all([sourceState(sources.google, now), sourceState(sources.ics, now)]),
      // calendar.events alone still syncs the primary calendar.
      google: { connected: connected && (capabilities.calendarRead || capabilities.calendarWrite), canWrite: connected && capabilities.calendarWrite },
      calendarFeeds: enabledFeeds(ctx, "calendar").length,
    };
    res.json(body);
  });

  router.post("/events", async (req, res) => {
    const input = createSchema.parse(req.body);
    const timeZone = ctx.config.timeZone;
    const allDay = input.allDay ?? (isDayKey(input.start) && (!input.end || isDayKey(input.end)));
    const times = resolveTimes(timeZone, { start: input.start, end: input.end, allDay });
    const start = times.start;
    // A timed event with no end lasts an hour; an all-day event always has its end.
    const end = times.end ?? new Date(Date.parse(start) + 3_600_000).toISOString();
    const now = ctx.now();
    if (Math.abs(Date.parse(start) - now.getTime()) > CALENDAR_LIMITS.futureDays * 86_400_000) throw new AppError(400, "日期超出可新增的範圍。");
    const event = service.create({
      title: input.title, start, end, allDay,
      ...(input.location ? { location: input.location } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.repeat ? { repeat: input.repeat } : {}),
      origin: "capture",
    });
    // A weekly event stays in BELL: no Google insert, nothing pending.
    const google = !input.repeat && (input.addToGoogle ?? ctx.settings.value("calendar.addToGoogle")) && (await service.canWriteGoogle());
    if (google) service.deferPush(event.id);
    const body: CalendarEventCreateResponse = {
      event,
      google: google ? "pending" : "none",
      undoPath: `/api/calendar/events/${event.id}`,
      message: createdMessage(event, timeZone, now),
    };
    res.status(201).json(body);
  });

  // An edit while 自動整理 runs wins: the tidy stops and writes nothing (as for a todo).
  // Synced events also push their update two-way to Google Calendar.
  router.patch("/events/:id", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const event = await service.updateWithGoogle(id, updateSchema.parse(req.body), AbortSignal.timeout(15_000));
    cancelTidy(ctx, "event", id);
    res.json(event);
  });

  router.delete("/events/:id", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const event = service.events.get(id, { strict: true });
    if (!event) throw new AppError(404, "找不到這個行程，可能已經刪除。");
    let google = service.cancelPending(id);
    if (!google && event.googleEventId) {
      await service.removeFromGoogle(id, AbortSignal.timeout(15_000));
      google = true;
    }
    const result = service.events.delete(id);
    const body: CalendarEventDeleteResponse = { deleted: true, ...(result.undoToken ? { undoToken: result.undoToken } : {}), google };
    res.json(body);
  });

  router.post("/events/:id/google", async (req, res) => {
    const id = idParam.parse(req.params.id);
    const event = service.get(id);
    if (!event) throw new AppError(404, "找不到這個行程，可能已經刪除。");
    if (event.repeat) throw new AppError(409, "每週行程只存在 BELL，不會加入 Google 行事曆。");
    if (event.googleEventId || service.isPending(id)) throw new AppError(409, "這個行程已經在 Google 行事曆了。");
    if (!(await service.canWriteGoogle())) throw new AppError(503, "請先在「連線與設定」連接 Google 行事曆，並允許新增行程。");
    service.deferPush(id);
    const body: CalendarGoogleInsertResponse = { pending: true, undoPath: `/api/calendar/events/${id}/google` };
    res.status(202).json(body);
  });

  router.post("/events/:id/skip", (req, res) => {
    const id = idParam.parse(req.params.id);
    const { day } = z.object({ day: dayParam }).strict().parse(req.body);
    service.skipOccurrence(id, day);
    const body: CalendarEventSkipResponse = { skipped: day, undoPath: `/api/calendar/events/${id}/skip/${day}` };
    res.json(body);
  });

  router.delete("/events/:id/skip/:day", (req, res) => {
    const id = idParam.parse(req.params.id);
    const day = dayParam.parse(req.params.day);
    service.restoreOccurrence(id, day);
    res.json({ restored: day });
  });

  router.delete("/events/:id/google", async (req, res) => {
    const id = idParam.parse(req.params.id);
    if (!service.get(id)) throw new AppError(404, "找不到這個行程，可能已經刪除。");
    const removed = await service.removeFromGoogle(id, AbortSignal.timeout(15_000));
    res.json({ removed });
  });

  router.patch("/google-events", async (req, res) => {
    const patch = googleUpdateSchema.parse(req.body);
    const event = await service.updateNativeGoogle(patch, AbortSignal.timeout(15_000));
    res.json(event);
  });

  router.delete("/google-events", async (req, res) => {
    const { id } = z.object({ id: z.string().min(1).max(600) }).strict().parse(req.body);
    const snapshot = await service.deleteNativeGoogle(id, AbortSignal.timeout(15_000));
    const body: GoogleCalendarEventDeleteResponse = { deleted: true, ...(snapshot ? { snapshot } : {}) };
    res.json(body);
  });

  router.post("/google-events/restore", async (req, res) => {
    const { snapshot } = z.object({ snapshot: googleSnapshotSchema }).strict().parse(req.body);
    const event = await service.restoreNativeGoogle(snapshot, AbortSignal.timeout(15_000));
    res.json({ event });
  });

  return router;
}

/** Full-week grid bounds covering the calendar month of `day` (28, 35, or 42 days). */
export function monthBounds(day: DayKey, mondayFirst: boolean): { first: DayKey; last: DayKey } {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const monthFirst = `${day.slice(0, 7)}-01` as DayKey;
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthLast = `${day.slice(0, 7)}-${String(lastDate).padStart(2, "0")}` as DayKey;
  return {
    first: weekStart(monthFirst, mondayFirst),
    last: addDays(weekStart(monthLast, mondayFirst), 6),
  };
}

/** The first day of the week containing `day` (Monday or Sunday). */
export function weekStart(day: DayKey, mondayFirst: boolean): DayKey {
  const weekday = weekdayOf(day);
  return addDays(day, -(mondayFirst ? (weekday + 6) % 7 : weekday));
}

async function sourceState(source: SourceSync, now: Date): Promise<CalendarSourceState> {
  const status: SourceStatus = await source.status();
  const state = todaySource(status, source.intervalMs, now);
  return { ...state, id: status.id as CalendarSourceState["id"] };
}

/** 「已加入行程「讀書會」· 明天 14:00」, or 「已加入每週行程「計算機網路」· 每週一 14:00」 (SPEC §6.6 capture toast). */
function createdMessage(event: ManualEvent, timeZone: string, now: Date): string {
  if (event.repeat) return `已加入每週行程「${event.title}」· ${weeklyLabel(todayKey(timeZone, new Date(event.start)))}${event.allDay ? "" : ` ${localTime(timeZone, event.start)}`}`;
  const days = daysBetween(todayKey(timeZone, now), todayKey(timeZone, new Date(event.start)));
  const date = days === 0 ? "今天" : days === 1 ? "明天" : monthDayWeek(timeZone, event.start);
  const when = event.allDay ? date : `${date} ${localTime(timeZone, event.start)}`;
  return `已加入行程「${event.title}」· ${when}`;
}
