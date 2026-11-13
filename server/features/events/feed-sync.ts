import type { CalendarEvent } from "../../../shared/calendar.js";
import type { ExternalEvent, FeedSubscription, FeedTarget } from "../../../shared/events.js";
import { addDays, dayBounds, isDayKey, todayKey, zonedTimeToUtc } from "../../../shared/time.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import { redact } from "../../secrets/redact.js";
import type { SourceItemInput } from "../../stores/source-items.js";
import { SourceSync, type SyncContext, type SyncOutcome } from "../../sync.js";
import type { ParsedFeedEvent, ParseWindow } from "./feed-parse.js";
import {
  enabledFeeds, feedFetchUrl, feedSource, feedStore, fetchFeed, toCalendarEvent, toExternalEvent, type FeedHttp,
} from "./feeds.js";

/** Feeds are fetched every 3 h; POST /api/sync refetches only after an hour (polite caching, like CTFtime). */
export const FEED_INTERVAL_MS = 3 * 3_600_000;
export const FEED_STALE_MS = 3_600_000;
const FAILED_MESSAGE = "無法讀取這個訂閱，稍後會自動重試。";

type FeedItemValue = ExternalEvent | CalendarEvent;

/** The occurrences a sync keeps: events from yesterday to 60 days ahead; a personal calendar like Google's (−1 d … +30 d). */
export function feedWindow(target: FeedTarget, now: Date, timeZone: string): ParseWindow {
  const today = todayKey(timeZone, now);
  return target === "calendar"
    ? { from: new Date(dayBounds(timeZone, addDays(today, -1)).start), to: new Date(dayBounds(timeZone, addDays(today, 30)).end), timeZone }
    : { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + 60 * 86_400_000), timeZone };
}

/** The source_items rows for one feed's parsed occurrences. */
export function feedItems(feed: FeedSubscription, kind: FeedSubscription["kind"], events: ParsedFeedEvent[], target: FeedTarget, timeZone: string, now: Date): SourceItemInput<FeedItemValue>[] {
  if (target === "calendar") {
    return events.map((event) => {
      const value = toCalendarEvent(feed, event, timeZone, now);
      const startsAt = isDayKey(value.start) ? zonedTimeToUtc(timeZone, value.start).toISOString() : value.start;
      return { kind: "calendar-event", externalId: value.id, value, startsAt };
    });
  }
  return events.map((event) => {
    const value = toExternalEvent(feed, kind, event, now);
    return { kind: "external-event", externalId: value.id, value, startsAt: value.start };
  });
}

const feedIdOf = (value: FeedItemValue) => ("feedId" in value && value.feedId) || ("calendarId" in value && value.calendarId) || undefined;

/**
 * Fetches every enabled subscription of one target and replaces the cached
 * items. One broken feed keeps its previous items and records its own
 * lastError (shown in 連線與設定); the source fails only when every feed did.
 */
export async function syncFeeds(ctx: ModuleContext, target: FeedTarget, http: FeedHttp, now: Date, signal: AbortSignal): Promise<number> {
  const store = feedStore(ctx);
  const feeds = enabledFeeds(ctx, target);
  const source = feedSource(target);
  const kind = target === "calendar" ? "calendar-event" : "external-event";
  const timeZone = ctx.config.timeZone;
  const window = feedWindow(target, now, timeZone);
  const inputs: SourceItemInput<FeedItemValue>[] = [];
  const failed = new Set<string>();
  let lastMessage = FAILED_MESSAGE;
  for (const feed of feeds) {
    signal.throwIfAborted();
    try {
      const url = await feedFetchUrl(ctx, feed);
      const result = await fetchFeed(http, url, window, feed.kind, { calendar: target === "calendar" });
      inputs.push(...feedItems(feed, result.kind, result.events, target, timeZone, now));
      const current = store.get(feed.id);
      if (current) store.put({ ...current, kind: result.kind, lastSyncedAt: now.toISOString(), lastError: null, updatedAt: now.toISOString() });
    } catch (error) {
      if (signal.aborted) throw error;
      failed.add(feed.id);
      lastMessage = redact(error instanceof AppError ? error.message : FAILED_MESSAGE).slice(0, 300);
      const current = store.get(feed.id);
      if (current) store.put({ ...current, lastError: lastMessage, updatedAt: now.toISOString() });
    }
  }
  for (const item of ctx.sourceItems.list<FeedItemValue>({ source, kind })) {
    const feedId = feedIdOf(item.value);
    if (feedId && failed.has(feedId)) inputs.push({ kind, externalId: item.externalId, value: item.value, startsAt: item.startsAt });
  }
  ctx.sourceItems.replace(source, kind, inputs);
  if (feeds.length && failed.size === feeds.length)
    throw new AppError(502, feeds.length === 1 ? lastMessage : `${feeds.length} 個訂閱都無法讀取，稍後會自動重試。`);
  return inputs.length;
}

/**
 * The `feeds` source (events module, #/events) and the `ics` source (calendar
 * module, the agenda): the same subscriptions table split by target.
 */
export class FeedSourceSync extends SourceSync {
  constructor(private readonly ctx: ModuleContext, private readonly target: FeedTarget, options: { intervalMs?: number } = {}) {
    super({
      id: feedSource(target),
      state: ctx.syncState,
      intervalMs: options.intervalMs ?? FEED_INTERVAL_MS,
      staleAfterMs: FEED_STALE_MS,
      fetch: ctx.fetch,
      now: ctx.now,
    });
  }

  configured(): boolean {
    return enabledFeeds(this.ctx, this.target).length > 0;
  }

  /** Background runs (boot, interval) skip a fetch or a failed attempt younger than an hour: a restart does not refetch every feed. */
  override schedule(): void {
    if (!this.dueForFetch()) return;
    super.schedule();
  }

  protected async run({ signal, now, http }: SyncContext): Promise<SyncOutcome> {
    return { items: await syncFeeds(this.ctx, this.target, http, now, signal) };
  }
}
