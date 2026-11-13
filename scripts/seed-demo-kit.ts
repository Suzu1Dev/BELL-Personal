import { MAIL_TRIAGE_VERSION, type MailMessage, type MailTriage } from "../shared/mail.js";
import { addDays, todayKey, zonedTimeToUtc, type DayKey } from "../shared/time.js";

/**
 * The helpers every part of the demo seed shares: times relative to --now in
 * the seed's zone, and the Gmail message and triage builders. The mail and
 * assignments teams' seed files (seed-demo-mail.ts, seed-demo-assignments.ts)
 * build their rows with it, so scripts/seed-demo.ts stays the only file that
 * writes the shared Gmail cache.
 */
export interface SeedKit {
  now: Date;
  timeZone: string;
  /** Today's local day. */
  day: DayKey;
  /** Local wall time `offset` days from today, as an ISO instant. */
  at(offset: number, time: string): string;
  /** `minutes` before now, as an ISO instant. */
  ago(minutes: number): string;
  /** 「10/20」 for the day `offset` days from today. */
  md(offset: number): string;
  gmailUrl(id: string): string;
  /** An unread inbox message (labels INBOX, UNREAD) unless `rest` says otherwise. */
  mail(id: string, from: MailMessage["from"], subject: string, receivedAt: string, rest: Partial<MailMessage>): MailMessage;
  /** An AI triage made 30 minutes ago. */
  triage(category: MailTriage["category"], summary: string, extra?: Partial<MailTriage>): MailTriage;
}

export function seedKit({ now, timeZone }: { now: Date; timeZone: string }): SeedKit {
  const day = todayKey(timeZone, now);
  const at = (offset: number, time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return zonedTimeToUtc(timeZone, addDays(day, offset), hour, minute).toISOString();
  };
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const md = (offset: number) => { const [, month, date] = addDays(day, offset).split("-").map(Number); return `${month}/${date}`; };
  const gmailUrl = (id: string) => `https://mail.google.com/mail/u/0/#inbox/${id}`;
  return {
    now, timeZone, day, at, ago, md, gmailUrl,
    mail: (id, from, subject, receivedAt, rest) => ({
      id, threadId: id, from, subject, snippet: rest.snippet ?? subject, receivedAt, unread: true,
      labels: ["INBOX", "UNREAD"], webUrl: gmailUrl(id), ...rest,
    }),
    triage: (category, summary, extra = {}) => ({ summary, category, priority: "low", action: "read", source: "ai", triagedAt: ago(30), version: MAIL_TRIAGE_VERSION, ...extra }),
  };
}
