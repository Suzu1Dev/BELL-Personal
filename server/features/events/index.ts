import type { FeatureModule } from "../../modules.js";
import { goingAction } from "./actions.js";
import { CtftimeSync } from "./ctftime.js";
import { FeedSourceSync } from "./feed-sync.js";
import { eventsRouter } from "./router.js";
import { eventsToday } from "./today.js";

/**
 * 活動 module (calendar-events team). Contract: docs/ARCHITECTURE.md §2 and
 * §10, docs/design/SPEC-ux.md §3.3 (活動), §4.3 (event.decide), §6.4.
 *
 * Sources: `ctftime` (CtftimeSync: one API call, 30-day window, cached ≥ 1 h,
 *   every 3 h, on while ctftime.enabled) and `feeds` (RSS/Atom/iCal
 *   subscriptions with target "events", every 3 h) → source_items
 *   `external-event`. Subscriptions: table event_feeds (PERSONAL v3), secret
 *   URLs in the vault as ics.<feed id> (feeds.ts).
 * today(): event.decide rows (ctftime:<id> / feed:<feed>:<key>, within 7 days,
 *   CTFs at or above ctftime.minWeight), later.events, nav.events (pending
 *   event suggestions found in mail).
 * actions.ctftime / actions.feed: 要參加 → a calendar local event (+ Google when
 *   events.addToGoogle); 略過 is the core's dismiss.
 * Routes: /api/events (router.ts): the #/events list and the feed endpoints.
 */
export const eventsModule: FeatureModule = {
  name: "events",
  label: "活動",
  setup(ctx) {
    const ctftime = new CtftimeSync(ctx);
    const feeds = new FeedSourceSync(ctx, "events");
    return {
      router: eventsRouter(ctx, { ctftime, feeds }),
      sources: [ctftime, feeds],
      today: eventsToday,
      actions: { ctftime: goingAction, feed: goingAction },
      writableWhenHidden: ["/feeds"],
    };
  },
};
