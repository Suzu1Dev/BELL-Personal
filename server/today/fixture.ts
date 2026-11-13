import { randomUUID } from "node:crypto";
import { ACTION_COMMIT_MS } from "../../shared/limits.js";
import type { ActionAccepted, ActionId, ActionStatus, HandledItem, TodayPayload } from "../../shared/today.js";
import { ACTION_EFFECTS, applyActionToPayload } from "../../shared/today-logic.js";
import { AppError } from "../errors.js";
import { actionBodySchema, defaultLabel } from "./actions.js";

interface FixtureAction {
  actionId: string;
  itemId: string;
  action: ActionId;
  at: Date;
  undoUntil: Date;
  undone: boolean;
}

/** Old entries are forgotten past this many (a dev session never gets close). */
const MAX_ENTRIES = 500;

/**
 * Actions under the dev fixture override (BELLPERSONAL_TODAY_FIXTURE): kept
 * in memory and never touching data. Every GET /api/today replays them on the
 * fixture with applyActionToPayload (the same rule the browser applies
 * optimistically), so a row acted on stays gone after the refresh, its count
 * moves to handled and the footer lists it; 復原 within the window brings it
 * back. Restarting the server forgets them.
 */
export class FixtureActions {
  private readonly entries = new Map<string, FixtureAction>();

  constructor(private readonly now: () => Date, private readonly commitMs = ACTION_COMMIT_MS) {}

  /** POST /api/actions */
  accept(body: unknown): ActionAccepted {
    const { itemId, action } = actionBodySchema.parse(body);
    const at = this.now();
    const undoUntil = action === "open" ? at : new Date(at.getTime() + this.commitMs);
    const actionId = `fixture-${randomUUID()}`;
    this.entries.set(actionId, { actionId, itemId, action, at, undoUntil, undone: false });
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return { actionId, undoUntil: undoUntil.toISOString(), label: defaultLabel(action) };
  }

  /** GET /api/actions/:actionId — fixture actions never write anywhere, so they never fail. */
  status(actionId: string): ActionStatus {
    const entry = this.get(actionId);
    const effect = ACTION_EFFECTS[entry.action];
    const state: ActionStatus["state"] = entry.undone ? "undone" : effect.state === null && !effect.closes ? "logged" : "applied";
    return { actionId, itemId: entry.itemId, action: entry.action, state, at: entry.at.toISOString(), undoUntil: entry.undoUntil.toISOString() };
  }

  /** DELETE /api/actions/:actionId */
  undo(actionId: string): { undone: true; actionId: string } {
    const entry = this.get(actionId);
    if (entry.undone) throw new AppError(409, "這個動作已經復原了。");
    if (entry.action === "open") throw new AppError(409, "這個動作不能復原。");
    if (this.now().getTime() > entry.undoUntil.getTime()) throw new AppError(409, "這個動作已經送出，無法復原。");
    entry.undone = true;
    return { undone: true, actionId };
  }

  /** The fixture as it looks after the accepted actions, oldest first. */
  apply(fixture: TodayPayload): TodayPayload {
    const now = this.now().getTime();
    let payload = fixture;
    for (const entry of this.entries.values()) {
      if (entry.undone) continue;
      const item = payload.queue.flatMap((group) => group.items).find((candidate) => candidate.id === entry.itemId);
      const next = applyActionToPayload(payload, entry.itemId, entry.action);
      if (item && next !== payload && ACTION_EFFECTS[entry.action].closes) {
        const handled: HandledItem = {
          itemId: item.id, kind: item.kind, title: item.title, action: entry.action, at: entry.at.toISOString(),
          actionId: entry.actionId, undoable: now <= entry.undoUntil.getTime(),
        };
        payload = { ...next, handled: [handled, ...(next.handled ?? [])] };
      } else {
        payload = next;
      }
    }
    return payload;
  }

  private get(actionId: string): FixtureAction {
    const entry = this.entries.get(actionId);
    if (!entry) throw new AppError(404, "找不到這個動作。");
    return entry;
  }
}
