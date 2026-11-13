import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";

/** Deleted records stay restorable for this long, then disappear for good. */
export const TRASH_DAYS = 30;
const TRASH_PRUNE_EVERY_MS = 3_600_000;

/** One deleted row, exactly as it was stored. */
export interface TrashRecord {
  v: 1;
  table: string;
  id: string;
  json: string;
  deletedAt: string;
}

export type Restorer = (record: TrashRecord) => unknown;

const TOKEN = /^[a-z][a-z0-9_]{0,39}\.[\w-]{1,80}\.[0-9TZ-]{10,40}\.[0-9a-f]{8}$/;

/**
 * Soft delete for document tables (bell-explain's data/trash pattern): the row
 * is written to data/trash/<token>.json (mode 0600, never overwritten) before
 * it is deleted, so the 6-second undo toast can restore it and a mistaken
 * delete can still be recovered by hand for 30 days. With no directory (tests,
 * :memory: databases) records are kept in memory.
 */
export class Trash {
  private readonly memory = new Map<string, TrashRecord>();
  private readonly restorers = new Map<string, Restorer>();
  private lastPruned = 0;

  constructor(readonly directory: string | null, private readonly now: () => Date = () => new Date()) {
    this.prune();
  }

  /** A DocTable registers how to put its rows back; POST /api/trash/restore dispatches here. */
  register(table: string, restorer: Restorer): void {
    if (this.restorers.has(table)) throw new Error(`Trash restorer for ${table} is already registered.`);
    this.restorers.set(table, restorer);
  }

  /** Saves a deleted row and returns the undo token. Expired copies are pruned here too, at most hourly (the process is long-lived). */
  put(table: string, id: string, json: string): string {
    if (this.now().getTime() - this.lastPruned > TRASH_PRUNE_EVERY_MS) this.prune();
    const deletedAt = this.now().toISOString();
    const token = `${table}.${id.replace(/[^\w-]/g, "_").slice(0, 80) || "_"}.${deletedAt.replace(/[:.]/g, "-")}.${randomBytes(4).toString("hex")}`;
    if (!TOKEN.test(token)) throw new Error(`Invalid trash table name: ${table}`);
    const record: TrashRecord = { v: 1, table, id, json, deletedAt };
    if (!this.directory) { this.memory.set(token, record); return token; }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    writeFileSync(join(this.directory, `${token}.json`), JSON.stringify(record), { mode: 0o600, flag: "wx" });
    return token;
  }

  /** Reads a trashed record without removing it. */
  read(token: string): TrashRecord {
    if (!TOKEN.test(token)) throw new AppError(400, "復原代碼格式不正確。");
    if (!this.directory) {
      const record = this.memory.get(token);
      if (!record) throw new AppError(404, "找不到可復原的資料，可能已經復原或超過保留期限。");
      return record;
    }
    let raw: string;
    try { raw = readFileSync(join(this.directory, `${token}.json`), "utf8"); }
    catch { throw new AppError(404, "找不到可復原的資料，可能已經復原或超過保留期限。"); }
    try {
      const record = JSON.parse(raw) as TrashRecord;
      if (record?.v === 1 && typeof record.table === "string" && typeof record.id === "string" && typeof record.json === "string") return record;
    } catch { /* reported below */ }
    logEvent("store.unreadable", { table: "trash", strict: true });
    throw new AppError(500, "這筆刪除紀錄無法讀取，請從備份還原。");
  }

  /** Puts a record back through its table's restorer, then forgets the trash copy. */
  restore(token: string): { table: string; id: string; value: unknown } {
    const record = this.read(token);
    const restorer = this.restorers.get(record.table);
    if (!restorer) throw new AppError(400, "這類資料不支援復原。");
    const value = restorer(record);
    this.remove(token);
    return { table: record.table, id: record.id, value };
  }

  remove(token: string): void {
    if (!TOKEN.test(token)) return;
    if (!this.directory) { this.memory.delete(token); return; }
    rmSync(join(this.directory, `${token}.json`), { force: true });
  }

  /** Removes copies older than TRASH_DAYS; called at boot, from put() and by the daily maintenance timer. */
  prune(): void {
    this.lastPruned = this.now().getTime();
    const cutoff = this.now().getTime() - TRASH_DAYS * 86_400_000;
    if (!this.directory) {
      for (const [token, record] of this.memory) if (Date.parse(record.deletedAt) < cutoff) this.memory.delete(token);
      return;
    }
    try {
      for (const name of readdirSync(this.directory))
        if (name.endsWith(".json") && statSync(join(this.directory, name)).mtimeMs < cutoff) rmSync(join(this.directory, name), { force: true });
    } catch {
      // No trash yet, or it cannot be read; deletes still write new copies.
    }
  }
}
