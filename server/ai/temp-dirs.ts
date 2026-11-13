import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { logEvent } from "../log.js";
import { maxAgentTimeoutMs } from "./agent-timeouts.js";

/**
 * The folders AI jobs make under `<dataDir>/ai` (mkdtemp's six-character
 * suffix): a key mode's throwaway CLI home (connection-runtime.ts), a key
 * check's home (connections.ts) and a Claude run's cwd (structured.ts). Each
 * is removed when its job ends; a crash or a kill -9 leaves it behind, and a
 * key mode home can hold a CLI's cache of the run.
 */
const AI_TEMP_DIR = /^(?:(?:claude|codex)-home|keycheck|run)-[A-Za-z0-9]{6}$/;

/** Older than the longest a job may run (agent-timeouts.ts), with an hour to spare: never a folder in use. */
export const AI_TEMP_MAX_AGE_MS = maxAgentTimeoutMs + 3_600_000;

/**
 * Deletes leftover AI job folders from `<dataDir>/ai` that have not changed
 * for AI_TEMP_MAX_AGE_MS. Only direct children whose names match the
 * patterns above and that are real directories (a symlink is skipped, never
 * followed), and nothing at all when `ai` itself is a symlink or resolves
 * outside the data directory. Run at boot and with the daily maintenance.
 * Returns how many were removed.
 */
export function pruneAiTempDirs(dataDir: string, now: Date = new Date(), maxAgeMs = AI_TEMP_MAX_AGE_MS): number {
  if (dataDir === ":memory:") return 0;
  const root = join(dataDir, "ai");
  try {
    if (!lstatSync(root).isDirectory()) return 0;
    const inside = relative(realpathSync(dataDir), realpathSync(root));
    if (inside !== "ai") return 0;
  } catch { return 0; }
  const cutoff = now.getTime() - maxAgeMs;
  let removed = 0;
  let names: string[];
  try { names = readdirSync(root); } catch { return 0; }
  for (const name of names) {
    if (!AI_TEMP_DIR.test(name)) continue;
    const path = join(root, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch { /* gone meanwhile */ }
  }
  if (removed) logEvent("ai.temp_pruned", { removed });
  return removed;
}

