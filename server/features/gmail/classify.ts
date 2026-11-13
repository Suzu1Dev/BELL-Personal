import type { InboxCategory, MailCategory, MailMessage, MailTriage } from "../../../shared/mail.js";
import { effectiveTriage, isAutomated, isGitHubNotification, isMine, type RuleContext } from "./rules.js";

/**
 * Where a conversation belongs: a Today queue row (mail.reply, mail.bill,
 * mail.action), a digest category, or neither. Shared by today(), the inbox
 * list and the sync's reply detection so the three always agree.
 */

export interface ThreadView {
  threadId: string;
  /** The newest inbox message not sent by the owner: the row's message. */
  latest: MailMessage;
  /** Cached inbox messages of the thread, oldest first. */
  messages: MailMessage[];
  unread: boolean;
}

/** Groups inbox messages by conversation, newest conversation first. */
export function latestByThread(messages: MailMessage[]): ThreadView[] {
  const byThread = new Map<string, MailMessage[]>();
  for (const message of messages) byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message]);
  const threads: ThreadView[] = [];
  for (const [threadId, list] of byThread) {
    const sorted = [...list].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
    const latest = [...sorted].reverse().find((message) => !isMine(message));
    if (!latest) continue;
    threads.push({ threadId, latest, messages: sorted, unread: sorted.some((message) => message.unread) });
  }
  return threads.sort((a, b) => b.latest.receivedAt.localeCompare(a.latest.receivedAt) || a.threadId.localeCompare(b.threadId));
}

export type MailRowKind = "mail.reply" | "mail.bill" | "mail.action";

/** Today's digest strip categories (SPEC-ux §4.4), with their one contextual action. */
export const DIGEST_CATEGORIES = [
  { key: "newsletter", label: "電子報", action: "read" },
  { key: "school", label: "學校公告", action: "open" },
  { key: "github", label: "GitHub 通知", action: "read" },
  { key: "notification", label: "通知", action: "read" },
  { key: "promo", label: "促銷", action: "archive" },
  { key: "other", label: "其他", action: "open" },
] as const;
export type DigestKey = (typeof DIGEST_CATEGORIES)[number]["key"];

export interface ThreadClass {
  triage: MailTriage;
  /** The queue kind this conversation has (whether or not it is in the queue now). */
  kind?: MailRowKind;
  /** It belongs in the Today queue now: an unanswered reply, a bill, or unread mail that asks for something. */
  queueable: boolean;
  /** Unread, not a queue row and not represented by an AI suggestion: counted in the digest. */
  digest?: DigestKey;
  category: InboxCategory;
  /** The owner already replied after the row's message. */
  replied: boolean;
  /** Sent by a person: rows show the serif initial. */
  person: boolean;
}

export interface ClassifyContext extends RuleContext {
  /** Message ids an AI suggestion was made from (the suggestion row stands for the mail). */
  suggested?: ReadonlySet<string>;
  /** False when the lms module is hidden for the user's roles (設定 › 身分): no 轉成作業 and no assignment suggestion. */
  assignments?: boolean;
}

const INBOX_OF: Record<MailCategory, InboxCategory> = {
  "needs-reply": "needs-reply", bill: "bill", school: "school", invitation: "invitation",
  newsletter: "newsletter", notification: "notification", promo: "other", other: "other",
};

function digestKey(message: MailMessage, triage: MailTriage): DigestKey {
  switch (triage.category) {
    case "newsletter": return "newsletter";
    case "school": return "school";
    case "promo": return "promo";
    case "notification": return isGitHubNotification(message) ? "github" : "notification";
    default: return "other";
  }
}

export function classifyThread(thread: ThreadView, context: ClassifyContext): ThreadClass {
  const message = thread.latest;
  const triage = effectiveTriage(message, context);
  const replied = !!message.repliedAt && message.repliedAt >= message.receivedAt;
  const suggested = thread.messages.some((item) => context.suggested?.has(item.id));
  let kind: MailRowKind | undefined;
  if (triage.category === "bill") kind = "mail.bill";
  else if (triage.action === "reply" || triage.category === "needs-reply") kind = "mail.reply";
  else if (triage.action === "todo") kind = "mail.action";

  let queueable = false;
  if (kind === "mail.reply") queueable = !replied;
  else if (kind === "mail.bill") queueable = true;
  else if (kind === "mail.action") queueable = thread.unread;
  if (triage.action === "calendar" && suggested && kind !== "mail.reply") queueable = false;

  const digest = !queueable && thread.unread && !suggested && kind !== "mail.reply" ? digestKey(message, triage) : undefined;
  const category = kind === "mail.reply" ? "needs-reply" : kind === "mail.bill" ? "bill" : INBOX_OF[triage.category];
  return {
    triage, queueable, category, replied, person: !isAutomated(message),
    ...(kind ? { kind } : {}),
    ...(digest ? { digest } : {}),
  };
}
