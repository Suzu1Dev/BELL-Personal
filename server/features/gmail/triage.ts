import { z } from "zod";
import { MAIL_TRIAGE_VERSION, type MailBill, type MailCategory, type MailMessage, type MailTriage } from "../../../shared/mail.js";
import type { ModelExecution } from "../../../shared/models.js";
import type { EventSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import { dayKey, isDayKey, isLocalTime, localTime, timeZoneOffsetMinutes, zonedTimeToUtc } from "../../../shared/time.js";
import { AppError, publicError } from "../../errors.js";
import { logEvent } from "../../log.js";
import { jsonSchemaFor } from "../../ai/structured.js";
import type { ModuleContext } from "../../modules.js";
import { untrustedBlock } from "../../prompts/boundary.js";
import { redact, secretInPatch } from "../../secrets/redact.js";
import type { MailStore } from "./store.js";
import { assignmentAnswerShape, assignmentModelShape, assignmentPromptLine, assignmentSuggestionsFromTriage } from "./triage-assignments.js";

/**
 * AI mail triage (decisions.md item 8): a DB-backed queue whose state lives
 * in each MailMessage (`triageQueue`), processed one batch of at most 15
 * inbox messages at a time after each sync with ctx.ai.runStructured and a
 * strict schema (engineering brief §D, plus `context` and `bill`). The model
 * only proposes: it sets the category, priority, action and a one-line zh
 * summary, and the todos and events it finds become pending suggestions
 * (deduplicated per message). Messages whose text looks like it carries a
 * secret are never sent; they keep the rule triage. A failed batch of several
 * messages is split (the queue halves its batch size) instead of charging
 * them; a message that fails alone counts one attempt, and after three it is
 * `failed` and keeps the rules. An unavailable CLI (503, 429) or AI being off
 * counts nothing. After any failure the queue waits before the next run.
 */

export const TRIAGE_BATCH = 15;
export const TRIAGE_MAX_ATTEMPTS = 3;
/** Batches per kick, so a big first sync does not hold the single agent slot for long. */
export const TRIAGE_BATCHES_PER_RUN = 3;
const EXCERPT_CHARS = 1800;

/** The §D categories the model answers with, mapped to the shared ones. */
export const AI_CATEGORIES = ["action", "school", "event", "finance", "notification", "newsletter", "promo", "other"] as const;
const AI_ACTIONS = ["reply", "todo", "calendar", "read", "archive", "none"] as const;

const nullableText = (max: number) => z.string().max(max).nullable();

const triageAnswerShape = {
  items: z.array(z.object({
    id: z.string().max(100),
    summary: z.string().max(400),
    category: z.enum(AI_CATEGORIES),
    priority: z.enum(["high", "medium", "low"]),
    action: z.enum(AI_ACTIONS),
    context: nullableText(60),
    bill: z.object({
      payee: z.string().max(80),
      amount: z.number().min(0).max(100_000_000),
      currency: z.string().max(8),
      dueDate: nullableText(40),
      period: nullableText(20),
      autopay: z.boolean().nullable(),
    }).strict().nullable(),
  }).strict()).max(TRIAGE_BATCH),
  todos: z.array(z.object({
    sourceId: z.string().max(100),
    title: z.string().max(200),
    due: nullableText(40),
  }).strict()).max(TRIAGE_BATCH * 2),
  events: z.array(z.object({
    sourceId: z.string().max(100),
    title: z.string().max(200),
    start: z.string().max(40),
    end: nullableText(40),
    location: nullableText(200),
  }).strict()).max(TRIAGE_BATCH * 2),
};

export const triageAnswerSchema = z.object({
  ...triageAnswerShape,
  // Assignments announced in mail (SPEC-mail-assignments §5.3): shape and parsing in triage-assignments.ts.
  ...assignmentAnswerShape,
}).strict();
export type TriageAnswer = z.infer<typeof triageAnswerSchema>;

/**
 * The JSON schema the model is given: the answer's, with the limits of
 * §5.3 on the assignments' `submit` and `url`, which the answer itself
 * checks loosely (triage-assignments.ts) so one long link cannot fail a batch.
 */
export const TRIAGE_JSON_SCHEMA = jsonSchemaFor(z.object({ ...triageAnswerShape, ...assignmentModelShape }).strict());

/** The UTC offset of `timeZone` at `at`, as the model should write it (「+08:00」). */
export function offsetText(timeZone: string, at: Date): string {
  const minutes = timeZoneOffsetMinutes(timeZone, at);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** The task prompt, with date-times written in the user's zone (BELLPERSONAL_TZ), not a fixed +08:00. */
export function triagePrompt(offset: string): string {
  return [
  "請整理以下每一封新信件，替每封信寫一句台灣繁體中文摘要（最多 40 個字，說清楚寄件者要你做什麼或信的重點），並判斷：",
  "category：action（需要你處理或回覆的個人信件）、school（學校公告）、event（活動邀請或報名通知）、finance（帳單、繳費、扣款）、notification（系統或服務通知，例如 GitHub）、newsletter（電子報）、promo（促銷廣告）、other。",
  "priority：high（今天就該處理，例如教授或主管要你回覆）、medium、low。",
  "action：reply（需要你親自回信）、todo（需要你做一件事但不必回信）、calendar（有一個要參加的活動或會議）、read（看過即可）、archive（可以直接封存）、none。",
  "context：信件所屬的課程或組織（例如「作業系統」），沒有就填 null。",
  "bill：只有帳單才填（payee 收款單位、amount 金額數字、currency 例如 TWD、dueDate 繳費期限 YYYY-MM-DD、period 例如「9 月」、autopay 是否已設定自動扣繳，不知道填 null），其他信件填 null。",
  `todos：信中明確要求你在某個期限前完成的事（title 用動詞開頭，due 為 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM${offset}，沒有期限填 null）；帳單和需要回信的信不用列。`,
  `events：信中你已報名、受邀或需要出席的活動與會議（start、end 為 YYYY-MM-DDTHH:MM${offset}，整天的活動用 YYYY-MM-DD；location 沒有就填 null）。不要列出廣告裡的活動。`,
  assignmentPromptLine(offset),
  `items、todos、events、assignments 裡的 id 與 sourceId 必須是資料中信件的 id。每封信都要有一個 items 項目。日期以資料中的 today 與時區 timeZone（目前 UTC${offset}）推算，時間一律寫成該時區的當地時間。`,
  ].join("\n");
}

/** The prompt for Asia/Taipei (tests and docs). */
export const TRIAGE_PROMPT = triagePrompt("+08:00");

const CATEGORY_OF: Record<(typeof AI_CATEGORIES)[number], MailCategory> = {
  action: "other", school: "school", event: "invitation", finance: "bill", notification: "notification", newsletter: "newsletter", promo: "promo", other: "other",
};

/** The model's item → the stored MailTriage (source "ai"). */
export function toTriage(item: TriageAnswer["items"][number], triagedAt: string, timeZone: string): MailTriage {
  const category: MailCategory = item.action === "reply" ? "needs-reply" : CATEGORY_OF[item.category];
  const summary = item.summary.replace(/\s+/g, " ").trim();
  const bill = item.bill && category === "bill" ? toBill(item.bill, timeZone) : undefined;
  const context = item.context?.trim();
  return {
    summary: summary.length > 120 ? `${summary.slice(0, 119)}…` : summary,
    category,
    priority: item.priority,
    action: item.action,
    source: "ai",
    triagedAt,
    version: MAIL_TRIAGE_VERSION,
    ...(context ? { context: context.slice(0, 40) } : {}),
    ...(bill ? { bill } : {}),
  };
}

function toBill(bill: NonNullable<TriageAnswer["items"][number]["bill"]>, timeZone: string): MailBill | undefined {
  if (!bill.payee.trim() || !(bill.amount > 0)) return undefined;
  const due = parseDay(bill.dueDate, timeZone);
  return {
    payee: bill.payee.trim().slice(0, 40),
    amount: bill.amount,
    currency: (bill.currency.trim().toUpperCase() || "TWD").replace(/^NT\$?$/, "TWD").slice(0, 3),
    ...(due ? { dueDay: due.day } : {}),
    ...(bill.period?.trim() ? { period: bill.period.trim().slice(0, 12) } : {}),
    ...(bill.autopay !== null ? { autopay: bill.autopay } : {}),
  };
}

/**
 * A model date-time as an instant (ms). With an offset (`Z`, `+08:00`) it is
 * taken as written; without one it is wall-clock time in the user's zone, not
 * the host's (the host clock is UTC, so Date.parse would shift it by 8 hours).
 */
export function modelInstant(text: string, timeZone: string): number {
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(text);
  if (local) {
    if (!isDayKey(local[1]) || Number(local[2]) > 23 || Number(local[3]) > 59) return Number.NaN;
    return zonedTimeToUtc(timeZone, local[1], Number(local[2]), Number(local[3])).getTime();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return Number.NaN;
  return Date.parse(text);
}

/** "2026-10-20" or a date-time → the local day (and time when one was given). */
export function parseDay(value: string | null | undefined, timeZone: string): { day: string; time?: string } | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (isDayKey(text)) return { day: text };
  const instant = modelInstant(text, timeZone);
  if (Number.isNaN(instant)) return undefined;
  const time = localTime(timeZone, instant);
  return { day: dayKey(timeZone, instant), ...(isLocalTime(time) ? { time } : {}) };
}

/** 「KKTIX 報名成功信」: the sender plus what kind of mail it is, for 「來自 …」. */
export function suggestionOrigin(message: MailMessage): string {
  const sender = message.from.name ?? message.from.email.split("@")[0];
  const kind = /報名(成功|完成)|registration (confirmed|complete)|ticket/i.test(message.subject) ? "報名成功信"
    : /邀請|invitation|invite/i.test(message.subject) ? "邀請信" : "信件";
  return `${sender} ${kind}`.slice(0, 80);
}

export interface TriageRunResult {
  processed: number;
  failed: number;
  suggestions: number;
  /** Why processing stopped early: aborted, disabled, unavailable (503/429), failed (a batch failed). */
  stopped?: string;
  /** The size of the batch that failed (stopped "failed"). */
  failedBatch?: number;
}

interface Execution { execution?: ModelExecution }

/**
 * Processes pending triage, one batch of at most `batchSize` at a time, up to
 * `maxBatches`. Safe to call while another run is going on only through
 * MailTriageQueue.kick().
 */
export async function runTriage(ctx: ModuleContext, store: MailStore, signal: AbortSignal, maxBatches = TRIAGE_BATCHES_PER_RUN, batchSize = TRIAGE_BATCH): Promise<TriageRunResult> {
  const result: TriageRunResult = { processed: 0, failed: 0, suggestions: 0 };
  for (let batch = 0; batch < maxBatches; batch++) {
    if (signal.aborted) { result.stopped = "aborted"; break; }
    if (!ctx.settings.value("ai.enabled") || !ctx.settings.value("ai.mailTriage")) { result.stopped = "disabled"; break; }
    const pending = nextBatch(ctx, store, batchSize);
    if (!pending.length) break;
    const outcome = await runBatch(ctx, store, pending, signal);
    result.processed += outcome.processed;
    result.failed += outcome.failed;
    result.suggestions += outcome.suggestions;
    if (outcome.stopped) { result.stopped = outcome.stopped; if (outcome.failedBatch) result.failedBatch = outcome.failedBatch; break; }
  }
  return result;
}

/** Pending messages, newest first; mail that left the inbox or looks secret is settled with the rules right away. */
function nextBatch(ctx: ModuleContext, store: MailStore, size: number): MailMessage[] {
  const now = ctx.now().toISOString();
  const pending = store.all().filter((message) => message.triageQueue?.state === "pending").sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const settle: MailMessage[] = [];
  const batch: MailMessage[] = [];
  for (const message of pending) {
    const text = `${message.subject}\n${message.snippet}\n${message.excerpt ?? ""}`;
    if (!message.labels.includes("INBOX") || secretInPatch(text)) {
      settle.push({ ...message, triageQueue: { state: "done", attempts: message.triageQueue!.attempts, updatedAt: now } });
      continue;
    }
    if (batch.length < Math.max(1, Math.min(size, TRIAGE_BATCH))) batch.push(message);
  }
  if (settle.length) store.put(settle);
  return batch;
}

async function runBatch(ctx: ModuleContext, store: MailStore, batch: MailMessage[], signal: AbortSignal): Promise<TriageRunResult> {
  const timeZone = ctx.config.timeZone;
  const data = {
    today: ctx.today(),
    timeZone,
    messages: batch.map((message) => ({
      id: message.id,
      from: message.from,
      subject: message.subject,
      receivedAt: `${dayKey(timeZone, message.receivedAt)} ${localTime(timeZone, message.receivedAt)}`,
      gmailLabels: message.labels.filter((label) => label === "IMPORTANT" || label.startsWith("CATEGORY_")),
      automated: !!message.listUnsubscribe,
      body: untrustedBlock("email", message.excerpt ?? message.snippet, EXCERPT_CHARS),
    })),
  };
  let answer: TriageAnswer;
  let meta: Execution = {};
  try {
    const prompt = triagePrompt(offsetText(timeZone, ctx.now()));
    const run = await ctx.ai.runStructured({ role: "信件分類", schema: triageAnswerSchema, jsonSchema: TRIAGE_JSON_SCHEMA, prompt, data, signal, timeoutKind: "standard" });
    answer = run.value;
    meta = { execution: run.execution };
  } catch (error) {
    if (signal.aborted) return { processed: 0, failed: 0, suggestions: 0, stopped: "aborted" };
    const unavailable = error instanceof AppError && (error.status === 503 || error.status === 429);
    logEvent("gmail.triage_failed", { messages: batch.length, unavailable, errorClass: error instanceof Error ? error.name : typeof error, ...(error instanceof AppError ? { status: error.status } : {}) });
    if (unavailable) return { processed: 0, failed: 0, suggestions: 0, stopped: "unavailable" };
    // Several messages: one of them (or an outage) may be the cause; the queue retries smaller batches later, charging nobody.
    if (batch.length > 1) return { processed: 0, failed: 0, suggestions: 0, stopped: "failed", failedBatch: batch.length };
    const failed = recordFailure(ctx, store, batch, redact(publicError(error)).slice(0, 200));
    return { processed: 0, failed, suggestions: 0, stopped: "failed", failedBatch: 1 };
  }
  return applyAnswer(ctx, store, batch, answer, meta.execution);
}

/** Counts one attempt per message that is still cached (a sync may have deleted or pruned it meanwhile). */
function recordFailure(ctx: ModuleContext, store: MailStore, batch: MailMessage[], error: string): number {
  const now = ctx.now().toISOString();
  let failed = 0;
  const updates: MailMessage[] = [];
  for (const message of batch) {
    const current = store.get(message.id);
    if (!current) continue;
    const attempts = (message.triageQueue?.attempts ?? 0) + 1;
    const state = attempts >= TRIAGE_MAX_ATTEMPTS ? "failed" as const : "pending" as const;
    if (state === "failed") failed++;
    updates.push({ ...current, triageQueue: { state, attempts, updatedAt: now, error } });
  }
  store.put(updates);
  return failed;
}

/**
 * Stores the model's triage and turns its todos and events into pending
 * suggestions. The model ran for seconds to minutes: a message a sync deleted
 * or pruned meanwhile (or a purge, a disconnect) is left gone, never written
 * back from the batch's copy, and gets no suggestion.
 */
export function applyAnswer(ctx: ModuleContext, store: MailStore, batch: MailMessage[], answer: TriageAnswer, execution?: ModelExecution): TriageRunResult {
  const now = ctx.now();
  const timeZone = ctx.config.timeZone;
  const byId = new Map(batch.filter((message) => store.get(message.id)).map((message) => [message.id, message]));
  const triaged = new Map<string, MailTriage>();
  for (const item of answer.items) if (byId.has(item.id) && !triaged.has(item.id)) triaged.set(item.id, toTriage(item, now.toISOString(), timeZone));

  const updates: MailMessage[] = [];
  const missing: MailMessage[] = [];
  for (const message of byId.values()) {
    const triage = triaged.get(message.id);
    if (!triage) { missing.push(message); continue; }
    const current = store.get(message.id)!;
    updates.push({ ...current, triage, triageQueue: { state: "done", attempts: (message.triageQueue?.attempts ?? 0) + 1, updatedAt: now.toISOString() } });
  }
  store.put(updates);
  const failed = missing.length ? recordFailure(ctx, store, missing, "模型沒有回覆這封信的分類。") : 0;

  let suggestions = 0;
  const made = new Set<string>();
  // Assignments first: a message that announces one gets no todo suggestion (triage-assignments.ts).
  const assigned = assignmentSuggestionsFromTriage(ctx, {
    byId, triaged, items: answer.assignments, ...(execution ? { execution } : {}),
    parseDue: (value) => parseDay(value, timeZone), originOf: suggestionOrigin,
  });
  suggestions += assigned.size;
  for (const event of answer.events) {
    const message = byId.get(event.sourceId);
    if (!message || made.has(`event:${message.id}`)) continue;
    const payload = toEvent(event, timeZone, now);
    if (!payload) continue;
    made.add(`event:${message.id}`);
    ctx.suggestions.create<EventSuggestion>({
      kind: "event", title: payload.title, payload,
      sourceRef: { source: "gmail", externalId: message.id, url: message.webUrl },
      dedupeKey: `mail-event:${message.id}`, origin: suggestionOrigin(message),
      ...(execution ? { modelExecution: execution } : {}),
    });
    suggestions++;
  }
  for (const todo of answer.todos) {
    const message = byId.get(todo.sourceId);
    const triage = message && triaged.get(message.id);
    // Bills and mail to answer already offer 轉待辦 on their own row; an announced assignment is offered as one.
    if (!message || !triage || triage.category === "bill" || triage.action === "reply" || assigned.has(message.id) || made.has(`todo:${message.id}`)) continue;
    const title = todo.title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) continue;
    const due = parseDay(todo.due, timeZone);
    made.add(`todo:${message.id}`);
    ctx.suggestions.create<TodoSuggestion>({
      kind: "todo", title,
      payload: { title, ...(due ? { dueDay: due.day, ...(due.time ? { dueTime: due.time } : {}) } : {}) },
      sourceRef: { source: "gmail", externalId: message.id, url: message.webUrl },
      dedupeKey: `mail-todo:${message.id}`, origin: suggestionOrigin(message),
      ...(execution ? { modelExecution: execution } : {}),
    });
    suggestions++;
  }
  logEvent("gmail.triaged", { messages: updates.length, missing: missing.length, suggestions });
  return { processed: updates.length, failed, suggestions };
}

/** The model's event → the suggestion payload; undefined without a title or start, or for an event more than a day past. */
export function toEvent(event: Omit<TriageAnswer["events"][number], "sourceId">, timeZone: string, now: Date): EventSuggestion | undefined {
  const title = event.title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!title) return undefined;
  const text = event.start.trim();
  const allDay = isDayKey(text);
  const start = allDay ? zonedTimeToUtc(timeZone, text).getTime() : modelInstant(text, timeZone);
  if (Number.isNaN(start)) return undefined;
  if (start < now.getTime() - 86_400_000) return undefined; // past events are not worth a suggestion
  const endAt = event.end ? modelInstant(event.end.trim(), timeZone) : Number.NaN;
  const location = event.location?.trim().slice(0, 120);
  return {
    title,
    start: new Date(start).toISOString(),
    ...(!allDay && endAt > start ? { end: new Date(endAt).toISOString() } : {}),
    allDay,
    ...(location ? { location } : {}),
  };
}

/** A run starts once this many messages wait, or the oldest has waited TRIAGE_MAX_WAIT_MS (the rules cover the gap). */
export const TRIAGE_MIN_PENDING = 5;
export const TRIAGE_MAX_WAIT_MS = 10 * 60_000;
/** After a failed batch the next run waits 2, 4, 8 … minutes (at most an hour); an unavailable CLI waits 15 minutes. */
export const TRIAGE_BACKOFF_MS = 2 * 60_000;
export const TRIAGE_MAX_BACKOFF_MS = 60 * 60_000;
export const TRIAGE_UNAVAILABLE_MS = 15 * 60_000;

/**
 * Single-flight runner: kick() after each sync starts a background job
 * ("mail-triage") unless one is already running; close() aborts it. Runs
 * are coalesced (TRIAGE_MIN_PENDING or TRIAGE_MAX_WAIT_MS, or `now` when
 * someone is looking at the inbox) so steady mail does not cost one model
 * call per message. A failed batch halves the next batch size (doubling back
 * after successes) until the message that fails alone is found, and backs
 * off; a signed-out or rate-limited CLI waits TRIAGE_UNAVAILABLE_MS.
 */
export class MailTriageQueue {
  private running: Promise<void> | null = null;
  private readonly controller = new AbortController();
  private batchSize = TRIAGE_BATCH;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly ctx: ModuleContext, private readonly store: MailStore) {}

  get active(): boolean {
    return this.running !== null;
  }

  pending(): { pending: number; failed: number } {
    let pending = 0;
    let failed = 0;
    for (const message of this.store.all()) {
      if (message.triageQueue?.state === "pending") pending++;
      else if (message.triageQueue?.state === "failed") failed++;
    }
    return { pending, failed };
  }

  /**
   * Starts one run in the background when AI triage is on, enough is pending
   * (or `now`), and no backoff is in force.
   */
  kick(options: { now?: boolean } = {}): void {
    if (this.running || this.controller.signal.aborted) return;
    if (!this.ctx.settings.value("ai.enabled") || !this.ctx.settings.value("ai.mailTriage")) return;
    const now = this.ctx.now().getTime();
    if (now < this.retryAt) return;
    const waiting = this.store.all().filter((message) => message.triageQueue?.state === "pending");
    if (!waiting.length) return;
    const oldest = Math.min(...waiting.map((message) => Date.parse(message.triageQueue!.updatedAt) || now));
    if (!options.now && waiting.length < TRIAGE_MIN_PENDING && now - oldest < TRIAGE_MAX_WAIT_MS) return;
    this.running = (async () => {
      try {
        const job = this.ctx.jobs.start({ kind: "mail-triage", title: "整理新信件" }, async (emit, signal) => {
          emit({ type: "stage", stage: "triage", message: "正在用 AI 整理新信件…" });
          const stop = AbortSignal.any([signal, this.controller.signal]);
          const result = await runTriage(this.ctx, this.store, stop, TRIAGE_BATCHES_PER_RUN, this.batchSize);
          this.settle(result);
          return { processed: result.processed, suggestions: result.suggestions };
        }, { maxRunning: 1, busyMessage: "信件正在整理中。" });
        await this.ctx.jobs.settled(job.id);
      } catch (error) {
        if (!(error instanceof AppError)) logEvent("gmail.triage_error", { errorClass: error instanceof Error ? error.name : typeof error });
      } finally {
        this.running = null;
      }
    })();
  }

  /** Batch size and backoff after a run. */
  private settle(result: TriageRunResult): void {
    const now = this.ctx.now().getTime();
    if (result.stopped === "unavailable") {
      this.retryAt = now + TRIAGE_UNAVAILABLE_MS;
    } else if (result.stopped === "failed") {
      this.failures++;
      if (result.failedBatch && result.failedBatch > 1) this.batchSize = Math.ceil(result.failedBatch / 2);
      this.retryAt = now + Math.min(TRIAGE_MAX_BACKOFF_MS, TRIAGE_BACKOFF_MS * 2 ** (this.failures - 1));
    } else if (result.processed) {
      this.failures = 0;
      this.retryAt = 0;
      this.batchSize = Math.min(TRIAGE_BATCH, this.batchSize * 2);
    }
  }

  /** The current batch size and when the next run may start (tests, status). */
  get backoff(): { batchSize: number; retryAt: number } {
    return { batchSize: this.batchSize, retryAt: this.retryAt };
  }

  /** Waits for the current run (tests, shutdown). */
  async idle(): Promise<void> {
    await this.running;
  }

  close(): void {
    this.controller.abort();
  }
}
