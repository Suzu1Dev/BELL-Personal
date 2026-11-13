import type { DayKey } from "./time.js";
import type { ActionId, QueueAction, QueueItem } from "./today.js";

/**
 * Mail digest types. Only metadata, a snippet and a plain-text excerpt are
 * stored (never HTML, never remote images); see MAIL_LIMITS.
 */
export const MAIL_CATEGORIES = [
  "needs-reply",
  "bill",
  "school",
  "invitation",
  "newsletter",
  "notification",
  "promo",
  "other",
] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export const MAIL_CATEGORY_LABELS: Record<MailCategory, string> = {
  "needs-reply": "需要回覆",
  bill: "帳單",
  school: "學校",
  invitation: "活動邀請",
  newsletter: "電子報",
  notification: "通知",
  promo: "促銷",
  other: "其他",
};

export const MAIL_PRIORITIES = ["high", "medium", "low"] as const;
export type MailPriority = (typeof MAIL_PRIORITIES)[number];

export const MAIL_ACTIONS = ["reply", "todo", "calendar", "read", "archive", "none"] as const;
export type MailAction = (typeof MAIL_ACTIONS)[number];

export interface MailAddress {
  name?: string;
  email: string;
}

/** A bill found in a message (category bill): drives the mail.bill row 「{payee} {period}帳單 NT${amount}」. */
export interface MailBill {
  payee: string;
  amount: number;
  /** ISO 4217, "TWD" for NT$. */
  currency: string;
  /** Local due day. */
  dueDay?: DayKey;
  /** 「9 月」 */
  period?: string;
  /** false → meta 「沒有設定自動扣繳」. */
  autopay?: boolean;
}

/** AI (or rule-based) triage of one message. A suggestion only: nothing is archived automatically. */
export interface MailTriage {
  summary: string;
  category: MailCategory;
  priority: MailPriority;
  action: MailAction;
  source: "ai" | "rule";
  triagedAt: string;
  /** AI rank among today's actionable mail (1 first); orders rows inside a queue group. */
  rank?: number;
  /** Course or organisation for the meta line (「作業系統」). */
  context?: string;
  bill?: MailBill;
  /** The AI triage prompt's version (2: it also asks for assignments); absent on triage written before versions. */
  version?: number;
}

/**
 * The AI triage prompt's version, stored on each AI triage
 * (MailTriage.version): 2 also asks for assignments (SPEC-mail-assignments
 * §5.3). Mail the model triaged before (no version) never got that question,
 * so the assignment rules read it like mail the model never saw.
 */
export const MAIL_TRIAGE_VERSION = 2;

/**
 * The DB-backed AI triage queue (the state lives in the MailMessage JSON, so
 * it survives restarts): new inbox mail starts `pending`, a successful batch
 * makes it `done` (with `triage.source: "ai"`), and three failed attempts make
 * it `failed`. Until then the rule-based triage is used.
 */
export const MAIL_TRIAGE_STATES = ["pending", "done", "failed"] as const;
export type MailTriageState = (typeof MAIL_TRIAGE_STATES)[number];

export interface MailTriageQueue {
  state: MailTriageState;
  attempts: number;
  updatedAt: string;
  /** zh-TW reason of the last failed attempt (redacted, no message text). */
  error?: string;
}

/** A Gmail message normalised for the digest. */
export interface MailMessage {
  /** Gmail message id. */
  id: string;
  threadId: string;
  from: MailAddress;
  subject: string;
  snippet: string;
  /** Plain-text excerpt, at most MAIL_LIMITS.excerptBytes. */
  excerpt?: string;
  receivedAt: string;
  unread: boolean;
  labels: string[];
  /** "在 Gmail 開啟" link. */
  webUrl: string;
  triage?: MailTriage;
  /** A List-Unsubscribe header was present (rule fallback: automated mail, digest 電子報). */
  listUnsubscribe?: boolean;
  /** The thread already has a message sent by the owner after this one (closes 回覆中…). */
  repliedAt?: string;
  /** AI triage queue state; absent for mail that is never sent to the model (older backlog). */
  triageQueue?: MailTriageQueue;
}

export const MAIL_LIMITS = { excerptBytes: 8192, retentionDays: 30, subject: 300, snippet: 300 } as const;

/* ---------------------------------------------------------------------------
 * #/inbox (GET /api/gmail/threads, GET /api/gmail/threads/:threadId)
 * ------------------------------------------------------------------------- */

/**
 * Which conversations #/inbox lists (SPEC-mail-assignments §1.1): 收件匣 (the
 * cache), 封存 and 全部 (read live from Gmail, never written to disk). Part of
 * the URL: `#/inbox?view=archive&q=…`.
 */
export const MAIL_VIEWS = ["inbox", "archive", "all"] as const;
export type MailView = (typeof MAIL_VIEWS)[number];

/** Where a conversation is in Gmail now: in the inbox, or archived (no INBOX message). */
export const MAIL_LOCATIONS = ["inbox", "archive"] as const;
export type MailLocation = (typeof MAIL_LOCATIONS)[number];

/** GET /api/gmail/search limits: query length, rows per page, page-token length. */
export const MAIL_SEARCH_LIMITS = { query: 200, pageSize: 20, pageToken: 200 } as const;

/** The inbox chips (SPEC-ux §3.3) in order; 促銷 is listed under 其他. */
export const INBOX_CATEGORIES = ["needs-reply", "bill", "school", "invitation", "newsletter", "notification", "other"] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

/** One conversation in the inbox list: its latest inbox message, phrased like a Today row. */
export interface InboxThread {
  threadId: string;
  /** The latest inbox message of the thread; actions target `gmail:<messageId>`. */
  messageId: string;
  itemId: string;
  from: MailAddress;
  subject: string;
  /** Row title: the subject, or 「中華電信 9 月帳單 NT$599」 for a bill. */
  title: string;
  /** Joined with " · ": sender and the one-line summary. */
  meta: string[];
  summary?: string;
  summarySource: "ai" | "rule";
  /** Gmail's snippet of the row's message (≤ 300 characters): the local search matches it too. */
  snippet?: string;
  category: InboxCategory;
  /** The Today queue kind when the thread is (or would be) a queue row. */
  kind?: "mail.reply" | "mail.bill" | "mail.action";
  /** Whether the thread is open in the Today queue right now. */
  inQueue: boolean;
  receivedAt: string;
  when: NonNullable<QueueItem["when"]>;
  unread: boolean;
  /** Cached messages in the thread. */
  count: number;
  /** A person (not an automated sender): show the serif initial. */
  avatar?: { initial: string };
  /** [0] is the primary action; the same ids, labels and keys as the Today row. */
  actions: QueueAction[];
  /** Item state of the row: snoozed until, 回覆中…, or handled (轉待辦). */
  state?: { kind: "snoozed" | "replying" | "handled"; until?: string; action?: ActionId };
  /** A reply from the owner was seen in the thread. */
  replied: boolean;
  /** ISO; latest allowed snooze (a bill's deadline − 2 h). */
  snoozeLimit?: string;
  webUrl: string;
  /** In the inbox or archived; absent = inbox (servers before SPEC-mail-assignments). */
  location?: MailLocation;
  /** Read from Gmail for this view or search only: not in the local cache, kept in server memory for minutes. */
  live?: boolean;
  /**
   * In Gmail's trash (only a reader reached by a link shows one, such as an
   * assignment's 開啟信件): 移回收件匣 restores it; 刪除 is not offered.
   */
  trashed?: boolean;
  /**
   * An assignment was made from this conversation (轉成作業 or 加入作業 on its
   * suggestion): the row says 已轉成作業 and no longer offers 轉成作業.
   */
  converted?: boolean;
}

export interface InboxSourceState {
  /** Gmail is connected with the gmail.modify scope. */
  connected: boolean;
  state: "ok" | "syncing" | "stale" | "error" | "reconnect" | "off";
  lastSyncedAt?: string;
  /** zh-TW, set for error and reconnect. */
  message?: string;
}

export interface InboxListResponse {
  source: InboxSourceState;
  /** Newest first; snoozed threads are left out (see `snoozed`). */
  threads: InboxThread[];
  counts: Record<InboxCategory, number>;
  /** Threads with an unread inbox message. */
  unread: number;
  /** Threads hidden until their snooze ends. */
  snoozed: number;
}

export interface InboxMessage {
  id: string;
  from: MailAddress;
  receivedAt: string;
  unread: boolean;
  snippet: string;
  /** Plain text only, never HTML. */
  excerpt?: string;
  /** Sent by the owner. */
  mine: boolean;
}

/** A pending AI suggestion found in the thread, rendered as a `.q-row.is-ai`. */
export interface InboxSuggestion {
  itemId: string;
  kind: "suggestion.event" | "suggestion.todo" | "suggestion.assignment";
  title: string;
  meta: string[];
  actions: QueueAction[];
}

export interface InboxThreadResponse {
  thread: InboxThread;
  /** Cached messages of the conversation, oldest first. */
  messages: InboxMessage[];
  suggestions: InboxSuggestion[];
}

/**
 * The reader's AI 處理: POST /api/gmail/threads/:threadId/process {} → 202,
 * the `mail-process` job to follow with GET /api/jobs/:jobId/events. The model
 * reads the cached conversation and proposes events, todos and an assignment;
 * they become pending suggestions (shown under 從這封信找到), never records.
 */
export interface MailProcessStart {
  jobId: string;
  threadId: string;
}

/** The `mail-process` job's `done.result`. */
export interface MailProcessResult {
  threadId: string;
  /** Usable items the model found, including ones already suggested, added or dismissed before. */
  found: number;
  /** Pending suggestions this run added to the conversation. */
  added: number;
  /** Pending suggestions of the conversation now. */
  pending: number;
}

/** GET /api/status → modules.gmail. */
export interface MailModuleStatus {
  messages: number;
  triage: { pending: number; failed: number };
  triaging: boolean;
  /** AI 處理 can run: 使用 AI is on and the selected CLI is signed in. */
  aiProcess: boolean;
}

/**
 * GET /api/gmail/search?view=inbox|archive|all&q=&pageToken= (SPEC-mail-assignments
 * §3.5, §4): one page of conversations for the 封存 and 全部 views, or a Gmail
 * search in any view. Rows use the inbox list grammar; live rows are never cached
 * on disk. Without Gmail (not connected, reconnect, or the call failed) the
 * server answers the matching cached mail with `origin: "cache"`.
 */
export interface MailSearchResponse {
  view: MailView;
  /** The query as the server used it (trimmed); "" lists the view. */
  q: string;
  /** This page, newest first; a conversation may repeat on a later page (the client drops repeats by threadId). */
  threads: InboxThread[];
  /** Opaque Gmail page token for 載入更多; absent on the last page and for cache answers. */
  nextPageToken?: string;
  /** gmail: listed live; cache: only the local cache was searched. */
  origin: "gmail" | "cache";
  /** zh-TW reason when Gmail failed and the answer fell back to the cache. */
  error?: string;
  source: InboxSourceState;
}

/* ---------------------------------------------------------------------------
 * The reader's original layout (SPEC-mail-html): GET /api/gmail/messages/:id/body
 * ------------------------------------------------------------------------- */

/**
 * How the reader shows a message: 原始版面 (the mail's own HTML, sanitized on
 * the server, in a sandboxed frame without scripts) or 純文字 (the cached
 * plain-text excerpt). AppSettings `mail.bodyView`, also switched in the reader.
 */
export const MAIL_BODY_VIEWS = ["original", "plain"] as const;
export type MailBodyView = (typeof MAIL_BODY_VIEWS)[number];

/** Caps of the original layout (shared by the sanitizer, the endpoints and the settings schema). */
export const MAIL_BODY_LIMITS = {
  /** Decoded HTML characters rendered; a longer body shows its plain text. */
  htmlChars: 1_000_000,
  /** `<style>` characters kept (all blocks together). */
  cssChars: 200_000,
  /** One `style` attribute. */
  styleAttributeChars: 4_000,
  /** One image (inline part, attachment or remote), in bytes. */
  imageBytes: 10_000_000,
  /** One `data:` image in the HTML, and all of them together, in bytes. */
  dataImageBytes: 256_000,
  dataImagesTotal: 1_000_000,
  /** Distinct remote images rewritten per message (the rest are dropped). */
  remoteImages: 200,
  /** Image attachments listed under a message. */
  attachments: 30,
  /** Entries of 信任的寄件者. */
  trustedSenders: 200,
} as const;

/** An image attachment of a message, served same-origin (raster only, checked by magic bytes). */
export interface MailImageAttachment {
  /** The MIME part id (stable for a message; Gmail's attachment ids change on every read). */
  partId: string;
  filename: string;
  /** Size Gmail reports, in bytes. */
  size: number;
  url: string;
}

/** Why a message shows its plain text in the 原始版面 view. */
export const MAIL_BODY_FALLBACKS = ["no-html", "too-large", "unsafe", "not-connected"] as const;
export type MailBodyFallback = (typeof MAIL_BODY_FALLBACKS)[number];

/**
 * GET /api/gmail/messages/:messageId/body[?images=1]: the message's HTML,
 * sanitized and wrapped in a document for `<iframe sandbox srcdoc>` (read live
 * from Gmail, held only in server memory for at most 5 minutes, never on disk).
 * Remote images are left out unless `images=1` was asked or the sender is on
 * 信任的寄件者; tracking pixels are always left out.
 */
export interface MailBodyResponse {
  messageId: string;
  /** "html": `document` is the frame's page; "text": show the plain text (`reason` says why). */
  kind: "html" | "text";
  reason?: MailBodyFallback;
  document?: string;
  images: {
    /** Remote images in the mail, tracking pixels not counted. */
    remote: number;
    /** Remote images are in `document` (loaded through the proxy). */
    shown: boolean;
    /** Shown because the sender is on 信任的寄件者. */
    trusted: boolean;
    /** Known tracking pixels removed: never loaded, whatever the setting. */
    trackers: number;
  };
  sender: MailAddress;
  /** Image attachments not already shown inline. */
  attachments: MailImageAttachment[];
}

/** Whether `sender` matches an entry of 信任的寄件者: an address exactly, or a domain and its subdomains. */
export function trustedSender(entries: readonly string[], sender: string): boolean {
  const email = sender.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (!email.includes("@") || !domain) return false;
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.includes("@")) return entry === email;
    return domain === entry || domain.endsWith(`.${entry}`);
  });
}
