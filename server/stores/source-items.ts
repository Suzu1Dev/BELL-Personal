import type { SQLInputValue } from "node:sqlite";
import type { SourceId, SourceItemKind } from "../../shared/sources.js";
import type { AppDatabase } from "../db/database.js";
import { logEvent } from "../log.js";

/** What a SourceSync writes for one fetched item. `value` is the normalised shared type (MailMessage, CalendarEvent…). */
export interface SourceItemInput<T = unknown> {
  kind: SourceItemKind;
  externalId: string;
  value: T;
  /** ISO instant used by window queries on agenda-like items. */
  startsAt?: string | null;
  /** ISO instant used by window queries on deadline-like items. */
  dueAt?: string | null;
  /** When the source last changed it; defaults to now. */
  updatedAt?: string;
}

export interface SourceItem<T = unknown> {
  source: SourceId;
  kind: SourceItemKind;
  externalId: string;
  value: T;
  startsAt: string | null;
  dueAt: string | null;
  updatedAt: string;
  fetchedAt: string;
}

export interface SourceItemQuery {
  source?: SourceId;
  kind?: SourceItemKind;
  /** Half-open window [from, to) on starts_at or due_at; rows with a NULL field are excluded when a bound is given. */
  window?: { field: "startsAt" | "dueAt"; from?: string; to?: string };
  limit?: number;
  /** Default: the window field ascending, else updated_at descending. */
  order?: "asc" | "desc";
}

/**
 * The generic cache every source writes (sources.sqlite source_items), keyed by
 * (source, external_id). Values are the normalised shared types, so widgets read
 * them without knowing the source. Unreadable rows are skipped and logged.
 */
export class SourceItemStore {
  constructor(private readonly database: AppDatabase, private readonly now: () => Date = () => new Date()) {}

  upsert<T>(source: SourceId, items: SourceItemInput<T>[]): number {
    const fetchedAt = this.now().toISOString();
    const statement = this.database.db.prepare(
      `INSERT INTO source_items (source, kind, external_id, json, starts_at, due_at, updated_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO UPDATE SET kind = excluded.kind, json = excluded.json, starts_at = excluded.starts_at,
         due_at = excluded.due_at, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at`,
    );
    this.database.transaction(() => {
      for (const item of items)
        statement.run(source, item.kind, item.externalId, JSON.stringify(item.value), item.startsAt ?? null, item.dueAt ?? null, item.updatedAt ?? fetchedAt, fetchedAt);
    });
    return items.length;
  }

  /**
   * Replaces everything a source holds of one kind with a full fetch: upserts
   * `items` and deletes the rows of that kind it no longer returned.
   */
  replace<T>(source: SourceId, kind: SourceItemKind, items: SourceItemInput<T>[]): { upserted: number; removed: number } {
    return this.database.transaction(() => {
      this.upsert(source, items);
      const keep = new Set(items.map((item) => item.externalId));
      const stale = this.database.db.prepare("SELECT external_id FROM source_items WHERE source = ? AND kind = ?").all(source, kind)
        .map((row) => String(row.external_id)).filter((id) => !keep.has(id));
      const remove = this.database.db.prepare("DELETE FROM source_items WHERE source = ? AND external_id = ?");
      for (const id of stale) remove.run(source, id);
      return { upserted: items.length, removed: stale.length };
    });
  }

  get<T>(source: SourceId, externalId: string): SourceItem<T> | undefined {
    const row = this.database.db.prepare("SELECT * FROM source_items WHERE source = ? AND external_id = ?").get(source, externalId);
    return row ? this.map<T>(row) : undefined;
  }

  list<T>(query: SourceItemQuery = {}): SourceItem<T>[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.source) { where.push("source = ?"); params.push(query.source); }
    if (query.kind) { where.push("kind = ?"); params.push(query.kind); }
    const column = query.window?.field === "dueAt" ? "due_at" : query.window ? "starts_at" : undefined;
    if (column && query.window?.from) { where.push(`${column} >= ?`); params.push(query.window.from); }
    if (column && query.window?.to) { where.push(`${column} < ?`); params.push(query.window.to); }
    const direction = query.order === "desc" ? "DESC" : query.order === "asc" ? "ASC" : column ? "ASC" : "DESC";
    const sql = `SELECT * FROM source_items${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${column ?? "updated_at"} ${direction}, external_id${query.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(query.limit))}` : ""}`;
    return this.database.db.prepare(sql).all(...params).flatMap((row) => this.map<T>(row) ?? []);
  }

  count(source: SourceId, kind?: SourceItemKind): number {
    const row = kind
      ? this.database.db.prepare("SELECT COUNT(*) AS n FROM source_items WHERE source = ? AND kind = ?").get(source, kind)
      : this.database.db.prepare("SELECT COUNT(*) AS n FROM source_items WHERE source = ?").get(source);
    return Number(row?.n ?? 0);
  }

  remove(source: SourceId, externalIds: string[]): number {
    const statement = this.database.db.prepare("DELETE FROM source_items WHERE source = ? AND external_id = ?");
    return this.database.transaction(() => externalIds.reduce((sum, id) => sum + Number(statement.run(source, id).changes), 0));
  }

  /** Deletes a source's rows fetched before `before` (retention, e.g. mail after 30 days). */
  pruneFetchedBefore(source: SourceId, before: string): number {
    return Number(this.database.db.prepare("DELETE FROM source_items WHERE source = ? AND fetched_at < ?").run(source, before).changes);
  }

  /** Drops everything a source cached, e.g. on disconnect. */
  clear(source: SourceId): number {
    return Number(this.database.db.prepare("DELETE FROM source_items WHERE source = ?").run(source).changes);
  }

  private map<T>(row: Record<string, unknown>): SourceItem<T> | undefined {
    try {
      return {
        source: String(row.source) as SourceId,
        kind: String(row.kind) as SourceItemKind,
        externalId: String(row.external_id),
        value: JSON.parse(String(row.json)) as T,
        startsAt: row.starts_at == null ? null : String(row.starts_at),
        dueAt: row.due_at == null ? null : String(row.due_at),
        updatedAt: String(row.updated_at),
        fetchedAt: String(row.fetched_at),
      };
    } catch {
      logEvent("store.unreadable", { table: "source_items", source: String(row.source), strict: false });
      return undefined;
    }
  }
}
