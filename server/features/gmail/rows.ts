import { detectAssignment } from "../../../shared/assignment-detect.js";
import type { InboxCategory, MailBill, MailMessage } from "../../../shared/mail.js";
import { zonedTimeToUtc } from "../../../shared/time.js";
import type { QueueAction, QueueCandidate, TodayContribution, TodayInput } from "../../../shared/today.js";
import { deadlineWhen, metaDeadline, queueAction, receivedWhen } from "../../../shared/today-format.js";
import { gmailInboxUrl } from "./parse.js";
import { classifyThread, DIGEST_CATEGORIES, latestByThread, type ClassifyContext, type DigestKey, type MailRowKind, type ThreadClass, type ThreadView } from "./classify.js";
import { isAutomated } from "./rules.js";

/**
 * Today rows for mail (SPEC-ux §4.3): mail.reply / mail.bill / mail.action,
 * one per conversation (its newest inbox message), plus the digest of unread
 * mail that needs nothing and the unread badge. Pure: today() and the inbox
 * list feed it the cached messages and the ids an AI suggestion came from.
 */

const HOUR = 3_600_000;
const PRIORITY_RANK = { high: 1, medium: 2, low: 3 } as const;

/** The sender as shown in meta: the display name, else the address. */
export const senderName = (message: Pick<MailMessage, "from">) => message.from.name ?? message.from.email;

/** The serif initial of a person (Latin initials upper-cased). */
export function initialOf(name: string): string {
  const cleaned = name.replace(/^["'「（(]+/, "").trim();
  return (Array.from(cleaned)[0] ?? "?").toLocaleUpperCase("zh-TW");
}

/** 「中華電信 9 月帳單 NT$599」 */
export function billTitle(bill: MailBill): string {
  const amount = bill.currency === "TWD" ? `NT$${bill.amount.toLocaleString("en-US")}` : `${bill.currency} ${bill.amount.toLocaleString("en-US")}`;
  return `${bill.payee} ${bill.period ? `${bill.period}` : ""}帳單 ${amount}`.replace(/\s+/g, " ");
}

/** A bill's deadline: 23:59 local on its due day. */
export function billDueAt(bill: MailBill | undefined, timeZone: string): string | undefined {
  if (!bill?.dueDay) return undefined;
  try { return zonedTimeToUtc(timeZone, bill.dueDay, 23, 59).toISOString(); } catch { return undefined; }
}

/**
 * The row actions per kind; [0] is the primary action (SPEC-ux §4.3 table,
 * SPEC-mail-assignments §2.6: every mail row also offers 刪除 #, and 轉成作業
 * A when the rules recognise an assignment announcement).
 */
export function rowActions(kind: MailRowKind, options: { assignment?: boolean } = {}): QueueAction[] {
  const extra = [queueAction("trash"), ...(options.assignment ? [queueAction("assignment")] : [])];
  switch (kind) {
    case "mail.reply":
      return [queueAction("reply"), queueAction("todo"), queueAction("snooze"), queueAction("archive"), ...extra];
    case "mail.bill":
      return [queueAction("todo", { label: "轉成待辦", touchLabel: "轉待辦" }), queueAction("archive"), queueAction("snooze"), ...extra];
    case "mail.action":
      return [queueAction("read"), queueAction("todo"), queueAction("snooze"), queueAction("archive", { key: undefined }), ...extra];
  }
}

/**
 * Actions for a conversation in the inbox that is not an open queue row
 * (#/inbox, SPEC-ux §3.3, SPEC-mail-assignments §0.2): mail to answer keeps
 * 回覆 ↵ · 轉待辦 T · 延後 S · 封存 E; anything else leads with the close
 * action, like mail.action on Today (標為已讀 E while unread, else 封存 E),
 * with 回覆 still offered; every conversation also has 刪除 # and 轉成作業 A.
 * A conversation read live (outside the cache) has no 轉待辦 or 延後: the
 * tasks module and item state work on cached mail.
 */
export function inboxActions(category: InboxCategory, unread: boolean, options: { live?: boolean } = {}): QueueAction[] {
  const tail = [queueAction("trash"), queueAction("assignment")];
  let actions: QueueAction[];
  if (category === "needs-reply") actions = [queueAction("reply"), queueAction("todo"), queueAction("snooze"), queueAction("archive"), ...tail];
  else {
    const reply = queueAction("reply", { key: undefined });
    actions = unread
      ? [queueAction("read"), queueAction("todo"), queueAction("snooze"), queueAction("archive", { key: undefined }), ...tail, reply]
      : [queueAction("archive"), queueAction("todo"), queueAction("snooze"), ...tail, reply];
  }
  return options.live ? actions.filter((action) => action.id !== "todo" && action.id !== "snooze") : actions;
}

/**
 * Actions for an archived conversation (SPEC-mail-assignments §3.2):
 * 移回收件匣 E · 刪除 # · 轉待辦 T (cached mail only) · 轉成作業 A · 回覆.
 */
export function archivedActions(options: { live?: boolean } = {}): QueueAction[] {
  return [
    queueAction("unarchive"), queueAction("trash"), ...(options.live ? [] : [queueAction("todo")]),
    queueAction("assignment"), queueAction("reply", { key: undefined }),
  ];
}

/**
 * Actions for a conversation in Gmail's trash, opened from a link (an
 * assignment's 開啟信件): 移回收件匣 E restores it (untrash + INBOX), and
 * 刪除 is left out because it is already there.
 */
export function trashedActions(options: { live?: boolean } = {}): QueueAction[] {
  return archivedActions(options).filter((action) => action.id !== "trash");
}

/** Whether the rules read this message as a teacher's assignment announcement (the row then lists 轉成作業 A). */
export function looksLikeAssignment(message: MailMessage, context: { schoolDomains?: string[]; timeZone: string; course?: string; category?: string }): boolean {
  try {
    return !!detectAssignment({
      subject: message.subject, from: message.from, text: message.excerpt ?? message.snippet, receivedAt: message.receivedAt,
      automated: isAutomated(message), labels: message.labels, ...(context.course ? { context: context.course } : {}),
      ...(context.category ? { category: context.category } : {}),
    }, { schoolDomains: context.schoolDomains ?? [], timeZone: context.timeZone });
  } catch {
    return false;
  }
}

/** The queue candidate for a classified conversation. */
export function mailRow(thread: ThreadView, info: ThreadClass & { kind: MailRowKind }, input: Pick<TodayInput, "now" | "timeZone"> & { schoolDomains?: string[]; assignments?: boolean }): QueueCandidate {
  const { now, timeZone } = input;
  const message = thread.latest;
  const { triage, kind } = info;
  const sender = senderName(message);
  const assignment = input.assignments !== false && kind !== "mail.bill" && looksLikeAssignment(message, { schoolDomains: input.schoolDomains, timeZone, course: triage.context, category: triage.category });
  const base = {
    id: `gmail:${message.id}`,
    kind,
    source: "gmail" as const,
    summary: triage.summary,
    summarySource: triage.source,
    actions: rowActions(kind, { assignment }),
    url: message.webUrl,
  };
  const hints = { receivedAt: message.receivedAt, rank: triage.rank ?? PRIORITY_RANK[triage.priority] };
  if (kind === "mail.bill") {
    const dueAt = billDueAt(triage.bill, timeZone);
    const autopay = triage.bill?.autopay === false ? ["沒有設定自動扣繳"] : triage.bill?.autopay === true ? ["已設定自動扣繳"] : [];
    return {
      ...base,
      title: triage.bill ? billTitle(triage.bill) : message.subject,
      meta: ["帳單", ...(dueAt ? [metaDeadline(dueAt, now, timeZone, { dateOnly: true })] : [sender]), ...autopay],
      when: dueAt ? deadlineWhen(dueAt, now, timeZone) : receivedWhen(message.receivedAt, now, timeZone),
      ...(dueAt ? { snoozeLimit: new Date(Date.parse(dueAt) - 2 * HOUR).toISOString() } : {}),
      hints: { ...hints, ...(dueAt ? { dueAt, hardDeadline: true } : {}) },
    };
  }
  if (kind === "mail.reply") {
    return {
      ...base,
      title: message.subject,
      meta: [sender, ...(triage.context ? [triage.context] : []), "待回覆"],
      ...(info.person ? { avatar: { initial: initialOf(sender) } } : {}),
      when: receivedWhen(message.receivedAt, now, timeZone),
      hints: { ...hints, important: triage.priority === "high" },
    };
  }
  return {
    ...base,
    title: message.subject,
    meta: [sender, triage.summary],
    when: receivedWhen(message.receivedAt, now, timeZone),
    hints,
  };
}

export interface MailTodayInput extends Pick<TodayInput, "now" | "timeZone"> {
  messages: MailMessage[];
  schoolDomains: string[];
  /** Message ids an AI suggestion was made from. */
  suggested: ReadonlySet<string>;
  /** Row ids (`gmail:<id>`) set aside by item state right now (snoozed, 轉待辦…): they leave the digest too. */
  aside?: ReadonlySet<string>;
  /** The connected Google account, for Gmail links (u/0 otherwise). */
  account?: string;
  /** False when the lms module is hidden for the user's roles: rows offer no 轉成作業. */
  assignments?: boolean;
}

/** today(): queue rows, digest categories and the unread badge from the cache. */
export function mailContribution(input: MailTodayInput): TodayContribution {
  const context: ClassifyContext = { schoolDomains: input.schoolDomains, timeZone: input.timeZone, now: input.now, suggested: input.suggested };
  const threads = latestByThread(input.messages.filter((message) => message.labels.includes("INBOX")));
  const queue: QueueCandidate[] = [];
  const digest = new Map<DigestKey, number>();
  let unread = 0;
  for (const thread of threads) {
    if (thread.unread) unread++;
    const info = classifyThread(thread, context);
    if (info.queueable && info.kind) queue.push(mailRow(thread, { ...info, kind: info.kind }, input));
    else if (info.digest && !input.aside?.has(`gmail:${thread.latest.id}`)) digest.set(info.digest, (digest.get(info.digest) ?? 0) + 1);
  }
  return {
    queue,
    digest: DIGEST_CATEGORIES.filter((category) => digest.get(category.key)).map((category) => ({
      key: category.key, label: category.label, count: digest.get(category.key)!, action: category.action,
      ...(category.action === "open" ? { url: gmailInboxUrl(input.account) } : {}),
    })),
    inboxUnread: unread,
  };
}

/** The message ids behind a digest target (`gmail:digest` or `gmail:digest:<key>`), at the moment of the action. */
export function digestMessages(input: Omit<MailTodayInput, "now"> & { now: Date }, key?: string): MailMessage[] {
  const context: ClassifyContext = { schoolDomains: input.schoolDomains, timeZone: input.timeZone, now: input.now, suggested: input.suggested };
  const threads = latestByThread(input.messages.filter((message) => message.labels.includes("INBOX")));
  return threads.flatMap((thread) => {
    const info = classifyThread(thread, context);
    if (!info.digest || (key && info.digest !== key) || input.aside?.has(`gmail:${thread.latest.id}`)) return [];
    return thread.messages.filter((message) => message.unread || key === "promo");
  });
}
