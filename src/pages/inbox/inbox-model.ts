/**
 * Pure helpers behind #/inbox (tested under node:test): category groups and
 * chip counts, the cursor after a row leaves, optimistic edits layered on the
 * fetched list and toast text. 延後 uses Today's SnoozePopover.
 */
import { extractAssignment } from "../../../shared/assignment-detect";
import { INBOX_CATEGORIES, type InboxCategory, type InboxListResponse, type InboxMessage, type InboxThread, type MailLocation, type MailProcessResult, type MailView } from "../../../shared/mail";
import type { ActionId } from "../../../shared/today";
import { metaDeadline, queueAction } from "../../../shared/today-format";
import { ACTION_TOASTS } from "../../copy/common";
import { GMAIL_OFFLINE, INBOX_CATEGORY_LABELS, MAIL_PROCESS, MAIL_SEARCH } from "../../copy/inbox";

export { mailHoverActions } from "../today/today-view";

export type InboxFilter = "all" | InboxCategory;

export interface InboxGroup {
  category: InboxCategory;
  label: string;
  threads: InboxThread[];
  unread: number;
}

/** Threads grouped by category in chip order, newest first inside a group; empty groups are left out. */
export function groupThreads(threads: InboxThread[], filter: InboxFilter): InboxGroup[] {
  return INBOX_CATEGORIES
    .filter((category) => filter === "all" || filter === category)
    .map((category) => {
      const list = threads.filter((thread) => thread.category === category);
      return { category, label: INBOX_CATEGORY_LABELS[category], threads: list, unread: list.filter((thread) => thread.unread).length };
    })
    .filter((group) => group.threads.length > 0);
}

/** Row ids in display (DOM) order. */
export function displayOrder(groups: InboxGroup[]): string[] {
  return groups.flatMap((group) => group.threads.map((thread) => thread.threadId));
}

/** Where the cursor goes when `removed` leaves: the next row, or the previous one if it was last (SPEC-ux §4.3). */
export function nextAfter(order: string[], removed: string): string | undefined {
  const index = order.indexOf(removed);
  if (index < 0) return order[0];
  return order[index + 1] ?? order[index - 1];
}

/** Moves the cursor by `step` within `order`, clamped. */
export function moveCursor(order: string[], current: string | undefined, step: number): string | undefined {
  if (!order.length) return undefined;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return order[step > 0 ? 0 : order.length - 1];
  return order[Math.min(order.length - 1, Math.max(0, index + step))];
}

/** An instant edit shown before the server's next answer. */
export type InboxEdit =
  | { kind: "hide"; threadIds: string[]; snoozed?: boolean }
  | { kind: "read"; threadIds: string[] }
  | { kind: "state"; threadId: string; state: NonNullable<InboxThread["state"]> }
  | { kind: "suggestion"; itemId: string }
  /** 封存 or 移回收件匣: the row changes sides; it stays in 全部 and leaves the 收件匣 and 封存 lists. */
  | { kind: "moved"; threadIds: string[]; location: MailLocation };

/** The list with optimistic edits applied (counts follow the rows). */
/**
 * What the reading pane's conversation depends on, from the list row: the
 * pane refetches when this changes (a new message, read state, triage's
 * summary and suggestions, 回覆中…), not on every list refresh.
 */
export function threadVersion(thread: InboxThread | undefined): string | undefined {
  if (!thread) return undefined;
  return JSON.stringify([
    thread.messageId, thread.count, thread.unread, thread.receivedAt, thread.category, thread.kind ?? null, thread.inQueue,
    thread.summary ?? null, thread.summarySource, thread.state ?? null, thread.replied, thread.location ?? null,
  ]);
}

export function applyEdits(list: InboxListResponse, edits: InboxEdit[]): InboxListResponse {
  if (!edits.length) return list;
  // A conversation moved out of the inbox leaves the inbox list.
  const hidden = new Set(edits.flatMap((edit) => (edit.kind === "hide" || (edit.kind === "moved" && edit.location === "archive") ? edit.threadIds : [])));
  const read = new Set(edits.flatMap((edit) => (edit.kind === "read" ? edit.threadIds : [])));
  const states = new Map(edits.flatMap((edit) => (edit.kind === "state" ? [[edit.threadId, edit.state] as const] : [])));
  const threads = list.threads
    .filter((thread) => !hidden.has(thread.threadId))
    .map((thread) => {
      let next = thread;
      if (read.has(thread.threadId) && thread.unread) next = { ...next, unread: false, actions: next.inQueue ? next.actions : readActions(next.actions) };
      const state = states.get(thread.threadId);
      if (state) next = withState(next, state);
      return next;
    });
  const counts = Object.fromEntries(INBOX_CATEGORIES.map((category) => [category, threads.filter((thread) => thread.category === category).length])) as InboxListResponse["counts"];
  const before = new Map(list.threads.map((thread) => [thread.threadId, thread]));
  const unreadLost = list.threads.filter((thread) => thread.unread && (hidden.has(thread.threadId) || read.has(thread.threadId))).length;
  return {
    ...list,
    threads,
    counts,
    unread: Math.max(0, list.unread - unreadLost),
    snoozed: list.snoozed + edits.reduce((sum, edit) => sum + (edit.kind === "hide" && edit.snoozed ? edit.threadIds.filter((id) => before.has(id)).length : 0), 0),
  };
}

/** A row's new item state; after 轉成作業 it is converted (已轉成作業) and no longer offers it, as the server answers. */
function withState(thread: InboxThread, state: NonNullable<InboxThread["state"]>): InboxThread {
  const next: InboxThread = { ...thread, state, ...(state.kind === "handled" ? { inQueue: false } : {}) };
  if (state.kind !== "handled" || state.action !== "assignment") return next;
  return { ...next, converted: true, actions: next.actions.filter((action) => action.id !== "assignment") };
}

/** A read conversation outside the queue leads with 封存 E instead of 標為已讀 (as the server answers). */
function readActions(actions: InboxThread["actions"]): InboxThread["actions"] {
  const rest = actions.filter((action) => action.id !== "read");
  const archive = rest.find((action) => action.id === "archive");
  return archive ? [{ ...archive, key: "E" }, ...rest.filter((action) => action !== archive)] : rest;
}

/** The undo-toast text for an action on a conversation (SPEC-ux §10 Toasts, SPEC-mail-assignments §7.2). */
export function toastFor(action: ActionId, title: string, params?: { label?: string; when?: string }): string {
  switch (action) {
    case "archive": return ACTION_TOASTS.archive(title);
    case "read": return ACTION_TOASTS.read(title);
    case "todo": return ACTION_TOASTS.todo(title);
    case "snooze": return params?.label ? ACTION_TOASTS.snooze(params.label) : ACTION_TOASTS.snoozeGeneric(title);
    case "calendar": return ACTION_TOASTS.calendar(title);
    case "dismiss": return ACTION_TOASTS.dismiss(title);
    case "trash": return ACTION_TOASTS.trash(title);
    case "unarchive": return ACTION_TOASTS.unarchive(title);
    case "assignment": return ACTION_TOASTS.assignment(title, params?.when);
    default: return ACTION_TOASTS.done(title);
  }
}

/* ------------------------------------------------- 用 AI 處理 */

/** How 用 AI 處理 ended: the job's result, or why it did not run or failed. */
export type MailProcessOutcome = MailProcessResult | { error: string };

/** The reader offers 用 AI 處理 when AI can run, on cached mail only (a live or trashed conversation is not processed). */
export function offersProcess(thread: Pick<InboxThread, "live" | "trashed">, aiProcess: boolean): boolean {
  return aiProcess && !thread.live && !thread.trashed;
}

/** The toast once 用 AI 處理 ends: what it added (listed under 從這封信找到), or why nothing was added. */
export function processNotice(outcome: MailProcessOutcome): { kind: "success" | "error"; message: string } {
  if ("error" in outcome) return { kind: "error", message: MAIL_PROCESS.failed(outcome.error) };
  if (outcome.added) return { kind: "success", message: MAIL_PROCESS.added(outcome.added) };
  if (outcome.pending) return { kind: "success", message: MAIL_PROCESS.nothingNew };
  return { kind: "success", message: outcome.found ? MAIL_PROCESS.handled : MAIL_PROCESS.none };
}

/* ------------------------------------------------- search (SPEC-mail-assignments §4) */

/**
 * The literal words of a search, for the instant local filter and the
 * highlight: NFKC, lower case, split on whitespace. Gmail operators
 * (`from:x`), exclusions (`-x`) and OR / AND are left to the Gmail search.
 */
export function searchTerms(q: string): string[] {
  const terms = q.normalize("NFKC").toLowerCase().split(/\s+/)
    .map((term) => term.replace(/^["'(「]+|["')」]+$/g, ""))
    .filter((term) => term && !term.startsWith("-") && !/^[a-z_]+:/.test(term) && term !== "or" && term !== "and");
  return [...new Set(terms)];
}

const fold = (text: string) => text.normalize("NFKC").toLowerCase();

/** Every term occurs in the subject, the sender's name or address, the summary or the snippet. */
export function matchesSearch(thread: InboxThread, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const haystack = fold([thread.subject, thread.title, thread.from.name ?? "", thread.from.email, thread.summary ?? "", thread.snippet ?? "", ...thread.meta].join("\n"));
  return terms.every((term) => haystack.includes(term));
}

/** The loaded conversations that match, newest first (the 「符合「…」的信」 group). */
export function filterThreads(threads: readonly InboxThread[], terms: readonly string[]): InboxThread[] {
  if (!terms.length) return [];
  return threads.filter((thread) => matchesSearch(thread, terms))
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.threadId.localeCompare(b.threadId));
}

/** `next` without the conversations already in `shown` (or repeated within itself): appended rows never duplicate one above. */
export function withoutShown(shown: readonly InboxThread[], next: readonly InboxThread[]): InboxThread[] {
  const seen = new Set(shown.map((thread) => thread.threadId));
  const kept: InboxThread[] = [];
  for (const thread of next) {
    if (seen.has(thread.threadId)) continue;
    seen.add(thread.threadId);
    kept.push(thread);
  }
  return kept;
}

/**
 * Where the terms occur in `text`, as [start, end) offsets into `text`
 * itself (the match runs on the NFKC, lower-case form, so ＨＷ５ finds hw5),
 * merged and in order. Highlights only; operators are never marked.
 */
export function highlightRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (!text || !terms.length) return [];
  let folded = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const piece = fold(char);
    for (let unit = 0; unit < piece.length; unit++) origin.push(index);
    folded += piece;
    index += char.length;
  }
  const found: Array<[number, number]> = [];
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      const last = origin[at + term.length - 1];
      found.push([origin[at], last + String.fromCodePoint(text.codePointAt(last)!).length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/**
 * Optimistic edits on a plain list of conversations (the 封存 / 全部 pages
 * and search results). With a `view`, a conversation moved to the other side
 * leaves that view's list (移回收件匣 in 封存, 封存 in a 收件匣 search); in
 * 全部 it stays and changes sides. The edits outlive the view they were made
 * in, so a conversation moved back from 封存 still shows in 全部.
 */
export function applyThreadEdits(threads: InboxThread[], edits: readonly InboxEdit[], view?: MailView): InboxThread[] {
  if (!edits.length) return threads;
  const edited = editThreads(threads, edits);
  if (view === "archive") return edited.filter((thread) => thread.location !== "inbox");
  if (view === "inbox") return edited.filter((thread) => thread.location !== "archive");
  return edited;
}

function editThreads(threads: InboxThread[], edits: readonly InboxEdit[]): InboxThread[] {
  const hidden = new Set(edits.flatMap((edit) => (edit.kind === "hide" ? edit.threadIds : [])));
  const read = new Set(edits.flatMap((edit) => (edit.kind === "read" ? edit.threadIds : [])));
  const states = new Map(edits.flatMap((edit) => (edit.kind === "state" ? [[edit.threadId, edit.state] as const] : [])));
  const moved = new Map(edits.flatMap((edit) => (edit.kind === "moved" ? edit.threadIds.map((id) => [id, edit.location] as const) : [])));
  return threads.filter((thread) => !hidden.has(thread.threadId)).map((thread) => {
    let next = thread;
    if (read.has(thread.threadId) && thread.unread) next = { ...next, unread: false, actions: next.inQueue ? next.actions : readActions(next.actions) };
    const state = states.get(thread.threadId);
    if (state) next = withState(next, state);
    const location = moved.get(thread.threadId);
    if (location && location !== (next.location ?? "inbox")) next = movedTo(next, location);
    return next;
  });
}

/** A row on the other side of the inbox: 封存 E becomes 移回收件匣 E, or back. */
function movedTo(thread: InboxThread, location: MailLocation): InboxThread {
  const from = location === "archive" ? "archive" : "unarchive";
  const to = queueAction(location === "archive" ? "unarchive" : "archive");
  // The new close action takes E; nothing else keeps it.
  const actions = thread.actions.map((action) => {
    if (action.id === from) return to;
    if (action.key !== "E") return action;
    const { key: _key, ...rest } = action;
    return rest;
  });
  return { ...thread, location, inQueue: false, actions };
}

/**
 * The toast 轉成作業 shows before the server answers: the same rule
 * extraction the server runs (shared/assignment-detect.ts) on the best text
 * the page has (the reader's excerpt, else the snippet and summary).
 */
export function assignmentToast(thread: InboxThread, options: { text?: string; now: Date; timeZone: string }): string {
  const draft = extractAssignment({
    subject: thread.subject, from: thread.from, receivedAt: thread.receivedAt,
    text: options.text ?? [thread.snippet, thread.summary].filter(Boolean).join("\n"),
  }, { schoolDomains: [], timeZone: options.timeZone });
  const when = draft.dueAt ? metaDeadline(draft.dueAt, options.now, options.timeZone, { dateOnly: !!draft.dueDay }) : undefined;
  return ACTION_TOASTS.assignment(draft.title, when);
}

/** The polite live-region sentence after a search (SPEC-mail-assignments §4.2 item 8). */
export function searchAnnouncement(found: number): string {
  return found ? MAIL_SEARCH.found(found) : MAIL_SEARCH.notFound;
}


/* ------------------------------------------------- focus and keys (SPEC-mail-assignments §2.3, §4.2, §9) */

/**
 * A one-shot request to put focus on a row's title after a list action or
 * key: every request is new (`n`), even for the row that already has the
 * cursor (↓ from the search field onto the first result, 刪除 on the row
 * above the cursor), and it is used by the render it causes and never again,
 * so a later render (typing in the search field) never moves focus.
 */
export interface FocusRequest {
  n: number;
  target: string | undefined;
}

export const NO_FOCUS_REQUEST: FocusRequest = { n: 0, target: undefined };

export function requestFocus(previous: FocusRequest, target: string | undefined): FocusRequest {
  return { n: previous.n + 1, target };
}

export interface Focusable {
  focus(options?: FocusOptions): void;
}

/**
 * What a request focuses: the target row's title; with no such row (the
 * list emptied), the page's <main> when focus would otherwise sit on
 * <body>; nothing when focus is somewhere the user put it (the search field).
 */
export function focusFor(request: FocusRequest, titles: ReadonlyMap<string, Focusable>, focusLost: boolean): Focusable | "main" | undefined {
  if (!request.n) return undefined;
  const title = request.target ? titles.get(request.target) : undefined;
  if (title) return title;
  return focusLost ? "main" : undefined;
}

/**
 * ↵ on a row title: in 封存, 全部 and search results it opens the
 * conversation (§4.2 item 7: their first action is 移回收件匣 or 封存, which
 * would move the mail instead of reading it); in the plain 收件匣 list it is
 * the row's primary action, as on Today.
 */
export function enterOpens(view: MailView, searching: boolean): boolean {
  return searching || view !== "inbox";
}

/** Whether a conversation stays on screen after `action` (its hover buttons change, so focus goes back to its title). */
export function rowStays(action: ActionId, view: MailView): boolean {
  if (action === "archive" || action === "unarchive") return view === "all";
  return action === "read" || action === "todo" || action === "assignment" || action === "reply";
}

/** Actions that change the conversation in Gmail: the server refuses them (503) while Gmail is not connected. */
export const GMAIL_WRITES: ReadonlySet<ActionId> = new Set<ActionId>(["archive", "read", "trash", "unarchive"]);

/** Whether `action` cannot run because Gmail is not connected (it would only come back refused). */
export function gmailBlocked(action: ActionId, connected: boolean): boolean {
  return !connected && GMAIL_WRITES.has(action);
}

/**
 * What to say for the Gmail actions that cannot run without Gmail, in the
 * order given: 「Gmail 尚未連線，無法封存；請先到設定連線 Gmail。」, or
 * 「…無法封存、標為已讀或刪除；…」 for several. Undefined when none is one.
 */
export function offlineMessage(actions: readonly ActionId[]): string | undefined {
  const verbs = [...new Set(actions.filter((action) => GMAIL_WRITES.has(action)).map((action) => GMAIL_OFFLINE.verbs[action]))];
  if (!verbs.length) return undefined;
  const joined = verbs.length === 1 ? verbs[0] : `${verbs.slice(0, -1).join("、")}或${verbs.at(-1)}`;
  return GMAIL_OFFLINE.message(joined);
}

/** 解釋這個 in the reader sends at most this many characters (the suite handoff limit). */
export const MAIL_EXPLAIN_LIMIT = 2000;

/**
 * 解釋這個's text for a conversation: the subject, a blank line, then the
 * newest message's plain text (else its snippet, else the summary), the whole
 * at most MAIL_EXPLAIN_LIMIT characters (a cut body ends in 「…」). Never HTML.
 */
export function mailExplainText(subject: string, messages: readonly Pick<InboxMessage, "excerpt" | "snippet">[], summary?: string): string {
  const latest = messages.at(-1);
  const head = [...subject.trim()].slice(0, MAIL_EXPLAIN_LIMIT).join("");
  const raw = latest?.excerpt?.trim() || latest?.snippet?.trim() || summary?.trim() || "";
  const body = [...raw.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")];
  const room = MAIL_EXPLAIN_LIMIT - [...head].length - (head ? 2 : 0);
  if (room <= 0 || !body.length) return head;
  const excerpt = body.length > room ? `${body.slice(0, room - 1).join("").trimEnd()}…` : body.join("");
  return head ? `${head}\n\n${excerpt}` : excerpt;
}
