import { INBOX_CATEGORIES, type InboxCategory, type InboxListResponse, type InboxMessage, type InboxSourceState, type InboxSuggestion, type InboxThread, type MailLocation, type MailMessage } from "../../../shared/mail.js";
import type { AiSuggestion, EventSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import { localTime, zonedTimeToUtc } from "../../../shared/time.js";
import type { ActionId, QueueAction, QueueItem } from "../../../shared/today.js";
import { hiddenByState, type ItemStateView } from "../../../shared/today-logic.js";
import { metaDeadline, monthDayWeek, queueAction, receivedWhen } from "../../../shared/today-format.js";
import { suggestionRow as coreSuggestionRow } from "../../today/suggestions.js";
import { classifyThread, latestByThread, type ClassifyContext, type ThreadView } from "./classify.js";
import { isMine } from "./rules.js";
import { archivedActions, inboxActions, initialOf, mailRow, senderName, trashedActions } from "./rows.js";

/**
 * The #/inbox payloads (SPEC-ux §3.3, SPEC-mail-assignments §3): one row per
 * conversation in the `.q-row` grammar (sender · one-line summary, received
 * time), grouped by category; the reading pane gets the plain-text excerpts
 * and the pending suggestions found in the thread. Snoozed conversations stay
 * hidden until they wake, like Gmail's own snooze. The same row builder makes
 * the rows of the 封存 and 全部 views and of searches (./search.ts), cached or
 * read live.
 */

export interface InboxInput {
  messages: MailMessage[];
  /** The item state of a row id (ctx.itemState.get). */
  stateOf: (itemId: string) => (ItemStateView & { action?: ActionId | null }) | undefined;
  context: ClassifyContext;
  source: InboxSourceState;
  /** Conversations an assignment was made from (the lms module's native records, by mailRef.threadId). */
  converted?: ReadonlySet<string>;
}

export interface RowOptions {
  /** In the inbox, or archived (no INBOX message). Default inbox. */
  location?: MailLocation;
  /** Read from Gmail for this view or search only (not cached). */
  live?: boolean;
  /** Every message is in Gmail's trash: 移回收件匣 restores it (the reader of a link, never a list). */
  trashed?: boolean;
}

/** Labels that take a message out of every #/inbox view. */
const HIDDEN_LABELS = ["TRASH", "SPAM", "DRAFT"];
export const isHiddenMessage = (message: Pick<MailMessage, "labels">) => message.labels.some((label) => HIDDEN_LABELS.includes(label));

/** A conversation whose every message is in Gmail's trash (刪除 trashes the whole conversation). */
export const isTrashed = (messages: ReadonlyArray<Pick<MailMessage, "labels">>) => messages.length > 0 && messages.every((message) => message.labels.includes("TRASH"));

/** Every action a row offers also includes 轉成作業 (SPEC-mail-assignments §5.6: the reader of every conversation offers it). */
function withAssignment(actions: QueueAction[]): QueueAction[] {
  return actions.some((action) => action.id === "assignment") ? actions : [...actions, queueAction("assignment")];
}

export function threadSummary(thread: ThreadView, input: Pick<InboxInput, "stateOf" | "context" | "converted">, options: RowOptions = {}): InboxThread {
  const { context } = input;
  const location = options.location ?? "inbox";
  const message = thread.latest;
  const info = classifyThread(thread, context);
  const itemId = `gmail:${message.id}`;
  const state = input.stateOf(itemId);
  // Only an inbox conversation can be a Today row (today() reads INBOX mail).
  const row = location === "inbox" && info.kind ? mailRow(thread, { ...info, kind: info.kind }, context) : undefined;
  const inQueue = !!row && !options.live && info.queueable && !hiddenByState(row, state, context.now);
  const sender = isMine(message) ? "我" : senderName(message);
  const summary = info.triage.summary;
  const when: NonNullable<QueueItem["when"]> = row?.when && info.kind === "mail.bill" ? row.when : receivedWhen(message.receivedAt, context.now, context.timeZone);
  const offered = options.trashed
    ? trashedActions({ live: options.live })
    : location === "archive"
    ? archivedActions({ live: options.live })
    : inQueue && row ? withAssignment(row.actions) : inboxActions(info.category, thread.unread, { live: options.live });
  // Already an assignment (轉成作業, or 加入作業 on its suggestion): A would only answer 「已經轉成作業了」.
  const converted = !!input.converted?.has(thread.threadId);
  // The lms module hidden for the user's roles (設定 › 身分): no 轉成作業 anywhere.
  const actions = converted || context.assignments === false ? offered.filter((action) => action.id !== "assignment") : offered;
  return {
    threadId: thread.threadId,
    messageId: message.id,
    itemId,
    from: message.from,
    subject: message.subject,
    title: row?.title ?? message.subject,
    meta: [sender, ...(summary && summary !== message.subject ? [summary] : [])],
    ...(summary ? { summary } : {}),
    summarySource: info.triage.source,
    ...(message.snippet ? { snippet: message.snippet } : {}),
    category: info.category,
    ...(info.kind ? { kind: info.kind } : {}),
    inQueue,
    receivedAt: message.receivedAt,
    when,
    unread: thread.unread,
    count: thread.messages.length,
    // People you correspond with get their initial; announcements and services get the category tile.
    ...(info.person && info.category === "needs-reply" && !isMine(message) ? { avatar: { initial: initialOf(sender) } } : {}),
    actions,
    ...(state && (state.state === "snoozed" || state.state === "replying" || state.state === "handled")
      ? { state: { kind: state.state, ...(state.until ? { until: state.until } : {}), ...(state.action ? { action: state.action } : {}) } }
      : {}),
    replied: info.replied,
    ...(row?.snoozeLimit ? { snoozeLimit: row.snoozeLimit } : {}),
    webUrl: message.webUrl,
    location,
    ...(options.live ? { live: true } : {}),
    ...(options.trashed ? { trashed: true } : {}),
    ...(converted ? { converted: true } : {}),
  };
}

/**
 * A conversation's messages as one view: the row's message is the newest one
 * not sent by the owner (the inbox rule), or the newest one when the owner
 * wrote all of them (a search can find those).
 */
export function threadView(threadId: string, messages: MailMessage[]): ThreadView | undefined {
  const sorted = [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  const latest = [...sorted].reverse().find((message) => !isMine(message)) ?? sorted[sorted.length - 1];
  if (!latest) return undefined;
  return { threadId, latest, messages: sorted, unread: sorted.some((message) => message.unread) };
}

const snoozedNow = (thread: InboxThread, now: Date) => thread.state?.kind === "snoozed" && !!thread.state.until && Date.parse(thread.state.until) > now.getTime();

export function inboxList(input: InboxInput): InboxListResponse {
  const threads = latestByThread(input.messages.filter((message) => message.labels.includes("INBOX"))).map((thread) => threadSummary(thread, input));
  const visible = threads.filter((thread) => !snoozedNow(thread, input.context.now));
  const counts = Object.fromEntries(INBOX_CATEGORIES.map((category) => [category, 0])) as Record<InboxCategory, number>;
  for (const thread of visible) counts[thread.category]++;
  return {
    source: input.source,
    threads: visible,
    counts,
    unread: threads.filter((thread) => thread.unread).length,
    snoozed: threads.length - visible.length,
  };
}

/** A cached conversation as a row: in the inbox when any message has INBOX, else archived (trash, spam and drafts left out). */
export function cachedThreadRow(input: Pick<InboxInput, "stateOf" | "context" | "converted">, threadId: string, messages: MailMessage[]): InboxThread | undefined {
  const inInbox = messages.filter((message) => message.labels.includes("INBOX"));
  if (inInbox.length) {
    const [view] = latestByThread(inInbox);
    return view ? threadSummary(view, input, { location: "inbox" }) : undefined;
  }
  const kept = messages.filter((message) => !isHiddenMessage(message));
  const view = threadView(threadId, kept);
  return view ? threadSummary(view, input, { location: "archive" }) : undefined;
}

export interface ThreadDetail {
  thread: InboxThread;
  messages: InboxMessage[];
  suggestions: InboxSuggestion[];
}

function detailOf(thread: InboxThread, messages: MailMessage[], suggestions: AiSuggestion[], context: ClassifyContext): ThreadDetail {
  const ids = new Set(messages.map((message) => message.id));
  return {
    thread,
    messages: [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).map((message) => ({
      id: message.id, from: message.from, receivedAt: message.receivedAt, unread: message.unread, snippet: message.snippet,
      ...(message.excerpt ? { excerpt: message.excerpt } : {}), mine: isMine(message),
    })),
    suggestions: suggestions
      .filter((suggestion) => suggestion.status === "pending" && suggestion.sourceRef?.source === "gmail" && ids.has(suggestion.sourceRef.externalId))
      .filter((suggestion) => context.assignments !== false || suggestion.kind !== "assignment")
      .flatMap((suggestion) => suggestionRow(suggestion, context) ?? []),
  };
}

/** One cached conversation for the reading pane; undefined when nothing of it is cached. */
export function inboxThread(input: InboxInput, threadId: string, suggestions: AiSuggestion[]): ThreadDetail | undefined {
  const all = input.messages.filter((message) => message.threadId === threadId && !message.labels.includes("DRAFT"));
  const thread = cachedThreadRow(input, threadId, all) ?? (() => {
    const view = threadView(threadId, all);
    return view ? threadSummary(view, input, { location: "archive", trashed: isTrashed(all) }) : undefined;
  })();
  if (!thread) return undefined;
  return detailOf(thread, all, suggestions, input.context);
}

/**
 * Where a conversation read live from Gmail is and which message is its row
 * (SPEC-mail-assignments §1.2): in the inbox when any of its visible messages
 * has INBOX, and then the row is its newest inbox message not sent by the
 * owner (the cached inbox's rule); else archived, with the newest message not
 * sent by the owner. A conversation whose every message is in the trash is
 * `trashed` (only a reader opened by a link shows it); one with nothing
 * visible otherwise (spam, drafts) has no row. The 封存 / 全部 / search rows
 * and the reader use this one rule, so both name the same message (item id).
 */
export function liveConversation(threadId: string, messages: MailMessage[]): { view: ThreadView; location: MailLocation; trashed: boolean } | undefined {
  const kept = messages.filter((message) => !message.labels.includes("DRAFT"));
  const visible = kept.filter((message) => !isHiddenMessage(message));
  if (!visible.length) {
    const view = isTrashed(kept) ? threadView(threadId, kept) : undefined;
    return view ? { view, location: "archive", trashed: true } : undefined;
  }
  const inbox = visible.filter((message) => message.labels.includes("INBOX"));
  const view = (inbox.length ? latestByThread(inbox)[0] : undefined) ?? threadView(threadId, visible);
  return view ? { view, location: inbox.length ? "inbox" : "archive", trashed: false } : undefined;
}

/** A list row (封存, 全部, search) of a conversation read live; never one in the trash. */
export function liveThreadRow(input: Pick<InboxInput, "stateOf" | "context" | "converted">, threadId: string, messages: MailMessage[]): InboxThread | undefined {
  const conversation = liveConversation(threadId, messages);
  if (!conversation || conversation.trashed) return undefined;
  return threadSummary(conversation.view, input, { location: conversation.location, live: true });
}

/**
 * A conversation read live with threads.get (SPEC-mail-assignments §3.3,
 * §3.5 step 5): the same reading pane, `thread.live`. Drafts are left out;
 * undefined when nothing else is left, or only spam.
 */
export function liveThread(input: Pick<InboxInput, "stateOf" | "context" | "converted">, threadId: string, messages: MailMessage[], suggestions: AiSuggestion[]): ThreadDetail | undefined {
  const conversation = liveConversation(threadId, messages);
  if (!conversation) return undefined;
  const { view, location, trashed } = conversation;
  const kept = messages.filter((message) => !message.labels.includes("DRAFT"));
  return detailOf(threadSummary(view, input, { location, live: true, trashed }), kept, suggestions, input.context);
}

/** The same `.q-row.is-ai` the core puts in the Today queue for this suggestion (without 「來自 …」: the reader is that mail). */
function suggestionRow(suggestion: AiSuggestion, context: ClassifyContext): InboxSuggestion | undefined {
  const { timeZone, now } = context;
  if (suggestion.kind === "event") {
    const event = suggestion.payload as EventSuggestion;
    if (!event?.title || Number.isNaN(Date.parse(event.start))) return undefined;
    const when = event.allDay ? monthDayWeek(timeZone, event.start) : `${monthDayWeek(timeZone, event.start)}${localTime(timeZone, event.start)}`;
    return {
      itemId: `ai:${suggestion.id}`, kind: "suggestion.event", title: "從信件找到 1 個活動，要加入行事曆嗎？",
      meta: [event.title, when, ...(event.location ? [event.location] : [])],
      actions: [queueAction("calendar"), queueAction("dismiss")],
    };
  }
  if (suggestion.kind === "todo") {
    const todo = suggestion.payload as TodoSuggestion;
    if (!todo?.title) return undefined;
    let due: string | undefined;
    if (todo.dueDay) {
      const [hour, minute] = todo.dueTime ? todo.dueTime.split(":").map(Number) : [23, 59];
      try { due = zonedTimeToUtc(timeZone, todo.dueDay, hour, minute).toISOString(); } catch { due = undefined; }
    }
    return {
      itemId: `ai:${suggestion.id}`, kind: "suggestion.todo", title: "從信件找到 1 件待辦，要加入嗎？",
      meta: [todo.title, ...(due ? [metaDeadline(due, now, timeZone, { dateOnly: !todo.dueTime })] : [])],
      actions: [queueAction("todo", { label: "加入待辦", touchLabel: "加入待辦" }), queueAction("dismiss")],
    };
  }
  if (suggestion.kind === "assignment") {
    const row = coreSuggestionRow(suggestion, { now, timeZone });
    if (!row || row.kind !== "suggestion.assignment") return undefined;
    const origin = suggestion.origin ? `來自 ${suggestion.origin}` : undefined;
    return { itemId: row.id, kind: "suggestion.assignment", title: row.title, meta: row.meta.filter((part) => part !== origin), actions: row.actions };
  }
  return undefined;
}
