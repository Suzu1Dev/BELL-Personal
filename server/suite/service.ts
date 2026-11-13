import {
  SUITE_LIMITS,
  type SuiteCapability,
  type SuiteManifest,
  type SuiteSiblingId,
  type SuiteSource,
  type SuiteSourcesResponse,
  type SuiteTodayFeed,
} from "../../shared/suite.js";
import { logEvent } from "../log.js";
import { readSiblingJson, SuiteReadError, type SuiteFailure, type SuiteTransport } from "./client.js";
import type { SuiteConfig } from "./config.js";
import { parseTodayFeed } from "./feed.js";

/** The only path Personal reads on a sibling. */
export const SUITE_TODAY_PATH = "/api/suite/today";

/** Seams for tests (AppOptions.suite); production uses the defaults. */
export interface SuiteOptions {
  transport?: SuiteTransport;
  now?: () => Date;
  /** Default SUITE_LIMITS.fetchTimeoutMs (3000). */
  timeoutMs?: number;
  /** Default SUITE_LIMITS.fetchMaxBytes (64 KiB). */
  maxBytes?: number;
  /** Default logEvent. Receives only appId, a failure class and ms. */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Resolves BELL PR's server-held Bearer token (env or paired vault token), if any. */
  prToken?: () => Promise<string | null> | string | null;
}

const CAPABILITIES: readonly SuiteCapability[] = [
  { id: "tasks.draft", kind: "accept-handoff", route: "#/tasks", accepts: ["text"], maxChars: SUITE_LIMITS.handoffText },
  { id: "todo.open", kind: "object-route", route: "#/tasks/{id}" },
  { id: "event.open", kind: "object-route", route: "#/events/{id}" },
  { id: "idea.open", kind: "object-route", route: "#/ideas/{id}" },
];

/** One sibling's read state; memory only, never persisted. */
interface SiblingCache {
  feed?: SuiteTodayFeed;
  lastSuccessAt?: number;
  /** When the last read finished; reads closer together than cacheFreshMs answer from here. */
  lastAttemptAt?: number;
  /** Undefined when the last read succeeded. */
  lastFailure?: SuiteFailure;
  /** The read in progress: concurrent requests and refreshes join it instead of starting another. */
  inflight?: Promise<void>;
}

/**
 * BELL Suite on Personal's side (suite-contract v1 §2, §4): its own manifest,
 * and the siblings' Today feeds read server-side from the loopback origins in
 * BELLPERSONAL_SUITE_FETCH. One-way: nothing here writes, and a sibling's
 * trouble is a status in the answer, never an error of the endpoint.
 */
export class SuiteService {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  private readonly transport: SuiteTransport;
  private readonly now: () => Date;
  private readonly log: NonNullable<SuiteOptions["log"]>;
  private readonly prToken?: () => Promise<string | null> | string | null;
  private readonly caches = new Map<SuiteSiblingId, SiblingCache>();

  constructor(private readonly config: SuiteConfig, options: SuiteOptions = {}) {
    this.transport = options.transport ?? readSiblingJson;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? SUITE_LIMITS.fetchTimeoutMs;
    this.maxBytes = options.maxBytes ?? SUITE_LIMITS.fetchMaxBytes;
    this.log = options.log ?? logEvent;
    this.prToken = options.prToken;
  }

  manifest(): SuiteManifest {
    return {
      schemaVersion: 1,
      appId: "personal",
      displayName: "BELL Personal",
      summary: "今日、任務與收件匣",
      capabilities: CAPABILITIES.map((capability) => ({ ...capability })),
      links: { ...this.config.links },
    };
  }

  /** Drops one sibling's in-memory feed cache (e.g. when PR credentials change). */
  clearCache(appId: SuiteSiblingId): void {
    this.caches.delete(appId);
  }

  /** Every sibling, in a fixed order; `refresh` is the manual retry (joins a read in progress). */
  async sources(refresh = false): Promise<SuiteSourcesResponse> {
    const token = (await this.prToken?.()) ?? null;
    const [explain, pr] = await Promise.all([
      this.feedSource("explain", refresh),
      token && this.config.fetch.pr ? this.feedSource("pr", refresh, token) : Promise.resolve(this.unsupportedSource("pr")),
    ]);
    return { schemaVersion: 1, sources: [explain, pr] };
  }

  /** Without a paired/env token, BELL PR cannot be read: never guessed, never a made-up number. */
  private unsupportedSource(appId: SuiteSiblingId): SuiteSource {
    return { appId, status: this.config.links[appId] || this.config.fetch[appId] ? "unsupported" : "unconfigured" };
  }

  private async feedSource(appId: SuiteSiblingId, refresh: boolean, bearerToken?: string): Promise<SuiteSource> {
    const origin = this.config.fetch[appId];
    if (!origin) return { appId, status: "unconfigured" };
    let cache = this.caches.get(appId);
    if (!cache) this.caches.set(appId, (cache = {}));
    const fresh = cache.lastAttemptAt !== undefined && this.now().getTime() - cache.lastAttemptAt < SUITE_LIMITS.cacheFreshMs;
    if (cache.inflight || refresh || !fresh) {
      try {
        await this.read(appId, origin, cache, bearerToken);
      } catch {
        // attempt() records every failure itself; this only keeps an unexpected throw from becoming a 500.
      }
    }
    return this.view(appId, cache);
  }

  private read(appId: SuiteSiblingId, origin: string, cache: SiblingCache, bearerToken?: string): Promise<void> {
    cache.inflight ??= this.attempt(appId, origin, cache, bearerToken).finally(() => { cache.inflight = undefined; });
    return cache.inflight;
  }

  private async attempt(appId: SuiteSiblingId, origin: string, cache: SiblingCache, bearerToken?: string): Promise<void> {
    const started = performance.now();
    let failure: SuiteFailure | undefined;
    try {
      const body = await this.transport({
        origin,
        path: SUITE_TODAY_PATH,
        timeoutMs: this.timeoutMs,
        maxBytes: this.maxBytes,
        ...(bearerToken ? { bearerToken } : {}),
      });
      const checked = parseTodayFeed(body, appId);
      if (checked.ok) {
        cache.feed = checked.feed;
        cache.lastSuccessAt = this.now().getTime();
      } else failure = checked.reason;
    } catch (error) {
      failure = error instanceof SuiteReadError ? error.reason : "connect";
    }
    cache.lastAttemptAt = this.now().getTime();
    cache.lastFailure = failure;
    // A sibling speaking another contract version makes the old feed meaningless (§4: unavailable).
    if (failure === "version") cache.feed = undefined;
    // Never the body, the URL or the error text: the feed carries course titles.
    if (failure) this.log("suite.read_failed", { appId, reason: failure, ms: Math.round(performance.now() - started) });
  }

  /** ready (last read succeeded) → stale (failed, success within 30 min) → unavailable (the feed is dropped). */
  private view(appId: SuiteSiblingId, cache: SiblingCache): SuiteSource {
    const lastSuccessAt = cache.lastSuccessAt === undefined ? undefined : new Date(cache.lastSuccessAt).toISOString();
    if (cache.feed && lastSuccessAt) {
      if (cache.lastFailure === undefined) return { appId, status: "ready", lastSuccessAt, feed: cache.feed };
      if (this.now().getTime() - cache.lastSuccessAt! <= SUITE_LIMITS.staleDropMs) return { appId, status: "stale", lastSuccessAt, feed: cache.feed };
    }
    cache.feed = undefined;
    return lastSuccessAt ? { appId, status: "unavailable", lastSuccessAt } : { appId, status: "unavailable" };
  }
}
