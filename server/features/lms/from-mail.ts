import { UNSORTED_COURSE, type Assignment, type AssignmentMailRef } from "../../../shared/assignments.js";
import { assignmentKey, extractAssignment, sameNativeAssignment, type AssignmentDetectContext, type AssignmentMailInput } from "../../../shared/assignment-detect.js";
import type { MailMessage } from "../../../shared/mail.js";
import type { AiSuggestion, AssignmentSuggestion } from "../../../shared/suggestions.js";
import type { ActionCreated } from "../../../shared/today.js";
import { AppError } from "../../errors.js";
import type { ActionHandler, ActionPlan, ModuleContext, SuggestionAcceptor } from "../../modules.js";
import { defaultLabel } from "../../today/actions.js";
import { assignmentSuggestionSchema } from "../../today/suggestion-payloads.js";
import { findMailMessage } from "../gmail/lookup.js";
import { isAutomated } from "../gmail/rules.js";
import { assignmentFingerprint } from "./lms.js";
import { knownCourses, localAssignments, type LocalAssignmentStore, type NewNativeAssignment } from "./native.js";

/**
 * Assignments from mail (SPEC-mail-assignments §5.5, §5.6) and the actions on
 * native rows:
 *
 *  - anySourceActions.assignment — 轉成作業 on `gmail:<messageId>`: the user's
 *    tap is the confirmation, so the record is created at once from the rule
 *    extraction (or from a pending suggestion for that mail, which is then
 *    accepted); one assignment per mail (409); undo deletes it.
 *  - suggestionActions.assignment / acceptSuggestion.assignment — 加入作業 on
 *    an `assignment` suggestion; undo deletes it and the core reopens it.
 *  - actions.assignment — 開啟, 標為已交, 延後 and 略過 on `assignment:<uuid>`
 *    rows are the core's; this describes rows Today did not serve (#/work).
 */

/** What the rules read from a cached or live message. */
export function mailInput(message: MailMessage): AssignmentMailInput {
  return {
    subject: message.subject,
    from: message.from,
    text: message.excerpt ?? message.snippet,
    receivedAt: message.receivedAt,
    automated: isAutomated(message),
    labels: message.labels,
    ...(message.triage?.context ? { context: message.triage.context } : {}),
    ...(message.triage?.category ? { category: message.triage.category } : {}),
  };
}

/** The rules' context: the school domains setting, the zone and the courses the owner already has. */
export function detectContext(ctx: ModuleContext): AssignmentDetectContext {
  return { schoolDomains: ctx.settings.value("mail.schoolDomains"), timeZone: ctx.config.timeZone, courses: knownCourses(ctx) };
}

/** The mail's ids and Gmail link (never its text). */
export function mailRefOf(message: Pick<MailMessage, "id" | "threadId" | "webUrl">): AssignmentMailRef {
  return { messageId: message.id, threadId: message.threadId, url: message.webUrl };
}

/** A suggestion's payload as a new mail assignment. */
export function fromSuggestion(payload: AssignmentSuggestion, mailRef: AssignmentMailRef | undefined): NewNativeAssignment {
  return {
    origin: "mail",
    title: payload.title,
    ...(payload.courseName ? { courseName: payload.courseName } : {}),
    dueAt: payload.dueAt,
    ...(payload.dueAt && payload.dueDay ? { dueDateOnly: true } : {}),
    ...(payload.submitHint ? { submitHint: payload.submitHint } : {}),
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.notes ? { notes: payload.notes } : {}),
    ...(mailRef ? { mailRef } : {}),
  };
}

function parsePayload(suggestion: AiSuggestion | undefined): AssignmentSuggestion {
  const parsed = assignmentSuggestionSchema.safeParse(suggestion?.payload);
  if (!parsed.success) throw new AppError(422, "這則建議的內容不完整，無法加入作業。");
  return parsed.data;
}

/**
 * The mail a suggestion came from, for 開啟信件: its thread from the cache or
 * a live read; when Gmail no longer has it, the message id (its own thread
 * id for a first message) and the suggestion's Gmail link.
 */
async function suggestionMailRef(ctx: ModuleContext, suggestion: AiSuggestion): Promise<AssignmentMailRef | undefined> {
  const ref = suggestion.sourceRef;
  if (ref?.source !== "gmail") return undefined;
  const message = await findMailMessage(ctx, ref.externalId).catch(() => undefined);
  if (message) return mailRefOf(message);
  return { messageId: ref.externalId, threadId: ref.externalId, url: ref.url ?? "" };
}

/** What the toast says about the record an action made or found (ActionAccepted.created). */
export function createdOf(assignment: Assignment): ActionCreated {
  return { title: assignment.title, dueAt: assignment.dueAt, ...(assignment.dueDateOnly ? { dueDateOnly: true } : {}) };
}

/**
 * Creates the record once and remembers whether this action made it, so undo
 * removes only its own. An assignment already made from the same mail is
 * reused (a retried accept never makes two), and so is the one the owner
 * already has for this assignment: another mail of the same conversation
 * (the TA's follow-up) or a reminder of it (findTwin).
 */
function createOnce(store: LocalAssignmentStore, input: NewNativeAssignment): Pick<ActionPlan, "apply" | "undo"> & { record: () => Assignment | undefined } {
  let created: Assignment | undefined;
  let reused: Assignment | undefined;
  return {
    apply: () => {
      reused = (input.mailRef ? store.byMessage(input.mailRef.messageId) : undefined) ?? findTwin(store.list(), input);
      if (reused) return { resultId: reused.id, created: createdOf(reused) };
      created = store.create(input);
      return { resultId: created.id, created: createdOf(created) };
    },
    undo: () => {
      if (created) store.discard(created.id);
      created = undefined;
    },
    record: () => created ?? reused,
  };
}

/**
 * The native assignment that already stands for this one: made from another
 * mail of the same conversation with the same code or title, or the same
 * assignment by code, course and deadline (sameNativeAssignment).
 */
export function findTwin(natives: Assignment[], input: Pick<NewNativeAssignment, "title" | "courseName" | "dueAt" | "mailRef">): Assignment | undefined {
  const draft = { title: input.title, dueAt: input.dueAt, ...(input.courseName ? { courseName: input.courseName } : {}) };
  const threadId = input.mailRef?.threadId;
  return natives.find((assignment) => (threadId && assignment.mailRef?.threadId === threadId && assignmentKey(assignment.title) === assignmentKey(input.title))
    || sameNativeAssignment(draft, nativeDraft(assignment)));
}

/** A native record as the matchers read it (「未分類」 is no course). */
export const nativeDraft = (assignment: Assignment) => ({
  title: assignment.title, dueAt: assignment.dueAt, ...(assignment.courseName !== UNSORTED_COURSE ? { courseName: assignment.courseName } : {}),
});

/**
 * The pending `assignment` suggestions that 轉成作業 on this mail answers:
 * the one made from the mail itself first (its fields are the draft), then
 * the ones made from other mails of the same conversation (the announcement
 * when the user converts the TA's follow-up).
 */
function pendingSuggestionsFor(ctx: ModuleContext, messageId: string, threadId: string): AiSuggestion[] {
  const pending = ctx.suggestions.list({ status: "pending", kind: "assignment", limit: 500 })
    .filter((suggestion) => suggestion.sourceRef?.source === "gmail");
  const own = pending.filter((suggestion) => suggestion.sourceRef!.externalId === messageId);
  const thread = pending.filter((suggestion) => suggestion.sourceRef!.externalId !== messageId
    && ctx.sourceItems.get<MailMessage>("gmail", suggestion.sourceRef!.externalId)?.value.threadId === threadId);
  return [...own, ...thread];
}

/**
 * What 轉成作業 needs from the mail, read once: its ids and link, the draft
 * (a pending suggestion's fields, else the rules) and the suggestions it
 * answers. Only these leave this function, never the message: the plan lives
 * in memory for a day, and a mail read live may be held for 5 minutes only
 * (/privacy).
 */
function convertDraft(ctx: ModuleContext, message: MailMessage): { messageId: string; input: NewNativeAssignment; answers: AiSuggestion[] } {
  const related = pendingSuggestionsFor(ctx, message.id, message.threadId);
  const parsed = related.length ? assignmentSuggestionSchema.safeParse(related[0].payload) : undefined;
  const draft = parsed?.success ? parsed.data : extractAssignment(mailInput(message), detectContext(ctx));
  const answers = related.filter((suggestion, index) => {
    if (index === 0 || suggestion.sourceRef!.externalId === message.id) return true;
    const payload = assignmentSuggestionSchema.safeParse(suggestion.payload);
    return payload.success && assignmentKey(payload.data.title) === assignmentKey(draft.title);
  });
  return { messageId: message.id, input: fromSuggestion(draft, mailRefOf(message)), answers };
}

/** Bulk mail targets (the digest, an inbox category) are not one mail. */
const BULK_TARGET = /^(?:digest|category)(?::|$)/;

/** anySourceActions.assignment: 轉成作業 on a mail row, the inbox list (A) or the reader. */
export function convertMailHandler(): ActionHandler {
  return async (request, ctx) => {
    if (request.source !== "gmail" || BULK_TARGET.test(request.sourceId)) throw new AppError(400, "這個項目不能轉成作業。");
    const store = localAssignments(ctx);
    if (store.byMessage(request.sourceId)) throw new AppError(409, "這封信已經轉成作業了。");
    const found = await findMailMessage(ctx, request.sourceId);
    if (!found) throw new AppError(404, "找不到這封信，沒有建立作業。");
    // A suggestion already read this mail (the model, or the rules): its fields are the better draft.
    const { messageId, input, answers } = convertDraft(ctx, found);
    let decided: string[] = [];
    const once = createOnce(store, input);
    return {
      label: "已轉成作業",
      // A conversation Today did not serve (#/inbox): the handled list names the assignment, never the mail text.
      target: { kind: "mail.action", title: input.title },
      apply: () => {
        if (store.byMessage(messageId)) throw new AppError(409, "這封信已經轉成作業了。");
        const result = once.apply!() as { resultId: string };
        for (const suggestion of answers) {
          try { ctx.suggestions.decide(suggestion.id, "accepted", result.resultId); decided.push(suggestion.id); } catch { /* decided meanwhile: nothing to take over */ }
        }
        return result;
      },
      undo: () => {
        once.undo!();
        for (const id of decided) ctx.suggestions.reopen(id);
        decided = [];
      },
    };
  };
}

/** suggestionActions.assignment: 加入作業 on an `ai:` suggestion.assignment row (Today, the reader, #/work). */
export function suggestionAssignmentHandler(): ActionHandler {
  return async (request, ctx) => {
    if (request.action !== "assignment") throw new AppError(400, "這則建議不能這樣處理。");
    const suggestion = request.suggestion!;
    const payload = parsePayload(suggestion);
    const once = createOnce(localAssignments(ctx), fromSuggestion(payload, await suggestionMailRef(ctx, suggestion)));
    return { label: "已加入作業", apply: once.apply, undo: once.undo };
  };
}

/** acceptSuggestion.assignment: POST /api/suggestions/:id/accept. */
export function acceptAssignmentSuggestion(): SuggestionAcceptor {
  return async (suggestion, ctx) => {
    const payload = parsePayload(suggestion);
    const once = createOnce(localAssignments(ctx), fromSuggestion(payload, await suggestionMailRef(ctx, suggestion)));
    const { resultId } = once.apply!() as { resultId: string };
    return { resultId, result: once.record(), undo: once.undo };
  };
}

/** Actions a native assignment row offers; anything else is refused before the core records it. */
const NATIVE_ACTIONS = new Set(["open", "submitted", "snooze", "dismiss"]);

/**
 * actions.assignment: the core writes 開啟, 標為已交 (until-change, the
 * `dueAt|submission` fingerprint, so editing the deadline brings the row
 * back), 延後 and 略過. For a row Today did not serve (#/work, due in 10
 * days) this describes it so the core keeps that fingerprint.
 */
export function nativeActionHandler(): ActionHandler {
  return (request, ctx) => {
    if (!NATIVE_ACTIONS.has(request.action)) throw new AppError(400, "作業不能這樣處理。");
    const label = defaultLabel(request.action);
    if (request.item) return { label };
    const assignment = localAssignments(ctx).get(request.sourceId);
    if (!assignment) throw new AppError(404, "找不到這份作業。");
    const title = assignment.courseName === UNSORTED_COURSE ? assignment.title : `${assignment.courseName} ${assignment.title}`;
    return { label, target: { kind: "assignment", title: title.slice(0, 280), fingerprint: assignmentFingerprint(assignment) } };
  };
}
