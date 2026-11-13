import type { FeatureModule } from "../../modules.js";
import { FeedSourceSync } from "../events/feed-sync.js";
import { acceptEventSuggestion, scheduleAction, suggestionEventAction } from "./actions.js";
import { GoogleCalendarSync } from "./google.js";
import { calendarRouter } from "./router.js";
import { calendarService } from "./store.js";
import { calendarToday } from "./today.js";

/**
 * 行事曆 module (calendar-events team). Contract: docs/ARCHITECTURE.md §2 and
 * §10, docs/design/SPEC-ux.md §3.3, §4.8, §6.4.
 *
 * Sources: `google-calendar` (GoogleCalendarSync: calendarList + events.list,
 *   yesterday … +30 days, every 5 min) and `ics` (personal iCal subscriptions,
 *   feeds with target "calendar", every 3 h) → source_items `calendar-event`.
 * Local events: manual_events through calendarService(ctx) (store.ts), the one
 *   owner of that table; other modules (capture, events) create events with it.
 *   A row with `repeat` is a weekly series (the student's 課表): repeat.ts
 *   expands it into occurrences inside collectItems, the one reader of the agenda;
 *   it is never inserted into Google Calendar and skips single days (停課).
 * today(): agenda rows (habitLink 健身 → 運動), nextUp for tomorrow,
 *   later.events (first event tomorrow + one-off local events within 14 days).
 * suggestionActions.event / acceptSuggestion.event: 加入行事曆 for mail suggestions.
 * anySourceActions.schedule: 排進 ({ start, end }) a time block for any row.
 * Routes: /api/calendar (router.ts). Google copies are inserted after the
 *   6.5 s undo window and flushed on shutdown.
 */
export const calendarModule: FeatureModule = {
  name: "calendar",
  label: "行事曆",
  setup(ctx) {
    const service = calendarService(ctx);
    const google = new GoogleCalendarSync(ctx, { pastDays: 62, futureDays: 180 });
    const ics = new FeedSourceSync(ctx, "calendar");
    return {
      router: calendarRouter(ctx, { google, ics }),
      sources: [google, ics],
      today: calendarToday,
      suggestionActions: { event: suggestionEventAction },
      anySourceActions: { schedule: scheduleAction },
      acceptSuggestion: { event: acceptEventSuggestion },
      status: () => ({ localEvents: service.events.count() }),
      close: () => service.flush(),
    };
  },
};
