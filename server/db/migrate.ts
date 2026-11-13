import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { logEvent } from "../log.js";

export interface Migration {
  version: number;
  /** Runs inside BEGIN IMMEDIATE; throw to roll the step back. */
  up?: (db: DatabaseSync) => void;
}

/** Version 1 records the schemas that existed before migrations were tracked. */
export const BASELINE: Migration[] = [{ version: 1 }];

/**
 * Brings a database to the newest version this build knows, one transaction per
 * step, and records it in PRAGMA user_version. A database written by a newer
 * BELL is refused instead of being read with older assumptions after a rollback.
 */
export function migrate(db: DatabaseSync, name: string, migrations: Migration[], path?: string): number {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest)
    throw new Error(`${name} 資料庫版本 ${current} 比這個 BELL 版本支援的 ${latest} 新。請改用較新的 BELL，或從備份還原資料。`);
  const pending = migrations.filter(step => step.version > current);
  if (!pending.length) return current;
  // Only real changes to existing data need a copy: recording the baseline changes
  // nothing, and a brand-new database (version 0 with steps to run) has nothing to save.
  if (path && path !== ":memory:" && current > 0 && pending.some(step => step.up)) {
    const backup = `${path}.before-v${pending[0].version}`;
    if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  }
  for (const step of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      step.up?.(db);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    logEvent("db.migrated", { database: name, version: step.version });
  }
  return latest;
}

/** How long the pre-migration copies (`<db>.before-v<N>`) are kept: long enough to roll back a bad release. */
export const MIGRATION_COPY_DAYS = 30;

/**
 * Deletes `*.before-v<N>` copies older than MIGRATION_COPY_DAYS from the data
 * directory. They hold everything the database held (mail subjects in the
 * action log, for one), and every backup snapshot copies the data directory.
 * Returns how many were removed.
 */
export function pruneMigrationCopies(dataDir: string, now: Date = new Date()): number {
  if (dataDir === ":memory:") return 0;
  const cutoff = now.getTime() - MIGRATION_COPY_DAYS * 86_400_000;
  let removed = 0;
  let names: string[];
  try { names = readdirSync(dataDir); } catch { return 0; }
  for (const name of names) {
    if (!/\.sqlite\.before-v\d+$/.test(name)) continue;
    const path = join(dataDir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) { rmSync(path, { force: true }); removed++; }
    } catch { /* gone meanwhile */ }
  }
  if (removed) logEvent("db.migration_copies_pruned", { removed });
  return removed;
}
