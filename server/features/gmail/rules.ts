import type { MailBill, MailMessage, MailTriage } from "../../../shared/mail.js";
import { addDays, dayKey, isDayKey, zonedParts, type DayKey } from "../../../shared/time.js";

/**
 * The rule-based triage used whenever AI is off, still pending or failed
 * (SPEC-ux §4.4 rule fallback). Pure: it reads only the message, the school
 * domains setting and the clock, so it is recomputed on every read and always
 * follows the current settings.
 *
 *   Gmail CATEGORY_PROMOTIONS          → 促銷 (promo, archive)
 *   notifications@github.com           → GitHub 通知 (notification, read)
 *   a known biller or a bill subject    → 帳單 (bill, todo) with amount and due day when found
 *   a List-Unsubscribe header           → 電子報 (newsletter, read)
 *   noreply / notification senders      → 通知 (notification, read)
 *   IMPORTANT and not automated         → 需要回覆 (high priority: 最重要)
 *   a school domain                     → 學校公告 (school)
 *   CATEGORY_UPDATES / FORUMS / SOCIAL  → 通知
 *   a person in the primary inbox       → 需要回覆 (medium)
 *   anything else                       → 其他
 */

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|noreply[-+].*|mailer-daemon|postmaster|notifications?|notify|alerts?|bounce[s]?|news(letter)?|info|service|system|support|ebill|e-?invoice|billing)([-+._].*)?$/i;
const GITHUB = /(^|\.)github\.com$/i;
/** Utilities, telecoms and card issuers common in Taiwan: their mail is almost always a bill. */
const BILLERS = [
  "cht.com.tw", "taipower.com.tw", "water.gov.tw", "twtwater.com.tw", "taiwanmobile.com", "fetnet.net", "gt.com.tw",
  "einvoice.nat.gov.tw", "tstartel.com", "ctbcbank.com", "cathaybk.com.tw", "esunbank.com.tw", "fubon.com", "taishinbank.com.tw",
];
const BILL_SUBJECT = /(帳單|繳費通知|繳款通知|電費|水費|瓦斯費|電信費|費用通知|\bbill\b|\binvoice\b|statement)/i;

export interface RuleContext {
  schoolDomains: string[];
  timeZone: string;
  now: Date;
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
const localOf = (email: string) => email.split("@")[0]?.toLowerCase() ?? "";
const endsWithDomain = (domain: string, list: string[]) => list.some((item) => domain === item || domain.endsWith(`.${item}`));

/** Sent by a machine: List-Unsubscribe, a noreply-style address, or an automated domain. */
export function isAutomated(message: Pick<MailMessage, "from" | "listUnsubscribe" | "labels">): boolean {
  if (message.listUnsubscribe) return true;
  if (AUTOMATED_LOCAL.test(localOf(message.from.email))) return true;
  return GITHUB.test(domainOf(message.from.email));
}

/** Sent by the owner (Gmail labels it SENT). */
export const isMine = (message: Pick<MailMessage, "labels">) => message.labels.includes("SENT");

/** The digest bucket of non-actionable mail (Today .digest, SPEC-ux §4.4). */
export function isGitHubNotification(message: Pick<MailMessage, "from">): boolean {
  return GITHUB.test(domainOf(message.from.email));
}

/** First sentence-ish of the snippet, for the rule summary. */
export function ruleSummary(message: Pick<MailMessage, "snippet" | "subject">): string {
  const text = (message.snippet || message.subject).replace(/\s+/g, " ").trim();
  const sentence = /^(.{8,}?[。！？!?])(\s|$)/.exec(text)?.[1] ?? text;
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}

/** 「NT$599」「新台幣 1,299 元」「應繳金額：599 元」 → 599. */
export function findAmount(text: string): number | undefined {
  const patterns = [
    /NT\$\s?([\d,]+(?:\.\d+)?)/i,
    /(?:新台幣|新臺幣|TWD)\s*([\d,]+(?:\.\d+)?)/i,
    /(?:應繳|本期|繳費|帳單)?金額[：:\s]*\$?\s*([\d,]+(?:\.\d+)?)\s*元?/,
    /([\d,]+(?:\.\d+)?)\s*元/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0 && value < 10_000_000) return value;
  }
  return undefined;
}

/** 「繳費期限 10/20」「2026/10/20 前」「10月20日截止」 → the next such local day on or after the received day. */
export function findDueDay(text: string, receivedAt: string, timeZone: string): DayKey | undefined {
  const received = dayKey(timeZone, receivedAt);
  const year = zonedParts(timeZone, receivedAt).year;
  const near = /(?:繳費期限|繳款期限|繳費截止|截止日|期限|due)[^0-9]{0,8}((?:\d{4}[/.-])?\d{1,2}[/.-]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)/i.exec(text)
    ?? /((?:\d{4}[/.-])?\d{1,2}[/.-]\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)\s*(?:前|截止|到期)/.exec(text);
  if (!near) return undefined;
  const parts = near[1].match(/\d+/g)!.map(Number);
  const [y, m, d] = parts.length === 3 ? parts : [year, parts[0], parts[1]];
  const candidate = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (!isDayKey(candidate)) return undefined;
  if (parts.length === 2 && candidate < received) {
    const next = `${String(year + 1).padStart(4, "0")}-${candidate.slice(5)}`;
    return isDayKey(next) ? next : undefined;
  }
  return candidate < addDays(received, -31) ? undefined : candidate;
}

/** 「9 月」 from 「9 月電子帳單」 or 「九月份帳單」 (Arabic numerals only). */
function findPeriod(subject: string): string | undefined {
  const match = /(\d{1,2})\s*月份?/.exec(subject);
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 12 ? `${Number(match[1])} 月` : undefined;
}

/** Best-effort bill details from the subject and text (payee = the sender's name). */
export function ruleBill(message: MailMessage, timeZone: string): MailBill | undefined {
  const text = `${message.subject}\n${message.snippet}\n${message.excerpt ?? ""}`;
  const amount = findAmount(text);
  if (amount === undefined) return undefined;
  const payee = (message.from.name ?? domainOf(message.from.email)).replace(/(股份有限公司|有限公司|客服中心|電子帳單)$/u, "").trim() || message.from.email;
  const dueDay = findDueDay(text, message.receivedAt, timeZone);
  const period = findPeriod(message.subject);
  const autopay = /已(設定|申請)?自動扣繳|自動轉帳扣繳/.test(text) ? true : /(未|沒有)(設定|申請)?自動扣繳/.test(text) ? false : undefined;
  return {
    payee: payee.slice(0, 40), amount, currency: "TWD",
    ...(dueDay ? { dueDay } : {}), ...(period ? { period } : {}), ...(autopay !== undefined ? { autopay } : {}),
  };
}

/** The rule triage of one message (source "rule"). */
export function ruleTriage(message: MailMessage, context: RuleContext): MailTriage {
  const base = { summary: ruleSummary(message), source: "rule" as const, triagedAt: message.receivedAt };
  const labels = new Set(message.labels);
  const domain = domainOf(message.from.email);
  const automated = isAutomated(message);
  if (labels.has("CATEGORY_PROMOTIONS")) return { ...base, category: "promo", priority: "low", action: "archive" };
  if (isGitHubNotification(message)) return { ...base, category: "notification", priority: "low", action: "read" };
  if (endsWithDomain(domain, BILLERS) || (BILL_SUBJECT.test(message.subject) && !message.listUnsubscribe)) {
    const bill = ruleBill(message, context.timeZone);
    if (bill || endsWithDomain(domain, BILLERS)) return { ...base, category: "bill", priority: "medium", action: "todo", ...(bill ? { bill } : {}) };
  }
  if (message.listUnsubscribe) return { ...base, category: "newsletter", priority: "low", action: "read" };
  if (automated) return { ...base, category: "notification", priority: "low", action: "read" };
  if (labels.has("IMPORTANT") && !isMine(message)) return { ...base, category: "needs-reply", priority: "high", action: "reply" };
  if (endsWithDomain(domain, context.schoolDomains)) return { ...base, category: "school", priority: "low", action: "none" };
  if (labels.has("CATEGORY_UPDATES") || labels.has("CATEGORY_FORUMS") || labels.has("CATEGORY_SOCIAL"))
    return { ...base, category: "notification", priority: "low", action: "read" };
  if (!isMine(message)) return { ...base, category: "needs-reply", priority: "medium", action: "reply" };
  return { ...base, category: "other", priority: "low", action: "none" };
}

/** The triage the app uses: the AI's when it has one, otherwise the rules (recomputed with the current settings). */
export function effectiveTriage(message: MailMessage, context: RuleContext): MailTriage {
  return message.triage?.source === "ai" ? message.triage : ruleTriage(message, context);
}
