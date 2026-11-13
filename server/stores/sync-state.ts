import { SOURCE_STATES, type SourceId, type SourceState } from "../../shared/sources.js";
import type { AppDatabase } from "../db/database.js";

/** One persisted row per source (sources.sqlite sync_state). */
export interface SyncStateRow {
  source: SourceId;
  state: SourceState;
  /** Opaque per-source cursor (historyId, syncToken, ETag…), usually JSON. */
  cursor: string | null;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  /** Redacted zh-TW message. */
  lastError: string | null;
  items: number | null;
  updatedAt: string;
}

const states = new Set<string>(SOURCE_STATES);

export class SyncStateStore {
  constructor(private readonly database: AppDatabase, private readonly now: () => Date = () => new Date()) {}

  private map(row: Record<string, unknown>): SyncStateRow {
    const state = String(row.state);
    return {
      source: String(row.source) as SourceId,
      state: (states.has(state) ? state : "error") as SourceState,
      cursor: row.cursor == null ? null : String(row.cursor),
      lastSyncedAt: row.last_synced_at == null ? null : String(row.last_synced_at),
      lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
      lastError: row.last_error == null ? null : String(row.last_error),
      items: row.items == null ? null : Number(row.items),
      updatedAt: String(row.updated_at),
    };
  }

  get(source: SourceId): SyncStateRow | undefined {
    const row = this.database.db.prepare("SELECT * FROM sync_state WHERE source = ?").get(source);
    return row ? this.map(row) : undefined;
  }

  all(): SyncStateRow[] {
    return this.database.db.prepare("SELECT * FROM sync_state ORDER BY source").all().map((row) => this.map(row));
  }

  /** Upserts the given fields; omitted fields keep their stored value. */
  save(source: SourceId, patch: Partial<Omit<SyncStateRow, "source" | "updatedAt">>): SyncStateRow {
    const current = this.get(source);
    const next: SyncStateRow = {
      source,
      state: "idle",
      cursor: null,
      lastSyncedAt: null,
      lastAttemptAt: null,
      lastError: null,
      items: null,
      ...current,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    this.database.db.prepare(
      `INSERT INTO sync_state (source, state, cursor, last_synced_at, last_attempt_at, last_error, items, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET state = excluded.state, cursor = excluded.cursor, last_synced_at = excluded.last_synced_at,
         last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error, items = excluded.items, updated_at = excluded.updated_at`,
    ).run(next.source, next.state, next.cursor, next.lastSyncedAt, next.lastAttemptAt, next.lastError, next.items, next.updatedAt);
    return next;
  }

  /** Forgets a source's cursor and status, e.g. after disconnecting it. */
  reset(source: SourceId): void {
    this.database.db.prepare("DELETE FROM sync_state WHERE source = ?").run(source);
  }

  /** Boot repair: a sync interrupted by a restart is reported, not left "syncing" forever. */
  repairAfterRestart(): number {
    return Number(this.database.db.prepare(
      "UPDATE sync_state SET state = 'error', last_error = '上次同步因服務重新啟動而中斷，稍後會自動重試。', updated_at = ? WHERE state = 'syncing'",
    ).run(this.now().toISOString()).changes);
  }
}
