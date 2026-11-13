import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ACTION_COMMIT_MS, ACTION_LOCAL_UNDO_MS } from "../../shared/limits.js";
import type { AiSuggestion } from "../../shared/suggestions.js";
import { todayKey } from "../../shared/time.js";
import { ACTION_IDS, QUEUE_SOURCES, type ActionAccepted, type ActionId, type ActionStatus, type QueueCandidate, type QueueSource } from "../../shared/today.js";
import { QUEUE_ACTION_PRESETS } from "../../shared/today-format.js";
import { ACTION_EFFECTS, type ActionEffect } from "../../shared/today-logic.js";
import { AppError, publicError } from "../errors.js";
import { logEvent } from "../log.js";
import type { ActionHandler, ActionPlan, ActionRequest, ModuleHost } from "../modules.js";
import { redact } from "../secrets/redact.js";
import type { CoreServices } from "../services.js";
import type { ActionLogRow } from "./item-state.js";

export interface ActionServiceOptions {
  /** Delay before a remote write commits; default ACTION_COMMIT_MS (6.5 s). */
  commitMs?: number;
  /** How long a local-only action stays undoable; default 24 h. */
  localUndoMs?: number;
}

interface LivePlan {
  plan: ActionPlan;
  effect: ActionEffect;
  /** Whether a module handler produced the plan (its undo is lost on restart). */
  fromModule: boolean;
  suggestionId?: string;
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
}

const SNOOZE_MAX_MS = 60 * 86_400_000;
const PARAMS_MAX_BYTES = 2000;

/** A closing action that another one, a moment ago, already applied to the same item. */
class DuplicateAction extends Error {
  constructor() { super("duplicate action"); this.name = "DuplicateAction"; }
}
const DUPLICATE_MESSAGE = "這個項目剛剛已經處理過了。";

/** POST /api/actions body (ActionRequestBody). */
export const actionBodySchema = z.object({
  itemId: z.string().min(3).max(600),
  action: z.enum(ACTION_IDS),
  params: z.record(z.string(), z.unknown()).optional(),
}).strict();

/**
 * POST /api/actions and DELETE /api/actions/:actionId (SPEC §6.5). Generic
 * actions (snooze, dismiss, open, submitted, reviewed, reply) are applied by
 * the core; the rest are dispatched to the owning module's ActionHandler:
 * by the item id's source prefix (ModuleParts.actions), by suggestion kind for
 * `ai:` rows (suggestionActions), or to the tasks/calendar/lms module for 轉待辦,
 * 排進 and 轉成作業 (anySourceActions). Local writes happen before the 202; remote
 * writes wait in an in-memory timer queue for ACTION_COMMIT_MS so an undo
 * cancels them before anything reaches Gmail/Calendar/GitHub. The queue is
 * flushed (committed) when the server drains on shutdown.
 */
export class ActionService {
  private readonly plans = new Map<string, LivePlan & { at: number }>();
  private readonly pending = new Map<string, PendingWrite>();
  private readonly running = new Set<Promise<void>>();
  private readonly commitMs: number;
  private readonly localUndoMs: number;
  private closed = false;

  constructor(
    private readonly services: CoreServices,
    private readonly host: ModuleHost,
    private readonly lookup: (itemId: string) => Promise<QueueCandidate | undefined>,
    options: ActionServiceOptions = {},
  ) {
    this.commitMs = options.commitMs ?? ACTION_COMMIT_MS;
    this.localUndoMs = options.localUndoMs ?? ACTION_LOCAL_UNDO_MS;
  }

  async perform(body: unknown): Promise<ActionAccepted> {
    if (this.closed) throw new AppError(503, "伺服器正在重新啟動，請稍後再試。");
    const input = actionBodySchema.parse(body);
    const match = /^([a-z]+):(.+)$/.exec(input.itemId);
    if (!match || !(QUEUE_SOURCES as readonly string[]).includes(match[1])) throw new AppError(400, "項目代碼格式不正確。");
    const source = match[1] as QueueSource;
    const sourceId = match[2];
    const action = input.action;
    const effect = ACTION_EFFECTS[action];
    const params = input.params ?? {};
    const now = this.services.now();

    const item = await this.lookup(input.itemId);
    // 開啟 needs no button on the row; 排進 targets the free slot paired with the row, not one of its buttons;
    // 轉成作業 is offered on any mail (A, the reader) whether or not the row lists it (its handler refuses non-mail);
    // 移回收件匣 is for archived mail, which is never a Today row: the row served before its 封存 must not refuse it.
    const unlisted = action === "open" || action === "schedule" || (action === "assignment" && source !== "ai") || (action === "unarchive" && source === "gmail");
    if (item && !unlisted && !item.actions.some((entry) => entry.id === action))
      throw new AppError(400, "這個項目不能這樣處理。");
    const until = action === "snooze" ? this.snoozeUntil(params, item, now) : undefined;

    let suggestion: AiSuggestion | undefined;
    if (source === "ai") {
      suggestion = this.services.suggestions.get(sourceId);
      if (!suggestion) throw new AppError(404, "找不到這則建議。");
      if (suggestion.status !== "pending") throw new AppError(409, "這則建議已經處理過了。");
      // 加入作業 belongs to assignment suggestions only: never hand it to another kind's handler.
      if (action === "assignment" && suggestion.kind !== "assignment") throw new AppError(400, "這個項目不能這樣處理。");
    }
    if (this.recentClose(input.itemId, action, effect, item)) throw new AppError(409, DUPLICATE_MESSAGE);
    const { handler, required } = this.resolve(source, action, suggestion);
    if (required && !handler) throw new AppError(501, "這類項目目前還不能這樣處理。");
    // A module the chosen roles hide (學校作業 without 學生) takes no actions, even from a stale screen.
    if (handler) this.host.assertOwnerVisible(handler);

    const actionId = randomUUID();
    const request: ActionRequest = {
      actionId, itemId: input.itemId, source, sourceId, action, params,
      ...(item ? { item } : {}), ...(suggestion ? { suggestion } : {}),
      day: todayKey(this.services.config.timeZone, now), now,
    };
    const plan: ActionPlan = handler ? await handler(request, this.services) : { label: defaultLabel(action) };
    const applied = plan.apply ? await plan.apply() : undefined;
    const resultId = applied && typeof applied === "object" ? applied.resultId : undefined;
    const created = applied && typeof applied === "object" ? applied.created : undefined;

    const commitAt = plan.remote ? new Date(now.getTime() + this.commitMs) : null;
    let row: ActionLogRow;
    let decided = false;
    try {
      // Checked again with no await before the record: a concurrent twin may have closed the item meanwhile.
      if (this.recentClose(input.itemId, action, effect, item)) throw new DuplicateAction();
      if (suggestion && (action === "dismiss" || effect.closes)) {
        this.services.suggestions.decide(suggestion.id, action === "dismiss" ? "dismissed" : "accepted", action === "dismiss" ? undefined : resultId);
        decided = true;
      }
      const known = item ?? this.lastKnown(input.itemId);
      row = this.services.itemState.record({
        id: actionId,
        itemId: input.itemId,
        kind: item?.kind ?? plan.target?.kind ?? (suggestion ? `suggestion.${suggestion.kind}` : known?.kind) ?? (sourceId.startsWith("digest") ? "digest" : "other"),
        action,
        // An ai: row's title is the question (「從信件找到 1 個活動…」), and so is an event.decide row's
        // (「…，要參加嗎？」): the handled list names the suggestion or the row's subject instead.
        title: suggestion?.title ?? item?.subject ?? item?.title ?? plan.target?.title ?? known?.title ?? plan.label,
        params: storableParams(params),
        closes: effect.closes,
        remote: plan.remote ? "pending" : "none",
        commitAt: commitAt?.toISOString() ?? null,
        state: stateFor(effect, until, item?.hints.fingerprint ?? plan.target?.fingerprint),
      });
    } catch (error) {
      await Promise.resolve(plan.undo?.()).catch(() => {});
      if (decided) this.services.suggestions.reopen(suggestion!.id);
      if (error instanceof DuplicateAction) throw new AppError(409, DUPLICATE_MESSAGE);
      throw error;
    }

    this.plans.set(actionId, { plan, effect, fromModule: !!handler, at: now.getTime(), ...(suggestion ? { suggestionId: suggestion.id } : {}) });
    this.prunePlans(now.getTime());
    if (plan.remote) this.schedule(actionId);
    logEvent("action", { action, source, kind: row.kind, remote: !!plan.remote });
    return {
      actionId,
      undoUntil: (commitAt ?? (action === "open" ? now : new Date(now.getTime() + this.commitMs))).toISOString(),
      label: plan.label,
      ...(created ? { created } : {}),
    };
  }

  /**
   * The live user action that closed `itemId` within the commit window (or
   * whose remote write is still pending), when the same action arrives on it
   * again: a retry after a lost 202, a second tab, a double press on a row
   * Today's last snapshot still served. Recording it twice would take over the
   * item state, make the first undo answer 409 and send the write twice. A
   * different closing action is the user's next decision, not a repeat: 刪除
   * right after 轉成作業, 標為已讀 or 封存 (rows that stay on screen in
   * #/inbox) goes ahead and takes over the state, whose undo puts the first
   * action's state back. A row that came back because its source changed (new
   * fingerprint) stands on its own.
   */
  private recentClose(itemId: string, action: ActionId, effect: ActionEffect, item: QueueCandidate | undefined): ActionLogRow | undefined {
    if (!effect.closes) return undefined;
    const state = this.services.itemState.get(itemId);
    if (!state?.actionId || (state.state !== "handled" && state.state !== "dismissed")) return undefined;
    if (item?.hints.fingerprint && state.fingerprint && item.hints.fingerprint !== state.fingerprint) return undefined;
    const owner = this.services.itemState.log(state.actionId);
    if (!owner || owner.undone || owner.actor !== "user" || !owner.closes || owner.action !== action) return undefined;
    if (owner.remote === "failed" || owner.remote === "reverted" || owner.remote === "cancelled") return undefined;
    if (owner.remote !== "pending" && this.services.now().getTime() - Date.parse(owner.at) > this.commitMs) return undefined;
    return owner;
  }

  /** DELETE /api/actions/:actionId */
  async undo(actionId: string): Promise<{ undone: true; actionId: string }> {
    const row = this.services.itemState.log(actionId);
    if (!row) throw new AppError(404, "找不到這個動作。");
    if (row.undone) throw new AppError(409, row.remote === "failed" ? "這個動作沒有完成，已經自動還原。" : "這個動作已經復原了。");
    const effect = ACTION_EFFECTS[row.action];
    if (row.action === "open" || row.actor === "sync") throw new AppError(409, "這個動作不能復原。");
    const stateful = effect.state !== null;
    if (stateful && !this.services.itemState.ownsState(actionId)) throw new AppError(409, "這個項目之後又有變動，無法復原這個動作。");
    const live = this.plans.get(actionId);
    const age = this.services.now().getTime() - Date.parse(row.at);

    if (row.remote === "pending") {
      const pending = this.pending.get(actionId);
      if (!pending) throw new AppError(409, "這個動作正在送出，無法復原。");
      clearTimeout(pending.timer);
      this.pending.delete(actionId);
      await live?.plan.undo?.();
      this.services.itemState.undo(actionId, { stateful, remote: "cancelled" });
    } else if (row.remote === "committed") {
      if (!live?.plan.revert || age > this.localUndoMs) throw new AppError(409, "這個動作已經送出，無法復原。");
      await live.plan.revert(AbortSignal.timeout(15_000));
      await live.plan.undo?.();
      this.services.itemState.undo(actionId, { stateful, remote: "reverted" });
    } else {
      if (age > this.localUndoMs) throw new AppError(409, "已經超過可以復原的時間。");
      if (!live && routeNeedsModule(effect)) throw new AppError(409, "伺服器重新啟動過，這個動作無法再復原。");
      await live?.plan.undo?.();
      this.services.itemState.undo(actionId, { stateful });
    }
    const suggestionId = live?.suggestionId ?? (row.itemId.startsWith("ai:") ? row.itemId.slice(3) : undefined);
    if (suggestionId && this.services.suggestions.get(suggestionId)?.status !== "pending") this.services.suggestions.reopen(suggestionId);
    this.plans.delete(actionId);
    logEvent("action.undone", { action: row.action, remote: row.remote });
    return { undone: true, actionId };
  }

  /** GET /api/actions/:actionId */
  status(actionId: string): ActionStatus {
    const row = this.services.itemState.log(actionId);
    if (!row) throw new AppError(404, "找不到這個動作。");
    const state: ActionStatus["state"] = row.remote === "failed" ? "failed"
      : row.undone ? "undone"
        : row.remote === "pending" ? "pending"
          : row.remote === "committed" ? "committed"
            : ACTION_EFFECTS[row.action].state === null && !row.closes ? "logged" : "applied";
    return {
      actionId: row.id, itemId: row.itemId, action: row.action, state, at: row.at,
      undoUntil: row.commitAt ?? new Date(Date.parse(row.at) + this.commitMs).toISOString(),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  /** Whether the queue footer may offer 復原 for this logged action. */
  undoable(row: ActionLogRow): boolean {
    if (row.undone || row.action === "open" || row.actor === "sync") return false;
    if (this.services.now().getTime() - Date.parse(row.at) > this.localUndoMs) return false;
    const effect = ACTION_EFFECTS[row.action];
    if (effect.state !== null && !this.services.itemState.ownsState(row.id)) return false;
    const live = this.plans.get(row.id);
    if (row.remote === "pending") return this.pending.has(row.id);
    if (row.remote === "committed") return !!live?.plan.revert;
    if (row.remote !== "none") return false;
    return !!live || !routeNeedsModule(effect);
  }

  /** Remote writes still waiting for their commit time. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Shutdown: stop accepting actions and commit every pending remote write now. */
  async drain(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending.keys()].map((actionId) => this.commit(actionId)));
    await Promise.allSettled([...this.running]);
  }

  /** Tests: drop pending writes without running them. */
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.controller.abort(); }
    this.pending.clear();
  }

  private resolve(source: QueueSource, action: ActionId, suggestion: AiSuggestion | undefined): { handler?: ActionHandler; required: boolean } {
    const effect = ACTION_EFFECTS[action];
    if (source === "ai") {
      if (effect.route === "core") return { required: false };
      return { handler: this.host.suggestionActionHandler(suggestion!.kind), required: true };
    }
    if (effect.route === "any-todo") return { handler: this.host.anySourceActionHandler("todo"), required: true };
    if (effect.route === "any-schedule") return { handler: this.host.anySourceActionHandler("schedule"), required: true };
    if (effect.route === "any-assignment") return { handler: this.host.anySourceActionHandler("assignment"), required: true };
    return { handler: this.host.actionHandler(source), required: effect.route === "source" };
  }

  private snoozeUntil(params: Record<string, unknown>, item: QueueCandidate | undefined, now: Date): string {
    const { until } = z.object({ until: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "時間格式不正確" }) }).loose().parse(params);
    const time = Date.parse(until);
    if (time <= now.getTime() + 60_000) throw new AppError(400, "延後的時間必須在現在之後。");
    if (time > now.getTime() + SNOOZE_MAX_MS) throw new AppError(400, "最多只能延後 60 天。");
    if (item?.snoozeLimit && time > Date.parse(item.snoozeLimit)) throw new AppError(400, "會超過截止時間。");
    return new Date(time).toISOString();
  }

  private lastKnown(itemId: string): { kind: string; title: string } | undefined {
    const row = this.services.db.personal.db
      .prepare("SELECT kind, title FROM action_log WHERE item_id = ? AND kind NOT IN ('other', 'digest') ORDER BY at DESC LIMIT 1").get(itemId);
    return row ? { kind: String(row.kind), title: String(row.title) } : undefined;
  }

  private schedule(actionId: string): void {
    const controller = new AbortController();
    const timer = setTimeout(() => { void this.commit(actionId); }, this.commitMs);
    (timer as { unref?: () => void }).unref?.();
    this.pending.set(actionId, { timer, controller });
  }

  private async commit(actionId: string): Promise<void> {
    const pending = this.pending.get(actionId);
    if (!pending) return;
    this.pending.delete(actionId);
    clearTimeout(pending.timer);
    const live = this.plans.get(actionId);
    if (!live?.plan.remote) return;
    const task = (async () => {
      try {
        await live.plan.remote!(pending.controller.signal);
        this.services.itemState.setRemote(actionId, "committed");
        logEvent("action.committed", { actionId });
      } catch (error) {
        const message = redact(publicError(error)).slice(0, 300);
        this.services.itemState.setRemote(actionId, "failed", message);
        await Promise.resolve(live.plan.undo?.()).catch(() => {});
        this.services.itemState.undo(actionId, { stateful: live.effect.state !== null, remote: "failed" });
        if (live.suggestionId && this.services.suggestions.get(live.suggestionId)?.status !== "pending") this.services.suggestions.reopen(live.suggestionId);
        logEvent("action.failed", { actionId, errorClass: error instanceof Error ? error.name : typeof error, ...(error instanceof AppError ? { status: error.status } : {}) });
      }
    })();
    this.running.add(task);
    try { await task; } finally { this.running.delete(task); }
  }

  private prunePlans(now: number): void {
    for (const [id, live] of this.plans) if (now - live.at > this.localUndoMs && !this.pending.has(id)) this.plans.delete(id);
  }
}

/** What a remote write left waiting by a crash says (shutdown drains, so only a crash leaves one). */
export const INTERRUPTED_MESSAGE = "伺服器在送出前中斷，這個動作沒有完成，請再做一次。";

/**
 * Boot repair: remote writes still `pending` were never sent (the in-memory
 * timer died with the process). Mark them failed and put their items back in
 * the queue so the user can redo them; a local record their module created is
 * kept (its undo closure is gone), so an accepted suggestion stays accepted.
 *
 * Gmail 封存 / 標為已讀 and GitHub 標為已讀 also changed the cached copy
 * before the write (labels, unread). The source never saw the write, so its
 * history has nothing to correct that copy with: the next Gmail sync is made
 * a full one (it re-reads every inbox message), and the next GitHub poll
 * refetches the notifications unconditionally.
 */
export function repairActionsAfterRestart(services: Pick<CoreServices, "itemState" | "db" | "syncState">): number {
  const rows = services.db.personal.db.prepare("SELECT id, action, item_id FROM action_log WHERE remote = 'pending' AND undone = 0").all();
  const sources = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    const effect = ACTION_EFFECTS[String(row.action) as ActionId];
    services.itemState.setRemote(id, "failed", INTERRUPTED_MESSAGE);
    services.itemState.undo(id, { stateful: !!effect && effect.state !== null, remote: "failed" });
    sources.add(String(row.item_id).split(":")[0]);
  }
  if (sources.has("gmail") && services.syncState.get("gmail")) services.syncState.save("gmail", { cursor: null });
  const github = services.syncState.get("github");
  if (sources.has("github") && github?.cursor) {
    try {
      const cursor = JSON.parse(github.cursor) as { notifications?: Record<string, unknown> };
      if (cursor.notifications) {
        delete cursor.notifications.lastModified;
        delete cursor.notifications.fetchedAt;
        services.syncState.save("github", { cursor: JSON.stringify(cursor) });
      }
    } catch { /* an unreadable cursor is replaced by the next poll */ }
  }
  return rows.length;
}

/** Generic actions can be undone from the stored state alone; module actions need their in-memory plan. */
function routeNeedsModule(effect: ActionEffect): boolean {
  return effect.route !== "core";
}

function stateFor(effect: ActionEffect, until: string | undefined, itemFingerprint: string | undefined): Parameters<CoreServices["itemState"]["record"]>[0]["state"] {
  const fingerprint = itemFingerprint ?? null;
  switch (effect.state) {
    case "snoozed": return { state: "snoozed", until: until ?? null };
    case "dismissed": return { state: "dismissed", fingerprint: null };
    case "until-change": return { state: "dismissed", fingerprint };
    case "handled": return { state: "handled", fingerprint };
    case "replying": return { state: "replying", fingerprint };
    default: return null;
  }
}

const PAST_LABELS: Partial<Record<ActionId, string>> = {
  reply: "已開始回覆", open: "已開啟", snooze: "已延後", submitted: "已標為已交", reviewed: "已標為已審查", dismiss: "已略過",
  trash: "已移到垃圾桶", unarchive: "已移回收件匣", assignment: "已加入作業",
};

/** The label of an action no module planned (「已延後」, 「已略過」…). */
export function defaultLabel(action: ActionId): string {
  return PAST_LABELS[action] ?? `已${QUEUE_ACTION_PRESETS[action].label}`;
}

function storableParams(params: Record<string, unknown>): Record<string, unknown> | null {
  if (!Object.keys(params).length) return null;
  const json = JSON.stringify(params);
  return json.length <= PARAMS_MAX_BYTES ? params : null;
}

