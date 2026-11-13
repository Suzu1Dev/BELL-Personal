import type { MailMessage } from "../../../shared/mail.js";
import { dayKey } from "../../../shared/time.js";
import { googleAccountEmail, googleCapabilities, googleConnected } from "../../google/auth.js";
import { forgetMailDerivedData } from "../../google/forget.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { ResponseTooLargeError, SourceSync, type SyncContext, type SyncOutcome } from "../../sync.js";
import { GmailApi, HistoryExpiredError, mapLimit, type GmailHistoryRecord } from "./api.js";
import { normalizeMessage, withLabels, type GmailMessageResource } from "./parse.js";
import { classifyThread, latestByThread } from "./classify.js";
import { isMine } from "./rules.js";
import type { MailStore } from "./store.js";

export const GMAIL_SYNC_INTERVAL_MS = 2 * 60_000;
/** The first full sync looks this far back (or less, when the retention setting is shorter). */
export const FULL_SYNC_DAYS = 14;
/** Messages fetched by one full sync at most. */
export const FULL_SYNC_MAX = 300;
/** History pages read by one incremental sync before falling back to a full sync. */
const HISTORY_MAX_PAGES = 20;
/** Parallel messages.get calls (Gmail allows 250 quota units/s; a get costs 5). */
const FETCH_CONCURRENCY = 8;
/** New mail received within this window is queued for AI triage; older backlog keeps the rules. */
export const TRIAGE_WINDOW_DAYS = 7;
const DAY = 86_400_000;

export interface GmailSyncOptions {
  intervalMs?: number;
  /** Called after every successful sync (the triage queue starts a batch). */
  onSynced?: () => void;
}

/**
 * The `gmail` source. The first run (or a run after Gmail forgot our
 * historyId, HTTP 404) lists `in:inbox newer_than:14d` and fetches each
 * message (format=full, parsed down to metadata and a plain-text excerpt);
 * later runs read history.list from the stored historyId every 2 minutes.
 * Every run applies the retention setting and closes 回覆中… rows whose
 * thread now has a message sent by the owner.
 */
export class GmailSync extends SourceSync {
  private readonly onSynced?: () => void;
  /** The connected address, read at the start of every run (Gmail links open that account). */
  account: string | undefined;

  constructor(private readonly ctx: ModuleContext, private readonly store: MailStore, options: GmailSyncOptions = {}) {
    super({ id: "gmail", state: ctx.syncState, intervalMs: options.intervalMs ?? GMAIL_SYNC_INTERVAL_MS, fetch: ctx.fetch, now: ctx.now });
    this.onSynced = options.onSynced;
  }

  async configured(): Promise<boolean> {
    return (await googleConnected(this.ctx)) && (await googleCapabilities(this.ctx)).gmail;
  }

  protected async run(context: SyncContext): Promise<SyncOutcome> {
    this.account = await googleAccountEmail(this.ctx);
    const api = new GmailApi(this.ctx, context.http);
    let cursor: string;
    if (context.cursor) {
      try {
        cursor = await this.incremental(api, context.cursor, context);
      } catch (error) {
        if (!(error instanceof HistoryExpiredError)) throw error;
        logEvent("gmail.history_expired", {});
        cursor = await this.full(api, context);
      }
    } else {
      cursor = await this.full(api, context);
    }
    this.prune(context.now);
    this.store.relink(this.account);
    try { this.onSynced?.(); } catch { /* the triage queue reports its own problems */ }
    return { items: this.store.count(), cursor };
  }

  /** The retention window (mail.retentionDays): older cached mail is deleted. */
  private prune(now: Date): void {
    const days = this.ctx.settings.value("mail.retentionDays");
    const cutoff = new Date(now.getTime() - days * DAY).toISOString();
    const old = this.store.all().filter((message) => message.receivedAt < cutoff).map((message) => message.id);
    // Their suggestions, queue state and handled-list subjects leave with them (/privacy retention).
    forgetMailDerivedData(this.ctx, old);
    const removed = this.store.remove(old) + this.ctx.sourceItems.pruneFetchedBefore("gmail", cutoff);
    if (removed) logEvent("gmail.pruned", { removed });
  }

  private async full(api: GmailApi, context: SyncContext): Promise<string> {
    const { historyId } = await api.profile();
    const days = Math.max(1, Math.min(FULL_SYNC_DAYS, this.ctx.settings.value("mail.retentionDays")));
    const listed = await api.listIds(`in:inbox newer_than:${days}d`, FULL_SYNC_MAX);
    context.signal.throwIfAborted();
    const fetched = await this.fetchMessages(api, listed.map((item) => item.id), context);
    // Cached inbox mail that is no longer in the inbox (archived elsewhere) gets its labels refreshed.
    const listedIds = new Set(listed.map((item) => item.id));
    const missing = this.store.inbox().filter((message) => !listedIds.has(message.id) && message.receivedAt >= new Date(context.now.getTime() - days * DAY).toISOString());
    const refreshed = (await mapLimit(missing, FETCH_CONCURRENCY, (message) => api.message(message.id, "minimal")))
      .map((resource, index) => (resource ? withLabels(missing[index], resource.labelIds ?? []) : undefined));
    const gone = missing.filter((_message, index) => !refreshed[index]).map((message) => message.id);
    this.store.put([...fetched, ...refreshed.filter((message): message is MailMessage => !!message)]);
    this.forget(gone);
    // Replies sent from Gmail: one list of recent sent mail, matched against cached threads.
    const sent = await api.listIds(`in:sent newer_than:${days}d`, FULL_SYNC_MAX);
    const threads = new Set(this.store.inbox().map((message) => message.threadId));
    const relevant = sent.filter((item) => threads.has(item.threadId));
    const sentResources = await mapLimit(relevant, FETCH_CONCURRENCY, (item) => api.message(item.id, "minimal"));
    for (const resource of sentResources) if (resource) this.noteReply(resource.threadId, sentAt(resource, context.now));
    logEvent("gmail.full_sync", { listed: listed.length, fetched: fetched.length });
    return historyId;
  }

  private async incremental(api: GmailApi, startHistoryId: string, context: SyncContext): Promise<string> {
    const records: GmailHistoryRecord[] = [];
    let pageToken: string | undefined;
    let latest = startHistoryId;
    let pages = 0;
    do {
      const page = await api.history(startHistoryId, pageToken);
      records.push(...(page.history ?? []));
      if (page.historyId) latest = String(page.historyId);
      pageToken = page.nextPageToken;
      if (++pages >= HISTORY_MAX_PAGES && pageToken) throw new HistoryExpiredError();
    } while (pageToken);

    // The final labels of every message the history touched, in order.
    const labels = new Map<string, { threadId: string; labelIds: string[] }>();
    const deleted = new Set<string>();
    const added = new Set<string>();
    // The history.list reference only promises id and threadId on these messages;
    // when labelIds is missing, the current labels are looked up below.
    const unknown = new Set<string>();
    const touch = (message: { id: string; threadId: string; labelIds?: string[] }) => {
      if (message.labelIds) { labels.set(message.id, { threadId: message.threadId, labelIds: message.labelIds }); unknown.delete(message.id); }
      else { labels.set(message.id, { threadId: message.threadId, labelIds: [] }); unknown.add(message.id); }
    };
    for (const record of records) {
      for (const entry of record.messagesAdded ?? []) {
        touch(entry.message);
        added.add(entry.message.id);
        deleted.delete(entry.message.id);
      }
      for (const entry of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) touch(entry.message);
      for (const entry of record.messagesDeleted ?? []) { deleted.add(entry.message.id); labels.delete(entry.message.id); unknown.delete(entry.message.id); }
    }
    const lookups = [...unknown];
    const current = await mapLimit(lookups, FETCH_CONCURRENCY, (id) => api.message(id, "minimal"));
    lookups.forEach((id, index) => {
      const resource = current[index];
      if (resource) labels.set(id, { threadId: resource.threadId, labelIds: resource.labelIds ?? [] });
      else { labels.delete(id); deleted.add(id); }   // gone since the history was written
    });
    context.signal.throwIfAborted();

    const updates: MailMessage[] = [];
    const toFetch: string[] = [];
    const sentInThreads: Array<{ id: string; threadId: string }> = [];
    for (const [id, change] of labels) {
      const cached = this.store.get(id);
      if (change.labelIds.includes("SENT")) {
        if (added.has(id)) sentInThreads.push({ id, threadId: change.threadId });
        if (!change.labelIds.includes("INBOX")) continue;
      }
      if (cached) updates.push(withLabels(cached, change.labelIds));
      else if (change.labelIds.includes("INBOX")) toFetch.push(id);
    }
    const fetched = await this.fetchMessages(api, toFetch, context);
    this.store.put([...updates, ...fetched]);
    this.forget([...deleted]);

    const threads = new Set(this.store.all().map((message) => message.threadId));
    for (const item of sentInThreads.filter((entry) => threads.has(entry.threadId))) {
      const resource = await api.message(item.id, "minimal");
      if (resource) this.noteReply(item.threadId, sentAt(resource, context.now));
    }
    if (records.length) logEvent("gmail.incremental_sync", { records: records.length, fetched: fetched.length, updated: updates.length, deleted: deleted.size });
    return latest;
  }

  /**
   * Fetches, parses and merges new messages; previously cached ones keep their
   * triage and reply state. One message cannot stall the mailbox: a format=full
   * answer over the size cap is fetched again as headers only (no excerpt).
   */
  private async fetchMessages(api: GmailApi, ids: string[], context: SyncContext): Promise<MailMessage[]> {
    const resources = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
      context.signal.throwIfAborted();
      try {
        return await api.message(id, "full");
      } catch (error) {
        if (!(error instanceof ResponseTooLargeError)) throw error;
        logEvent("gmail.message_too_large", {});
        return api.message(id, "metadata");
      }
    });
    const triageFrom = new Date(context.now.getTime() - TRIAGE_WINDOW_DAYS * DAY).toISOString();
    return resources.flatMap((resource) => {
      if (!resource) return [];
      const fresh = this.parse(resource);
      const cached = this.store.get(fresh.id);
      if (cached) {
        const { triage, triageQueue, repliedAt } = cached;
        return [{ ...fresh, ...(triage ? { triage } : {}), ...(triageQueue ? { triageQueue } : {}), ...(repliedAt ? { repliedAt } : {}) }];
      }
      const queue = fresh.labels.includes("INBOX") && !isMine(fresh) && fresh.receivedAt >= triageFrom;
      return [{ ...fresh, ...(queue ? { triageQueue: { state: "pending" as const, attempts: 0, updatedAt: context.now.toISOString() } } : {}) }];
    });
  }

  /** normalizeMessage, or the headers alone when the body cannot be parsed. */
  private parse(resource: GmailMessageResource): MailMessage {
    try {
      return normalizeMessage(resource, this.account);
    } catch (error) {
      logEvent("gmail.message_unparsed", { errorClass: error instanceof Error ? error.name : typeof error });
      return normalizeMessage({ ...resource, payload: { headers: resource.payload?.headers ?? [] } }, this.account);
    }
  }

  /** The source deleted these messages: drop them and their queue state. */
  private forget(ids: string[]): void {
    for (const id of ids) this.ctx.itemState.clear(`gmail:${id}`);
    this.store.remove(ids);
  }

  /**
   * The owner sent a message in this thread at `at`: every earlier message
   * from someone else is replied, and a reply row for the thread closes as
   * handled (回覆), whether the reply started from BELL or in Gmail. Only a
   * row that was open counts: a follow-up in a thread answered (or handled)
   * on an earlier day closes nothing today.
   */
  noteReply(threadId: string, at: string): void {
    const messages = this.store.thread(threadId);
    const answered = messages.filter((message) => !isMine(message) && message.receivedAt <= at && (!message.repliedAt || message.repliedAt < at));
    if (!answered.length) return;
    const settings = this.ctx.settings.get();
    const context = { schoolDomains: settings["mail.schoolDomains"], timeZone: this.ctx.config.timeZone, now: this.ctx.now() };
    const [before] = latestByThread(messages.filter((message) => message.labels.includes("INBOX")));
    const beforeRow = before ? classifyThread(before, context) : undefined;
    const beforeState = before ? this.ctx.itemState.get(`gmail:${before.latest.id}`)?.state : undefined;
    const wasOpen = !!beforeRow && beforeRow.kind === "mail.reply" && beforeRow.queueable && beforeState !== "handled" && beforeState !== "dismissed";
    this.store.put(answered.map((message) => ({ ...message, repliedAt: at })));
    const [thread] = latestByThread(this.store.thread(threadId).filter((message) => message.labels.includes("INBOX")));
    if (!thread || thread.latest.receivedAt > at) return;
    const row = classifyThread(thread, context);
    const itemId = `gmail:${thread.latest.id}`;
    // Only a reply sent today counts as handled today; older replies (a first sync) just close the row.
    const sentToday = dayKey(this.ctx.config.timeZone, at) === this.ctx.today();
    if (row.kind === "mail.reply" && sentToday && wasOpen && before!.latest.id === thread.latest.id) {
      this.ctx.itemState.markHandled({ itemId, kind: "mail.reply", title: thread.latest.subject, action: "reply" });
    } else if (this.ctx.itemState.get(itemId)?.state === "replying") {
      // The reply is out (from the inbox on mail that was never a queue row, or before today): nothing to count.
      this.ctx.itemState.clear(itemId);
    }
  }
}

/** When a sent message left: internalDate, else now. */
function sentAt(resource: { internalDate?: string }, now: Date): string {
  const value = Number(resource.internalDate);
  return new Date(Number.isFinite(value) && value > 0 ? value : now.getTime()).toISOString();
}
