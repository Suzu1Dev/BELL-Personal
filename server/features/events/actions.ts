import { ACTION_EFFECTS } from "../../../shared/today-logic.js";
import { AppError } from "../../errors.js";
import type { ActionHandler } from "../../modules.js";
import { eventPlan, wantsGoogle } from "../calendar/actions.js";
import { calendarService } from "../calendar/store.js";
import { findExternalEvent } from "./catalog.js";

/**
 * actions.ctftime / actions.feed: 要參加 (going) on an event.decide row or an
 * EventCard. Creates the calendar's local event for it (origin "going",
 * itemId = the queue id, sourceRef = the cached ExternalEvent) and, when
 * 「要參加時同時加入 Google 行事曆」 (events.addToGoogle) is on and Google allows
 * writing, inserts the Google copy after the 6.5 s undo window. 略過 is the
 * core's generic dismiss.
 */
export const goingAction: ActionHandler = async (request, ctx) => {
  const found = findExternalEvent(ctx, request.itemId);
  // From #/events the row may not be one Today served: name the event (not 「已略過」) in the handled list.
  const target = found ? { target: { kind: "event.decide" as const, title: found.event.title, fingerprint: found.event.start } } : {};
  // The core applies 略過, 延後 and 開啟 itself; this module adds nothing to them.
  if (ACTION_EFFECTS[request.action].route === "core") return { label: request.action === "dismiss" ? "已略過" : "已處理", ...target };
  if (request.action !== "going") throw new AppError(400, "這個活動不能這樣處理。");
  if (!found) throw new AppError(404, "找不到這個活動，可能已經從來源移除。");
  if (calendarService(ctx).goingFor(request.itemId)) throw new AppError(409, "這個活動已經標為要參加。");
  const { event, source } = found;
  const notes = [event.format, typeof event.weight === "number" ? `權重 ${Math.round(event.weight)}` : undefined, event.organizer]
    .filter(Boolean).join(" · ");
  const plan = eventPlan(ctx, "已標為要參加", {
    title: event.title,
    start: event.start,
    ...(event.end ? { end: event.end } : {}),
    allDay: !!event.allDay,
    ...(event.online ? { location: "線上" } : event.location ? { location: event.location } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(notes ? { notes } : {}),
    sourceRef: { source, externalId: event.id, ...(event.url ? { url: event.url } : {}) },
    origin: "going",
    itemId: request.itemId,
  }, await wantsGoogle(ctx, "events.addToGoogle"));
  // Checked again right before the event is created: a second 要參加 for the same row may have been
  // planned meanwhile (a double click, a second tab), and the core records nothing when apply refuses.
  const apply = plan.apply!;
  return {
    ...plan,
    ...target,
    apply: () => {
      if (calendarService(ctx).goingFor(request.itemId)) throw new AppError(409, "這個活動已經標為要參加。");
      return apply();
    },
  };
};
