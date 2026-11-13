import { z } from "zod";
import type { ManualEvent } from "../../../shared/calendar.js";
import type { SourceRef } from "../../../shared/sources.js";
import type { AiSuggestion } from "../../../shared/suggestions.js";
import { addDays, dayKey, isDayKey, zonedTimeToUtc } from "../../../shared/time.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ActionHandler, ActionPlan, ModuleContext, SuggestionAcceptor } from "../../modules.js";
import { calendarService, eventRepeatInputSchema, type NewManualEvent } from "./store.js";

/**
 * Queue actions the calendar module owns (ARCHITECTURE §10.3):
 *  - suggestionActions.event: 加入行事曆 on an `ai:` suggestion.event row;
 *  - anySourceActions.schedule: 排進 a free slot for any row ({ start, end });
 *  - acceptSuggestion.event: the same confirmation through POST /api/suggestions/:id/accept.
 * Each creates a local event at once (apply) and, when Google is connected
 * with calendar.events and the setting allows it, inserts the Google copy as
 * the deferred remote write (6.5 s); undo deletes the local event, revert
 * the Google copy.
 */

const iso = z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "時間格式不正確" });

const eventPayloadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  start: iso,
  end: iso.optional(),
  allDay: z.boolean().optional(),
  location: z.string().max(200).optional(),
}).loose();

/** A one-tap plan that creates a local event and, optionally, its Google copy. */
export function eventPlan(ctx: ModuleContext, label: string, input: NewManualEvent, google: boolean): ActionPlan {
  const service = calendarService(ctx);
  let created: ManualEvent | undefined;
  return {
    label,
    apply: () => {
      created = service.create(input);
      return { resultId: created.id };
    },
    ...(google ? {
      remote: async (signal: AbortSignal) => { if (created) await service.pushToGoogle(created.id, signal); },
      revert: async (signal: AbortSignal) => { if (created) await service.removeFromGoogle(created.id, signal); },
    } : {}),
    undo: () => { if (created) service.discard(created.id); },
  };
}

/** Whether a new event should also go to Google: the setting is on and the grant allows writing. */
export async function wantsGoogle(ctx: ModuleContext, setting: "calendar.addToGoogle" | "events.addToGoogle"): Promise<boolean> {
  return ctx.settings.value(setting) && (await calendarService(ctx).canWriteGoogle());
}

/**
 * The local event for an event suggestion. All-day events (a DayKey start or
 * allDay) run from local midnight to the local midnight after their last day
 * in BELLPERSONAL_TZ, never UTC midnight.
 */
function suggestionEvent(suggestion: AiSuggestion, itemId: string, timeZone: string): NewManualEvent {
  const parsed = eventPayloadSchema.safeParse(suggestion.payload);
  if (!parsed.success) throw new AppError(400, "這則建議的活動資料不完整，無法加入行事曆。");
  const payload = parsed.data;
  const ref: SourceRef | undefined = suggestion.sourceRef;
  const allDay = !!payload.allDay || isDayKey(payload.start);
  let start = new Date(payload.start).toISOString();
  let end = payload.end ? new Date(payload.end).toISOString() : undefined;
  if (allDay) {
    const firstDay = isDayKey(payload.start) ? payload.start : dayKey(timeZone, payload.start);
    const lastDay = payload.end ? (isDayKey(payload.end) ? payload.end : dayKey(timeZone, Date.parse(payload.end) - 1)) : firstDay;
    start = zonedTimeToUtc(timeZone, firstDay).toISOString();
    end = zonedTimeToUtc(timeZone, addDays(lastDay >= firstDay ? lastDay : firstDay, 1)).toISOString();
  }
  return {
    title: payload.title,
    start,
    ...(end ? { end } : {}),
    allDay,
    ...(payload.location ? { location: payload.location } : {}),
    ...(ref ? { sourceRef: ref } : {}),
    ...(suggestion.origin ? { notes: `來自 ${suggestion.origin}` } : {}),
    origin: "suggestion",
    itemId,
  };
}

/** 加入行事曆 on `ai:<id>` rows whose suggestion is an event. */
export const suggestionEventAction: ActionHandler = async (request, ctx) => {
  if (request.action !== "calendar" || !request.suggestion) throw new AppError(400, "這則建議不能這樣處理。");
  const input = suggestionEvent(request.suggestion, request.itemId, ctx.config.timeZone);
  return eventPlan(ctx, "已加入行事曆", input, await wantsGoogle(ctx, "calendar.addToGoogle"));
};

const scheduleParams = z.object({
  start: iso,
  end: iso,
  title: z.string().trim().min(1).max(200).optional(),
}).loose();

/** The longest block 排進 creates. */
const SCHEDULE_MAX_MS = 12 * 3_600_000;

/** 排進: a time block titled with the row's title over the free slot (or the item's estimate). */
export const scheduleAction: ActionHandler = async (request, ctx) => {
  if (request.action !== "schedule") throw new AppError(400, "這個項目不能這樣處理。");
  const params = scheduleParams.safeParse(request.params);
  if (!params.success) throw new AppError(400, "排進需要開始與結束時間。");
  const start = Date.parse(params.data.start);
  const end = Date.parse(params.data.end);
  const now = request.now.getTime();
  if (end <= start) throw new AppError(400, "結束時間必須在開始之後。");
  if (end - start > SCHEDULE_MAX_MS) throw new AppError(400, "一次最多排進 12 小時。");
  if (end <= now) throw new AppError(400, "這個空檔已經過了。");
  if (start > now + 14 * 86_400_000) throw new AppError(400, "只能排進兩週內的空檔。");
  const title = request.item?.title ?? params.data.title;
  if (!title) throw new AppError(400, "找不到要排進的項目，請重新整理後再試。");
  const input: NewManualEvent = {
    title,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    allDay: false,
    ...(request.item?.url ? { url: request.item.url } : {}),
    origin: "schedule",
    itemId: request.itemId,
  };
  return eventPlan(ctx, "已排進行事曆", input, await wantsGoogle(ctx, "calendar.addToGoogle"));
};

/**
 * POST /api/suggestions/:id/accept for an event suggestion: the local event
 * now, the Google copy right away when allowed (this path has no undo
 * window). A failed Google insert keeps the local event and says so.
 * Quick capture (`{ via: "capture" }`) gets POST /api/calendar/events
 * behaviour instead: the Google insert waits the 6.5 s undo window
 * (deferPush), nothing blocks on Google, and `undoPath` cancels it. A
 * capture with `repeat` (「每週一 10:10 …」) is a weekly series: it stays in BELL,
 * so no insert is scheduled for it.
 */
export const acceptEventSuggestion: SuggestionAcceptor = async (suggestion, ctx, body) => {
  const service = calendarService(ctx);
  const request = body as { via?: unknown; originalText?: unknown; repeat?: unknown } | null | undefined;
  const capture = request?.via === "capture";
  // Quick capture also hands over the sentence the title was read from (自動整理 reads it).
  const originalText = capture && typeof request?.originalText === "string" ? request.originalText : undefined;
  const repeat = capture && request?.repeat !== undefined ? eventRepeatInputSchema.parse(request.repeat) : undefined;
  const fields = suggestionEvent(suggestion, `ai:${suggestion.id}`, ctx.config.timeZone);
  // A weekly class is on Today every week: 「來自 快速記下」 would repeat on each of its rows.
  if (repeat) delete fields.notes;
  const event = service.create({
    ...fields,
    ...(capture ? { origin: "capture" as const, ...(originalText ? { originalText } : {}) } : {}),
    ...(repeat ? { repeat } : {}),
  });
  if (capture) {
    const deferred = !repeat && (await wantsGoogle(ctx, "calendar.addToGoogle"));
    if (deferred) service.deferPush(event.id);
    return {
      resultId: event.id,
      result: { event, google: deferred ? "pending" : "none", undoPath: `/api/calendar/events/${event.id}` },
      undo: () => service.discard(event.id),
    };
  }
  let google: "inserted" | "failed" | "none" = "none";
  if (await wantsGoogle(ctx, "calendar.addToGoogle")) {
    try {
      await service.pushToGoogle(event.id, AbortSignal.timeout(20_000));
      google = "inserted";
    } catch (error) {
      google = "failed";
      logEvent("calendar.google_insert_failed", { errorClass: error instanceof Error ? error.name : typeof error });
    }
  }
  return {
    resultId: event.id,
    result: { event: service.get(event.id) ?? event, google },
    undo: async () => {
      await service.removeFromGoogle(event.id, AbortSignal.timeout(15_000)).catch(() => {});
      service.discard(event.id);
    },
  };
};
