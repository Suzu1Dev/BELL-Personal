import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { z } from "zod";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";
import { migrate, type Migration } from "./migrate.js";
import { PERSONAL_MIGRATIONS, SETTINGS_MIGRATIONS, SOURCES_MIGRATIONS } from "./schema.js";
import { Trash } from "./trash.js";

export interface AppDatabaseOptions {
  /** File path, or ":memory:" in tests. */
  path: string;
  /** zh-TW name used in migration errors and logs, e.g. 「個人資料」. */
  name: string;
  migrations: Migration[];
  /** Holds fetched source text: overwrite deleted pages (secure_delete). */
  sensitive?: boolean;
}

/** Strict reads refuse to guess: a row that exists but cannot be parsed stops the caller. */
export interface ReadOptions {
  strict?: boolean;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * One SQLite file: opened with WAL, full fsync and a busy timeout, chmod 0600,
 * and migrated before anything reads it (a database newer than this build is
 * refused). `db` is the raw node:sqlite handle for queries a helper does not cover.
 */
export class AppDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly name: string;
  readonly version: number;
  private depth = 0;
  private closed = false;

  constructor(options: AppDatabaseOptions) {
    this.path = options.path;
    this.name = options.name;
    const file = options.path !== ":memory:";
    if (file) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.path);
    if (file) chmodSync(options.path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    if (options.sensitive) this.db.exec("PRAGMA secure_delete = ON;");
    this.version = migrate(this.db, options.name, options.migrations, options.path);
  }

  /**
   * Runs `fn` inside BEGIN IMMEDIATE … COMMIT and rolls back if it throws.
   * Nested calls join the outer transaction. `fn` must be synchronous:
   * node:sqlite is synchronous, and awaiting inside a transaction would let
   * other requests' writes interleave.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("AppDatabase.transaction callbacks must be synchronous.");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* SQLite already rolled back */ }
      throw error;
    } finally {
      this.depth--;
    }
  }

  /** A typed JSON-document table helper; see DocTable. */
  docs<T extends { id: string }>(options: DocTableOptions<T>, trash?: Trash): DocTable<T> {
    return new DocTable(this, options, trash);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export interface DocTableOptions<T> {
  /** Table created by a migration with (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL, …). */
  table: string;
  /** zh-TW noun for messages, e.g. 「待辦」. */
  label: string;
  /** Persisted shape. New fields must be optional so older rows keep parsing. */
  schema: z.ZodType<T>;
  /** Derived index columns written next to the JSON on every put. Keys must be real columns. */
  columns?: (doc: T) => Record<string, SQLInputValue>;
}

export interface ListQuery extends ReadOptions {
  /** SQL condition over the table's columns. Code-written only: user input goes in `params`. */
  where?: string;
  params?: SQLInputValue[];
  /** Default "updated_at DESC". Code-written only. */
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/**
 * JSON-document rows with defensive reads (bell-explain store.ts): a lenient
 * read skips and logs a row that fails its schema; a strict read throws 500.
 * Use strict reads on any path that deletes, syncs or overwrites based on what
 * it read. Deletes go through the trash when one is attached, so they can be undone.
 */
export class DocTable<T extends { id: string }> {
  private readonly columnNames: string[] | undefined;

  constructor(private readonly database: AppDatabase, private readonly options: DocTableOptions<T>, private readonly trash?: Trash) {
    if (!IDENTIFIER.test(options.table)) throw new Error(`Invalid table name: ${options.table}`);
    trash?.register(options.table, (record) => this.restoreRecord(record.id, record.json));
  }

  get table(): string { return this.options.table; }

  private parse(id: unknown, json: unknown, strict = false): T | undefined {
    try {
      const result = this.options.schema.safeParse(JSON.parse(String(json)));
      if (result.success) return result.data;
    } catch { /* reported below */ }
    logEvent("store.unreadable", { table: this.options.table, id: String(id).slice(0, 80), strict });
    if (strict) throw new AppError(500, `有一筆${this.options.label}資料無法讀取，已暫停這項操作以免誤刪。請從 data/trash 或備份還原後再試。`);
    return undefined;
  }

  get(id: string, options: ReadOptions = {}): T | undefined {
    const row = this.database.db.prepare(`SELECT id, json FROM ${this.options.table} WHERE id = ?`).get(id);
    return row ? this.parse(row.id, row.json, options.strict) : undefined;
  }

  list(query: ListQuery = {}): T[] {
    const sql = [
      `SELECT id, json FROM ${this.options.table}`,
      query.where ? `WHERE ${query.where}` : "",
      `ORDER BY ${query.orderBy ?? "updated_at DESC"}`,
      query.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(query.limit))}` : "",
      query.offset !== undefined ? `OFFSET ${Math.max(0, Math.floor(query.offset))}` : "",
    ].join(" ");
    return this.database.db.prepare(sql).all(...(query.params ?? []))
      .flatMap((row) => this.parse(row.id, row.json, query.strict) ?? []);
  }

  count(where?: string, params: SQLInputValue[] = []): number {
    const row = this.database.db.prepare(`SELECT COUNT(*) AS n FROM ${this.options.table}${where ? ` WHERE ${where}` : ""}`).get(...params);
    return Number(row?.n ?? 0);
  }

  /** Validates and upserts; returns the stored (parsed) document. */
  put(input: T): T {
    const doc = this.options.schema.parse(input);
    const updatedAt = typeof (doc as { updatedAt?: unknown }).updatedAt === "string" ? (doc as unknown as { updatedAt: string }).updatedAt : new Date().toISOString();
    const extra = this.options.columns?.(doc) ?? {};
    const names = Object.keys(extra);
    for (const name of names) if (!IDENTIFIER.test(name) || ["id", "json", "updated_at"].includes(name)) throw new Error(`Invalid column: ${name}`);
    const columns = ["id", "json", "updated_at", ...names];
    this.database.db.prepare(
      `INSERT INTO ${this.options.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((name) => `${name} = excluded.${name}`).join(", ")}`,
    ).run(doc.id, JSON.stringify(doc), updatedAt, ...names.map((name) => extra[name] ?? null));
    return doc;
  }

  putMany(docs: T[]): void {
    this.database.transaction(() => { for (const doc of docs) this.put(doc); });
  }

  /**
   * Deletes a row. With a trash attached the row is saved first and the
   * returned token undoes the delete through POST /api/trash/restore.
   */
  delete(id: string): { deleted: boolean; undoToken?: string } {
    return this.database.transaction(() => {
      const row = this.database.db.prepare(`SELECT json FROM ${this.options.table} WHERE id = ?`).get(id);
      if (!row) return { deleted: false };
      const undoToken = this.trash?.put(this.options.table, id, String(row.json));
      this.database.db.prepare(`DELETE FROM ${this.options.table} WHERE id = ?`).run(id);
      return { deleted: true, ...(undoToken ? { undoToken } : {}) };
    });
  }

  private restoreRecord(id: string, json: string): T {
    const doc = this.parse(id, json, true)!;
    if (this.get(doc.id)) throw new AppError(409, `這筆${this.options.label}已經存在，不需要復原。`);
    return this.put(doc);
  }
}

export interface Databases {
  personal: AppDatabase;
  sources: AppDatabase;
  settings: AppDatabase;
  close(): void;
}

/**
 * Opens and migrates the three databases in BELLPERSONAL_DATA_DIR (0700).
 * personal.sqlite: the user's own records. sources.sqlite: cached source items,
 * sync state and AI suggestions (secure_delete). settings.sqlite: provider and
 * app settings. Pass ":memory:" in tests.
 */
export function openDatabases(dataDir: string): Databases {
  const memory = dataDir === ":memory:";
  if (!memory) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o700);
  }
  const path = (file: string) => (memory ? ":memory:" : join(dataDir, file));
  const opened: AppDatabase[] = [];
  try {
    const personal = new AppDatabase({ path: path("personal.sqlite"), name: "個人資料", migrations: PERSONAL_MIGRATIONS });
    opened.push(personal);
    const sources = new AppDatabase({ path: path("sources.sqlite"), name: "來源快取", migrations: SOURCES_MIGRATIONS, sensitive: true });
    opened.push(sources);
    const settings = new AppDatabase({ path: path("settings.sqlite"), name: "設定", migrations: SETTINGS_MIGRATIONS });
    opened.push(settings);
    return { personal, sources, settings, close: () => { for (const db of opened) db.close(); } };
  } catch (error) {
    for (const db of opened) db.close();
    throw error;
  }
}
