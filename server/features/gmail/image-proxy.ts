import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MAIL_BODY_LIMITS } from "../../../shared/mail.js";
import { PublicFetchError, publicFetch, type PublicFetchFailure, type PublicNetwork } from "../../public-fetch.js";
import type { LiveMail } from "./live.js";
import { acceptableRaster, isPixel, sniffImage, type SniffedImage } from "./images.js";
import { isTrackerUrl } from "./trackers.js";

/**
 * The mail image proxy (SPEC-mail-html §4.2). Remote images the owner chose
 * to show are fetched by this server, never by the browser, so the sender
 * sees the server's request (its network address, a generic User-Agent; no
 * owner device, browser, cookies or Referer):
 *
 *  - a URL is only fetched with a signature the body endpoint issued for that
 *    message (HMAC-SHA-256 over messageId and URL with a random per-process
 *    key), so the endpoint is not an open proxy and a mail cannot point it
 *    anywhere it did not show;
 *  - the server decides what is fetched and when: the body endpoint, when it
 *    builds a body with images shown, fetches every remote image of it at
 *    once (prefetch). The browser's requests are only answered from what that
 *    fetch got (held, in flight, or refused); a URL nobody prefetched is
 *    never fetched for the browser. So which images a mail's CSS shows on
 *    hover, for a phone width or a dark system setting never reaches the
 *    sender: it learns that the mail was opened, and when, nothing more;
 *  - publicFetch: public addresses only, pinned connections, ≤ 3 redirects
 *    re-checked (and a redirect into a known tracker is not followed), 10 s,
 *    10 MB, no cookies, no Referer, a generic User-Agent;
 *  - the bytes must be a raster image by their magic bytes (never SVG or
 *    HTML) whose header names a sane pixel size (no decompression bombs); one
 *    that decodes to at most 1×1 is a tracking pixel and is replaced by a
 *    transparent pixel of our own;
 *  - verified images are held in memory (LiveMail, 5 minutes, bounded by
 *    bytes) and refusals for as long, the same URL is fetched once at a time,
 *    at most 6 fetches run at once and at most 4 for one message (a hostile
 *    mail's slow hosts leave 2 for everything else), a fetch that waits 30 s
 *    for a slot gives up, and each message (and the server as a whole, for
 *    fetches that did not end in an image) has a fetch budget per 5 minutes.
 */

export const PROXY_TIMEOUT_MS = 10_000;
/** A fetch that has not got a slot after this long gives up (a hostile mail's queue never holds others for long). */
export const PROXY_QUEUE_MS = 30_000;
export const PROXY_MAX_REDIRECTS = 3;
export const PROXY_CONCURRENCY = 6;
/** Slots one message may hold at once: the rest stay free for every other mail. */
export const PROXY_MESSAGE_SLOTS = 4;
/** Upstream fetches (cache misses) per message, and for everything, per window. */
export const PROXY_PER_MESSAGE = 150;
export const PROXY_GLOBAL = 600;
export const PROXY_WINDOW_MS = 5 * 60_000;
/** Refusals held at most (oldest first out); they expire with the window. */
const MAX_ANSWERS = 2000;

const ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1";

/** Signs and checks proxy URLs. The key lives only in this process: a restart invalidates old URLs (the reader asks for new ones). */
export class ImageSigner {
  private readonly key: Buffer;

  constructor(key: Buffer = randomBytes(32)) {
    this.key = key;
  }

  sign(messageId: string, url: string): string {
    return createHmac("sha256", this.key).update(`${messageId}\n${url}`).digest("base64url");
  }

  verify(messageId: string, url: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(messageId, url));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** The same-origin URL the sanitizer writes for a remote image. */
  path(messageId: string, url: string): string {
    return `/api/mail-images/proxy?m=${encodeURIComponent(messageId)}&u=${encodeURIComponent(url)}&s=${this.sign(messageId, url)}`;
  }
}

/** A fixed budget per key and window (in memory; resets with the window). */
export class WindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly clock: () => number = Date.now) {}

  take(key: string): boolean {
    const now = this.clock();
    let entry = this.windows.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.windows.size >= 1000) for (const [old, value] of this.windows) if (value.resetAt <= now) this.windows.delete(old);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, entry);
    }
    if (entry.count >= this.limit) return false;
    entry.count++;
    return true;
  }

  /** Gives one back (a fetch that should not count). */
  give(key: string): void {
    const entry = this.windows.get(key);
    if (entry && entry.count > 0) entry.count--;
  }
}

export type ProxyOutcome =
  | { kind: "image"; bytes: Buffer; image: SniffedImage; cached: boolean }
  /** A tracking pixel: decoded to at most 1×1, or (`tracker`) a redirect into a known tracker that was not followed. */
  | { kind: "pixel"; tracker?: boolean }
  /** `expired`: nothing was prefetched for this URL (or it is no longer held). */
  | { kind: "refused"; reason: PublicFetchFailure | "not-image" | "rate-limited" | "expired" };

export interface ImageProxyDeps {
  network: PublicNetwork;
  live: LiveMail;
  clock?: () => number;
  /** Tests: smaller budgets and a shorter wait for a slot. */
  limits?: { perMessage?: number; global?: number; queueMs?: number };
}

interface Waiter {
  messageId: string;
  start: () => void;
}

export class ImageProxy {
  private readonly perMessage: WindowLimiter;
  private readonly global: WindowLimiter;
  private readonly clock: () => number;
  private readonly inflight = new Map<string, Promise<ProxyOutcome>>();
  /** Outcomes without bytes to hold (refusals, tracker redirects), by URL, for the window; dropped with LiveMail (清除快取的信件). */
  private readonly answers = new Map<string, { outcome: ProxyOutcome; at: number; generation: number }>();
  private active = 0;
  private readonly running = new Map<string, number>();
  private readonly waiting: Waiter[] = [];

  constructor(private readonly deps: ImageProxyDeps) {
    this.clock = deps.clock ?? Date.now;
    this.perMessage = new WindowLimiter(deps.limits?.perMessage ?? PROXY_PER_MESSAGE, PROXY_WINDOW_MS, this.clock);
    this.global = new WindowLimiter(deps.limits?.global ?? PROXY_GLOBAL, PROXY_WINDOW_MS, this.clock);
  }

  /**
   * Fetches every remote image of a body built with images shown, at once,
   * in the mail's order, whatever the browser will render; resolves with the
   * outcomes (for the log). Each URL is registered before this returns, so a
   * browser request that follows the body always finds it.
   */
  prefetch(messageId: string, urls: readonly string[]): Promise<ProxyOutcome[]> {
    return Promise.all(urls.map((url) => this.fetch(messageId, url)));
  }

  /** The answer for a signed URL the browser asks for (the caller verified the signature): never a new upstream fetch. */
  async serve(url: string): Promise<ProxyOutcome> {
    const held = this.deps.live.image(keyOf(url));
    if (held) return this.judge(held.bytes, true);
    const answered = this.answered(url);
    if (answered) return answered;
    return this.inflight.get(url) ?? { kind: "refused", reason: "expired" };
  }

  /** Starts (or joins) the upstream fetch of one URL for a message; held images, held refusals and repeats spend no budget. */
  fetch(messageId: string, url: string): Promise<ProxyOutcome> {
    const held = this.deps.live.image(keyOf(url));
    if (held) return Promise.resolve(this.judge(held.bytes, true));
    const answered = this.answered(url);
    if (answered) return Promise.resolve(answered);
    const pending = this.inflight.get(url);
    if (pending) return pending;
    if (!this.perMessage.take(messageId)) return Promise.resolve(this.remember(url, { kind: "refused", reason: "rate-limited" }));
    if (!this.global.take("all")) {
      this.perMessage.give(messageId);
      return Promise.resolve(this.remember(url, { kind: "refused", reason: "rate-limited" }));
    }
    const task = this.fetchOnce(messageId, url)
      .then((outcome) => {
        // The server-wide budget is for traffic that shows something: a refusal gives its fetch back.
        if (outcome.kind === "refused") this.global.give("all");
        if (outcome.kind !== "image") this.remember(url, outcome);
        return outcome;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, task);
    return task;
  }

  private async fetchOnce(messageId: string, url: string): Promise<ProxyOutcome> {
    if (!(await this.slot(messageId))) return { kind: "refused", reason: "timeout" };
    try {
      const result = await publicFetch(this.deps.network, url, {
        maxBytes: MAIL_BODY_LIMITS.imageBytes, timeoutMs: PROXY_TIMEOUT_MS, maxRedirects: PROXY_MAX_REDIRECTS, accept: ACCEPT,
        // The mail's own URL was checked by the sanitizer; a redirect into a known tracker is not followed either.
        checkUrl: (hop) => !isTrackerUrl(hop),
      });
      const outcome = this.judge(result.body, false);
      // Only verified raster images are held; a pixel is held too, so it is not fetched again.
      if (outcome.kind !== "refused") this.deps.live.putImage(keyOf(url), { bytes: result.body });
      return outcome;
    } catch (error) {
      if (error instanceof PublicFetchError && error.reason === "refused-url") return { kind: "pixel", tracker: true };
      if (error instanceof PublicFetchError) return { kind: "refused", reason: error.reason };
      return { kind: "refused", reason: "unreachable" };
    } finally {
      this.release(messageId);
    }
  }

  private judge(bytes: Buffer, cached: boolean): ProxyOutcome {
    const image = sniffImage(bytes);
    if (!image) return { kind: "refused", reason: "not-image" };
    if (isPixel(image)) return { kind: "pixel" };
    // A size the reader's tab can decode (a small file can declare gigabytes of pixels).
    if (!acceptableRaster(image)) return { kind: "refused", reason: "too-large" };
    return { kind: "image", bytes, image, cached };
  }

  private answered(url: string): ProxyOutcome | undefined {
    const entry = this.answers.get(url);
    if (!entry) return undefined;
    if (entry.at <= this.clock() - PROXY_WINDOW_MS || entry.generation !== this.deps.live.generation) {
      this.answers.delete(url);
      return undefined;
    }
    return entry.outcome;
  }

  private remember(url: string, outcome: ProxyOutcome): ProxyOutcome {
    this.answers.delete(url);
    this.answers.set(url, { outcome, at: this.clock(), generation: this.deps.live.generation });
    while (this.answers.size > MAX_ANSWERS) this.answers.delete(this.answers.keys().next().value!);
    return outcome;
  }

  private canRun(messageId: string): boolean {
    return this.active < PROXY_CONCURRENCY && (this.running.get(messageId) ?? 0) < PROXY_MESSAGE_SLOTS;
  }

  private take(messageId: string): void {
    this.active++;
    this.running.set(messageId, (this.running.get(messageId) ?? 0) + 1);
  }

  /** A slot for one fetch of `messageId`; false when none came within the queue time. */
  private slot(messageId: string): Promise<boolean> {
    if (this.canRun(messageId)) {
      this.take(messageId);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        messageId,
        start: () => {
          clearTimeout(timer);
          this.take(messageId);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      }, this.deps.limits?.queueMs ?? PROXY_QUEUE_MS);
      (timer as { unref?: () => void }).unref?.();
      this.waiting.push(waiter);
    });
  }

  /** Frees a slot and starts the first waiter allowed to run (one slot freed, at most one can start). */
  private release(messageId: string): void {
    this.active--;
    const count = (this.running.get(messageId) ?? 1) - 1;
    if (count > 0) this.running.set(messageId, count);
    else this.running.delete(messageId);
    const index = this.waiting.findIndex((waiter) => this.canRun(waiter.messageId));
    if (index >= 0) this.waiting.splice(index, 1)[0].start();
  }
}

const keyOf = (url: string) => `remote:${url}`;
