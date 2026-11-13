import { AppError } from "../../errors.js";
import { googleClient } from "../../google/auth.js";
import type { ModuleContext } from "../../modules.js";
import { expectOk, needsReconnect, ReconnectRequiredError, ResponseTooLargeError, safeFetch, type HttpRequestInit, type HttpResponse } from "../../sync.js";
import type { GmailMessageResource } from "./parse.js";

/**
 * A thin Gmail REST v1 client. Every request goes through safeFetch (HTTPS
 * only, redirects refused, deadline, body cap) with the injected fetch, and
 * the bearer token comes from googleClient(ctx), which refreshes it through
 * the same fetch and stores it in the vault. Tests answer these URLs with a
 * fake fetch; nothing here talks to Google on its own.
 */

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const LABEL = "Gmail";
/** The headers normalizeMessage reads, for a format=metadata fallback. */
const METADATA_HEADERS = ["From", "Subject", "Date", "List-Unsubscribe"];

export type Http = (url: string | URL, init?: HttpRequestInit) => Promise<HttpResponse>;

/** zh-TW messages for the interactive Gmail reads and writes (SPEC-mail-assignments §7.5). */
export const GMAIL_ERRORS = {
  notConnected: "Gmail 尚未連接，信件沒有變動。請到「連線與設定」連接 Google。",
  rateLimited: "Gmail 暫時限制讀取次數，請過一分鐘再試。",
  pageExpired: "搜尋結果已經過期，請重新搜尋。",
  queryTooLong: "搜尋文字太長了，請少於 200 個字。",
  gone: "這封信已經不在 Gmail，可能已被永久刪除。",
  notCached: "找不到這封信，可能已經封存或超過保留天數。",
  messageMissing: "找不到這封信，可能已經被刪除。請重新整理後再試。",
  alreadyInbox: "這封信已經在收件匣了。",
  alreadyTrash: "這封信已經在垃圾桶了。",
  spam: "這封信在垃圾郵件裡，請到 Gmail 查看。",
  reconnect: "Gmail 需要重新連線，請到「連線與設定」重新連線 Google。",
  unreachable: "無法連線到 Gmail，請稍後再試。",
} as const;

/** Gmail's per-user limits answer 429, or 403 with reason rateLimitExceeded / userRateLimitExceeded. */
function throwIfRateLimited(response: HttpResponse): void {
  if (response.status === 429) throw new AppError(429, GMAIL_ERRORS.rateLimited);
  if (response.status !== 403) return;
  let reasons: string[] = [];
  try {
    const body = JSON.parse(response.text()) as { error?: { errors?: Array<{ reason?: string }>; status?: string } };
    reasons = [...(body.error?.errors ?? []).map((item) => String(item.reason ?? "")), String(body.error?.status ?? "")];
  } catch { /* not JSON: an ordinary 403 */ }
  if (reasons.some((reason) => /rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reason))) throw new AppError(429, GMAIL_ERRORS.rateLimited);
}

/**
 * Why an interactive Gmail read failed, as one zh-TW sentence for a notice
 * (the sync's own messages promise an automatic retry, which a search does not make).
 */
export function liveFailure(error: unknown): string {
  if (needsReconnect(error)) return GMAIL_ERRORS.reconnect;
  if (error instanceof AppError) {
    if (error.status === 429) return GMAIL_ERRORS.rateLimited;
    if (error.status === 502 || error.status === 504) {
      return error.message
        .replace(/，?稍後會自動重試。$/, "，請稍後再試。")
        .replace(/^無法連線到來源，請稍後再試。$/, GMAIL_ERRORS.unreachable)
        .replace(/^來源回應逾時/, "Gmail 回應逾時");
    }
    return error.message;
  }
  return GMAIL_ERRORS.unreachable;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }>;
  messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
  labelsAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] }; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message: { id: string; threadId: string; labelIds?: string[] }; labelIds?: string[] }>;
}

export interface GmailHistoryPage {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

/** history.list answered 404: the stored historyId is too old, do a full sync. */
export class HistoryExpiredError extends Error {
  constructor() { super("Gmail history expired"); this.name = "HistoryExpiredError"; }
}

export class GmailApi {
  private token: string | undefined;

  constructor(private readonly ctx: Pick<ModuleContext, "config" | "vault" | "fetch" | "now">, private readonly http: Http) {}

  /** An API bound to one signal (SyncContext.http, or an action's commit signal). */
  static withSignal(ctx: Pick<ModuleContext, "config" | "vault" | "fetch" | "now">, signal: AbortSignal): GmailApi {
    return new GmailApi(ctx, (url, init) => safeFetch(ctx.fetch, url, signal, init));
  }

  /** The bearer token; `fresh` drops the cached access token so the refresh token is used. */
  private async authorization(fresh = false): Promise<string> {
    if (!this.token || fresh) {
      const client = await googleClient(this.ctx);
      if (fresh) client.setCredentials({ refresh_token: client.credentials.refresh_token });
      const { token } = await client.getAccessToken();
      if (!token) throw new ReconnectRequiredError("Google 沒有提供存取權杖，請到「連線與設定」重新連線 Google。");
      this.token = token;
    }
    return `Bearer ${this.token}`;
  }

  /** One Gmail call; a 401 is retried once with a refreshed token before it means 需要重新連線. */
  private async request(path: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    const send = async (fresh: boolean) => this.http(`${GMAIL_API}${path}`, {
      ...init,
      headers: { authorization: await this.authorization(fresh), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const response = await send(false);
    return response.status === 401 ? send(true) : response;
  }

  async profile(): Promise<{ emailAddress?: string; historyId: string }> {
    const body = expectOk(await this.request("/profile"), LABEL).json<{ emailAddress?: string; historyId?: string }>();
    if (!body.historyId) throw new AppError(502, "Gmail 回傳的資料格式不正確。");
    return { ...(body.emailAddress ? { emailAddress: body.emailAddress } : {}), historyId: String(body.historyId) };
  }

  /** messages.list: ids matching `q`, at most `max` across pages. */
  async listIds(q: string, max: number): Promise<Array<{ id: string; threadId: string }>> {
    const found: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, maxResults: String(Math.min(100, max - found.length)) });
      if (pageToken) params.set("pageToken", pageToken);
      const body = expectOk(await this.request(`/messages?${params}`), LABEL)
        .json<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>();
      found.push(...(body.messages ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken && found.length < max);
    return found.slice(0, max);
  }

  /** messages.get; undefined when the message is gone (404). `metadata` asks only for the headers the cache keeps. */
  async message(id: string, format: "full" | "minimal" | "metadata" = "full"): Promise<GmailMessageResource | undefined> {
    const params = new URLSearchParams({ format });
    if (format === "metadata") for (const name of METADATA_HEADERS) params.append("metadataHeaders", name);
    const response = await this.request(`/messages/${encodeURIComponent(id)}?${params}`);
    if (response.status === 404) return undefined;
    return expectOk(response, LABEL).json<GmailMessageResource>();
  }

  /**
   * messages.attachments.get: one part's bytes (an inline image, an image
   * attachment, or an HTML body Gmail left out of format=full). The JSON
   * answer carries base64url, so its cap is the decoded cap plus a third;
   * undefined when Gmail no longer has it (404) or the id is stale (400). Gmail's attachment ids
   * change from one messages.get to the next, so callers look the id up in a
   * fresh (≤ 5 minutes old) read of the message.
   */
  async attachment(messageId: string, attachmentId: string, maxBytes: number): Promise<Buffer | undefined> {
    const response = await this.request(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {
      maxBytes: Math.ceil(maxBytes * 4 / 3) + 4096,
    });
    // 404: gone; 400: an attachment id from an older read of the message (Gmail issues new ones per read).
    if (response.status === 404 || response.status === 400) return undefined;
    throwIfRateLimited(response);
    const body = expectOk(response, LABEL).json<{ data?: string }>();
    if (typeof body.data !== "string") throw new AppError(502, "Gmail 回傳的資料格式不正確。");
    const bytes = Buffer.from(body.data, "base64url");
    if (bytes.length > maxBytes) throw new ResponseTooLargeError();
    return bytes;
  }

  /** history.list from a stored historyId; throws HistoryExpiredError on 404. */
  async history(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage> {
    const params = new URLSearchParams({ startHistoryId, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await this.request(`/history?${params}`);
    if (response.status === 404) throw new HistoryExpiredError();
    return expectOk(response, LABEL).json<GmailHistoryPage>();
  }

  /**
   * One page of messages.list for #/inbox's 封存, 全部 and search
   * (SPEC-mail-assignments §3.5): `q` in the Gmail search-box syntax,
   * `maxResults` ids at most, `pageToken` from the previous page. An
   * expired or foreign page token (400) and Gmail's rate limits (429, or 403
   * rateLimitExceeded) become zh-TW AppErrors the route answers as they are.
   */
  async listPage(q: string, options: { maxResults: number; pageToken?: string }): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken?: string }> {
    const params = new URLSearchParams({ q, maxResults: String(options.maxResults) });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const response = await this.request(`/messages?${params}`);
    if (response.status === 400 && options.pageToken) throw new AppError(400, GMAIL_ERRORS.pageExpired);
    throwIfRateLimited(response);
    const body = expectOk(response, LABEL).json<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>();
    return {
      messages: (body.messages ?? []).filter((item) => typeof item?.id === "string" && typeof item?.threadId === "string"),
      ...(body.nextPageToken ? { nextPageToken: String(body.nextPageToken) } : {}),
    };
  }

  /** threads.get; undefined when Gmail no longer has the conversation (404). */
  async thread(threadId: string, format: "full" | "minimal" | "metadata" = "full"): Promise<{ id: string; messages: GmailMessageResource[] } | undefined> {
    const params = new URLSearchParams({ format });
    if (format === "metadata") for (const name of METADATA_HEADERS) params.append("metadataHeaders", name);
    const response = await this.request(`/threads/${encodeURIComponent(threadId)}?${params}`);
    if (response.status === 404) return undefined;
    throwIfRateLimited(response);
    const body = expectOk(response, LABEL).json<{ id?: string; messages?: GmailMessageResource[] }>();
    return { id: String(body.id ?? threadId), messages: body.messages ?? [] };
  }

  /** threads.modify: one conversation at once, like Gmail's own archive and mark-read. */
  async modifyThread(threadId: string, change: { add?: string[]; remove?: string[] }): Promise<void> {
    const response = await this.request(`/threads/${encodeURIComponent(threadId)}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] }),
    });
    if (response.status === 404) return; // The conversation was deleted meanwhile: nothing left to change.
    expectOk(response, LABEL);
  }

  /**
   * threads.trash (刪除): the whole conversation moves to Gmail's trash, which
   * Gmail empties after 30 days. The reference says the request body must be
   * empty. BELL never calls messages.delete or threads.delete.
   */
  async trashThread(threadId: string): Promise<void> {
    const response = await this.request(`/threads/${encodeURIComponent(threadId)}/trash`, { method: "POST" });
    if (response.status === 404) return;
    expectOk(response, LABEL);
  }

  /** threads.untrash (復原 after the commit); the body must be empty as well. */
  async untrashThread(threadId: string): Promise<void> {
    const response = await this.request(`/threads/${encodeURIComponent(threadId)}/untrash`, { method: "POST" });
    if (response.status === 404) return;
    expectOk(response, LABEL);
  }

  /**
   * messages.untrash (復原 of 刪除 after the commit): one message out of the
   * trash, so a message the owner deleted on its own stays deleted. The
   * request body must be empty.
   */
  async untrashMessage(id: string): Promise<void> {
    const response = await this.request(`/messages/${encodeURIComponent(id)}/untrash`, { method: "POST" });
    if (response.status === 404) return;
    expectOk(response, LABEL);
  }

  /** messages.batchModify in chunks of 1000 ids (digest 全部標為已讀). */
  async batchModify(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void> {
    for (let index = 0; index < ids.length; index += 1000) {
      expectOk(await this.request("/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({ ids: ids.slice(index, index + 1000), addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] }),
      }), LABEL);
    }
  }
}

/** Runs `task` over `items` with at most `limit` in flight (batched messages.get). */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
