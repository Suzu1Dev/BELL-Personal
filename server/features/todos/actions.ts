import { z } from "zod";
import type { MailMessage } from "../../../shared/mail.js";
import type { SourceId, SourceRef } from "../../../shared/sources.js";
import type { TodoSuggestion } from "../../../shared/suggestions.js";
import { dayKey, isDayKey, isLocalTime, localTime } from "../../../shared/time.js";
import { TODO_LIMITS, type Todo, type TodoOrigin } from "../../../shared/todos.js";
import type { QueueSource } from "../../../shared/today.js";
import { AppError } from "../../errors.js";
import type { ActionHandler, ActionPlan, ModuleContext, SuggestionAcceptor } from "../../modules.js";
import type { NewTodo, TodoStore } from "./store.js";

/** Where a queue row's source item lives, for the todo's sourceRef (轉待辦 keeps a link back). */
const SOURCE_OF: Partial<Record<QueueSource, SourceId>> = {
  gmail: "gmail", moodle: "moodle", canvas: "canvas", github: "github", ctftime: "ctftime", feed: "feeds",
};
const ORIGIN_OF: Partial<Record<QueueSource, TodoOrigin>> = { gmail: "mail", moodle: "assignment", canvas: "assignment", github: "github" };

/** Labels of the generic actions the core applies to native rows (this handler only adds the log label). */
const CORE_LABELS: Record<string, string> = { snooze: "已延後", dismiss: "已略過", open: "已開啟" };

const dayKeySchema = z.string().refine(isDayKey, { message: "日期格式不正確" });
const timeSchema = z.string().refine(isLocalTime, { message: "時間格式不正確" });

/** Optional overrides a client may send with 轉待辦 / 加入待辦 (`label` only feeds the toast). */
const overridesSchema = z.object({
  title: z.string().trim().min(1).max(TODO_LIMITS.title).optional(),
  dueDay: dayKeySchema.optional(),
  dueTime: timeSchema.optional(),
  notes: z.string().max(TODO_LIMITS.notes).optional(),
  label: z.string().max(100).optional(),
}).loose();

const todoSuggestionSchema: z.ZodType<TodoSuggestion> = z.object({
  title: z.string().trim().min(1).max(TODO_LIMITS.title),
  dueDay: dayKeySchema.optional(),
  dueTime: timeSchema.optional(),
  notes: z.string().max(TODO_LIMITS.notes).optional(),
});

/** actions.native: 完成 on a `native:<todo id>` row (SPEC §6.4: done_at = now, local; undo clears it). */
export function nativeActionHandler(store: TodoStore): ActionHandler {
  return (request) => {
    if (request.action in CORE_LABELS) return { label: CORE_LABELS[request.action] };
    if (request.action !== "done") throw new AppError(400, "這項待辦不能這樣處理。");
    return {
      label: "已完成",
      apply: () => {
        const todo = store.require(request.sourceId);
        if (todo.status === "done") throw new AppError(409, "這項待辦已經完成了。");
        store.complete(todo.id);
        return { resultId: todo.id };
      },
      undo: () => {
        if (store.get(request.sourceId)) store.reopen(request.sourceId);
      },
    };
  };
}

/** A due day and time from an ISO deadline; 23:59 (and a deadline at midnight) means the day alone. */
export function dueFromInstant(instant: string, timeZone: string): Pick<Todo, "dueDay" | "dueTime"> {
  const time = localTime(timeZone, instant);
  if (time === "00:00") return { dueDay: dayKey(timeZone, new Date(Date.parse(instant) - 60_000)) };
  return time === "23:59" ? { dueDay: dayKey(timeZone, instant) } : { dueDay: dayKey(timeZone, instant), dueTime: time };
}

/**
 * Creates the todo once and remembers whether this action made it, so undo
 * removes only a todo it created (轉待辦 on a row already turned into one reuses it).
 */
function createOnce(store: TodoStore, input: NewTodo): Pick<ActionPlan, "apply" | "undo"> {
  let created: string | undefined;
  return {
    apply: () => {
      const existing = input.sourceRef ? store.findBySource(input.sourceRef) : undefined;
      if (existing) return { resultId: existing.id };
      created = store.create(input).id;
      return { resultId: created };
    },
    undo: () => {
      if (created) store.discard(created);
    },
  };
}

/**
 * A mail that is not a Today row (#/inbox lists every conversation): its
 * subject, Gmail link and AI summary come from the cached message.
 */
function cachedMail(ctx: ModuleContext, sourceId: string): { title: string; url?: string; summary?: string } | undefined {
  const mail = ctx.sourceItems.get<MailMessage>("gmail", sourceId)?.value;
  if (!mail) return undefined;
  return { title: mail.subject, ...(mail.webUrl ? { url: mail.webUrl } : {}), ...(mail.triage?.summary ? { summary: mail.triage.summary } : {}) };
}

/** anySourceActions.todo: 轉待辦 / 轉成待辦 on a mail, assignment, review or event row. */
export function convertToTodoHandler(store: TodoStore): ActionHandler {
  return (request, ctx) => {
    if (request.source === "native") throw new AppError(400, "這已經是待辦了。");
    const overrides = overridesSchema.parse(request.params);
    const item = request.item;
    const cached = !item && request.source === "gmail" ? cachedMail(ctx, request.sourceId) : undefined;
    const title = overrides.title ?? item?.title ?? cached?.title;
    if (!title) throw new AppError(400, "找不到這個項目的標題，請重新整理後再試。");
    const due = overrides.dueDay
      ? { dueDay: overrides.dueDay, ...(overrides.dueTime ? { dueTime: overrides.dueTime } : {}) }
      : item?.hints.dueAt ? dueFromInstant(item.hints.dueAt, ctx.config.timeZone) : {};
    const source = SOURCE_OF[request.source];
    const url = item?.url ?? cached?.url;
    const sourceRef: SourceRef | undefined = source ? { source, externalId: request.sourceId, ...(url ? { url } : {}) } : undefined;
    const notes = overrides.notes ?? item?.summary ?? cached?.summary;
    return {
      label: "已轉成待辦",
      ...(cached ? { target: { kind: "mail.action" as const, title: cached.title } } : {}),
      ...createOnce(store, {
        title: title.slice(0, TODO_LIMITS.title),
        origin: ORIGIN_OF[request.source] ?? "manual",
        ...due,
        ...(notes ? { notes: notes.slice(0, TODO_LIMITS.notes) } : {}),
        ...(sourceRef ? { sourceRef } : {}),
      }),
    };
  };
}

/** The todo an AI `todo` suggestion describes, with the user's overrides. */
function fromSuggestion(payload: unknown, overrides: z.infer<typeof overridesSchema>, sourceRef: SourceRef | undefined): NewTodo {
  const parsed = todoSuggestionSchema.safeParse(payload);
  if (!parsed.success) throw new AppError(422, "這則建議的內容不完整，無法加入待辦。");
  const todo = parsed.data;
  const dueDay = overrides.dueDay ?? todo.dueDay;
  const dueTime = overrides.dueDay ? overrides.dueTime : todo.dueTime;
  return {
    title: overrides.title ?? todo.title,
    origin: "suggestion",
    ...(dueDay ? { dueDay } : {}),
    ...(dueDay && dueTime ? { dueTime } : {}),
    ...(overrides.notes ?? todo.notes ? { notes: overrides.notes ?? todo.notes } : {}),
    ...(sourceRef ? { sourceRef } : {}),
  };
}

/** suggestionActions.todo: 加入待辦 on an `ai:` suggestion.todo row; undo removes the todo. */
export function suggestionTodoHandler(store: TodoStore): ActionHandler {
  return (request) => {
    if (request.action !== "todo") throw new AppError(400, "這則建議不能這樣處理。");
    const input = fromSuggestion(request.suggestion?.payload, overridesSchema.parse(request.params), request.suggestion?.sourceRef);
    return { label: "已加入待辦", ...createOnce(store, input) };
  };
}

/** acceptSuggestion.todo: POST /api/suggestions/:id/accept with optional { title, dueDay, dueTime }. */
export function acceptTodoSuggestion(store: TodoStore): SuggestionAcceptor {
  return (suggestion, _ctx: ModuleContext, body) => {
    const todo = store.create(fromSuggestion(suggestion.payload, overridesSchema.parse(body ?? {}), suggestion.sourceRef));
    return { resultId: todo.id, result: todo };
  };
}
