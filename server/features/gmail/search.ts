import { z } from "zod";
import { MAIL_SEARCH_LIMITS, MAIL_VIEWS, type InboxThread, type MailMessage, type MailSearchResponse, type MailView } from "../../../shared/mail.js";
import type { AiSuggestion } from "../../../shared/suggestions.js";
import { AppError } from "../../errors.js";
import { googleAccountEmail, googleCapabilities, googleConnected } from "../../google/auth.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { ResponseTooLargeError } from "../../sync.js";
import { GMAIL_ERRORS, GmailApi, liveFailure, mapLimit } from "./api.js";
import { cachedThreadRow, isHiddenMessage, liveThread, liveThreadRow, type InboxInput, type ThreadDetail } from "./inbox.js";
import type { LiveMail } from "./live.js";
import { normalizeOrHeaders, type GmailMessageResource } from "./parse.js";
import { cleanSearchText, gmailViewQuery } from "./views.js";

/**
 * GET /api/gmail/search (SPEC-mail-assignments §3.5, §4): one page of the
 * 封存 or 全部 view, or of a Gmail search in any view. messages.list with the
 * view's query (views.ts), the listed messages grouped by conversation in
 * Gmail's order (newest first); conversations in the cache use it (AI
 * summary, item state), the others are read whole with threads.get(format=
 * metadata), 4 at a time, so a row says where its conversation is rather than
 * where the matched message is, and held in memory for 5 minutes (live.ts). Nothing
 * is written to source_items, sync_state or the logs (the log line has the
 * view, the time, the row count and whether there was a query, never the
 * query). Without Gmail the answer is the cached mail of that view
 * (`origin: "cache"`), so the page never blanks.
 */

/** messages.list page size: about 20 conversations once messages of one conversation are grouped. */
export const SEARCH_PAGE_MESSAGES = 25;
/** Parallel threads.get / messages.get calls for a page (SPEC-mail-assignments §3.5). */
const METADATA_CONCURRENCY = 4;
/** Rows a cache-only answer returns at most. */
const CACHE_ROWS_MAX = 100;

export const searchQuerySchema = z.object({
  view: z.enum(MAIL_VIEWS).default("inbox"),
  q: z.string().default(""),
  pageToken: z.string().max(MAIL_SEARCH_LIMITS.pageToken).regex(/^[A-Za-z0-9_-]*$/).optional(),
});

export interface SearchDeps {
  live: LiveMail;
  /** The inbox list's inputs (item state, classification context, source state). */
  input: () => Promise<InboxInput>;
}

/** Whether interactive Gmail reads can run: connected with gmail.modify and not waiting for a reconnect. */
export async function gmailReady(ctx: ModuleContext, input: Pick<InboxInput, "source">): Promise<boolean> {
  if (input.source.state === "reconnect") return false;
  return (await googleConnected(ctx)) && (await googleCapabilities(ctx)).gmail;
}

export async function searchMail(ctx: ModuleContext, deps: SearchDeps, query: unknown): Promise<MailSearchResponse> {
  const parsed = searchQuerySchema.safeParse(query);
  if (!parsed.success) throw new AppError(400, "搜尋條件格式不正確。");
  const { view, pageToken } = parsed.data;
  if (Array.from(parsed.data.q.trim()).length > MAIL_SEARCH_LIMITS.query) throw new AppError(400, GMAIL_ERRORS.queryTooLong);
  const q = cleanSearchText(parsed.data.q);
  const started = Date.now();
  const input = await deps.input();
  const answer = (body: MailSearchResponse) => {
    logEvent("gmail.search", { view, ms: Date.now() - started, rows: body.threads.length, hasQuery: !!q, origin: body.origin, page: !!pageToken });
    return body;
  };

  if (!(await gmailReady(ctx, input))) {
    if (!input.source.connected) deps.live.clear();
    return answer({ view, q, threads: cachedRows(input, view, q), origin: "cache", source: input.source });
  }
  try {
    const page = await livePage(ctx, deps, input, view, q, pageToken);
    return answer({ view, q, ...page, origin: "gmail", source: input.source });
  } catch (error) {
    // 載入更多 reports its own failure (the toast); page one falls back to the cache with the reason.
    if (pageToken) throw error instanceof AppError && error.status === 400 ? error : new AppError(error instanceof AppError && error.status === 429 ? 429 : 502, liveFailure(error));
    logEvent("gmail.search_failed", { view, errorClass: error instanceof Error ? error.name : typeof error, ...(error instanceof AppError ? { status: error.status } : {}) });
    return answer({ view, q, threads: cachedRows(input, view, q), origin: "cache", error: liveFailure(error), source: input.source });
  }
}

async function livePage(ctx: ModuleContext, deps: SearchDeps, input: InboxInput, view: MailView, q: string, pageToken: string | undefined): Promise<Pick<MailSearchResponse, "threads" | "nextPageToken">> {
  const api = GmailApi.withSignal(ctx, AbortSignal.timeout(30_000));
  const page = await api.listPage(gmailViewQuery(view, q), { maxResults: SEARCH_PAGE_MESSAGES, pageToken });
  // Gmail's order, one entry per conversation (its first, newest, listed message stands in when the conversation cannot be read whole).
  const firsts = new Map<string, string>();
  for (const item of page.messages) if (!firsts.has(item.threadId)) firsts.set(item.threadId, item.id);

  const byThread = new Map<string, MailMessage[]>();
  for (const message of input.messages) byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message]);
  // Gmail lists messages, but a row is a conversation: where it is (an inbox reply to an archived thread, my own
  // newest reply) and which message is its row come from all of its messages, like the reader's (liveConversation).
  const missing = [...firsts].filter(([threadId]) => !byThread.has(threadId) && !deps.live.listed(threadId));
  if (missing.length) {
    const account = await googleAccountEmail(ctx);
    await mapLimit(missing, METADATA_CONCURRENCY, async ([threadId, messageId]) => {
      const messages = await conversationMetadata(api, threadId, messageId, account);
      if (messages?.length) deps.live.putListed(threadId, messages);
    });
  }

  const threads: InboxThread[] = [];
  for (const [threadId] of firsts) {
    const cached = byThread.get(threadId);
    if (cached) {
      // The cache knows best where a cached conversation is now (an archive or 移回 waiting for its commit included).
      if (cached.every(isHiddenMessage)) continue;
      const row = cachedThreadRow(input, threadId, cached);
      if (row && fitsView(row, view)) threads.push(row);
      continue;
    }
    const listed = deps.live.listed(threadId);
    const row = listed ? liveThreadRow(input, threadId, listed) : undefined;
    // 封存 drops a conversation that turns out to be in the inbox (an older archived message matched).
    if (row && fitsView(row, view)) threads.push(row);
  }
  return { threads, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
}

/**
 * Every message of a conversation as metadata (threads.get format=metadata:
 * labels and the headers the cache keeps, never text). A conversation too
 * big for one answer falls back to the listed message alone; undefined when
 * Gmail no longer has it.
 */
async function conversationMetadata(api: GmailApi, threadId: string, messageId: string, account: string | undefined): Promise<MailMessage[] | undefined> {
  try {
    const resource = await api.thread(threadId, "metadata");
    return resource?.messages.map((item) => normalizeOrHeaders(item, account));
  } catch (error) {
    if (!(error instanceof ResponseTooLargeError)) throw error;
    logEvent("gmail.thread_too_large", { format: "metadata" });
    const resource = await api.message(messageId, "metadata");
    return resource ? [normalizeOrHeaders(resource, account)] : undefined;
  }
}

/** 封存 lists archived conversations only, 收件匣 inbox ones; 全部 both. */
const fitsView = (row: InboxThread, view: MailView) => view === "all" || row.location === view;

/**
 * The cache-only answer (Gmail not connected, needs a reconnect, or failed):
 * the cached conversations of the view, newest first, matching every literal
 * term of the query (Gmail operators are left to Gmail).
 */
export function cachedRows(input: InboxInput, view: MailView, q: string): InboxThread[] {
  const terms = literalTerms(q);
  const byThread = new Map<string, MailMessage[]>();
  for (const message of input.messages) byThread.set(message.threadId, [...(byThread.get(message.threadId) ?? []), message]);
  const rows: InboxThread[] = [];
  for (const [threadId, messages] of byThread) {
    if (messages.every(isHiddenMessage)) continue;
    const row = cachedThreadRow(input, threadId, messages);
    if (!row || !fitsView(row, view)) continue;
    if (terms.length && !matchesTerms(row, terms)) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.threadId.localeCompare(b.threadId)).slice(0, CACHE_ROWS_MAX);
}

/** The literal words of a query (NFKC, lower case): `word:value` operators, `-term` and OR / AND are Gmail's. */
export function literalTerms(q: string): string[] {
  return q.normalize("NFKC").toLowerCase().split(/\s+/)
    .map((term) => term.replace(/^["'(]+|["')]+$/g, ""))
    .filter((term) => term && !term.startsWith("-") && !/^[a-z_]+:/.test(term) && term !== "or" && term !== "and");
}

function matchesTerms(row: InboxThread, terms: string[]): boolean {
  const haystack = [row.subject, row.title, row.from.name ?? "", row.from.email, row.summary ?? "", row.snippet ?? ""].join("\n").normalize("NFKC").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** The reader keeps the newest messages of a long conversation; Gmail has the rest. */
export const LIVE_THREAD_MESSAGES = 20;

/**
 * The reader of a conversation outside the cache (SPEC-mail-assignments §3.5
 * step 5): threads.get(format=full), plain text only through the sync's
 * parser, held in memory for 5 minutes. 404 when Gmail no longer has it or
 * it is only spam; a conversation in the trash opens (its reader offers
 * 移回收件匣, like a cached one).
 */
export async function readLiveThread(ctx: ModuleContext, deps: SearchDeps, input: InboxInput, threadId: string, suggestions: AiSuggestion[]): Promise<ThreadDetail> {
  let messages = deps.live.thread(threadId);
  if (!messages) {
    const fetched = await fetchConversation(GmailApi.withSignal(ctx, AbortSignal.timeout(20_000)), threadId, await googleAccountEmail(ctx));
    if (!fetched?.length) throw new AppError(404, GMAIL_ERRORS.gone);
    messages = fetched;
    deps.live.putThread(threadId, messages);
  }
  const detail = liveThread(input, threadId, messages, suggestions);
  if (detail) return detail;
  const kept = messages.filter((message) => !message.labels.includes("DRAFT"));
  throw new AppError(404, kept.length && kept.every(isHiddenMessage) ? GMAIL_ERRORS.spam : GMAIL_ERRORS.gone);
}

/**
 * A conversation's newest messages with their plain text. One threads.get
 * (format=full) when it fits the response cap; a conversation too big for
 * that (long quoted HTML chains) is listed with threads.get(format=minimal)
 * and its newest messages are read one by one, each falling back to its
 * headers when it alone is too big, as the sync does (one message never
 * stalls the reader).
 */
async function fetchConversation(api: GmailApi, threadId: string, account: string | undefined): Promise<MailMessage[] | undefined> {
  const newest = (items: GmailMessageResource[]) => items.filter((item) => !(item.labelIds ?? []).includes("DRAFT")).slice(-LIVE_THREAD_MESSAGES);
  try {
    const resource = await api.thread(threadId, "full");
    return resource ? newest(resource.messages).map((item) => normalizeOrHeaders(item, account)) : undefined;
  } catch (error) {
    if (!(error instanceof ResponseTooLargeError)) throw error;
  }
  logEvent("gmail.thread_too_large", { format: "full" });
  const listing = await api.thread(threadId, "minimal");
  if (!listing) return undefined;
  const resources = await mapLimit(newest(listing.messages), METADATA_CONCURRENCY, async (item) => {
    try {
      return await api.message(item.id, "full");
    } catch (error) {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      logEvent("gmail.message_too_large", {});
      return api.message(item.id, "metadata");
    }
  });
  return resources.flatMap((resource) => (resource ? [normalizeOrHeaders(resource, account)] : []));
}
