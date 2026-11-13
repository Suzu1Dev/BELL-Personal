import { z } from "zod";
import { parseCapture, retypeCapture } from "../../../shared/capture-parse.js";
import { weeklyLabel } from "../../../shared/calendar.js";
import { CAPTURE_LIMITS, CAPTURE_TYPES, type CaptureRequest, type CaptureResponse } from "../../../shared/connect.js";
import { IDEA_LIMITS } from "../../../shared/ideas.js";
import { CAPTURE_ORIGIN, type EventSuggestion } from "../../../shared/suggestions.js";
import { dayKey, isDayKey, localTime } from "../../../shared/time.js";
import { TODO_ESTIMATE_MAX_MINUTES, TODO_LIMITS } from "../../../shared/todos.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext, SuggestionAcceptor } from "../../modules.js";
import { eventRepeatInputSchema } from "../calendar/store.js";
import { proposeTagsQuietly } from "../ideas/router.js";
import { ideaStore, tagSchema } from "../ideas/store.js";
import { dueFromInstant } from "../todos/actions.js";
import { todoStore } from "../todos/store.js";
import { startTidy, worthTidying } from "./tidy.js";
import { whenPhrase } from "./when.js";

const instantSchema = z.string().max(40).refine((value) => isDayKey(value) || !Number.isNaN(Date.parse(value)), { message: "時間格式不正確" });

/** POST /api/capture body (CaptureRequest, plus the AI suggestion being confirmed). */
export const captureRequestSchema = z.object({
  text: z.string().trim().min(1, { message: "請先寫下內容" }).max(CAPTURE_LIMITS.text),
  type: z.enum(CAPTURE_TYPES).optional(),
  title: z.string().trim().min(1).max(CAPTURE_LIMITS.title).optional(),
  start: instantSchema.optional(),
  end: instantSchema.optional(),
  due: instantSchema.optional(),
  allDay: z.boolean().optional(),
  location: z.string().trim().max(200).optional(),
  tags: z.array(tagSchema).max(CAPTURE_LIMITS.tags).optional(),
  estimateMinutes: z.number().int().positive().max(TODO_ESTIMATE_MAX_MINUTES).optional(),
  repeat: eventRepeatInputSchema.optional(),
  suggestionId: z.string().min(1).max(100).optional(),
}).strict();

export type CaptureInput = z.infer<typeof captureRequestSchema>;

/** The calendar-events team's acceptSuggestion.event (looked up per request through the module host). */
export type EventAcceptor = SuggestionAcceptor | undefined;

/** Where a created event is removed again: the acceptor's `result.undoPath`, else the calendar module's documented DELETE. */
function eventUndoPath(result: unknown, id: string): string {
  const path = result && typeof result === "object" ? (result as { undoPath?: unknown }).undoPath : undefined;
  return typeof path === "string" && path.startsWith("/api/") ? path : `/api/calendar/events/${encodeURIComponent(id)}`;
}

export { whenPhrase } from "./when.js";

/**
 * Creates the todo, event or idea a capture describes (SPEC-ux §6.6 step 3).
 * Without `type` the rule parser decides; explicit fields (from the parse row
 * or the confirmed AI option) override the parse. Events go through the
 * calendar module's `event` acceptor, which adds them to Google Calendar when
 * that is connected and 「新行程加到 Google 行事曆」 is on, else keeps them local.
 */
export async function createCapture(ctx: ModuleContext, input: CaptureInput, eventAcceptor: EventAcceptor): Promise<CaptureResponse> {
  const now = ctx.now();
  const timeZone = ctx.config.timeZone;
  if (input.suggestionId) {
    const suggestion = ctx.suggestions.get(input.suggestionId);
    if (!suggestion || suggestion.kind !== "quick-capture") throw new AppError(404, "找不到這則 AI 建議。");
    if (suggestion.status !== "pending") throw new AppError(409, "這則 AI 建議已經處理過了。");
  }
  const parsed = parseCapture(input.text, { now, timeZone });
  const type = input.type ?? parsed.type;
  const base = retypeCapture(parsed, type, { now, timeZone, text: input.text });
  const title = (input.title ?? base.title ?? input.text).trim();

  let response: CaptureResponse;
  if (type === "todo") {
    const due = input.due ?? base.due;
    const allDay = input.allDay ?? base.allDay;
    const dueFields = due ? (allDay ? { dueDay: isDayKey(due) ? due : dayKey(timeZone, due) } : dueFromInstant(due, timeZone)) : {};
    const estimate = input.estimateMinutes ?? base.durationMinutes;
    // Todos have no tags: keep the #tags the user typed in the notes rather than dropping them.
    const tags = input.tags ?? base.tags;
    const todo = todoStore(ctx).create({
      title: title.slice(0, TODO_LIMITS.title),
      origin: "quick-capture",
      ...(originalText(input.text, title) ? { originalText: input.text } : {}),
      ...(tags.length ? { notes: tags.map((tag) => `#${tag}`).join(" ") } : {}),
      ...dueFields,
      ...(estimate && estimate <= TODO_ESTIMATE_MAX_MINUTES ? { estimateMinutes: estimate } : {}),
    });
    const when = due ? whenPhrase(due, allDay, now, timeZone) : undefined;
    response = { type, id: todo.id, message: `已加入待辦「${todo.title}」${when ? `· ${when}` : ""}`, undoPath: `/api/todos/${todo.id}` };
  } else if (type === "idea") {
    const store = ideaStore(ctx);
    const idea = store.create({ text: title.slice(0, IDEA_LIMITS.text), tags: input.tags ?? base.tags, origin: "quick-capture" });
    proposeTagsQuietly(ctx, store, idea.id);
    response = { type, id: idea.id, message: "已記下靈感", undoPath: `/api/ideas/${idea.id}` };
  } else {
    const start = input.start ?? base.start;
    if (!start) throw new AppError(400, "行程需要日期或時間。");
    const allDay = input.allDay ?? base.allDay;
    const end = input.end ?? base.end;
    if (!eventAcceptor) throw new AppError(501, "行事曆還不能新增行程，先記成待辦吧。");
    const location = input.location ?? base.location;
    // A request that names its own start (the parse row's chips) also names its own repeat: turned off there, it stays off.
    const repeat = input.start !== undefined ? input.repeat : input.repeat ?? base.repeat;
    const payload: EventSuggestion = { title: title.slice(0, 200), start, ...(end ? { end } : {}), allDay, ...(location ? { location } : {}) };
    // The calendar module's one-tap confirmation path, with the user's Enter as the confirmation.
    // Its origin keeps it off Today and #/events even if the process dies before it is decided.
    const record = ctx.suggestions.create<EventSuggestion>({ kind: "event", title: `加入行事曆：${payload.title}`, payload, origin: CAPTURE_ORIGIN });
    let outcome: Awaited<ReturnType<SuggestionAcceptor>>;
    try {
      outcome = await eventAcceptor(record, ctx, { via: "capture", ...(originalText(input.text, title) ? { originalText: input.text } : {}), ...(repeat ? { repeat } : {}) });
    } catch (error) {
      ctx.suggestions.decide(record.id, "dismissed");
      throw error;
    }
    ctx.suggestions.decide(record.id, "accepted", outcome.resultId);
    const id = outcome.resultId ?? record.id;
    response = {
      type, id,
      message: repeat
        ? `已加入每週行程「${payload.title}」· ${weeklyLabel(isDayKey(start) ? start : dayKey(timeZone, start))}${allDay ? "" : ` ${localTime(timeZone, start)}`}`
        : `已加入行事曆「${payload.title}」· ${whenPhrase(start, allDay, now, timeZone)}`,
      undoPath: eventUndoPath(outcome.result, id),
    };
  }
  if (input.suggestionId) ctx.suggestions.decide(input.suggestionId, "accepted", response.id);
  const tidy = type !== "idea" && !input.suggestionId ? autoTidy(ctx, type, response.id, title) : undefined;
  logEvent("capture.created", { type, ai: !!input.suggestionId, explicitType: !!input.type, tidy: !!tidy });
  return tidy ? { ...response, tidy } : response;
}

/** The sentence is kept on the record when the title is not all of it (自動整理 and 整理 read it). */
function originalText(text: string, title: string): boolean {
  return text.trim() !== title.trim();
}

/**
 * 自動整理 after a capture: on unless 使用 AI or 自動整理快速記下的內容 is off,
 * and only for a title worth a model call. Never fails the capture: a busy or
 * missing tidy just leaves the rule result. A CLI the last status probe found
 * signed out cannot tidy, so nothing starts and no 整理中… shows (the probe is
 * read, never awaited: the save stays instant).
 */
function autoTidy(ctx: ModuleContext, type: "todo" | "event", id: string, title: string): CaptureResponse["tidy"] {
  if (!ctx.settings.value("ai.enabled") || !ctx.settings.value("ai.captureTidy") || !worthTidying(title)) return undefined;
  const provider = ctx.provider.settings().provider;
  if (ctx.status.peek()?.clis[provider].authenticated === false) return undefined;
  try {
    return startTidy(ctx, type, id, { auto: true });
  } catch {
    return undefined;
  }
}
