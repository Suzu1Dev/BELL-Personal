import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseCapture, type CaptureParse } from "../../../shared/capture-parse.js";
import { MANUAL_EVENT_LIMITS, type ManualEvent, type ManualEventPretidy } from "../../../shared/calendar.js";
import { TIDY_EVENT_ORIGINS, TIDY_TODO_ORIGINS, type CaptureTidyResult, type CaptureTidyStart, type CaptureTidyUndoResponse, type TidyReason, type TidyTarget } from "../../../shared/connect.js";
import type { JobEvent } from "../../../shared/jobs.js";
import { dayKey, localTime, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";
import { TODO_LIMITS, type Todo } from "../../../shared/todos.js";
import { weekdayChar } from "../../../shared/today-format.js";
import { AppError } from "../../errors.js";
import { withGenerationProgress } from "../../generation-progress.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { calendarService } from "../calendar/store.js";
import { todoStore } from "../todos/store.js";
import { whenPhrase } from "./when.js";

/**
 * 自動整理 (SPEC-ux §6.6.1): after quick capture saves a todo or an event with
 * the rule parser's title, a background job asks the model for a concise
 * title, the details as notes and (for events) the place, checks the answer
 * against the user's own text, and rewrites the record in place. The capture
 * itself never waits for it. Every rewrite is reversible (POST
 * /api/capture/tidy/undo) and keeps the sentence the user typed in
 * `originalText`. The same job backs the manual 整理 on #/tasks and #/calendar.
 *
 * Rules (decided here, documented in docs/ARCHITECTURE.md §10.6.1):
 *  - dates are a cross-check only: a day or time in the answer must equal the
 *    rule parse of the original text or the saved record, else the whole
 *    answer is refused; the tidy never moves a saved due date or start;
 *  - grounded in the user's text: the title keeps a key word of it (not only
 *    function words such as 要在, 生出來, 主題是) and adds no word or Han
 *    character it does not have; every note says only what the text says,
 *    and a date in a note must be one the text names; the place must appear
 *    in it; one failed check refuses the whole answer;
 *  - the record must be unchanged since the job started (fingerprint of the
 *    fields the user edits), else the answer is dropped; editing a todo
 *    cancels its tidy at once;
 *  - one tidy per record; the job waits for the agent slot at priority
 *    "soon": behind an AI 解析 the user is watching, ahead of mail triage;
 *  - reversible: the fields from before (`pretidy`) stay on the record until
 *    the user edits the title or notes; 復原 (the toast's token) and 復原整理
 *    (on the record) put them back;
 *  - only text the owner typed: todos made by hand or by quick capture and
 *    local events from quick capture; records from mail, LMS, GitHub, feeds
 *    or suggestions are refused (409), so their source data never goes out;
 *  - events: a Google insert still waiting for its undo window is postponed
 *    while the model runs and then given a fresh window, so Google receives
 *    the tidied event once; an event already in Google Calendar, or whose
 *    insert is on its way, is not tidied or restored (there is no Google
 *    update path) and 整理 answers 409. The moved details go before the
 *    「來自 快速記下」 line, so the agenda's meta line shows the first one.
 */

/** How long the model may take once its CLI runs (time queued for the agent slot does not count). */
export const CAPTURE_TIDY_TIMEOUT_MS = 60_000;
/** A waiting Google insert is postponed at most this long while the event is being tidied. */
export const TIDY_HOLD_MS = 120_000;
/** Titles this short and without punctuation are already tidy: no model call after a capture. */
export const AUTO_TIDY_MIN_CHARS = 16;
/** A tidied title longer than this is refused. The prompt asks for ~24 CJK / ~48 mixed characters. */
export const TIDY_TITLE_MAX = 60;
const NOTE_LINES_MAX = 8;
const NOTE_LINE_MAX = 200;
const UNDO_TTL_MS = 60 * 60_000;
const UNDO_KEEP = 200;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const tidyAnswerSchema = z.object({
  title: z.string().min(1).max(80),
  notes: z.array(z.string().max(NOTE_LINE_MAX)).max(NOTE_LINES_MAX),
  dueDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  dueTime: z.string().regex(TIME).nullable(),
  location: z.string().max(200).nullable(),
  confidence: z.enum(["high", "medium", "low"]),
}).strict();

export type TidyAnswer = z.infer<typeof tidyAnswerSchema>;

export function tidyPrompt(kind: TidyTarget): string {
  const noun = kind === "event" ? "行程" : "待辦";
  return [
    `把使用者快速記下的一句話整理成清楚的${noun}。data.text 是使用者原本輸入的文字；data.current 是目前存下的紀錄，標題通常是規則把日期字詞拿掉後剩下的部分，可能不通順或太長。`,
    "title：簡潔的標題，最多 24 個中文字（中英混合最多 48 個字元），用原文的詞，不要加上原文沒有的動詞或內容；口語的動作（做完、生出來、弄好）可以省略，只留下事情本身。專有名詞、課名、英文與數字照原文保留，不要翻譯、不要改大小寫。標題不放日期、時間、期限，也不放「要」「記得」這類語助詞。",
    "notes：從標題移出的細節，一行一項，用「主題：…」「內容：…」「備註：…」這類短句；沒有細節就回傳空陣列。只能用原文裡有的字詞，不要補充、不要重複標題，不要寫日期。",
    "例：「OS 期末報告 週五前要弄好，內容是排程器比較」→ title「OS 期末報告」，notes [「內容：排程器比較」]。",
    "dueDay、dueTime：只有原文清楚寫出時才填（YYYY-MM-DD、24 小時制 HH:MM），必須和 data.rule 或 data.current 的日期時間一致；否則回傳 null，不要自行推算或補上。",
    kind === "event" ? "location：行程的地點，原文有寫才填，否則回傳 null。" : "location：待辦一律回傳 null。",
    "confidence：high、medium 或 low；看不懂原文或不需要整理時回傳 low。",
  ].join("\n");
}

/** One record as the tidy sees it. */
interface TidySubject {
  kind: TidyTarget;
  id: string;
  title: string;
  notes?: string;
  location?: string;
  /** Local due day (todo) or start day (event). */
  day?: DayKey;
  /** Local due time (todo) or start time (event, not all-day). */
  time?: string;
  /** The sentence the model reads: what the user typed, or the title and notes of an older record. */
  text: string;
  createdAt: string;
  /** The fields the user edits; a change means the user edited the record. */
  fingerprint: string;
  /** An event already in Google Calendar or on its way there (not just waiting for its undo window). */
  inGoogle: boolean;
  /** The fields from before the last tidy, while 復原整理 can still put them back. */
  pretidy?: ManualEventPretidy;
  /** Text the owner typed (TIDY_TODO_ORIGINS / TIDY_EVENT_ORIGINS), not source data from mail or feeds. */
  typed: boolean;
}

const joinText = (...parts: Array<string | undefined>) => parts.map((part) => part?.trim()).filter(Boolean).join("\n");

function todoFingerprint(todo: Todo): string {
  return JSON.stringify([todo.title, todo.notes ?? "", todo.dueDay ?? "", todo.dueTime ?? "", todo.status, todo.priority, todo.projectId ?? "", todo.estimateMinutes ?? 0]);
}

function eventFingerprint(event: ManualEvent): string {
  return JSON.stringify([event.title, event.notes ?? "", event.location ?? "", event.start, event.end ?? "", event.allDay]);
}

function readSubject(ctx: ModuleContext, kind: TidyTarget, id: string): TidySubject | undefined {
  const timeZone = ctx.config.timeZone;
  if (kind === "todo") {
    const todo = todoStore(ctx).get(id, true);
    if (!todo) return undefined;
    return {
      kind, id, title: todo.title, notes: todo.notes, day: todo.dueDay, time: todo.dueTime,
      // A title the user rewrote dropped originalText (TodoStore.update): then the title and notes are the text.
      text: todo.originalText ?? joinText(todo.title, todo.notes), createdAt: todo.createdAt,
      fingerprint: todoFingerprint(todo), inGoogle: false, ...(todo.pretidy ? { pretidy: todo.pretidy } : {}),
      typed: (TIDY_TODO_ORIGINS as readonly string[]).includes(todo.origin),
    };
  }
  const service = calendarService(ctx);
  const event = service.events.get(id, { strict: true });
  if (!event) return undefined;
  return {
    kind, id, title: event.title, notes: event.notes, location: event.location,
    day: dayKey(timeZone, event.start), ...(event.allDay ? {} : { time: localTime(timeZone, event.start) }),
    text: event.originalText ?? joinText(event.title, event.location, event.notes), createdAt: event.createdAt,
    fingerprint: eventFingerprint(event), inGoogle: !!event.googleEventId || service.isInserting(id),
    ...(event.pretidy ? { pretidy: event.pretidy } : {}),
    typed: (TIDY_EVENT_ORIGINS as readonly string[]).includes(event.origin ?? ""),
  };
}

/* ------------------------------------------------------------------ checks */

const clean = (value: string) => value.replace(/\s+/g, " ").replace(/^[\s,，、:：;；\-–—]+|[\s,，、:：;；\-–—。]+$/g, "").trim();
/** 「主題:Windows …」 → 「主題：Windows …」: a Chinese label takes the full-width colon (the model sometimes writes ":"). */
const noteLine = (value: string) => clean(value).replace(/^(\p{Script=Han}{1,6})\s*[:：]\s*/u, "$1：");
const characters = (value: string) => [...value].length;

/** Compared form: full-width → ASCII, lower case, 周/星期/禮拜 → 週 (the model may spell the user's 周日 as 週日). */
const canon = (value: string) => value.normalize("NFKC").toLowerCase().replace(/周|星期|禮拜/g, "週").replace(/週天/g, "週日");

/** Han bigrams that carry no subject: connectives, filler verbs, labels and date words. */
const STOP_BIGRAMS = new Set([
  "要在", "得在", "需要", "必須", "可以", "應該", "記得", "然後", "還有", "就是", "一下", "一個", "這個", "那個", "時候",
  "生出", "出來", "完成", "弄好", "做完", "做好", "處理", "搞定", "主題", "題是", "內容", "容是", "備註", "細節", "注意",
  "之前", "以前", "為止", "截止", "最晚", "最遲", "今天", "明天", "後天", "今晚", "明早", "明晚", "週末", "月底", "下週", "這週", "本週",
  "早上", "上午", "中午", "下午", "晚上",
]);
const STOP_WORDS = new Set([
  "a", "an", "the", "to", "by", "on", "at", "in", "of", "is", "be", "do", "or", "and", "for", "with", "from", "about", "it", "my", "me", "up",
  "before", "after", "until", "till", "due", "next", "this", "that", "today", "tomorrow", "tonight",
  "get", "make", "finish", "done", "need", "must", "should", "will", "can", "please", "remember", "todo", "note", "notes",
]);
const WEEKDAY_WORD = /^(?:sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?$/;
/** Joining characters a title may add without inventing anything (Deep Hacking「的」簡報). */
const JOINERS = new Set([..."的與和及跟或之"]);

const latinWords = (value: string) => canon(value).match(/[a-z0-9][a-z0-9.+#_-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
const hanBigrams = (value: string) => (canon(value).match(/\p{Script=Han}+/gu) ?? []).flatMap((run) => {
  const chars = [...run];
  return chars.slice(1).map((char, index) => chars[index] + char);
});

/** Latin words (2+ characters) and Han bigrams that name something, not filler, a label or a date. */
export function keyTerms(value: string): string[] {
  const latin = latinWords(value).filter((word) => word.length >= 2 && !STOP_WORDS.has(word) && !WEEKDAY_WORD.test(word));
  const han = hanBigrams(value).filter((pair) => !STOP_BIGRAMS.has(pair) && !/^[在於到至]週$|^週[一二三四五六日]$|[一二三四五六日]前$/.test(pair));
  return [...latin, ...han];
}

/** The tidied title keeps a key word of what the user wrote: it did not drop every noun (「生出來」, 「主題是」 are not a title). */
export function keepsKeyTerms(title: string, text: string): boolean {
  const haystack = canon(text);
  return keyTerms(title).some((term) => haystack.includes(term));
}

/** A word or Han character of `value` that the user's text does not have (「Windows 更新」 when nothing was said about 更新). */
export function inventedPart(value: string, text: string): string | undefined {
  const haystack = canon(text);
  const word = latinWords(value).find((candidate) => !haystack.includes(candidate));
  if (word) return word;
  return [...canon(value)].find((char) => /\p{Script=Han}/u.test(char) && !JOINERS.has(char) && !haystack.includes(char));
}

const EPOCH = new Date(0);
/** The date and time words in a note line (「10/25」, 「週五」, 「9點」). */
function dateWords(line: string): string[] {
  return parseCapture(line, { now: EPOCH, timeZone: "UTC" }).spans
    .filter((span) => span.kind === "date" || span.kind === "time")
    .map((span) => line.slice(span.start, span.end));
}

/** Why a note line is refused: a date the text does not name, or words it does not have; undefined when it is grounded. */
export function noteProblem(line: string, text: string): "dates" | "notes" | undefined {
  const haystack = canon(text);
  if (dateWords(line).some((word) => !haystack.includes(canon(word)))) return "dates";
  // 「主題：Windows …」: the label is the model's; what follows it must be the user's.
  const value = line.replace(/^[^\s：:]{1,8}\s*[：:]\s*/u, "");
  return inventedPart(value || line, text) === undefined ? undefined : "notes";
}

export type TidyVerdict =
  | { ok: true; title: string; notes?: string; addedNotes: string[]; location?: string }
  | { ok: false; reason: Extract<TidyReason, "same" | "unsure" | "rejected">; detail: string };

/**
 * Pure check of a model answer against the record and the rule parse of the
 * original text. Returns the fields to write, or why nothing is written.
 */
export function judgeTidy(answer: TidyAnswer, subject: Pick<TidySubject, "kind" | "title" | "notes" | "location" | "day" | "time" | "text">, rule: Pick<CaptureParse, "day" | "time">): TidyVerdict {
  if (answer.confidence === "low") return { ok: false, reason: "unsure", detail: "confidence" };
  const title = clean(answer.title);
  if (!title) return { ok: false, reason: "rejected", detail: "empty" };
  if (characters(title) > TIDY_TITLE_MAX) return { ok: false, reason: "rejected", detail: "length" };
  if (!keepsKeyTerms(title, subject.text)) return { ok: false, reason: "rejected", detail: "nouns" };
  if (inventedPart(title, subject.text) !== undefined) return { ok: false, reason: "rejected", detail: "invented" };
  const days = new Set([rule.day, subject.day].filter(Boolean));
  const times = new Set([rule.time, subject.time].filter(Boolean));
  if ((answer.dueDay && !days.has(answer.dueDay)) || (answer.dueTime && !times.has(answer.dueTime))) return { ok: false, reason: "rejected", detail: "dates" };

  const existing = (subject.notes ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const addedNotes: string[] = [];
  for (const raw of answer.notes) {
    const line = noteLine(raw).slice(0, NOTE_LINE_MAX);
    if (!line || line === title || existing.includes(line) || addedNotes.includes(line)) continue;
    const problem = noteProblem(line, subject.text);
    if (problem) return { ok: false, reason: "rejected", detail: problem };
    addedNotes.push(line);
  }
  const notesLimit = subject.kind === "event" ? MANUAL_EVENT_LIMITS.notes : TODO_LIMITS.notes;
  // An event's agenda row shows only its first note line, and a captured event's is 「來自 快速記下」: the details go first.
  const lines = subject.kind === "event" ? [...addedNotes, ...existing] : [...existing, ...addedNotes];
  const notes = addedNotes.length ? lines.join("\n").slice(0, notesLimit) : undefined;

  let location: string | undefined;
  const place = answer.location ? clean(answer.location) : "";
  if (subject.kind === "event" && place && !subject.location && canon(subject.text).includes(canon(place))) location = place.slice(0, MANUAL_EVENT_LIMITS.location);

  const sameTitle = title === clean(subject.title);
  if (sameTitle && !notes && !location) return { ok: false, reason: "same", detail: "same" };
  return { ok: true, title, addedNotes, ...(notes ? { notes } : {}), ...(location ? { location } : {}) };
}

/** 「已整理成「Deep Hacking 簡報」· 10/18（日）」: the same when-part as the capture toast before it. */
export function tidyMessage(title: string, day: DayKey | undefined, time: string | undefined, now: Date, timeZone: string): string {
  if (!day) return `已整理成「${title}」`;
  const [hour, minute] = (time ?? "").split(":").map(Number);
  const instant = time ? zonedTimeToUtc(timeZone, day, hour, minute).toISOString() : day;
  return `已整理成「${title}」· ${whenPhrase(instant, !time, now, timeZone)}`;
}

/* ------------------------------------------------------------- job state */

/** The fields a tidy writes; 復原 needs them unchanged. */
type TidyFields = ManualEventPretidy;

const fieldsOf = (record: { title: string; notes?: string; location?: string }): TidyFields => ({
  title: record.title, ...(record.notes ? { notes: record.notes } : {}), ...(record.location ? { location: record.location } : {}),
});
const sameFields = (a: TidyFields, b: TidyFields) => a.title === b.title && (a.notes ?? "") === (b.notes ?? "") && (a.location ?? "") === (b.location ?? "");

interface UndoEntry {
  kind: TidyTarget;
  id: string;
  /** What this tidy wrote: 復原 runs only while the title, notes and place still read so. */
  after: TidyFields;
  expires: number;
}

class TidyState {
  /** `${kind}:${id}` → the running job. */
  readonly running = new Map<string, string>();
  readonly undo = new Map<string, UndoEntry>();

  prune(now: number): void {
    for (const [token, entry] of this.undo) if (entry.expires < now) this.undo.delete(token);
    while (this.undo.size > UNDO_KEEP) this.undo.delete(this.undo.keys().next().value!);
  }
}

const states = new WeakMap<object, TidyState>();

function stateOf(ctx: ModuleContext): TidyState {
  let state = states.get(ctx.db.personal);
  if (!state) {
    state = new TidyState();
    states.set(ctx.db.personal, state);
  }
  return state;
}

const keyOf = (kind: TidyTarget, id: string) => `${kind}:${id}`;

/** The tidy job running for a record, if any. */
export function runningTidy(ctx: ModuleContext, kind: TidyTarget, id: string): string | undefined {
  const jobId = stateOf(ctx).running.get(keyOf(kind, id));
  return jobId && ctx.jobs.get(jobId)?.status === "running" ? jobId : undefined;
}

/** The user edited (or deleted, or finished) the record: its tidy stops and nothing is written. */
export function cancelTidy(ctx: ModuleContext, kind: TidyTarget, id: string): boolean {
  const jobId = runningTidy(ctx, kind, id);
  return jobId ? ctx.jobs.cancel(jobId, "內容已經改過，停止整理。") : false;
}

/** Whether a capture's title is worth a model call: long, or with punctuation that joins two thoughts. */
export function worthTidying(title: string): boolean {
  return characters(title) > AUTO_TIDY_MIN_CHARS || /[，,、；;。:：!！?？]/.test(title);
}

export interface StartTidyOptions {
  /** After a capture (logged as auto); a manual 整理 otherwise. */
  auto: boolean;
  timeoutMs?: number;
}

/**
 * Starts the `capture-tidy` job for a todo or a local event, or returns the
 * one already running for it. 503 with AI off, 404 for a missing record, 409
 * for an event already in Google Calendar, 429 when four tidies are running.
 */
export function startTidy(ctx: ModuleContext, kind: TidyTarget, id: string, options: StartTidyOptions): CaptureTidyStart {
  if (!ctx.settings.value("ai.enabled")) throw new AppError(503, "AI 已關閉，無法整理。");
  const running = runningTidy(ctx, kind, id);
  if (running) return { jobId: running, kind, id };
  const subject = readSubject(ctx, kind, id);
  if (!subject) throw new AppError(404, kind === "todo" ? "找不到這項待辦，可能已經刪除了。" : "找不到這個行程，可能已經刪除了。");
  if (!subject.typed) throw new AppError(409, "這一項來自信件或其他來源，不能用 AI 整理。");
  if (subject.inGoogle) throw new AppError(409, "這個行程已在 Google 行事曆，請到 Google 行事曆修改。");
  const key = keyOf(kind, id);
  const state = stateOf(ctx);
  const job = ctx.jobs.start(
    { kind: "capture-tidy", title: "整理快速記下", ref: key },
    (emit, signal) => runTidy(ctx, subject, options, emit, signal).finally(() => {
      if (state.running.get(key) === job.id) state.running.delete(key);
    }),
    { maxRunning: 4, busyMessage: "AI 正在整理其他項目，請稍後再試。" },
  );
  state.running.set(key, job.id);
  return { jobId: job.id, kind, id };
}

async function runTidy(ctx: ModuleContext, subject: TidySubject, options: StartTidyOptions, emit: (event: JobEvent) => void, signal: AbortSignal): Promise<CaptureTidyResult> {
  const started = Date.now();
  const { kind, id } = subject;
  const timeZone = ctx.config.timeZone;
  const done = (result: Omit<CaptureTidyResult, "kind" | "id">): CaptureTidyResult => {
    logEvent("capture.tidied", { kind, applied: result.applied, reason: result.reason ?? null, auto: options.auto, ms: Date.now() - started });
    return { kind, id, ...result };
  };
  // An event's Google insert waits for the tidy, then gets a fresh undo window (finally).
  const calendar = kind === "event" ? calendarService(ctx) : undefined;
  const postponed = calendar?.reschedule(id, TIDY_HOLD_MS) ?? false;
  try {
    // Relative words (週日前) are read on the day the text was written.
    const createdAt = Date.parse(subject.createdAt);
    const written = Number.isNaN(createdAt) ? ctx.now() : new Date(createdAt);
    const rule = parseCapture(subject.text, { now: written, timeZone });
    const writtenDay = dayKey(timeZone, written);
    const { value } = await withGenerationProgress("整理快速記下", "tidy", emit, signal, (onProgress) => ctx.ai.runStructured({
      role: "快速記下整理",
      schema: tidyAnswerSchema,
      prompt: tidyPrompt(kind),
      data: {
        kind,
        text: subject.text,
        today: writtenDay,
        weekday: `週${weekdayChar(writtenDay)}`,
        timeZone,
        current: { title: subject.title, notes: subject.notes ?? null, dueDay: subject.day ?? null, dueTime: subject.time ?? null, location: subject.location ?? null },
        rule: { title: rule.title, day: rule.day ?? null, time: rule.time ?? null },
      },
      signal,
      timeoutMs: options.timeoutMs ?? CAPTURE_TIDY_TIMEOUT_MS,
      // Behind an AI 解析 the user is watching, ahead of mail triage (AgentSlots).
      priority: "soon",
      onProgress,
    }));
    signal.throwIfAborted();
    const current = readSubject(ctx, kind, id);
    if (!current) return done({ applied: false, reason: "gone" });
    if (current.fingerprint !== subject.fingerprint) return done({ applied: false, reason: "edited" });
    if (current.inGoogle) return done({ applied: false, reason: "google" });
    const verdict = judgeTidy(value, current, rule);
    if (!verdict.ok) {
      if (verdict.reason === "rejected") logEvent("capture.tidy_rejected", { kind, check: verdict.detail });
      return done({ applied: false, reason: verdict.reason });
    }
    const token = applyTidy(ctx, current, verdict, subject.text);
    return done({ applied: true, title: verdict.title, undoToken: token, message: tidyMessage(verdict.title, current.day, current.time, ctx.now(), timeZone) });
  } catch (error) {
    logEvent("capture.tidied", { kind, applied: false, reason: signal.aborted ? "cancelled" : "failed", auto: options.auto, ms: Date.now() - started });
    if (error instanceof AppError && error.status === 504) throw new AppError(504, "整理逾時");
    throw error;
  } finally {
    if (postponed) calendar!.reschedule(id);
  }
}

/**
 * Writes the tidied fields, keeps what they replaced on the record
 * (`pretidy`, for 復原 and 復原整理) and returns the toast's undo token.
 */
function applyTidy(ctx: ModuleContext, subject: TidySubject, verdict: Extract<TidyVerdict, { ok: true }>, text: string): string {
  const now = ctx.now().toISOString();
  let after: TidyFields;
  if (subject.kind === "todo") {
    const store = todoStore(ctx);
    const todo = store.require(subject.id);
    const { location: _none, ...pretidy } = fieldsOf(todo);
    const next: Todo = {
      ...todo,
      title: verdict.title.slice(0, TODO_LIMITS.title),
      ...(verdict.notes ? { notes: verdict.notes } : {}),
      originalText: todo.originalText ?? text.slice(0, TODO_LIMITS.originalText),
      tidiedAt: now,
      pretidy,
      updatedAt: now,
    };
    after = fieldsOf(store.table.put(next));
  } else {
    const service = calendarService(ctx);
    const event = service.events.get(subject.id, { strict: true });
    if (!event) throw new AppError(404, "找不到這個行程，可能已經刪除了。");
    const next: ManualEvent = {
      ...event,
      title: verdict.title.slice(0, MANUAL_EVENT_LIMITS.title),
      ...(verdict.notes ? { notes: verdict.notes } : {}),
      ...(verdict.location ? { location: verdict.location } : {}),
      originalText: event.originalText ?? text.slice(0, MANUAL_EVENT_LIMITS.originalText),
      tidiedAt: now,
      pretidy: fieldsOf(event),
      updatedAt: now,
    };
    after = fieldsOf(service.events.put(next));
  }
  const state = stateOf(ctx);
  state.prune(Date.now());
  const token = randomUUID();
  state.undo.set(token, { kind: subject.kind, id: subject.id, after, expires: Date.now() + UNDO_TTL_MS });
  return token;
}

/**
 * Puts the title, notes and place from before the tidy back (the rest of the
 * record, such as 重要 or 完成 set since, stays) and forgets the tidy.
 */
function restorePretidy(ctx: ModuleContext, subject: TidySubject): CaptureTidyUndoResponse {
  const pretidy = subject.pretidy!;
  const updatedAt = ctx.now().toISOString();
  const notes = pretidy.notes ? { notes: pretidy.notes } : {};
  if (subject.kind === "todo") {
    const store = todoStore(ctx);
    const { notes: _notes, tidiedAt: _tidiedAt, pretidy: _pretidy, ...rest } = store.require(subject.id);
    store.table.put({ ...rest, title: pretidy.title, ...notes, updatedAt });
  } else {
    const service = calendarService(ctx);
    const event = service.events.get(subject.id, { strict: true });
    if (!event) throw new AppError(404, "找不到這個行程，可能已經刪除了。");
    const { notes: _notes, location: _location, tidiedAt: _tidiedAt, pretidy: _pretidy, ...rest } = event;
    service.events.put({ ...rest, title: pretidy.title, ...notes, ...(pretidy.location ? { location: pretidy.location } : {}), updatedAt });
    // A Google insert still waiting gets a fresh window, so it carries the restored fields.
    service.reschedule(subject.id);
  }
  return { restored: true, kind: subject.kind, id: subject.id, title: pretidy.title };
}

/**
 * POST /api/capture/tidy/undo (the toast's 復原): puts back the fields from
 * before the tidy. 404 once used, expired (an hour, or a restart) or the
 * record is gone; 409 when the title, notes or place changed after the tidy
 * or the event reached Google Calendar.
 */
export function undoTidy(ctx: ModuleContext, token: string): CaptureTidyUndoResponse {
  const state = stateOf(ctx);
  state.prune(Date.now());
  const entry = state.undo.get(token);
  if (!entry) throw new AppError(404, "這次整理已經無法復原了。");
  const current = readSubject(ctx, entry.kind, entry.id);
  if (!current) {
    state.undo.delete(token);
    throw new AppError(404, "找不到這筆紀錄，可能已經刪除了。");
  }
  if (!current.pretidy || !sameFields(fieldsOf(current), entry.after)) throw new AppError(409, "整理之後這筆又改過了，所以沒有復原整理。");
  if (current.inGoogle) throw new AppError(409, "這個行程已經送到 Google 行事曆，請到 Google 行事曆修改。");
  state.undo.delete(token);
  cancelTidy(ctx, entry.kind, entry.id);
  const restored = restorePretidy(ctx, current);
  logEvent("capture.tidy_undone", { kind: entry.kind, via: "toast" });
  return restored;
}

/**
 * POST /api/capture/tidy/revert (復原整理 on the record, any time later):
 * the same as 復原, from the fields kept on the record. 409 when there is
 * nothing to put back (never tidied, or the user edited the title or notes
 * since) or the event is in Google Calendar.
 */
export function revertTidy(ctx: ModuleContext, kind: TidyTarget, id: string): CaptureTidyUndoResponse {
  const current = readSubject(ctx, kind, id);
  if (!current) throw new AppError(404, kind === "todo" ? "找不到這項待辦，可能已經刪除了。" : "找不到這個行程，可能已經刪除了。");
  if (!current.pretidy) throw new AppError(409, "這一項沒有可以復原的整理。");
  if (current.inGoogle) throw new AppError(409, "這個行程已經送到 Google 行事曆，請到 Google 行事曆修改。");
  cancelTidy(ctx, kind, id);
  const restored = restorePretidy(ctx, current);
  logEvent("capture.tidy_undone", { kind, via: "record" });
  return restored;
}
