import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { CONNECT_LIMITS, type FeedDeleteResponse, type FeedListResponse, type FeedSummary } from "../../../shared/connect.js";
import type { CalendarEvent } from "../../../shared/calendar.js";
import {
  CTFTIME_WINDOW_DAYS, FEED_KINDS, FEED_TARGETS,
  type EventListItem, type EventSourceState, type EventSuggestionItem, type EventsResponse, type ExternalEvent, type FeedSubscription,
} from "../../../shared/events.js";
import { CAPTURE_ORIGIN, type AiSuggestion, type EventSuggestion } from "../../../shared/suggestions.js";
import { todayKey } from "../../../shared/time.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import type { SourceSync } from "../../sync.js";
import { todaySource } from "../../today/service.js";
import { suggestionIsMoot } from "../../today/suggestions.js";
import { calendarService } from "../calendar/store.js";
import { upcomingEvents } from "./catalog.js";
import {
  detectTarget, feedSource, feedStore, feedTarget, fetchFeed, isSecretUrl, normalizeFeedUrl, routeHttp, summarizeFeed, vaultName,
} from "./feeds.js";
import { feedItems, feedWindow } from "./feed-sync.js";

/**
 * /api/events (#/events and the 訂閱 card in 連線與設定):
 *   GET    /              → EventsResponse (CTFs, feed events, mail suggestions, source states)
 *   GET    /feeds         → FeedListResponse
 *   POST   /feeds         FeedCreateRequest → 201 FeedSummary (fetched once first: a bad URL is refused)
 *   DELETE /feeds/:id     {} → FeedDeleteResponse (vault copy and cached items removed)
 */

const createSchema = z.object({
  url: z.string().trim().min(8).max(CONNECT_LIMITS.url),
  label: z.string().trim().min(1, { message: "請輸入訂閱名稱" }).max(CONNECT_LIMITS.feedLabel),
  kind: z.enum(FEED_KINDS).optional(),
  target: z.enum(FEED_TARGETS).optional(),
}).strict();

export function eventsRouter(ctx: ModuleContext, sources: { ctftime: SourceSync; feeds: SourceSync }): Router {
  const router = Router();
  const feeds = feedStore(ctx);

  router.get("/", async (_req, res) => {
    const now = ctx.now();
    const timeZone = ctx.config.timeZone;
    const settings = ctx.settings.get();
    const service = calendarService(ctx);
    const going = service.goingByItem();
    const events: EventListItem[] = upcomingEvents(ctx, now, CTFTIME_WINDOW_DAYS + 30).map(({ itemId, event, category, sourceLabel }) => {
      const local = going.get(itemId);
      return {
        id: itemId,
        category,
        origin: event.origin,
        title: event.title,
        start: event.start,
        ...(event.end ? { end: event.end } : {}),
        allDay: !!event.allDay,
        ...(event.location ? { location: event.location } : {}),
        ...(event.online !== undefined ? { online: event.online } : {}),
        ...(event.url ? { url: event.url } : {}),
        ...(event.organizer ? { organizer: event.organizer } : {}),
        sourceLabel,
        ...(event.format ? { format: event.format } : {}),
        ...(typeof event.weight === "number" ? { weight: event.weight } : {}),
        going: !!local,
        ...(local ? { manualEventId: local.id } : {}),
        inGoogle: !!local && (!!local.googleEventId || service.isPending(local.id)),
      };
    });
    const suggestions: EventSuggestionItem[] = ctx.suggestions.list<EventSuggestion>({ status: "pending", kind: "event", limit: 100 })
      .filter((suggestion) => suggestion.origin !== CAPTURE_ORIGIN && !suggestionIsMoot(suggestion, { now, timeZone }))
      .flatMap((suggestion) => suggestionItem(suggestion));
    const states = await Promise.all([eventSource(sources.ctftime, now), eventSource(sources.feeds, now)]);
    const body: EventsResponse = {
      now: now.toISOString(),
      today: todayKey(timeZone, now),
      timeZone,
      events,
      suggestions,
      sources: states,
      settings: { ctftimeEnabled: settings["ctftime.enabled"], minWeight: settings["ctftime.minWeight"], addToGoogle: settings["events.addToGoogle"] },
      google: { canWrite: await service.canWriteGoogle() },
      feeds: feeds.count("enabled = 1 AND target = 'events'"),
    };
    res.json(body);
  });

  router.get("/feeds", (_req, res) => {
    const body: FeedListResponse = { feeds: feeds.list({ orderBy: "created_at" }).map((feed) => summarizeFeed(feed, countItems(ctx, feed))) };
    res.json(body);
  });

  router.post("/feeds", async (req, res) => {
    const input = createSchema.parse(req.body);
    if (feeds.count() >= CONNECT_LIMITS.feeds) throw new AppError(409, `最多可以加入 ${CONNECT_LIMITS.feeds} 個訂閱，請先刪除不用的。`);
    const url = normalizeFeedUrl(input.url);
    const secret = isSecretUrl(url);
    if (secret && !ctx.vault.enabled) throw new AppError(503, "這個網址含有私密權杖，需要先設定主金鑰才能保存。請依部署說明設定後重新啟動服務。");
    const href = url.toString();
    for (const existing of feeds.list()) {
      const same = existing.secret ? (await ctx.vault.get<string>(vaultName(existing.id)).catch(() => undefined)) === href : existing.url === href;
      if (same) throw new AppError(409, `這個網址已經訂閱為「${existing.label}」。`);
    }
    const now = ctx.now();
    const timeZone = ctx.config.timeZone;
    // One fetch, parsed over both targets' windows; the target's own window is applied below.
    const eventsWindow = feedWindow("events", now, timeZone);
    const calendarWindow = feedWindow("calendar", now, timeZone);
    const wide = { timeZone, from: new Date(Math.min(eventsWindow.from.getTime(), calendarWindow.from.getTime())), to: new Date(Math.max(eventsWindow.to.getTime(), calendarWindow.to.getTime())) };
    let result: Awaited<ReturnType<typeof fetchFeed>>;
    try {
      // A personal calendar's export may be large: allow its cap when the address or the request says calendar.
      const calendar = input.target === "calendar" || detectTarget(url, "ics") === "calendar";
      result = await fetchFeed(routeHttp(ctx), href, wide, input.kind, { calendar });
    } catch (error) {
      throw new AppError(error instanceof AppError && error.status < 500 ? 400 : 502, `無法加入這個訂閱：${error instanceof AppError ? error.message : "網址沒有回應，請確認後再試。"}`);
    }
    const target = input.target && result.kind === "ics" ? input.target : detectTarget(url, result.kind);
    const id = randomUUID();
    const feed: FeedSubscription = {
      id,
      label: input.label,
      url: secret ? `https://${url.host}/` : href,
      kind: result.kind,
      enabled: true,
      ...(secret ? { secret: true } : {}),
      target,
      createdAt: now.toISOString(),
      lastSyncedAt: now.toISOString(),
      lastError: null,
      updatedAt: now.toISOString(),
    };
    if (secret) await ctx.vault.set(vaultName(id), href);
    feeds.put(feed);
    // The test fetch is the first sync: store what it found within the target's window.
    const window = target === "calendar" ? calendarWindow : eventsWindow;
    const parsed = result.events.filter((event) => Date.parse(event.end ?? event.start) >= window.from.getTime() && Date.parse(event.start) <= window.to.getTime());
    const items = feedItems(feed, result.kind, parsed, target, timeZone, now);
    const source = feedSource(target);
    ctx.sourceItems.upsert(source, items);
    if (!ctx.syncState.get(source)?.lastSyncedAt)
      ctx.syncState.save(source, { state: "ok", lastSyncedAt: now.toISOString(), lastAttemptAt: now.toISOString(), lastError: null, items: items.length });
    logEvent("feed.added", { kind: feed.kind, target, secret: !!feed.secret, items: items.length });
    const body: FeedSummary = summarizeFeed(feed, items.length);
    res.status(201).json(body);
  });

  router.delete("/feeds/:id", async (req, res) => {
    const id = z.string().regex(/^[\w-]{1,100}$/).parse(req.params.id);
    const feed = feeds.get(id, { strict: true });
    if (!feed) throw new AppError(404, "找不到這個訂閱，可能已經刪除。");
    const source = feedSource(feedTarget(feed));
    const removedIds = ownItems(ctx, feed).map((item) => item.externalId);
    const removedItems = ctx.sourceItems.remove(source, removedIds);
    ctx.db.personal.db.prepare("DELETE FROM event_feeds WHERE id = ?").run(id);
    if (feed.secret && ctx.vault.enabled) await ctx.vault.delete(vaultName(id)).catch(() => false);
    if (!feeds.count("enabled = 1 AND target = ?", [feedTarget(feed)])) ctx.syncState.reset(source);
    logEvent("feed.removed", { kind: feed.kind, removedItems });
    const body: FeedDeleteResponse = { deleted: true, removedItems };
    res.json(body);
  });

  return router;
}

function ownItems(ctx: ModuleContext, feed: FeedSubscription) {
  const target = feedTarget(feed);
  const source = feedSource(target);
  const kind = target === "calendar" ? "calendar-event" : "external-event";
  return ctx.sourceItems.list<ExternalEvent | CalendarEvent>({ source, kind })
    .filter((item) => ("feedId" in item.value ? item.value.feedId : (item.value as CalendarEvent).calendarId) === feed.id);
}

/** Upcoming items cached for a feed. */
function countItems(ctx: ModuleContext, feed: FeedSubscription): number {
  const now = ctx.now().getTime();
  return ownItems(ctx, feed).filter((item) => Date.parse(item.startsAt ?? item.value.start) >= now - 86_400_000).length;
}

function suggestionItem(suggestion: AiSuggestion<EventSuggestion>): EventSuggestionItem[] {
  const payload = suggestion.payload;
  if (!payload?.title || !payload.start || Number.isNaN(Date.parse(payload.start))) return [];
  return [{
    id: `ai:${suggestion.id}`,
    suggestionId: suggestion.id,
    title: payload.title,
    start: new Date(payload.start).toISOString(),
    ...(payload.end && !Number.isNaN(Date.parse(payload.end)) ? { end: new Date(payload.end).toISOString() } : {}),
    allDay: !!payload.allDay,
    ...(payload.location ? { location: payload.location } : {}),
    ...(suggestion.origin ? { origin: suggestion.origin } : {}),
    ...(suggestion.sourceRef?.url ? { url: suggestion.sourceRef.url } : {}),
    createdAt: suggestion.createdAt,
  }];
}

async function eventSource(source: SourceSync, now: Date): Promise<EventSourceState> {
  const status = await source.status();
  return { ...todaySource(status, source.intervalMs, now), id: status.id as EventSourceState["id"] };
}
