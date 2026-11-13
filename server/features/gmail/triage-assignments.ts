import { z } from "zod";
import { assignmentKey, detectAssignment, sameNativeAssignment } from "../../../shared/assignment-detect.js";
import { MAIL_TRIAGE_VERSION, type MailMessage, type MailTriage } from "../../../shared/mail.js";
import type { ModelExecution } from "../../../shared/models.js";
import type { AssignmentSuggestion } from "../../../shared/suggestions.js";
import { zonedTimeToUtc } from "../../../shared/time.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { secretInPatch } from "../../secrets/redact.js";
import { assignmentSuggestionSchema } from "../../today/suggestion-payloads.js";
import { detectContext, mailInput, nativeDraft } from "../lms/from-mail.js";
import { cachedAssignments } from "../lms/lms.js";
import { lmsHasAssignment, localAssignments } from "../lms/native.js";
import type { MailStore } from "./store.js";

/**
 * Assignments found in mail (SPEC-mail-assignments §5.3, §5.4). ASSIGNMENTS
 * team owns this file and its tests; the mail team's triage.ts only spreads
 * the schema, appends the prompt line and calls the two hooks, so neither team
 * edits the other's code.
 *
 *  - `assignmentAnswerShape`: the strict `assignments` array of the triage answer.
 *  - `assignmentPromptLine(offset)`: the zh-TW instruction appended to the triage prompt.
 *  - `assignmentSuggestionsFromTriage()`: the model's items → pending `assignment`
 *    suggestions (dedupe `mail-assignment:<messageId>`); returns the message ids
 *    that got one, which then get no todo suggestion.
 *  - `ruleAssignmentSuggestions()`: after each sync, the same suggestions from
 *    shared/assignment-detect.ts for mail the model will not read (AI or triage
 *    off, triage failed, backlog outside the triage window).
 *
 * Never import ./triage.js here: triage.ts spreads this file's schema while
 * it loads, so the cycle would read it before it exists. The triage helpers
 * this file needs come in `TriageAssignmentInput`.
 */

/** At most this many assignment items per triage batch (the batch size). */
export const ASSIGNMENT_ITEMS_MAX = 15;

const nullableText = (max: number) => z.string().max(max).nullable();

/** The longest link kept on a suggestion; a longer one is dropped (the record links its mail instead). */
export const ASSIGNMENT_URL_MAX = 500;

/** One `assignments` item as the model is told (SPEC-mail-assignments §5.3): every field required, null when unknown. */
const modelAssignmentSchema = z.object({
  sourceId: z.string().max(100),
  title: z.string().max(200),
  course: nullableText(80),
  due: nullableText(40),
  submit: nullableText(120),
  url: nullableText(ASSIGNMENT_URL_MAX),
}).strict();

/**
 * One item as the answer is checked: the model cannot shorten a link it
 * copies (a Safe Links wrapper, a prefilled form), and Codex is not held to
 * maxLength, so `submit` and `url` take any length here and the payload drops
 * what is too long. One field must never fail the whole batch of 15 mails.
 */
export const triageAssignmentSchema = modelAssignmentSchema.extend({
  submit: nullableText(4000),
  url: nullableText(4000),
}).strict();
export type TriageAssignment = z.infer<typeof triageAssignmentSchema>;

/** Spread into triageAnswerSchema's object: `{ ...items, todos, events, ...assignmentAnswerShape }`. */
export const assignmentAnswerShape = {
  assignments: z.array(triageAssignmentSchema).max(ASSIGNMENT_ITEMS_MAX),
};

/** The same array as the JSON schema the model is given (triage.ts triageModelSchema). */
export const assignmentModelShape = {
  assignments: z.array(modelAssignmentSchema).max(ASSIGNMENT_ITEMS_MAX),
};


/** The triage prompt's line about assignments; `offset` is the user's zone as the model writes it (「+08:00」). */
export function assignmentPromptLine(offset: string): string {
  return `assignments：老師、助教或課程寄來、要你在期限前繳交的作業、報告或實驗（不包含學校系統自動寄出的通知、考試公告、電子報）；title 用作業名稱（例如「HW5：系統呼叫實作」），course 為課程名稱，due 為 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM${offset}，submit 為繳交方式（例如「上傳到 E3」），url 為信中寫的繳交或說明網址（只填 https 開頭的網址），不知道的欄位填 null。列在 assignments 的信，不要再列進 todos。`;
}

export interface TriageAssignmentInput {
  /** The batch's messages still cached, by id. */
  byId: ReadonlyMap<string, MailMessage>;
  /** The triage just stored, by message id. */
  triaged: ReadonlyMap<string, MailTriage>;
  items: TriageAssignment[];
  execution?: ModelExecution;
  /** triage.ts parseDay: a model date or date-time → the local day (and time), offset-free text in BELLPERSONAL_TZ. */
  parseDue: (value: string | null) => { day: string; time?: string } | undefined;
  /** triage.ts suggestionOrigin: 「林志明 教授 信件」 for the row's 「來自 …」. */
  originOf: (message: MailMessage) => string;
}

const DAY = 86_400_000;
/** A deadline more than this long past drops the item (§5.3). */
const PAST_GRACE_MS = DAY;
/** The rules read inbox mail received within this window (older announcements are history). */
export const RULE_WINDOW_DAYS = 14;
/** Mail waiting for the model longer than this (a signed-out CLI, a long backlog) gets the rules meanwhile. */
export const RULE_PENDING_WAIT_MS = 30 * 60_000;

/** The dedupe key of the one assignment suggestion a message may get. */
export const assignmentDedupeKey = (messageId: string) => `mail-assignment:${messageId}`;

/** 「林志明 教授 信件」 for 「來自 …」 (triage.ts suggestionOrigin's wording for ordinary mail; that file cannot be imported here). */
const originOf = (message: MailMessage) => `${message.from.name ?? message.from.email.split("@")[0]} 信件`.slice(0, 80);

/**
 * One model item → the suggestion payload, or undefined when it is unusable:
 * an empty title, a deadline more than a day past, a malformed field. Dates
 * without an offset are wall-clock time in BELLPERSONAL_TZ (parseDue); a date
 * alone is due at 23:59 that day. Links are kept only when https and free of
 * secret shapes.
 */
export function triageAssignmentPayload(item: TriageAssignment, input: Pick<TriageAssignmentInput, "parseDue">, options: { timeZone: string; now: Date; context?: string }): AssignmentSuggestion | undefined {
  const title = item.title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!title) return undefined;
  let dueAt: string | null = null;
  let dueDay: string | undefined;
  const due = input.parseDue(item.due);
  if (due) {
    const [hour, minute] = due.time ? due.time.split(":").map(Number) : [23, 59];
    try { dueAt = zonedTimeToUtc(options.timeZone, due.day, hour, minute).toISOString(); } catch { dueAt = null; }
    if (dueAt && !due.time) dueDay = due.day;
    if (dueAt && Date.parse(dueAt) < options.now.getTime() - PAST_GRACE_MS) return undefined;
  }
  const course = (item.course?.replace(/\s+/g, " ").trim() || options.context?.trim())?.slice(0, 80);
  const submitHint = item.submit?.replace(/\s+/g, " ").trim().slice(0, 120);
  const url = safeLink(item.url);
  const parsed = assignmentSuggestionSchema.safeParse({
    title, dueAt, ...(dueDay ? { dueDay } : {}), ...(course ? { courseName: course } : {}),
    ...(submitHint ? { submitHint } : {}), ...(url ? { url } : {}), detectedBy: "ai",
  });
  return parsed.success ? parsed.data : undefined;
}

/** An https link without credentials or secret shapes, at most ASSIGNMENT_URL_MAX long; anything else is dropped. */
function safeLink(value: string | null): string | undefined {
  const text = value?.trim();
  if (!text || text.length > ASSIGNMENT_URL_MAX || secretInPatch(text)) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The model's assignment items → pending suggestions (§5.3): one per message
 * (dedupe `mail-assignment:<id>`), only for messages of the batch still
 * cached. Returns the ids of the messages the model called assignments
 * (triage.ts then skips their todo), including those that need no suggestion
 * because they already became an assignment or an LMS already lists them.
 */
export function assignmentSuggestionsFromTriage(ctx: ModuleContext, input: TriageAssignmentInput): Set<string> {
  const made = new Set<string>();
  if (!input.items.length) return made;
  const now = ctx.now();
  const converted = localAssignments(ctx).messageIds();
  const lms = cachedAssignments(ctx);
  const known = knownAssignments(ctx, (id) => input.byId.get(id)?.threadId ?? ctx.sourceItems.get<MailMessage>("gmail", id)?.value.threadId);
  for (const item of input.items) {
    const message = input.byId.get(item.sourceId);
    if (!message || made.has(message.id)) continue;
    const triaged = triageAssignmentPayload(item, input, { timeZone: ctx.config.timeZone, now, context: input.triaged.get(message.id)?.context });
    if (!triaged) continue;
    made.add(message.id);
    // The link must be one the mail itself carries: the model's answer for one mail could come from another in the batch.
    const { url: _url, ...rest } = triaged;
    const payload: AssignmentSuggestion = triaged.url && linkInMail(triaged.url, message) ? triaged : rest;
    if (converted.has(message.id) || lmsHasAssignment(lms, payload) || known.has(message, payload)) continue;
    known.add(message, payload);
    ctx.suggestions.create<AssignmentSuggestion>({
      kind: "assignment", title: payload.title, payload,
      sourceRef: { source: "gmail", externalId: message.id, url: message.webUrl },
      dedupeKey: assignmentDedupeKey(message.id), origin: input.originOf(message),
      ...(input.execution ? { modelExecution: input.execution } : {}),
    });
  }
  if (made.size) logEvent("gmail.assignments_suggested", { messages: made.size, source: "ai" });
  return made;
}

/**
 * After each Gmail sync: rule-made `assignment` suggestions (payload
 * `detectedBy: "rule"`) for inbox mail the model will not read (§5.2): AI or
 * triage off, a message whose triage failed, the backlog outside the triage
 * window. Mail the model read (triage source "ai") or will read (pending,
 * with AI on) is left to it. Idempotent (one dedupe key per message, and
 * messages that already have a suggestion are skipped before any parsing)
 * and cheap: only inbox mail of the last RULE_WINDOW_DAYS days is read.
 */
export function ruleAssignmentSuggestions(ctx: ModuleContext, store: MailStore): number {
  const now = ctx.now();
  const aiOn = ctx.settings.value("ai.enabled") && ctx.settings.value("ai.mailTriage");
  const since = new Date(now.getTime() - RULE_WINDOW_DAYS * DAY).toISOString();
  // Pending mail is the model's, unless it has waited so long that the CLI is evidently not getting to it.
  const waitedOut = new Date(now.getTime() - RULE_PENDING_WAIT_MS).toISOString();
  const modelWillRead = (message: MailMessage) => aiOn && message.triageQueue?.state === "pending" && message.triageQueue.updatedAt > waitedOut;
  // The model was asked about assignments only from MAIL_TRIAGE_VERSION on: older AI triage is no answer.
  const modelRead = (message: MailMessage) => message.triage?.source === "ai" && (message.triage.version ?? 1) >= MAIL_TRIAGE_VERSION;
  const candidates = store.inbox().filter((message) => message.receivedAt >= since && !message.labels.includes("SENT")
    && !modelRead(message) && !modelWillRead(message));
  if (!candidates.length) return 0;
  const seen = new Set<string>();
  for (const suggestion of ctx.suggestions.list({ kind: "assignment", limit: 2000 }))
    if (suggestion.sourceRef?.source === "gmail") seen.add(suggestion.sourceRef.externalId);
  const converted = localAssignments(ctx).messageIds();
  const fresh = candidates.filter((message) => !seen.has(message.id) && !converted.has(message.id));
  if (!fresh.length) return 0;
  const context = detectContext(ctx);
  const lms = cachedAssignments(ctx);
  const known = knownAssignments(ctx, (id) => store.get(id)?.threadId);
  let created = 0;
  // Oldest first: the announcement is offered, its reminders and replies are not offered again.
  for (const message of [...fresh].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    const draft = detectAssignment(mailInput(message), context);
    if (!draft || (draft.dueAt && Date.parse(draft.dueAt) < now.getTime() - PAST_GRACE_MS) || lmsHasAssignment(lms, draft)) continue;
    if (known.has(message, draft)) continue;
    known.add(message, draft);
    ctx.suggestions.create<AssignmentSuggestion>({
      kind: "assignment", title: draft.title, payload: draft,
      sourceRef: { source: "gmail", externalId: message.id, url: message.webUrl },
      dedupeKey: assignmentDedupeKey(message.id), origin: originOf(message),
    });
    created++;
  }
  if (created) logEvent("gmail.assignments_suggested", { messages: created, source: "rule" });
  return created;
}

/**
 * The assignments the owner already has or was already offered (native
 * records, and assignment suggestions pending, accepted or dismissed), with
 * the conversations they came from: a reminder, the TA's follow-up or a
 * reply in the same conversation is the same assignment, not a new one
 * (same code in that conversation, or sameNativeAssignment anywhere).
 */
function knownAssignments(ctx: ModuleContext, threadOf: (messageId: string) => string | undefined) {
  const drafts: Array<{ title: string; courseName?: string; dueAt: string | null }> = [];
  const threads = new Map<string, Set<string>>();
  const remember = (threadId: string | undefined, draft: { title: string; courseName?: string; dueAt: string | null }) => {
    drafts.push(draft);
    if (threadId) threads.set(threadId, (threads.get(threadId) ?? new Set()).add(assignmentKey(draft.title)));
  };
  for (const assignment of localAssignments(ctx).list()) remember(assignment.mailRef?.threadId, nativeDraft(assignment));
  for (const suggestion of ctx.suggestions.list({ kind: "assignment", limit: 2000 })) {
    const payload = assignmentSuggestionSchema.safeParse(suggestion.payload);
    if (!payload.success) continue;
    remember(suggestion.sourceRef?.source === "gmail" ? threadOf(suggestion.sourceRef.externalId) : undefined, payload.data);
  }
  return {
    has: (message: MailMessage, draft: { title: string; courseName?: string; dueAt: string | null }) =>
      !!threads.get(message.threadId)?.has(assignmentKey(draft.title)) || drafts.some((other) => sameNativeAssignment(draft, other)),
    add: (message: MailMessage, draft: { title: string; courseName?: string; dueAt: string | null }) => remember(message.threadId, draft),
  };
}

const LINK_PATTERN = /https?:\/\/[^\s<>"'，。、）)」]+/gi;
const normalLink = (value: string) => {
  try { return new URL(value.replace(/[.,;:!?]+$/, "")).toString(); } catch { return undefined; }
};

/** Whether the mail's own text (excerpt or snippet) carries this link, compared as normalised URLs. */
export function linkInMail(url: string, message: Pick<MailMessage, "excerpt" | "snippet">): boolean {
  const wanted = normalLink(url);
  if (!wanted) return false;
  for (const match of `${message.excerpt ?? ""}\n${message.snippet}`.matchAll(LINK_PATTERN)) if (normalLink(match[0]) === wanted) return true;
  return false;
}
