/**
 * The to-do draft capture (src/suite/useTaskHandoff.ts) against a stubbed
 * window: the address is cleaned in the same synchronous step that reads it,
 * before the manifest is known; an older draft is deleted by any new
 * handoff attempt — any reserved key on #/tasks, valid or not (contract
 * rev. d) — while an ordinary visit keeps it; nothing is shown until the
 * manifest says the sender is linked; a key that comes twice, or no draft,
 * refuses the whole handoff with a notice (contract D9, rev. d);
 * the draft is written whole to the one sessionStorage key; and taking it
 * out before 建立待辦's request means a reload cannot write it twice.
 * Runs in its own process (node --test), so the globals are this file's.
 */
import test from "node:test";
import assert from "node:assert/strict";

const EXPLAIN = "http://127.0.0.1:21101";
const KEY = "bell.suite.handoff.tasks";

const store = new Map<string, string>();
const replaced: string[] = [];
const fakeWindow = {
  location: { hash: "" },
  history: {
    state: null,
    replaceState(_state: unknown, _title: string, url: string) {
      replaced.push(url);
      fakeWindow.location.hash = url;
    },
  },
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  },
};
(globalThis as { window?: unknown }).window = fakeWindow;

interface Pending { url: string; resolve: (response: Response) => void; reject: (cause: unknown) => void }
const requests: Pending[] = [];
globalThis.fetch = ((url: string) => new Promise<Response>((resolve, reject) => { requests.push({ url: String(url), resolve, reject }); })) as typeof fetch;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const manifestBody = () => new Response(JSON.stringify({ schemaVersion: 1, appId: "personal", displayName: "BELL Personal", summary: "", capabilities: [], links: { explain: EXPLAIN } }), { status: 200, headers: { "Content-Type": "application/json" } });

const OLD = JSON.stringify({ v: 1, text: "舊的草稿", from: "explain", backUrl: `${EXPLAIN}/#/review`, receivedAt: "2026-11-08T01:00:00.000Z" });

test("capture → clean URL at once → wait for the manifest → draft; retry after a failed manifest", async () => {
  const handoff = await import("./useTaskHandoff");
  store.set(KEY, OLD);
  assert.equal(handoff.getTaskHandoff().kind, "draft", "a stored draft is restored on load");

  fakeWindow.location.hash = "#/tasks?draft=%E8%A4%87%E7%BF%92+%E5%82%85%E7%AB%8B%E8%91%89&from=explain&back=%23%2Fnote%2Fabc";
  handoff.captureTaskHandoff();

  // Synchronously: the address is plain #/tasks, the old draft is gone, nothing is shown yet.
  assert.deepEqual(replaced, ["#/tasks"]);
  assert.equal(fakeWindow.location.hash, "#/tasks");
  assert.equal(store.has(KEY), false, "a new handoff deletes the old draft before it is validated");
  assert.equal(handoff.getTaskHandoff().kind, "checking");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "/api/suite/manifest", "Personal's own server, same origin");

  // The manifest cannot be read: the draft is held, unverified, and not written anywhere.
  requests[0]?.reject(new TypeError("offline"));
  await flush();
  assert.equal(handoff.getTaskHandoff().kind, "unverified");
  assert.equal(store.has(KEY), false);

  handoff.retryTaskHandoff();
  assert.equal(handoff.getTaskHandoff().kind, "checking");
  assert.equal(requests.length, 2);
  requests[1]?.resolve(manifestBody());
  await flush();

  const state = handoff.getTaskHandoff();
  assert.equal(state.kind, "draft");
  if (state.kind !== "draft") return;
  assert.equal(state.draft.text, "複習 傅立葉");
  assert.equal(state.draft.from, "explain");
  assert.equal(state.draft.backUrl, `${EXPLAIN}/#/note/abc`);
  assert.deepEqual(JSON.parse(store.get(KEY) ?? "null"), state.draft, "written whole under the one key");
  assert.deepEqual([...store.keys()], [KEY]);

  // 建立待辦: the key is taken out before the request, and put back only if it fails.
  const restore = handoff.holdTaskHandoff(state.draft);
  assert.equal(store.has(KEY), false, "a reload while the request is out cannot offer the draft again");
  restore();
  assert.deepEqual(JSON.parse(store.get(KEY) ?? "null"), state.draft);

  handoff.taskHandoffCreated({ id: "t-1", title: "複習 傅立葉" }, state.draft, `${EXPLAIN}/#/note/abc`);
  assert.equal(store.has(KEY), false);
  assert.deepEqual(handoff.getTaskHandoff(), { kind: "created", id: "t-1", title: "複習 傅立葉", from: "explain", backUrl: `${EXPLAIN}/#/note/abc` });
  restore();
  assert.equal(store.has(KEY), false, "after a success nothing puts the draft back");

  handoff.leaveTaskRoute();
  assert.equal(handoff.getTaskHandoff().kind, "none");
  assert.equal(requests.length, 2, "the manifest is read once per load (plus the one retry)");
});

test("an unlinked sender is rejected, and still deletes the older draft", async () => {
  const handoff = await import("./useTaskHandoff");
  store.set(KEY, OLD);
  fakeWindow.location.hash = "#/tasks?draft=x&from=pr";
  replaced.length = 0;
  handoff.captureTaskHandoff();
  assert.deepEqual(replaced, ["#/tasks"]);
  assert.equal(store.has(KEY), false);
  assert.deepEqual(handoff.getTaskHandoff(), { kind: "rejected", reason: "from" }, "the manifest is already known: decided at once");
  handoff.leaveTaskRoute();
  assert.equal(handoff.getTaskHandoff().kind, "none");

  store.set(KEY, OLD);
  fakeWindow.location.hash = "#/tasks?from=explain";
  handoff.captureTaskHandoff();
  assert.equal(store.has(KEY), false, "a handoff parameter without a draft still replaces the old one (SPEC §5.5)");
  assert.deepEqual(handoff.getTaskHandoff(), { kind: "rejected", reason: "missing" }, "and is refused with a notice, not taken for an ordinary visit");
  handoff.discardTaskHandoff();
});

test("an attempt without a usable draft (rev. d, E1–E5) cleans the address, deletes the older draft and shows a refusal", async () => {
  const handoff = await import("./useTaskHandoff");
  for (const [hash, reason] of [
    ["#/tasks?from=explain", "missing"],
    ["#/tasks?back=%23%2Flibrary&from=explain", "missing"],
    ["#/tasks?title=x&from=explain", "missing"],
    ["#/tasks?from=explain&from=pr", "duplicate"],
    ["#/tasks?text=a&from=explain", "missing"],
    ["#/tasks?back", "missing"],
    ["#/tasks?fr%6Fm=explain", "missing"],
    ["#/tasks?draft=&from=explain", "empty"],
  ] as const) {
    store.set(KEY, OLD);
    replaced.length = 0;
    fakeWindow.location.hash = hash;
    handoff.captureTaskHandoff();
    assert.deepEqual(replaced, ["#/tasks"], `${hash}: the address is plain #/tasks at once`);
    assert.equal(store.has(KEY), false, `${hash}: the older draft is gone, and nothing new is written`);
    assert.deepEqual(handoff.getTaskHandoff(), { kind: "rejected", reason }, hash);
    handoff.discardTaskHandoff();
  }
});

test("an ordinary visit without a reserved key keeps the stored draft and the address (rev. d, E9–E11)", async () => {
  const handoff = await import("./useTaskHandoff");
  for (const hash of ["#/tasks", "#/tasks?group=someday", "#/tasks?focus=t-1", "#/tasks?x=1", "#/tasks/t-1?from=explain", "#/tasks?Draft=x&From=explain"]) {
    store.set(KEY, OLD);
    replaced.length = 0;
    fakeWindow.location.hash = hash;
    handoff.captureTaskHandoff();
    assert.deepEqual(replaced, [], `${hash}: the address is not touched`);
    assert.equal(fakeWindow.location.hash, hash);
    assert.equal(store.get(KEY), OLD, `${hash}: the stored draft stays`);
  }
  store.delete(KEY);
});

test("a repeated draft, from or back is rejected as a whole (contract D9), after the address is cleaned and the older draft deleted", async () => {
  const handoff = await import("./useTaskHandoff");
  for (const hash of [
    "#/tasks?draft=a&draft=b&from=explain",
    "#/tasks?draft=a&from=explain&from=pr",
    "#/tasks?draft=a&from=explain&from=explain",
    "#/tasks?draft=a&from=explain&back=%23%2Freview&back=",
    "#/tasks?dr%61ft=a&draft=b&from=explain",
  ]) {
    store.set(KEY, OLD);
    replaced.length = 0;
    fakeWindow.location.hash = hash;
    handoff.captureTaskHandoff();
    assert.deepEqual(replaced, ["#/tasks"], hash);
    assert.equal(store.has(KEY), false, `${hash}: the older draft is gone, and nothing new is written`);
    assert.deepEqual(handoff.getTaskHandoff(), { kind: "rejected", reason: "duplicate" }, hash);
    handoff.discardTaskHandoff();
  }

  // A repeated parameter that is not part of the handoff changes nothing.
  fakeWindow.location.hash = "#/tasks?draft=ok&from=explain&utm=1&utm=2";
  handoff.captureTaskHandoff();
  const state = handoff.getTaskHandoff();
  assert.equal(state.kind, "draft");
  if (state.kind === "draft") assert.equal(state.draft.text, "ok");
  handoff.discardTaskHandoff();
});

test("a hash without handoff parameters is left alone", async () => {
  const handoff = await import("./useTaskHandoff");
  replaced.length = 0;
  store.set(KEY, OLD);
  for (const hash of ["#/tasks", "#/today", "#/tasks/abc", "#/tasks?filter=open"]) {
    fakeWindow.location.hash = hash;
    handoff.captureTaskHandoff();
  }
  assert.deepEqual(replaced, []);
  assert.equal(store.get(KEY), OLD, "the stored draft stays");
  store.delete(KEY);
});

test("捨棄草稿 deletes the key", async () => {
  const handoff = await import("./useTaskHandoff");
  fakeWindow.location.hash = "#/tasks?draft=%E7%AC%AC%E4%B8%89%E4%BB%BD&from=explain";
  handoff.captureTaskHandoff();
  assert.equal(handoff.getTaskHandoff().kind, "draft");
  assert.equal(store.has(KEY), true);
  handoff.discardTaskHandoff();
  assert.equal(store.has(KEY), false);
  assert.equal(handoff.getTaskHandoff().kind, "none");
});


test("sync protection covers raw arrival, restored and discarded drafts, and releases only after leaving tasks", async () => {
  const handoff = await import("./useTaskHandoff");
  handoff.leaveTaskRoute();
  store.delete(KEY);
  fakeWindow.location.hash = "#/today";
  assert.equal(handoff.taskHandoffSyncBlocked(), false, "an ordinary route has no protection");

  fakeWindow.location.hash = "#/tasks?draft=raw&from=explain";
  assert.equal(handoff.taskHandoffSyncBlocked(), true, "reserved parameters are protected before capture runs");
  handoff.captureTaskHandoff();
  assert.equal(handoff.getTaskHandoff().kind, "draft");
  assert.equal(handoff.taskHandoffSyncBlocked(), true, "the cleaned URL still has a draft");

  handoff.discardTaskHandoff();
  assert.equal(handoff.getTaskHandoff().kind, "none");
  assert.equal(handoff.taskHandoffSyncBlocked(), true, "discard does not trigger sync while staying on tasks");

  fakeWindow.location.hash = "#/today";
  handoff.leaveTaskRoute();
  assert.equal(handoff.taskHandoffSyncBlocked(), false, "ordinary navigation releases the protection");

  fakeWindow.location.hash = "#/tasks?draft=returned&from=explain";
  handoff.captureTaskHandoff();
  assert.equal(handoff.getTaskHandoff().kind, "draft");
  assert.equal(handoff.taskHandoffSyncBlocked(), true, "returning with a draft protects again");
  fakeWindow.location.hash = "#/today";
  handoff.leaveTaskRoute();
  fakeWindow.location.hash = "#/tasks";
  assert.equal(handoff.taskHandoffSyncBlocked(), true, "returning to the existing draft re-arms the visit");
  handoff.discardTaskHandoff();
  assert.equal(handoff.taskHandoffSyncBlocked(), true, "discarding after that return still cannot sync");
  handoff.leaveTaskRoute();
});
