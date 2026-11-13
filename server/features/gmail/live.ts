import type { MailMessage } from "../../../shared/mail.js";
import type { MailBodyParts } from "./mail-body.js";

/**
 * Mail read live from Gmail for #/inbox's 封存 and 全部 views, searches and
 * the reader of a conversation outside the cache (SPEC-mail-assignments D4,
 * §3.5), and the reader's original layout (SPEC-mail-html: a message's HTML
 * and its parts, and the images shown in it): kept in server memory only,
 * for at most LIVE_TTL_MS, never in source_items, sync_state, logs or
 * backups (/privacy §02). Entries are dropped when they expire (a timer runs
 * while anything is held), when an action changes their conversation, on
 * 清除快取的信件 and when Gmail is no longer connected. Bodies and images are
 * also bounded by bytes (least recently used go first).
 */
export const LIVE_TTL_MS = 5 * 60_000;
/** Messages held at most (least recently used go first). */
export const LIVE_MAX_MESSAGES = 500;
/** Conversations (reader) held at most. */
export const LIVE_MAX_THREADS = 50;
/** Conversations listed (封存, 全部, search rows: every message's labels and headers) held at most. */
export const LIVE_MAX_LISTED = 200;
/** Messages kept per listed conversation (the newest; a row needs its labels and its newest messages). */
export const LIVE_LISTED_MESSAGES = 100;
/** Decoded message bodies (HTML and parts) held at most, in bytes. */
export const LIVE_MAX_BODY_BYTES = 12_000_000;
/** Images (inline parts, attachments, proxied remote images) held at most, in bytes. */
export const LIVE_MAX_IMAGE_BYTES = 32_000_000;
const SWEEP_MS = 30_000;

interface Entry<T> {
  value: T;
  at: number;
  threadId: string;
  /** Counted against the map's byte budget (bodies, images). */
  bytes?: number;
}

/** An image held for the reader: raw bytes as received; the endpoint sniffs and checks them again on every answer. */
export interface HeldImage {
  bytes: Buffer;
  filename?: string;
}

export class LiveMail {
  private readonly messages = new Map<string, Entry<MailMessage>>();
  private readonly threads = new Map<string, Entry<MailMessage[]>>();
  private readonly listings = new Map<string, Entry<MailMessage[]>>();
  private readonly bodies = new Map<string, Entry<MailBodyParts>>();
  private readonly images = new Map<string, Entry<HeldImage>>();
  private readonly budgets = new Map<Map<string, Entry<unknown>>, { max: number; used: number }>([
    [this.bodies as Map<string, Entry<unknown>>, { max: LIVE_MAX_BODY_BYTES, used: 0 }],
    [this.images as Map<string, Entry<unknown>>, { max: LIVE_MAX_IMAGE_BYTES, used: 0 }],
  ]);
  private timer: ReturnType<typeof setInterval> | undefined;
  private clears = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** Changes on every clear(): what others hold next to this cache (the proxy's refusals) is dropped with it. */
  get generation(): number {
    return this.clears;
  }

  message(id: string): MailMessage | undefined {
    return this.read(this.messages, id);
  }

  putMessage(message: MailMessage): void {
    this.write(this.messages, message.id, message, message.threadId, LIVE_MAX_MESSAGES);
  }

  /** A conversation's messages as last read with threads.get (oldest first). */
  thread(threadId: string): MailMessage[] | undefined {
    return this.read(this.threads, threadId);
  }

  putThread(threadId: string, messages: MailMessage[]): void {
    this.write(this.threads, threadId, messages, threadId, LIVE_MAX_THREADS);
  }

  /**
   * A conversation as a list row saw it (threads.get format=metadata: every
   * message's labels and headers, no text), so the row knows where the whole
   * conversation is, not only the message the search matched.
   */
  listed(threadId: string): MailMessage[] | undefined {
    return this.read(this.listings, threadId);
  }

  putListed(threadId: string, messages: MailMessage[]): void {
    this.write(this.listings, threadId, messages.slice(-LIVE_LISTED_MESSAGES), threadId, LIVE_MAX_LISTED);
  }

  /** A message's decoded HTML and its parts (the reader's original layout). */
  body(messageId: string): MailBodyParts | undefined {
    return this.read(this.bodies, messageId);
  }

  putBody(parts: MailBodyParts, bytes: number): void {
    this.write(this.bodies, parts.messageId, parts, parts.threadId, Number.POSITIVE_INFINITY, bytes);
  }

  forgetBody(messageId: string): void {
    this.remove(this.bodies, messageId);
    this.idle();
  }

  /** An image by key (`part:<messageId>:<partId>` or `remote:<url>`). */
  image(key: string): HeldImage | undefined {
    return this.read(this.images, key);
  }

  /** `threadId` ties a message's own images to its conversation; remote images belong to none (""). */
  putImage(key: string, image: HeldImage, threadId = ""): void {
    this.write(this.images, key, image, threadId, Number.POSITIVE_INFINITY, image.bytes.length);
  }

  /** An action changed this conversation: nothing read before it may be shown again. */
  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
    this.listings.delete(threadId);
    for (const [id, entry] of this.messages) if (entry.threadId === threadId) this.messages.delete(id);
    for (const [id, entry] of this.bodies) if (entry.threadId === threadId) this.remove(this.bodies, id);
    for (const [key, entry] of this.images) if (threadId && entry.threadId === threadId) this.remove(this.images, key);
    this.idle();
  }

  clear(): void {
    this.messages.clear();
    this.threads.clear();
    this.listings.clear();
    this.bodies.clear();
    this.images.clear();
    for (const budget of this.budgets.values()) budget.used = 0;
    this.clears++;
    this.idle();
  }

  /** Entries held right now (tests, status). */
  get size(): number {
    return this.messages.size + this.threads.size + this.listings.size + this.bodies.size + this.images.size;
  }

  /** Bytes held in bodies and images (tests). */
  get heldBytes(): number {
    let total = 0;
    for (const budget of this.budgets.values()) total += budget.used;
    return total;
  }

  close(): void {
    this.clear();
  }

  /** Drops every entry older than the TTL. */
  sweep(): void {
    const cutoff = this.clock() - LIVE_TTL_MS;
    for (const map of [this.messages, this.threads, this.listings, this.bodies, this.images] as Array<Map<string, Entry<unknown>>>) {
      for (const [key, entry] of map) if (entry.at <= cutoff) this.remove(map, key);
    }
    this.idle();
  }

  private remove<T>(map: Map<string, Entry<T>>, key: string): void {
    const entry = map.get(key);
    if (!entry) return;
    map.delete(key);
    const budget = this.budgets.get(map as Map<string, Entry<unknown>>);
    if (budget) budget.used -= entry.bytes ?? 0;
  }

  private read<T>(map: Map<string, Entry<T>>, key: string): T | undefined {
    const entry = map.get(key);
    if (!entry) return undefined;
    if (entry.at <= this.clock() - LIVE_TTL_MS) {
      this.remove(map, key);
      return undefined;
    }
    // Most recently used last: the oldest entry is the first one dropped.
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }

  private write<T>(map: Map<string, Entry<T>>, key: string, value: T, threadId: string, max: number, bytes?: number): void {
    const budget = this.budgets.get(map as Map<string, Entry<unknown>>);
    this.remove(map, key);
    // Bigger than the whole budget: not held at all (the next read asks Gmail again).
    if (budget && bytes !== undefined && bytes > budget.max) return;
    map.set(key, { value, at: this.clock(), threadId, ...(bytes !== undefined ? { bytes } : {}) });
    if (budget) budget.used += bytes ?? 0;
    while (map.size > max || (budget && budget.used > budget.max)) this.remove(map, map.keys().next().value!);
    if (!this.timer) {
      this.timer = setInterval(() => this.sweep(), SWEEP_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private idle(): void {
    if (this.size || !this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** One LiveMail per running server (the gmail module and findMailMessage share it), keyed by its source-item store. */
const instances = new WeakMap<object, LiveMail>();

export function liveMail(ctx: { sourceItems: object }): LiveMail {
  let live = instances.get(ctx.sourceItems);
  if (!live) {
    live = new LiveMail();
    instances.set(ctx.sourceItems, live);
  }
  return live;
}
