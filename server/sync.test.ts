import test from "node:test";
import assert from "node:assert/strict";
import { AppDatabase } from "./db/database.js";
import { SOURCES_MIGRATIONS } from "./db/schema.js";
import { AppError } from "./errors.js";
import { VaultKeyError } from "./secrets/vault.js";
import { SourceItemStore } from "./stores/source-items.js";
import { SyncStateStore } from "./stores/sync-state.js";
import { SourceSync, expectOk, safeFetch, type FetchLike, type SyncContext, type SyncOutcome } from "./sync.js";

function stores(t: test.TestContext) {
  const db = new AppDatabase({ path: ":memory:", name: "來源快取", migrations: SOURCES_MIGRATIONS, sensitive: true });
  t.after(() => db.close());
  return { db, state: new SyncStateStore(db), items: new SourceItemStore(db) };
}

class FakeSource extends SourceSync {
  runs = 0;
  ready = true;
  behaviour: (context: SyncContext) => Promise<SyncOutcome> = async () => ({ items: 0 });
  configured() { return this.ready; }
  protected async run(context: SyncContext) { this.runs++; return this.behaviour(context); }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("concurrent syncs share one run and the outcome is persisted", async (t) => {
  const { state } = stores(t);
  const source = new FakeSource({ id: "github", state });
  t.after(() => source.close());
  let release!: () => void;
  source.behaviour = async () => { await new Promise<void>((resolve) => { release = resolve; }); return { items: 7, cursor: "c1" }; };
  const first = source.sync();
  const second = source.sync();
  await tick();
  assert.equal((await source.status()).state, "syncing");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(source.runs, 1);
  assert.equal(a.state, "ok");
  assert.equal(b.items, 7);
  assert.equal(state.get("github")?.cursor, "c1");
  assert.ok(state.get("github")?.lastSyncedAt);
  // The cursor is handed to the next run.
  let seen: string | null = null;
  source.behaviour = async (context) => { seen = context.cursor; return {}; };
  await source.sync();
  assert.equal(seen, "c1");
  assert.equal(state.get("github")?.items, 7, "an outcome without items keeps the previous count");
});

test("the interval keeps syncing in the background and close() stops it and aborts the fetch", async (t) => {
  const { state } = stores(t);
  const source = new FakeSource({ id: "ctftime", state, intervalMs: 20 });
  let aborted = false;
  source.behaviour = async () => ({ items: 1 });
  source.start();
  await tick(80);
  assert.ok(source.runs >= 2, `ran ${source.runs} times`);
  source.behaviour = (context) => new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => { aborted = true; reject(context.signal.reason); }));
  await tick(30);
  await source.close();
  assert.equal(aborted, true);
  const runs = source.runs;
  await tick(60);
  assert.equal(source.runs, runs);
  assert.notEqual(state.get("ctftime")?.state, "syncing");
});

test("failures are stored redacted; credential failures become needs_reconnect and stop background retries", async (t) => {
  const { state } = stores(t);
  const source = new FakeSource({ id: "gmail", state });
  t.after(() => source.close());
  source.behaviour = async () => { throw new AppError(502, `Gmail 回應錯誤 token ghp_${"a".repeat(30)}`); };
  let status = await source.sync();
  assert.equal(status.state, "error");
  assert.match(status.lastError ?? "", /\[REDACTED\]/);
  source.behaviour = async () => { throw new Error("internal /home/user detail"); };
  status = await source.sync();
  assert.equal(status.lastError, "同步 Gmail 時發生問題，稍後會自動重試。");
  source.behaviour = async () => { throw Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }); };
  status = await source.sync();
  assert.equal(status.state, "needs_reconnect");
  assert.match(status.lastError ?? "", /需要重新連線/);
  const runs = source.runs;
  source.schedule();
  await tick();
  assert.equal(source.runs, runs, "background schedule skips a source waiting for reconnect");
  assert.equal(await source.request(false), false);
  source.behaviour = async () => { throw new VaultKeyError(); };
  assert.equal((await source.sync()).state, "needs_reconnect");
  source.behaviour = async () => ({ items: 3 });
  assert.equal(await source.request(true), true, "a forced request still runs, e.g. after reconnecting");
  await tick();
  assert.equal((await source.status()).state, "ok");
});

test("an unconfigured source never runs and reports 尚未設定 without an error", async (t) => {
  const { state } = stores(t);
  const source = new FakeSource({ id: "moodle", state });
  t.after(() => source.close());
  source.ready = false;
  const status = await source.sync();
  assert.equal(source.runs, 0);
  assert.equal(status.state, "not_configured");
  assert.equal(status.configured, false);
  assert.equal(await source.request(true), false);
});

test("request() syncs only stale sources unless forced", async (t) => {
  const { state } = stores(t);
  let now = new Date("2026-10-12T00:00:00Z");
  const source = new FakeSource({ id: "feeds", state, staleAfterMs: 60_000, now: () => now });
  t.after(() => source.close());
  assert.equal(await source.request(), true);
  await tick();
  assert.equal(source.runs, 1);
  assert.equal(await source.request(), false);
  now = new Date("2026-10-12T00:01:01Z");
  assert.equal(await source.request(), true);
  await tick();
  assert.equal(source.runs, 2);
});

test("a configured() that throws (unreadable vault) never rejects: needs_reconnect or error, and status() still answers", async (t) => {
  const { state } = stores(t);
  class VaultSource extends FakeSource {
    failure: unknown = new VaultKeyError();
    override configured(): boolean { throw this.failure; }
  }
  const source = new VaultSource({ id: "gmail", state });
  t.after(() => source.close());
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); });
  source.schedule();
  await tick(20);
  assert.deepEqual(unhandled, [], "the boot kick does not leave an unhandled rejection");
  assert.equal(source.runs, 0);
  assert.equal(state.get("gmail")?.state, "needs_reconnect");
  assert.match(state.get("gmail")?.lastError ?? "", /需要重新連線/);
  const status = await source.status();
  assert.equal(status.configured, true);
  assert.equal(status.state, "needs_reconnect");
  assert.equal(await source.request(true), true, "a forced request does not reject either");
  await tick();
  source.failure = new AppError(500, "憑證檔案格式不正確，請檢查本機服務記錄。");
  state.save("gmail", { state: "idle" });
  const corrupt = await source.sync();
  assert.equal(corrupt.state, "error");
  assert.match(corrupt.lastError ?? "", /憑證檔案格式不正確/);
  assert.equal((await source.status()).state, "error");
});

test("an unforced request waits staleAfterMs after a failed attempt instead of retrying on every focus", async (t) => {
  const { state } = stores(t);
  let now = new Date("2026-10-12T00:00:00Z");
  const source = new FakeSource({ id: "ctftime", state, staleAfterMs: 60_000, now: () => now });
  t.after(() => source.close());
  source.behaviour = async () => { throw new AppError(502, "CTFtime 回應 HTTP 503，稍後會自動重試。"); };
  assert.equal(await source.request(), true);
  await tick();
  assert.equal(source.runs, 1);
  assert.equal(state.get("ctftime")?.state, "error");
  assert.equal(source.isStale(), true, "the data itself is still stale for the UI");
  now = new Date("2026-10-12T00:00:30Z");
  assert.equal(await source.request(), false, "a focus 30 s after the failure does not refetch");
  assert.equal(await source.request(true), true, "an explicit 重新整理 still runs");
  await tick();
  assert.equal(source.runs, 2);
  now = new Date("2026-10-12T00:01:31Z");
  assert.equal(await source.request(), true);
  await tick();
  assert.equal(source.runs, 3);
});

test("boot repair reports a sync interrupted by a restart", (t) => {
  const { state } = stores(t);
  state.save("gmail", { state: "syncing" });
  assert.equal(state.repairAfterRestart(), 1);
  assert.equal(state.get("gmail")?.state, "error");
  assert.match(state.get("gmail")?.lastError ?? "", /重新啟動/);
});

test("safeFetch: HTTPS only, no redirects, a deadline and a body cap", async () => {
  const seen: RequestInit[] = [];
  const fake: FetchLike = async (_url, init) => {
    seen.push(init!);
    return new Response("x".repeat(100), { status: 200, headers: { "content-type": "text/plain" } });
  };
  const signal = new AbortController().signal;
  await assert.rejects(safeFetch(fake, "http://example.com/feed", signal), /HTTPS/);
  await assert.rejects(safeFetch(fake, "https://u:p@example.com/", signal), /帳號密碼/);
  const response = await safeFetch(fake, "https://example.com/feed", signal);
  assert.equal(response.text().length, 100);
  assert.equal(seen[0].redirect, "error");
  assert.match(String((seen[0].headers as Record<string, string>)["user-agent"]), /^bell-personal\//);
  assert.ok(seen[0].signal);
  await assert.rejects(safeFetch(fake, "https://example.com/feed", signal, { maxBytes: 50 }), /大小限制/);
  const failing: FetchLike = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(safeFetch(failing, "https://example.com", signal), (error: { status?: number }) => error.status === 502);
  const unauthorized = await safeFetch(async () => new Response("{}", { status: 401 }), "https://example.com", signal);
  assert.throws(() => expectOk(unauthorized, "Canvas"), (error: Error) => error.name === "ReconnectRequiredError");
});

test("the item cache upserts, windows and replaces per source", (t) => {
  const { items } = stores(t);
  items.upsert("google-calendar", [
    { kind: "calendar-event", externalId: "e1", value: { title: "A" }, startsAt: "2026-10-12T16:00:00.000Z" },
    { kind: "calendar-event", externalId: "e2", value: { title: "B" }, startsAt: "2026-10-13T02:00:00.000Z" },
    { kind: "calendar-event", externalId: "e3", value: { title: "C" }, startsAt: "2026-10-14T02:00:00.000Z" },
  ]);
  const day = items.list<{ title: string }>({ kind: "calendar-event", window: { field: "startsAt", from: "2026-10-12T16:00:00.000Z", to: "2026-10-13T16:00:00.000Z" } });
  assert.deepEqual(day.map((item) => item.value.title), ["A", "B"]);
  assert.deepEqual(items.replace("google-calendar", "calendar-event", [{ kind: "calendar-event", externalId: "e2", value: { title: "B2" } }]), { upserted: 1, removed: 2 });
  assert.equal(items.count("google-calendar"), 1);
  assert.equal(items.get<{ title: string }>("google-calendar", "e2")?.value.title, "B2");
  assert.equal(items.clear("google-calendar"), 1);
});
