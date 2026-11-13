import test from "node:test";
import assert from "node:assert/strict";
import { serialLoader } from "./usePoll";

function deferredRuns() {
  const runs: Array<() => void> = [];
  const run = () => new Promise<void>((resolve) => { runs.push(resolve); });
  return { runs, run };
}

test("a refresh asked for while a request is out runs once more after it; ticks share the request", async () => {
  const { runs, run } = deferredRuns();
  const load = serialLoader(run, { hidden: () => false, alive: () => true });
  const first = load(true);
  assert.equal(runs.length, 1);
  assert.equal(load(false), first, "the 30 s tick or a focus shares the request out");
  // The action's POST resolved while the poll was out: its refresh must not be dropped.
  const afterAction = load(true);
  const again = load(true);
  assert.equal(again, afterAction, "several refreshes during one request queue a single follow-up");
  runs[0]();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 2, "a second request starts after the first");
  runs[1]();
  await afterAction;
  assert.equal(runs.length, 2);
});

test("hidden tabs skip ticks but not refreshes; nothing queued runs after unmount", async () => {
  const { runs, run } = deferredRuns();
  let alive = true;
  const load = serialLoader(run, { hidden: () => true, alive: () => alive });
  await load(false);
  assert.equal(runs.length, 0);
  const forced = load(true);
  assert.equal(runs.length, 1);
  const queued = load(true);
  alive = false;
  runs[0]();
  await forced;
  await queued;
  assert.equal(runs.length, 1);
});
