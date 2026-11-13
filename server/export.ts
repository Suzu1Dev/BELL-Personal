import type { AppDatabase } from "./db/database.js";
import type { CoreServices } from "./services.js";

/** GET /api/export: version of the file format below. */
export const EXPORT_FORMAT = "bell-personal-export";
export const EXPORT_VERSION = 1;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  timeZone: string;
  /** PRAGMA user_version of each database, so an import knows the shapes. */
  schema: { personal: number; settings: number; sources?: number };
  /** Every personal.sqlite table: document tables as their JSON documents, relational tables as rows. */
  personal: Record<string, unknown[]>;
  settings: { app: unknown; provider: unknown };
  /** Only with ?include=sources: cached source items, sync state and AI suggestions. */
  sources?: Record<string, unknown[]>;
}

/**
 * The user's own data as one JSON document: all personal tables (todos,
 * projects, habits and logs, ideas, manual events, briefs, queue state, and
 * any table a later migration adds) plus the effective settings. The vault is
 * never included; source caches only on request. Tables are read generically
 * so new tables are exported without changes here.
 */
export function exportData(services: CoreServices, includeSources: boolean): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: services.now().toISOString(),
    timeZone: services.config.timeZone,
    schema: {
      personal: userVersion(services.db.personal),
      settings: userVersion(services.db.settings),
      ...(includeSources ? { sources: userVersion(services.db.sources) } : {}),
    },
    personal: dumpTables(services.db.personal),
    settings: { app: services.settings.get(), provider: services.provider.settings() },
    ...(includeSources ? { sources: dumpTables(services.db.sources) } : {}),
  };
}

function userVersion(database: AppDatabase): number {
  return Number(database.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

function dumpTables(database: AppDatabase): Record<string, unknown[]> {
  const tables = database.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String(row.name));
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
    const rows = database.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    result[table] = rows.map((row) => {
      if (typeof row.json !== "string") return { ...row };
      let value: unknown;
      try { value = JSON.parse(row.json); } catch { value = row.json; }
      // Document tables: the document itself; source_items keep their key and time columns too.
      if (table !== "source_items") return value;
      const { json: _json, ...meta } = row;
      return { ...meta, value };
    });
  }
  return result;
}
