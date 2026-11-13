import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lutimesSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../test-helpers.js";
import { maxAgentTimeoutMs } from "./agent-timeouts.js";
import { AI_TEMP_MAX_AGE_MS, pruneAiTempDirs } from "./temp-dirs.js";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

/** A folder with a file inside, last changed `hours` before NOW. */
function folder(path: string, hours: number) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "inside.txt"), "x");
  utimesSync(path, hoursAgo(hours), hoursAgo(hours));
}

test("pruneAiTempDirs removes only stale job folders directly under <dataDir>/ai", (t) => {
  const base = tempDir(t);
  const dataDir = join(base, "data");
  const ai = join(dataDir, "ai");
  for (const name of ["claude-home-AbC123", "codex-home-xyz789", "keycheck-QwErTy", "run-Zz9Zz9"]) folder(join(ai, name), 5);
  folder(join(ai, "claude-home-Fresh1"), 0.5);
  folder(join(ai, "run-Recent"), 2.5);
  // Old, but not ours: other names, a file with a job folder's name, a folder outside ai.
  for (const name of ["claude-home-toolong12", "keycheck-abc", "notes", "openai-home-AbC123"]) folder(join(ai, name), 50);
  writeFileSync(join(ai, "run-File01"), "x");
  utimesSync(join(ai, "run-File01"), hoursAgo(50), hoursAgo(50));
  folder(join(dataDir, "claude-home-Outsd1"), 50);
  // A symlink with a job folder's name is never followed.
  const target = join(base, "elsewhere");
  folder(target, 50);
  symlinkSync(target, join(ai, "codex-home-Link01"));
  lutimesSync(join(ai, "codex-home-Link01"), hoursAgo(50), hoursAgo(50));

  assert.equal(pruneAiTempDirs(dataDir, NOW), 4);
  assert.deepEqual(readdirSync(ai).sort(), [
    "claude-home-Fresh1", "claude-home-toolong12", "codex-home-Link01", "keycheck-abc", "notes", "openai-home-AbC123", "run-File01", "run-Recent",
  ]);
  assert.ok(existsSync(join(target, "inside.txt")), "the symlink's target is untouched");
  assert.ok(existsSync(join(dataDir, "claude-home-Outsd1")));
  assert.equal(pruneAiTempDirs(dataDir, NOW), 0, "nothing left to do");
  assert.ok(AI_TEMP_MAX_AGE_MS > maxAgentTimeoutMs, "a folder in use by the longest job is never old enough");
});

test("pruneAiTempDirs does nothing when ai is a symlink, missing, or the database is in memory", (t) => {
  const base = tempDir(t);
  const outside = join(base, "outside");
  folder(join(outside, "claude-home-AbC123"), 50);
  const dataDir = join(base, "data");
  mkdirSync(dataDir);
  assert.equal(pruneAiTempDirs(dataDir, NOW), 0, "no ai folder yet");
  symlinkSync(outside, join(dataDir, "ai"));
  assert.equal(pruneAiTempDirs(dataDir, NOW), 0);
  assert.ok(existsSync(join(outside, "claude-home-AbC123")), "never deletes through a symlinked ai");
  assert.equal(pruneAiTempDirs(":memory:", NOW), 0);
});
