import { SOURCE_LABELS, type SourceId, type SourceState, type SourceStatus } from "../shared/sources.js";
import { AppError } from "./errors.js";
import { logEvent } from "./log.js";
import { redact } from "./secrets/redact.js";
import { VaultKeyError } from "./secrets/vault.js";
import type { SyncStateStore } from "./stores/sync-state.js";

/** A source whose credentials were rejected: only the user can fix it (state needs_reconnect, 需要重新連線). */
export class ReconnectRequiredError extends AppError {
  constructor(message = "需要重新連線。") { super(401, message); this.name = "ReconnectRequiredError"; }
}

/** The ending of a background source's error: the next sync tries again on its own. */
export const AUTO_RETRY = "稍後會自動重試。";

/** safeFetch could not reach the host (DNS, refused, TLS, reset). */
export class SourceUnreachableError extends AppError {
  constructor() { super(502, `無法連線到來源，${AUTO_RETRY}`); this.name = "SourceUnreachableError"; }
}

/** safeFetch's own deadline passed before the host answered. */
export class SourceTimeoutError extends AppError {
  constructor() { super(504, `來源回應逾時，${AUTO_RETRY}`); this.name = "SourceTimeoutError"; }
}

/** A response body over the request's maxBytes (default 5 MB). */
export class ResponseTooLargeError extends AppError {
  constructor() { super(502, "來源回應超過大小限制。"); this.name = "ResponseTooLargeError"; }
}

/** True for errors that mean "the stored credential is dead": Google invalid_grant, an unreadable vault record, or ReconnectRequiredError. */
export function needsReconnect(error: unknown): boolean {
  if (error instanceof ReconnectRequiredError || error instanceof VaultKeyError) return true;
  const value = error as { message?: unknown; response?: { data?: { error?: unknown } }; code?: unknown } | null;
  if (value?.response?.data?.error === "invalid_grant") return true;
  return typeof value?.message === "string" && /\binvalid_grant\b/.test(value.message);
}

export const USER_AGENT = "bell-personal/0.1 (+self-hosted)";

export interface HttpRequestInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  /** Response body cap; default 5 MB. */
  maxBytes?: number;
  /** Per-request deadline; default 15 s. */
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: Buffer;
  text(): string;
  json<T = unknown>(): T;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The only way a source talks to the network: HTTPS only, redirects refused,
 * a deadline combined with the source's abort signal, and a body-size cap.
 * Non-2xx responses are returned (304/404/410 carry meaning for syncs); use
 * expectOk() when any failure should stop the sync.
 */
export async function safeFetch(fetchImpl: FetchLike, url: string | URL, signal: AbortSignal, init: HttpRequestInit = {}): Promise<HttpResponse> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new AppError(400, "來源網址必須使用 HTTPS。");
  if (target.username || target.password) throw new AppError(400, "來源網址不可包含帳號密碼。");
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: init.method ?? "GET",
      redirect: "error",
      headers: { "user-agent": USER_AGENT, accept: "application/json, application/xml;q=0.9, text/calendar;q=0.9, */*;q=0.5", ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(init.timeoutMs ?? 15_000)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof Error && error.name === "TimeoutError") throw new SourceTimeoutError();
    throw new SourceUnreachableError();
  }
  const limit = init.maxBytes ?? 5_000_000;
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ResponseTooLargeError();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const body = Buffer.concat(chunks);
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
    text: () => body.toString("utf8"),
    json: <T>() => {
      try { return JSON.parse(body.toString("utf8")) as T; }
      catch { throw new AppError(502, "來源回傳的資料格式不正確。"); }
    },
  };
}

/** Throws for non-2xx: 401 → ReconnectRequiredError, 429 → retry later, anything else → 502. */
export function expectOk(response: HttpResponse, label: string): HttpResponse {
  if (response.ok) return response;
  if (response.status === 401) throw new ReconnectRequiredError(`${label} 拒絕了保存的憑證，需要重新連線。`);
  if (response.status === 429) throw new AppError(429, `${label} 暫時限制請求頻率，稍後會自動重試。`);
  throw new AppError(502, `${label} 回應 HTTP ${response.status}，稍後會自動重試。`);
}

export interface SourceSyncOptions {
  id: SourceId;
  /** Display name; defaults to SOURCE_LABELS[id]. */
  label?: string;
  state: SyncStateStore;
  /** Background cadence; default 5 minutes. */
  intervalMs?: number;
  /** POST /api/sync re-fetches only when the last success is older than this; default min(interval, 60 s). */
  staleAfterMs?: number;
  /** Test seams. */
  fetch?: FetchLike;
  now?: () => Date;
}

/** What run() receives. */
export interface SyncContext {
  /** Aborted on shutdown; pass it to every await that can take time. */
  signal: AbortSignal;
  /** The cursor run() returned last time (historyId, syncToken, ETag…), or null for a full sync. */
  cursor: string | null;
  now: Date;
  /** safeFetch bound to the injected fetch and this source's signal. */
  http: (url: string | URL, init?: HttpRequestInit) => Promise<HttpResponse>;
}

export interface SyncOutcome {
  /** Items now stored for this source (shown as a count in settings). */
  items?: number;
  /** New cursor; undefined keeps the old one, null clears it (forces a full sync next time). */
  cursor?: string | null;
}

/**
 * One instance per source (bell-explain's SyncService shape). A subclass
 * implements configured() and run(); the base class owns the timer, the
 * single-flight guard, persisted state and error mapping:
 *  - start(): an unref'd interval plus one kick at boot;
 *  - sync(): concurrent callers share the one active run;
 *  - every outcome is persisted to sync_state (lastSyncedAt, redacted zh-TW
 *    lastError, cursor) and logged as fetch.<id> {ms, items, outcome};
 *  - credential failures (invalid_grant, 401 via expectOk, vault key) become
 *    needs_reconnect instead of a retrying error;
 *  - close(): stops the timer, aborts the active fetch and waits for it.
 * sync() never rejects: failures are reported through status().
 */
export abstract class SourceSync {
  readonly id: SourceId;
  readonly label: string;
  readonly intervalMs: number;
  readonly staleAfterMs: number;
  protected readonly state: SyncStateStore;
  protected readonly fetch: FetchLike;
  protected readonly now: () => Date;
  private active: Promise<void> | null = null;
  private controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(options: SourceSyncOptions) {
    this.id = options.id;
    this.label = options.label ?? SOURCE_LABELS[options.id];
    this.state = options.state;
    this.intervalMs = options.intervalMs ?? 5 * 60_000;
    this.staleAfterMs = options.staleAfterMs ?? Math.min(this.intervalMs, 60_000);
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  /** Whether credentials and settings exist. Unconfigured sources never run and show 尚未設定, not an error. */
  abstract configured(): boolean | Promise<boolean>;

  /** One sync: fetch, normalise, write to the item cache. Throw AppError with a zh-TW message on failure. */
  protected abstract run(context: SyncContext): Promise<SyncOutcome>;

  /** Starts the background interval and kicks one sync at boot. Idempotent. */
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.schedule(), this.intervalMs);
    this.timer.unref();
    queueMicrotask(() => this.schedule());
  }

  /**
   * Fire-and-forget sync, for timers and "sync on open". A source waiting for
   * the user to reconnect is skipped: retrying a dead credential only adds noise.
   * Call sync() directly after storing a new credential.
   */
  schedule(): void {
    if (this.closed || this.state.get(this.id)?.state === "needs_reconnect") return;
    void this.sync();
  }

  /** POST /api/sync: syncs when forced or due; returns whether a sync was started or joined. */
  async request(force = false): Promise<boolean> {
    // A configured() that throws (an unreadable vault record) still runs: runOnce() stores why.
    if (this.closed || (await this.probeConfigured()).configured === false) return false;
    if (force) { void this.sync(); return true; }
    if (!this.dueForFetch() || this.state.get(this.id)?.state === "needs_reconnect") return false;
    this.schedule();
    return true;
  }

  /** Whether the cached data is older than staleAfterMs (shown as stale in the UI). */
  isStale(): boolean {
    const last = this.state.get(this.id)?.lastSyncedAt;
    return !last || this.now().getTime() - Date.parse(last) >= this.staleAfterMs;
  }

  /**
   * Whether an unforced fetch (POST /api/sync on page open or focus, the
   * cache-respecting background runs) should start now: the data is stale and,
   * after a failed attempt, that attempt is at least staleAfterMs old too, so a
   * failing upstream is not asked again on every focus.
   */
  dueForFetch(): boolean {
    if (!this.isStale()) return false;
    const row = this.state.get(this.id);
    if (row?.state !== "error" || !row.lastAttemptAt) return true;
    return this.now().getTime() - Date.parse(row.lastAttemptAt) >= this.staleAfterMs;
  }

  /** Runs one sync, or joins the one in flight. Resolves with the resulting status; never rejects. */
  sync(): Promise<SourceStatus> {
    if (this.active) return this.active.then(() => this.status());
    if (this.closed) return this.status();
    this.active = this.runOnce()
      .catch((error: unknown) => { logEvent(`fetch.${this.id}`, { outcome: "error", errorClass: error instanceof Error ? error.name : typeof error }); })
      .finally(() => { this.active = null; });
    return this.active.then(() => this.status());
  }

  get syncing(): boolean {
    return this.active !== null;
  }

  /** Never rejects: a configured() that throws (an unreadable vault record) reports needs_reconnect or error. */
  async status(): Promise<SourceStatus> {
    const probe = await this.probeConfigured();
    const configured = probe.configured !== false;
    const row = this.state.get(this.id);
    let state: SourceState = row?.state ?? "idle";
    let lastError = configured ? (row?.lastError ?? null) : null;
    if (!configured) state = "not_configured";
    else if (this.active) state = "syncing";
    else if (probe.error !== undefined) ({ state, message: lastError } = this.describeFailure(probe.error));
    else if (state === "not_configured" || state === "syncing") state = "idle";
    return {
      id: this.id,
      label: this.label,
      configured,
      state,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      lastAttemptAt: row?.lastAttemptAt ?? null,
      lastError,
      items: row?.items ?? null,
      stale: configured && this.isStale(),
    };
  }

  /** Forget cursor and status (after the user disconnects the source). */
  reset(): void {
    this.state.reset(this.id);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.active?.catch(() => {});
  }

  /** configured() without throwing: `configured` is undefined when it threw. */
  private async probeConfigured(): Promise<{ configured?: boolean; error?: unknown }> {
    try {
      return { configured: await this.configured() };
    } catch (error) {
      return { error };
    }
  }

  /** The persisted state and redacted zh-TW message for a failed run (or a configured() that threw). */
  private describeFailure(error: unknown): { state: "needs_reconnect" | "error"; message: string } {
    const reconnect = needsReconnect(error);
    const message = reconnect
      ? `${this.label} 需要重新連線：請到「連線與設定」重新授權。`
      : error instanceof AppError ? error.message : `同步 ${this.label} 時發生問題，稍後會自動重試。`;
    return { state: reconnect ? "needs_reconnect" : "error", message: redact(message).slice(0, 300) };
  }

  private async runOnce(): Promise<void> {
    const started = Date.now();
    const probe = await this.probeConfigured();
    if (probe.configured === false) {
      if (this.state.get(this.id)?.state !== "not_configured") this.state.save(this.id, { state: "not_configured", lastError: null });
      return;
    }
    const previous = this.state.get(this.id);
    this.state.save(this.id, { state: "syncing", lastAttemptAt: this.now().toISOString() });
    const signal = this.controller.signal;
    try {
      // An unreadable vault record (VaultKeyError, a corrupt secrets file) fails here like a run() would.
      if (probe.error !== undefined) throw probe.error;
      const outcome = await this.run({
        signal,
        cursor: previous?.cursor ?? null,
        now: this.now(),
        http: (url, init) => safeFetch(this.fetch, url, signal, init),
      });
      this.state.save(this.id, {
        state: "ok",
        lastSyncedAt: this.now().toISOString(),
        lastError: null,
        items: outcome.items ?? previous?.items ?? null,
        ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
      });
      logEvent(`fetch.${this.id}`, { ms: Date.now() - started, items: outcome.items ?? null, outcome: "ok" });
    } catch (error) {
      if (this.closed && signal.aborted) {
        // Shutdown, not a failure: leave the previous state for the next boot.
        this.state.save(this.id, { state: previous?.state === "syncing" || !previous ? "idle" : previous.state });
        logEvent(`fetch.${this.id}`, { ms: Date.now() - started, outcome: "aborted" });
        return;
      }
      const failure = this.describeFailure(error);
      this.state.save(this.id, { state: failure.state, lastError: failure.message });
      logEvent(`fetch.${this.id}`, {
        ms: Date.now() - started,
        outcome: failure.state,
        errorClass: error instanceof Error ? error.name : typeof error,
        ...(error instanceof AppError ? { status: error.status } : {}),
      });
    }
  }
}
