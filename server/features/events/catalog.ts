import type { ExternalEvent, FeedSubscription } from "../../../shared/events.js";
import type { ModuleContext } from "../../modules.js";
import { passesWeight } from "./ctftime.js";
import { feedStore } from "./feeds.js";

/**
 * The upcoming external events the user may decide on (CTFtime above the
 * minimum weight, enabled event feeds), with their queue item ids:
 * `ctftime:<CTFtime id>` and `feed:<feed id>:<key>` (the ExternalEvent id
 * without its `feed:`/`ics:` origin). Dismissed (略過) events are left out;
 * whether an event is marked 要參加 is the calendar's local event for it.
 */

export const CTFTIME_LABEL = "CTFtime";
export const FEEDS_LABEL = "活動訂閱";

export interface UpcomingEvent {
  itemId: string;
  source: "ctftime" | "feeds";
  category: "ctf" | "community";
  event: ExternalEvent;
  /** 「CTFtime」 or the feed's label. */
  sourceLabel: string;
}

/** ExternalEvent id → queue item id. */
export function itemIdOf(event: Pick<ExternalEvent, "id" | "origin">): string {
  if (event.origin === "ctftime") return event.id;
  return `feed:${event.id.slice(event.id.indexOf(":") + 1)}`;
}

/** Queue item id → the cached ExternalEvent (feeds keep `feed:` or `ics:` ids). */
export function findExternalEvent(ctx: ModuleContext, itemId: string): { event: ExternalEvent; source: "ctftime" | "feeds" } | undefined {
  if (itemId.startsWith("ctftime:")) {
    const event = ctx.sourceItems.get<ExternalEvent>("ctftime", itemId)?.value;
    return event ? { event, source: "ctftime" } : undefined;
  }
  if (!itemId.startsWith("feed:")) return undefined;
  const rest = itemId.slice("feed:".length);
  for (const origin of ["feed", "ics"]) {
    const event = ctx.sourceItems.get<ExternalEvent>("feeds", `${origin}:${rest}`)?.value;
    if (event) return { event, source: "feeds" };
  }
  return undefined;
}

export function isDismissed(ctx: ModuleContext, itemId: string): boolean {
  return ctx.itemState.get(itemId)?.state === "dismissed";
}

/**
 * Events that have not ended and start before now + horizonDays, nearest
 * first. CTFtime only while it is on and at or above ctftime.minWeight; feed
 * events only from enabled subscriptions (rows of a feed the table does not
 * know, e.g. demo data, are kept).
 */
export function upcomingEvents(ctx: ModuleContext, now: Date, horizonDays: number, options: { includeDismissed?: boolean } = {}): UpcomingEvent[] {
  const settings = ctx.settings.get();
  const horizon = new Date(now.getTime() + horizonDays * 86_400_000).toISOString();
  const window = { field: "startsAt" as const, from: new Date(now.getTime() - 14 * 86_400_000).toISOString(), to: horizon };
  const feeds = new Map(feedStore(ctx).list().map((feed: FeedSubscription) => [feed.id, feed]));
  const result: UpcomingEvent[] = [];
  const ended = (event: ExternalEvent) => Date.parse(event.end ?? event.start) <= now.getTime() && Date.parse(event.start) <= now.getTime();
  if (settings["ctftime.enabled"]) {
    for (const row of ctx.sourceItems.list<ExternalEvent>({ source: "ctftime", kind: "external-event", window })) {
      const event = row.value;
      if (!event?.id || ended(event) || !passesWeight(event, settings["ctftime.minWeight"])) continue;
      result.push({ itemId: itemIdOf(event), source: "ctftime", category: "ctf", event, sourceLabel: CTFTIME_LABEL });
    }
  }
  for (const row of ctx.sourceItems.list<ExternalEvent>({ source: "feeds", kind: "external-event", window })) {
    const event = row.value;
    if (!event?.id || ended(event)) continue;
    const feed = event.feedId ? feeds.get(event.feedId) : undefined;
    if (feed && !feed.enabled) continue;
    result.push({ itemId: itemIdOf(event), source: "feeds", category: "community", event, sourceLabel: feed?.label ?? event.feedName ?? FEEDS_LABEL });
  }
  return result
    .filter((entry) => options.includeDismissed || !isDismissed(ctx, entry.itemId))
    .sort((a, b) => Date.parse(a.event.start) - Date.parse(b.event.start) || a.itemId.localeCompare(b.itemId));
}
