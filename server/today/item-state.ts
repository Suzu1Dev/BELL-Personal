import { randomUUID } from "node:crypto";
import { ACTION_IDS, type ActionId } from "../../shared/today.js";
import { ITEM_STATES, type HandledLogEntry, type ItemStateKind, type ItemStateView } from "../../shared/today-logic.js";
import { todayKey } from "../../shared/time.js";
import type { AppDatabase } from "../db/database.js";

/** personal.sqlite item_state: the one state a queue item is in. */
export interface ItemStateRow {
  itemId: string;
  state: ItemStateKind;
  until: string | null;
  day: string | null;
  fingerprint: string | null;
  action: ActionId | null;
  actionId: string | null;
  at: string;
}

export const REMOTE_STATES = ["none", "pending", "committed", "cancelled", "failed", "reverted"] as const;
export type RemoteState = (typeof REMOTE_STATES)[number];

/** personal.sqlite action_log: every action on a queue item, for counts, pace, the handled list and undo. */
export interface ActionLogRow {
  id: string;
  day: string;
  itemId: string;
  /** QueueKind, or "digest"/"other" for targets that are not queue rows. */
  kind: string;
  action: ActionId;
  title: string;
  params: Record<string, unknown> | null;
  at: string;
  undone: boolean;
  closes: boolean;
  remote: RemoteState;
  commitAt: string | null;
  error: string | null;
  /** item_state before this action (null: there was none), restored on undo. */
  previous: ItemStateRow | null;
  /** user: POST /api/actions. sync: a module saw it happen at the source (a sent reply). */
  actor: "user" | "sync";
}

/** What a new log entry plus its state change look like. */
export interface ActionRecord {
  id?: string;
  itemId: string;
  kind: string;
  action: ActionId;
  title: string;
  params?: Record<string, unknown> | null;
  closes: boolean;
  remote?: RemoteState;
  commitAt?: string | null;
  actor?: "user" | "sync";
  /** The state to write; null leaves item_state untouched. */
  state: { state: ItemStateKind; until?: string | null; fingerprint?: string | null } | null;
}

const STATES = new Set<string>(ITEM_STATES);
const ACTIONS = new Set<string>(ACTION_IDS);
/** How long state and log rows are kept. */
export const ITEM_STATE_RETENTION_DAYS = 60;

/**
 * The persisted half of the Today queue (personal.sqlite v2). The core writes
 * it for POST /api/actions; modules use `markHandled` when the source shows an
 * item was dealt with elsewhere (the mail module seeing a sent reply closes
 * 回覆中…), and `clear` to forget an item. It never stores message bodies;
 * `title` is the row title shown in the handled list.
 */
export class ItemStateStore {
  constructor(private readonly database: AppDatabase, private readonly timeZone: string, private readonly now: () => Date = () => new Date()) {}

  private mapState(row: Record<string, unknown>): ItemStateRow | undefined {
    const state = String(row.state);
    if (!STATES.has(state)) return undefined;
    return {
      itemId: String(row.item_id),
      state: state as ItemStateKind,
      until: row.until == null ? null : String(row.until),
      day: row.day == null ? null : String(row.day),
      fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
      action: row.action != null && ACTIONS.has(String(row.action)) ? (String(row.action) as ActionId) : null,
      actionId: row.action_id == null ? null : String(row.action_id),
      at: String(row.at),
    };
  }

  private mapLog(row: Record<string, unknown>): ActionLogRow {
    const parse = <T>(value: unknown): T | null => {
      if (value == null) return null;
      try { return JSON.parse(String(value)) as T; } catch { return null; }
    };
    return {
      id: String(row.id),
      day: String(row.day),
      itemId: String(row.item_id),
      kind: String(row.kind),
      action: String(row.action) as ActionId,
      title: String(row.title ?? ""),
      params: parse<Record<string, unknown>>(row.params),
      at: String(row.at),
      undone: Number(row.undone) === 1,
      closes: Number(row.closes) === 1,
      remote: (REMOTE_STATES as readonly string[]).includes(String(row.remote)) ? (String(row.remote) as RemoteState) : "none",
      commitAt: row.commit_at == null ? null : String(row.commit_at),
      error: row.error == null ? null : String(row.error),
      previous: parse<ItemStateRow>(row.previous),
      actor: String(row.actor) === "sync" ? "sync" : "user",
    };
  }

  get(itemId: string): ItemStateRow | undefined {
    const row = this.database.db.prepare("SELECT * FROM item_state WHERE item_id = ?").get(itemId);
    return row ? this.mapState(row) : undefined;
  }

  /** Every item's state, for grouping (rows are pruned after ITEM_STATE_RETENTION_DAYS). */
  states(): Map<string, ItemStateView> {
    const map = new Map<string, ItemStateView>();
    for (const row of this.database.db.prepare("SELECT * FROM item_state").all()) {
      const state = this.mapState(row);
      if (state) map.set(state.itemId, { state: state.state, until: state.until, fingerprint: state.fingerprint });
    }
    return map;
  }

  log(id: string): ActionLogRow | undefined {
    const row = this.database.db.prepare("SELECT * FROM action_log WHERE id = ?").get(id);
    return row ? this.mapLog(row) : undefined;
  }

  /** Today's closing actions that still stand (not undone, remote not failed). */
  closedOn(day: string): ActionLogRow[] {
    return this.database.db.prepare("SELECT * FROM action_log WHERE day = ? AND undone = 0 AND closes = 1 AND remote NOT IN ('failed', 'reverted') ORDER BY at")
      .all(day).map((row) => this.mapLog(row));
  }

  /** closedOn(day) shaped for shared/today-logic.ts; `undoable` is decided by the caller. */
  handledLog(day: string, undoable: (row: ActionLogRow) => boolean = () => false): HandledLogEntry[] {
    return this.closedOn(day).map((row) => ({
      actionId: row.id, itemId: row.itemId, kind: row.kind, title: row.title, action: row.action, at: row.at, undoable: undoable(row), closes: true,
    }));
  }

  /**
   * Writes the log row and the item's new state in one transaction, keeping
   * the previous state for undo. Returns the stored row.
   */
  record(input: ActionRecord): ActionLogRow {
    const now = this.now();
    const at = now.toISOString();
    const id = input.id ?? randomUUID();
    const day = todayKey(this.timeZone, now);
    return this.database.transaction(() => {
      const previous = this.get(input.itemId) ?? null;
      this.database.db.prepare(
        `INSERT INTO action_log (id, day, item_id, kind, action, title, params, at, undone, closes, remote, commit_at, error, previous, actor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(id, day, input.itemId, input.kind, input.action, input.title.slice(0, 300), input.params ? JSON.stringify(input.params) : null, at,
        input.closes ? 1 : 0, input.remote ?? "none", input.commitAt ?? null, previous ? JSON.stringify(previous) : null, input.actor ?? "user", at);
      if (input.state) this.writeState({
        itemId: input.itemId, state: input.state.state, until: input.state.until ?? null, day,
        fingerprint: input.state.fingerprint ?? null, action: input.action, actionId: id, at,
      });
      return this.log(id)!;
    });
  }

  /**
   * For modules: the item was dealt with at its source (a reply was sent, the
   * LMS shows it submitted). Logs a closing action for today and hides the row
   * until its fingerprint changes. Idempotent per item and day.
   */
  markHandled(input: { itemId: string; kind: string; title: string; action: ActionId; fingerprint?: string | null }): ActionLogRow {
    const current = this.get(input.itemId);
    const day = todayKey(this.timeZone, this.now());
    if (current?.state === "handled" && current.day === day && current.action === input.action && current.actionId) {
      const existing = this.log(current.actionId);
      if (existing && !existing.undone) return existing;
    }
    return this.record({ ...input, closes: true, actor: "sync", state: { state: "handled", fingerprint: input.fingerprint ?? null } });
  }

  /** For modules: an item's id changed at the source; its state moves along unless the new id already has one. */
  rename(from: string, to: string): boolean {
    if (from === to) return false;
    return Number(this.database.db.prepare("UPDATE item_state SET item_id = ? WHERE item_id = ? AND NOT EXISTS (SELECT 1 FROM item_state WHERE item_id = ?)").run(to, from, to).changes) > 0;
  }

  /**
   * The items' source data was deleted for privacy (中斷連線, 清除快取的信件,
   * the retention window): their states go, and their log rows keep the
   * action and time but lose the title (a mail subject), which becomes
   * `placeholder`. `prefix` matches every id that starts with it.
   */
  forget(items: { ids?: readonly string[]; prefix?: string }, placeholder: string): number {
    return this.database.transaction(() => {
      let changed = 0;
      if (items.prefix) {
        const like = `${items.prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        changed += Number(this.database.db.prepare("DELETE FROM item_state WHERE item_id LIKE ? ESCAPE '\\'").run(like).changes);
        changed += Number(this.database.db.prepare("UPDATE action_log SET title = ?, params = NULL WHERE item_id LIKE ? ESCAPE '\\'").run(placeholder, like).changes);
      }
      for (const id of items.ids ?? []) {
        changed += Number(this.database.db.prepare("DELETE FROM item_state WHERE item_id = ?").run(id).changes);
        changed += Number(this.database.db.prepare("UPDATE action_log SET title = ?, params = NULL WHERE item_id = ?").run(placeholder, id).changes);
      }
      return changed;
    });
  }

  /** For modules: forget an item's state (the source deleted it). The log is kept. */
  clear(itemId: string): void {
    this.database.db.prepare("DELETE FROM item_state WHERE item_id = ?").run(itemId);
  }

  setRemote(id: string, remote: RemoteState, error: string | null = null): void {
    this.database.db.prepare("UPDATE action_log SET remote = ?, error = ?, updated_at = ? WHERE id = ?").run(remote, error, this.now().toISOString(), id);
  }

  /**
   * Marks the action undone and, for an action that set the item's state,
   * puts back the state it replaced. Refused (false) when a later action or a
   * sync changed the item meanwhile, so an old undo never clobbers new state.
   */
  undo(id: string, options: { stateful: boolean; remote?: RemoteState }): boolean {
    return this.database.transaction(() => {
      const row = this.log(id);
      if (!row || row.undone) return false;
      if (options.stateful) {
        const current = this.get(row.itemId);
        if (current && current.actionId !== id) return false;
        if (current) {
          if (row.previous) this.writeState(row.previous);
          else this.clear(row.itemId);
        }
      }
      this.database.db.prepare(`UPDATE action_log SET undone = 1${options.remote ? ", remote = ?" : ""}, updated_at = ? WHERE id = ?`)
        .run(...(options.remote ? [options.remote] : []), this.now().toISOString(), id);
      return true;
    });
  }

  /** Whether the action is still the one that set the item's current state (or the state was cleared). */
  ownsState(id: string): boolean {
    const row = this.log(id);
    if (!row) return false;
    const current = this.get(row.itemId);
    return !current || current.actionId === id;
  }

  /**
   * Drops log rows older than the retention window, and the states that can
   * no longer matter: snoozes that woke up, and 回覆中 marks, once that old.
   * Dismissed (略過, forever), handled and until-change states (標為已交 on
   * an assignment the LMS still lists as open) are kept however old they are:
   * dropping them would bring the row back. Modules clear the states of items
   * their source deleted (ItemStateStore.clear); one user's table stays small.
   */
  prune(): number {
    const now = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - ITEM_STATE_RETENTION_DAYS * 86_400_000).toISOString();
    return this.database.transaction(() =>
      Number(this.database.db.prepare("DELETE FROM item_state WHERE at < ? AND ((state = 'snoozed' AND (until IS NULL OR until <= ?)) OR state = 'replying')").run(cutoff, now).changes)
      + Number(this.database.db.prepare("DELETE FROM action_log WHERE at < ?").run(cutoff).changes));
  }

  private writeState(row: ItemStateRow): void {
    this.database.db.prepare(
      `INSERT INTO item_state (item_id, state, until, day, fingerprint, action, action_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET state = excluded.state, until = excluded.until, day = excluded.day,
         fingerprint = excluded.fingerprint, action = excluded.action, action_id = excluded.action_id, at = excluded.at`,
    ).run(row.itemId, row.state, row.until, row.day, row.fingerprint, row.action, row.actionId, row.at);
  }
}
