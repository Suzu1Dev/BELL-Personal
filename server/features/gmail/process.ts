import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobEvent } from "../../../shared/jobs.js";
import type { MailMessage, MailProcessResult, MailProcessStart } from "../../../shared/mail.js";
import type { ModelExecution } from "../../../shared/models.js";
import type { EventSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import { dayKey, localTime } from "../../../shared/time.js";
import { weekdayChar } from "../../../shared/today-format.js";
import { jsonSchemaFor } from "../../ai/structured.js";
import { AppError } from "../../errors.js";
import { withGenerationProgress } from "../../generation-progress.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { untrustedBlock } from "../../prompts/boundary.js";
import { secretInPatch } from "../../secrets/redact.js";
import { GMAIL_ERRORS } from "./api.js";
import { isHiddenMessage, threadView } from "./inbox.js";
import { isMine } from "./rules.js";
import type { MailStore } from "./store.js";
import { offsetText, parseDay, suggestionOrigin, toEvent } from "./triage.js";
import { assignmentModelShape, assignmentPromptLine, assignmentSuggestionsFromTriage, triageAssignmentSchema } from "./triage-assignments.js";

/**
 * The reader's 用 AI 處理 (POST /api/gmail/threads/:threadId/process): the owner
 * asks the model to read one cached conversation and decide what in it belongs
 * in the calendar, the todos or the assignments. Like the triage, the model
 * only proposes: every item becomes a pending suggestion on the conversation's
 * row message (the reader lists them under 從這封信找到, Today as `ai:` rows),
 * and nothing is created until the owner taps 加入行事曆 / 加入待辦 / 加入作業.
 *
 * Only cached mail is read (the retention window then removes the
 * suggestions with it, /privacy §03), at most the newest PROCESS_MESSAGES
 * messages of the conversation; a message whose text looks like it carries a
 * secret is never sent. What was already suggested for the conversation
 * (pending, accepted or dismissed) is not suggested again, so a second run
 * never brings back what the owner dismissed. One job per conversation.
 */

/** The newest messages of the conversation the model reads. */
export const PROCESS_MESSAGES = 4;
/** Characters of the newest message's text, and of each earlier one. */
const LATEST_CHARS = 4000;
const EARLIER_CHARS = 1500;
/** Items of each kind the answer may hold, and those turned into suggestions. */
const ANSWER_ITEMS_MAX = 8;
export const PROCESS_ITEMS_MAX = 5;
/** Two AI 處理 at once at most (the agent slot runs one model call at a time anyway). */
const MAX_RUNNING = 2;

const nullableText = (max: number) => z.string().max(max).nullable();
const eventItem = z.object({ title: z.string().max(200), start: z.string().max(40), end: nullableText(40), location: nullableText(200) }).strict();
const todoItem = z.object({ title: z.string().max(200), due: nullableText(40) }).strict();

/** The answer as checked; assignments take the triage's lenient `submit` and `url` (triage-assignments.ts). */
export const processAnswerSchema = z.object({
  events: z.array(eventItem).max(ANSWER_ITEMS_MAX),
  todos: z.array(todoItem).max(ANSWER_ITEMS_MAX),
  assignments: z.array(triageAssignmentSchema.omit({ sourceId: true })).max(ANSWER_ITEMS_MAX),
}).strict();
export type ProcessAnswer = z.infer<typeof processAnswerSchema>;

/** The JSON schema the model is given, with the assignments' limits as the triage tells them. */
const PROCESS_JSON_SCHEMA = jsonSchemaFor(z.object({
  events: z.array(eventItem).max(ANSWER_ITEMS_MAX),
  todos: z.array(todoItem).max(ANSWER_ITEMS_MAX),
  assignments: z.array(assignmentModelShape.assignments.element.omit({ sourceId: true })).max(ANSWER_ITEMS_MAX),
}).strict());

/** The task prompt, with date-times in the owner's zone (BELLPERSONAL_TZ). */
export function processPrompt(offset: string): string {
  return [
    "擁有者在收件匣打開了這個對話，請判斷信中有哪些事要加入擁有者的行事曆、待辦或作業。資料的 messages 由舊到新排列，最後一封最新；mine 為 true 的是擁有者自己寄出的信。",
    "只列出信中明確寫到、而且跟擁有者本人有關的事，推測不出來就不要列；沒有就回傳空陣列，同一件事只列一次。",
    `events：擁有者已報名、受邀或需要出席的活動、會議、考試或面談（title 用活動名稱；start、end 為 YYYY-MM-DDTHH:MM${offset}，整天的活動用 YYYY-MM-DD，沒有結束時間填 null；location 沒有就填 null）。不要列出廣告或電子報裡的活動，也不要列已經結束的活動。`,
    `todos：信中要求擁有者在某個期限前完成的事（title 用動詞開頭，例如「繳交停修申請」；due 為 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM${offset}，沒有期限填 null）。只需要回信的事不用列，已經列在 events 的活動也不要再列成待辦。`,
    assignmentPromptLine(offset),
    `日期以資料中的 today、weekday 與時區 timeZone（目前 UTC${offset}）推算，時間一律寫成該時區的當地時間；信中只寫月日時，取收信之後最近的那一天。`,
  ].join("\n");
}

/** The conversation as the model may read it: its row message and the newest messages without secret shapes. */
interface ProcessSubject {
  anchor: MailMessage;
  /** Every visible message id of the conversation (suggestions on any of them belong to it). */
  ids: Set<string>;
  /** What the model reads, oldest first. */
  read: MailMessage[];
}

/** 404 when nothing of the conversation is cached; 422 when every message looks like it carries a secret. */
function processSubject(store: MailStore, threadId: string): ProcessSubject {
  const messages = store.thread(threadId).filter((message) => !isHiddenMessage(message));
  const view = threadView(threadId, messages);
  if (!view) throw new AppError(404, GMAIL_ERRORS.notCached);
  const read = view.messages
    .filter((message) => !secretInPatch(`${message.subject}\n${message.snippet}\n${message.excerpt ?? ""}`))
    .slice(-PROCESS_MESSAGES);
  if (!read.length) throw new AppError(422, "這封信看起來含有密碼或驗證碼，不會交給 AI 處理。");
  return { anchor: view.latest, ids: new Set(view.messages.map((message) => message.id)), read };
}

/**
 * Starts the `mail-process` job for a cached conversation, or returns the one
 * already running for it. 503 with AI off, 404 outside the cache, 422 for a
 * conversation that looks like it carries secrets, 429 when two are running.
 */
export function startMailProcess(ctx: ModuleContext, store: MailStore, threadId: string): MailProcessStart {
  if (!ctx.settings.value("ai.enabled")) throw new AppError(503, "AI 已關閉，無法處理這封信。請到「連線與設定」開啟 AI。");
  const running = ctx.jobs.running("mail-process").find((job) => job.ref === threadId);
  if (running) return { jobId: running.id, threadId };
  processSubject(store, threadId);
  const job = ctx.jobs.start(
    { kind: "mail-process", title: "AI 處理信件", ref: threadId },
    (emit, signal) => runProcess(ctx, store, threadId, emit, signal),
    { maxRunning: MAX_RUNNING, busyMessage: "AI 正在處理其他信件，請等它完成後再試。" },
  );
  return { jobId: job.id, threadId };
}

async function runProcess(ctx: ModuleContext, store: MailStore, threadId: string, emit: (event: JobEvent) => void, signal: AbortSignal): Promise<MailProcessResult> {
  const started = Date.now();
  const timeZone = ctx.config.timeZone;
  const subject = processSubject(store, threadId);
  const today = ctx.today();
  const data = {
    today,
    weekday: `週${weekdayChar(today)}`,
    timeZone,
    messages: subject.read.map((message, index) => ({
      from: message.from,
      mine: isMine(message),
      subject: message.subject,
      receivedAt: `${dayKey(timeZone, message.receivedAt)} ${localTime(timeZone, message.receivedAt)}`,
      body: untrustedBlock("email", message.excerpt ?? message.snippet, index === subject.read.length - 1 ? LATEST_CHARS : EARLIER_CHARS),
    })),
  };
  try {
    const run = await withGenerationProgress("用 AI 處理這封信", "process", emit, signal, (onProgress) => ctx.ai.runStructured({
      role: "信件處理",
      schema: processAnswerSchema,
      jsonSchema: PROCESS_JSON_SCHEMA,
      prompt: processPrompt(offsetText(timeZone, ctx.now())),
      data,
      signal,
      timeoutKind: "quick",
      // Someone is watching the reader: ahead of the background triage (AgentSlots).
      priority: "interactive",
      onProgress,
    }));
    signal.throwIfAborted();
    // The model ran for seconds: mail purged, pruned or disconnected meanwhile gets no suggestion.
    const anchor = store.get(subject.anchor.id);
    if (!anchor) throw new AppError(404, GMAIL_ERRORS.notCached);
    const before = pendingIds(ctx, subject.ids);
    const found = applyProcessAnswer(ctx, anchor, subject.ids, run.value, run.execution);
    const after = pendingIds(ctx, subject.ids);
    const added = [...after].filter((id) => !before.has(id)).length;
    logEvent("gmail.processed", { messages: subject.read.length, found, added, pending: after.size, ms: Date.now() - started });
    return { threadId, found, added, pending: after.size };
  } catch (error) {
    logEvent("gmail.process_failed", { cancelled: signal.aborted, errorClass: error instanceof Error ? error.name : typeof error, ...(error instanceof AppError ? { status: error.status } : {}), ms: Date.now() - started });
    if (error instanceof AppError && error.status === 504) throw new AppError(504, "AI 處理逾時，請再試一次。");
    throw error;
  }
}

/** Pending suggestions made from the conversation's messages. */
function pendingIds(ctx: ModuleContext, ids: ReadonlySet<string>): Set<string> {
  return new Set(ctx.suggestions.list({ status: "pending", limit: 500 })
    .filter((suggestion) => suggestion.sourceRef?.source === "gmail" && ids.has(suggestion.sourceRef.externalId))
    .map((suggestion) => suggestion.id));
}

/** Compares titles without spacing, punctuation, case or full-width forms. */
const titleKey = (title: string) => title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * The model's items → pending suggestions on the conversation's row message
 * (`anchor`). An item the conversation already has a suggestion for, in any
 * status, is skipped: an event at the same time (or with the same title on
 * the same day), a todo with the same title; the assignment goes through the
 * triage's hook, which keeps one per message and skips what the owner already
 * has. Returns how many usable items the model found.
 */
export function applyProcessAnswer(ctx: ModuleContext, anchor: MailMessage, ids: ReadonlySet<string>, answer: ProcessAnswer, execution?: ModelExecution): number {
  const now = ctx.now();
  const timeZone = ctx.config.timeZone;
  const fromThread = (kind: "event" | "todo") => ctx.suggestions.list({ kind, limit: 2000 })
    .filter((suggestion) => suggestion.sourceRef?.source === "gmail" && ids.has(suggestion.sourceRef.externalId));
  const common = {
    sourceRef: { source: "gmail" as const, externalId: anchor.id, url: anchor.webUrl },
    origin: suggestionOrigin(anchor),
    ...(execution ? { modelExecution: execution } : {}),
  };
  let found = 0;

  const events = fromThread("event").map((suggestion) => suggestion.payload as EventSuggestion).filter((event) => !!event?.start);
  const sameEvent = (a: EventSuggestion, b: EventSuggestion) => a.start === b.start
    || (titleKey(a.title) === titleKey(b.title) && dayKey(timeZone, a.start) === dayKey(timeZone, b.start));
  for (const item of answer.events.slice(0, PROCESS_ITEMS_MAX)) {
    const payload = toEvent(item, timeZone, now);
    if (!payload) continue;
    found++;
    if (events.some((event) => sameEvent(event, payload))) continue;
    events.push(payload);
    ctx.suggestions.create<EventSuggestion>({ kind: "event", title: payload.title, payload, dedupeKey: `mail-event:${anchor.id}:${shortHash(payload.start)}`, ...common });
  }

  const assigned = assignmentSuggestionsFromTriage(ctx, {
    byId: new Map([[anchor.id, anchor]]),
    triaged: new Map(anchor.triage ? [[anchor.id, anchor.triage]] : []),
    items: answer.assignments.slice(0, 1).map((item) => ({ ...item, sourceId: anchor.id })),
    ...(execution ? { execution } : {}),
    parseDue: (value) => parseDay(value, timeZone),
    originOf: suggestionOrigin,
  });
  found += assigned.size;

  // An assignment or event of this answer is offered as one, never again as a todo of the same name.
  const offeredOtherwise = new Set([...answer.assignments, ...answer.events].map((item) => titleKey(item.title)));
  const todos = new Set(fromThread("todo").map((suggestion) => titleKey((suggestion.payload as TodoSuggestion)?.title ?? "")));
  for (const item of answer.todos.slice(0, PROCESS_ITEMS_MAX)) {
    const title = item.title.replace(/\s+/g, " ").trim().slice(0, 120);
    const key = titleKey(title);
    if (!key || offeredOtherwise.has(key)) continue;
    found++;
    if (todos.has(key)) continue;
    todos.add(key);
    const due = parseDay(item.due, timeZone);
    const payload: TodoSuggestion = { title, ...(due ? { dueDay: due.day, ...(due.time ? { dueTime: due.time } : {}) } : {}) };
    ctx.suggestions.create<TodoSuggestion>({ kind: "todo", title, payload, dedupeKey: `mail-todo:${anchor.id}:${shortHash(key)}`, ...common });
  }
  return found;
}
