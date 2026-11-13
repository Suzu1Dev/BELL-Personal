import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SuiteSource, SuiteSourcesResponse } from "../../shared/suite.js";
import { appContext } from "../app.js";
import { PUBLIC_PATHS } from "../security.js";
import { startTestServer, testServices, type TestServer } from "../test-helpers.js";
import type { SuiteOptions } from "./service.js";
import { VALID_FEED } from "./test-fixtures.js";

const ownOrigin = "https://box.tailone.ts.net:20003";
const ownHost = new URL(ownOrigin).host;
const projectRoot = path.resolve(import.meta.dirname, "../..");

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A sibling app on 127.0.0.1:0 that records every request it receives; `handle` may be swapped mid-test. */
interface Sibling {
  origin: string;
  requests: Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  handle: Handler;
}

async function startSibling(t: TestContext, handle: Handler = sendJson(VALID_FEED)): Promise<Sibling> {
  const sibling: Sibling = { origin: "", requests: [], handle };
  const server = http.createServer((req, res) => {
    sibling.requests.push({ url: req.url ?? "", headers: req.headers });
    sibling.handle(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  sibling.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return sibling;
}

function sendJson(body: unknown, status = 200, type = "application/json; charset=utf-8"): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

/** Resolves when the sibling's side of this request's connection closes. */
const socketClosed = (req: http.IncomingMessage) => new Promise<void>((resolve) => req.socket.once("close", () => resolve()));

function fakeClock(start = "2026-11-08T05:30:00.000Z") {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
    iso: () => new Date(current).toISOString(),
  };
}

async function personal(t: TestContext, env: NodeJS.ProcessEnv = {}, suite: SuiteOptions = {}): Promise<TestServer> {
  return startTestServer(t, testServices(t, { env }), { suite });
}

const fetchEnv = (sibling: Sibling) => ({ BELLPERSONAL_SUITE_FETCH: `explain=${sibling.origin}` });

async function sources(server: TestServer, query = "", headers: Record<string, string> = {}): Promise<SuiteSourcesResponse> {
  const res = await server.call("GET", `/api/suite/sources${query}`, { headers });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers["cache-control"], "no-store");
  return res.json as SuiteSourcesResponse;
}
const explainOf = async (server: TestServer, query = ""): Promise<SuiteSource> => (await sources(server, query)).sources[0]!;

function recordLog() {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return { events, log: (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); } };
}

test("the suite routes sit behind the origin guard and the identity gate, without CORS", async (t) => {
  const sibling = await startSibling(t);
  const server = await personal(t, { BELLPERSONAL_ALLOWED_ORIGINS: ownOrigin, ...fetchEnv(sibling) });
  for (const route of ["/api/suite/manifest", "/api/suite/sources", "/api/suite/sources?refresh=1"]) {
    for (const headers of [
      { host: "evil.example:20003" },
      { host: ownHost, origin: "https://evil.example" },
      // A sibling's origin is a link target, never an allowed Origin.
      { host: ownHost, origin: "https://box.tailone.ts.net:20001" },
      { host: ownHost, "sec-fetch-site": "cross-site" },
      { host: ownHost, origin: ownOrigin, "sec-fetch-site": "cross-site" },
      { host: ownHost, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    ]) {
      const res = await server.call("GET", route, { headers });
      assert.equal(res.status, 403, `${route} ${JSON.stringify(headers)}`);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    }
  }
  const preflight = await server.call("OPTIONS", "/api/suite/sources", {
    headers: { host: ownHost, origin: "https://evil.example", "access-control-request-method": "GET" },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
  assert.equal(sibling.requests.length, 0, "a refused request never reaches the sibling");

  for (const route of ["/api/suite/manifest", "/api/suite/sources"]) {
    const res = await server.call("GET", route, { headers: { host: ownHost, origin: ownOrigin } });
    assert.equal(res.status, 200, route);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  }
  // Read-only: no write endpoint, and Personal serves no today feed of its own.
  assert.equal((await server.call("POST", "/api/suite/sources", { headers: { host: ownHost, origin: ownOrigin }, body: {} })).status, 404);
  assert.equal((await server.call("GET", "/api/suite/today")).status, 404);
  for (const publicPath of PUBLIC_PATHS) assert.ok(!publicPath.startsWith("/api/suite"), publicPath);
});

test("with Tailscale users configured, a request without the owner's identity is refused before any read", async (t) => {
  const sibling = await startSibling(t);
  const server = await personal(t, { BELLPERSONAL_TAILSCALE_USERS: "alice@github", ...fetchEnv(sibling) });
  for (const route of ["/api/suite/manifest", "/api/suite/sources", "/api/suite/sources?refresh=1"]) {
    const res = await server.call("GET", route);
    assert.equal(res.status, 403, route);
    assert.equal(res.json.error, "此服務只開放給擁有者的 Tailscale 帳號。");
  }
  assert.equal(sibling.requests.length, 0);
});

test("the manifest lists Personal's capabilities and only the configured browser links", async (t) => {
  const server = await personal(t, {
    BELLPERSONAL_ALLOWED_ORIGINS: ownOrigin,
    BELLPERSONAL_SUITE_LINKS: "explain=https://box.tailone.ts.net:20001, pr=http://127.0.0.1:4610",
    BELLPERSONAL_SUITE_FETCH: "explain=http://127.0.0.1:20011",
  });
  const res = await server.call("GET", "/api/suite/manifest");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(res.json, {
    schemaVersion: 1,
    appId: "personal",
    displayName: "BELL Personal",
    summary: "今日、任務與收件匣",
    capabilities: [
      { id: "tasks.draft", kind: "accept-handoff", route: "#/tasks", accepts: ["text"], maxChars: 2000 },
      { id: "todo.open", kind: "object-route", route: "#/tasks/{id}" },
      { id: "event.open", kind: "object-route", route: "#/events/{id}" },
      { id: "idea.open", kind: "object-route", route: "#/ideas/{id}" },
    ],
    links: { explain: "https://box.tailone.ts.net:20001", pr: "http://127.0.0.1:4610" },
  });
  assert.ok(!res.text.includes("20011"), "the server's read target never reaches the browser");

  const bare = await personal(t);
  assert.deepEqual((await bare.call("GET", "/api/suite/manifest")).json.links, {});
});

test("without BELLPERSONAL_SUITE_FETCH both siblings are unconfigured and nothing is read", async (t) => {
  const server = await personal(t);
  assert.deepEqual(await sources(server), {
    schemaVersion: 1,
    sources: [{ appId: "explain", status: "unconfigured" }, { appId: "pr", status: "unconfigured" }],
  });
  assert.deepEqual(await sources(server, "?refresh=1"), {
    schemaVersion: 1,
    sources: [{ appId: "explain", status: "unconfigured" }, { appId: "pr", status: "unconfigured" }],
  });
});

test("PR is unsupported once linked or configured, and is never read", async (t) => {
  const pr = await startSibling(t);
  const linked = await personal(t, { BELLPERSONAL_SUITE_LINKS: "pr=http://127.0.0.1:4610" });
  assert.deepEqual((await sources(linked)).sources[1], { appId: "pr", status: "unsupported" });
  const fetched = await personal(t, { BELLPERSONAL_SUITE_FETCH: `pr=${pr.origin}` });
  assert.deepEqual(await sources(fetched, "?refresh=1"), {
    schemaVersion: 1,
    sources: [{ appId: "explain", status: "unconfigured" }, { appId: "pr", status: "unsupported" }],
  });
  assert.equal(pr.requests.length, 0);
});

test("a valid feed is ready, and the read carries only Accept and Host", async (t) => {
  const sibling = await startSibling(t);
  const clock = fakeClock();
  const server = await personal(t, fetchEnv(sibling), { now: clock.now });
  const body = await sources(server, "", {
    origin: "http://127.0.0.1:4331",
    cookie: "session=owner-secret",
    authorization: "Bearer owner-token",
    referer: "http://127.0.0.1:4331/#/today",
    "x-forwarded-for": "100.64.0.1",
    "user-agent": "browser",
  });
  assert.deepEqual(body, {
    schemaVersion: 1,
    sources: [{ appId: "explain", status: "ready", lastSuccessAt: "2026-11-08T05:30:00.000Z", feed: VALID_FEED }, { appId: "pr", status: "unconfigured" }],
  });
  assert.equal(sibling.requests.length, 1);
  const [read] = sibling.requests;
  assert.equal(read!.url, "/api/suite/today");
  assert.deepEqual(Object.keys(read!.headers).sort(), ["accept", "connection", "host"]);
  assert.equal(read!.headers.accept, "application/json");
  assert.equal(read!.headers.host, new URL(sibling.origin).host);
  assert.equal(read!.headers.connection, "close");
});

test("reads within 60 s answer from memory; refresh=1 reads again", async (t) => {
  const sibling = await startSibling(t);
  const clock = fakeClock();
  const server = await personal(t, fetchEnv(sibling), { now: clock.now });
  assert.equal((await explainOf(server)).status, "ready");
  assert.equal(sibling.requests.length, 1);

  clock.advance(30_000);
  const cached = await explainOf(server);
  assert.equal(cached.status, "ready");
  assert.equal(cached.lastSuccessAt, "2026-11-08T05:30:00.000Z");
  for (const query of ["?refresh=true", "?refresh=0", "?refresh=", "?refresh=1&refresh=1", "?other=1"]) await explainOf(server, query);
  assert.equal(sibling.requests.length, 1, "within 60 s and without refresh=1 nothing is read");

  const refreshed = await explainOf(server, "?refresh=1");
  assert.equal(refreshed.lastSuccessAt, "2026-11-08T05:30:30.000Z");
  assert.equal(sibling.requests.length, 2);

  clock.advance(59_000);
  await explainOf(server);
  assert.equal(sibling.requests.length, 2);
  clock.advance(1_000);
  const reread = await explainOf(server);
  assert.equal(sibling.requests.length, 3);
  assert.equal(reread.lastSuccessAt, clock.iso());
});

test("a failed read keeps the last feed as stale for 30 min, then drops it", async (t) => {
  const sibling = await startSibling(t);
  const clock = fakeClock();
  const server = await personal(t, fetchEnv(sibling), { now: clock.now });
  assert.equal((await explainOf(server)).status, "ready");

  sibling.handle = sendJson({ error: "boom" }, 500);
  clock.advance(2 * 60_000);
  assert.deepEqual(await explainOf(server), { appId: "explain", status: "stale", lastSuccessAt: "2026-11-08T05:30:00.000Z", feed: VALID_FEED });
  clock.advance(27 * 60_000);
  assert.equal((await explainOf(server)).status, "stale", "29 minutes after the last success");
  clock.advance(2 * 60_000);
  assert.deepEqual(await explainOf(server), { appId: "explain", status: "unavailable", lastSuccessAt: "2026-11-08T05:30:00.000Z" });
  assert.equal(sibling.requests.length, 4);
  // The dropped feed does not come back while the sibling keeps failing.
  assert.deepEqual(await explainOf(server, "?refresh=1"), { appId: "explain", status: "unavailable", lastSuccessAt: "2026-11-08T05:30:00.000Z" });

  sibling.handle = sendJson(VALID_FEED);
  assert.deepEqual(await explainOf(server, "?refresh=1"), { appId: "explain", status: "ready", lastSuccessAt: clock.iso(), feed: VALID_FEED });
});

test("a sibling that never answers times out (3 s by default) and its socket is closed", async (t) => {
  const defaults = await personal(t);
  assert.equal(appContext(defaults.app).suite.timeoutMs, 3000);
  assert.equal(appContext(defaults.app).suite.maxBytes, 64 * 1024);

  const closed: Array<Promise<void>> = [];
  const sibling = await startSibling(t, (req) => { closed.push(socketClosed(req)); });
  const { events, log } = recordLog();
  const server = await personal(t, fetchEnv(sibling), { timeoutMs: 200, log });
  const started = performance.now();
  assert.deepEqual(await explainOf(server), { appId: "explain", status: "unavailable" });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 190 && elapsed < 2000, `answered after ${Math.round(elapsed)} ms`);
  await closed[0];
  assert.equal(events[0]?.fields.reason, "timeout");

  // The deadline covers the body too: headers then silence.
  sibling.handle = (req, res) => {
    closed.push(socketClosed(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"schemaVersion":1,');
  };
  assert.equal((await explainOf(server, "?refresh=1")).status, "unavailable");
  await closed[1];
  assert.deepEqual(events.map((entry) => entry.fields.reason), ["timeout", "timeout"]);
});

test("a body over 64 KiB is refused and the connection is cut as soon as the cap is passed", async (t) => {
  let streamed = 0;
  let closed: Promise<void> | undefined;
  const sibling = await startSibling(t, (req, res) => {
    closed = socketClosed(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"schemaVersion":1,"pad":"');
    // Up to 4 MiB, 16 KiB every 5 ms: only an early abort ends this before the 10 s deadline.
    const timer = setInterval(() => {
      if (res.destroyed || streamed >= 4 * 1024 * 1024) return clearInterval(timer);
      res.write("x".repeat(16 * 1024));
      streamed += 16 * 1024;
    }, 5);
    req.socket.once("close", () => clearInterval(timer));
  });
  const { events, log } = recordLog();
  const server = await personal(t, fetchEnv(sibling), { timeoutMs: 10_000, log });
  const started = performance.now();
  assert.deepEqual(await explainOf(server), { appId: "explain", status: "unavailable" });
  assert.ok(performance.now() - started < 5000);
  await closed;
  assert.ok(streamed < 512 * 1024, `the sibling streamed ${streamed} bytes before the cut`);
  assert.equal(events[0]?.fields.reason, "too-large");

  // A declared length over the cap is refused before any body is read.
  sibling.handle = (req, res) => {
    closed = socketClosed(req);
    res.writeHead(200, { "content-type": "application/json", "content-length": String(64 * 1024 + 1) });
    res.write("{");
  };
  assert.equal((await explainOf(server, "?refresh=1")).status, "unavailable");
  await closed;
  assert.equal(events[1]?.fields.reason, "too-large");

  // Exactly at the cap is fine.
  const padded = JSON.stringify(VALID_FEED);
  const exact = padded.slice(0, -1) + " ".repeat(64 * 1024 - Buffer.byteLength(padded)) + "}";
  sibling.handle = sendJson(exact);
  assert.equal((await explainOf(server, "?refresh=1")).status, "ready");
});

test("a redirect is a failure and is never followed", async (t) => {
  const target = await startSibling(t);
  const sibling = await startSibling(t, (_req, res) => {
    res.writeHead(302, { location: `${target.origin}/api/suite/today`, "content-type": "application/json" });
    res.end("{}");
  });
  const { events, log } = recordLog();
  const server = await personal(t, fetchEnv(sibling), { log });
  assert.deepEqual(await explainOf(server), { appId: "explain", status: "unavailable" });
  assert.equal(sibling.requests.length, 1);
  assert.equal(target.requests.length, 0);
  assert.equal(events[0]?.fields.reason, "status");
});

test("a 500, a non-JSON content type or a dropped connection is a failure, logged without the body or address", async (t) => {
  const sibling = await startSibling(t, sendJson({ error: "secret stack trace" }, 500));
  const { events, log } = recordLog();
  const server = await personal(t, fetchEnv(sibling), { log });
  assert.deepEqual(await explainOf(server), { appId: "explain", status: "unavailable" });
  sibling.handle = sendJson(VALID_FEED, 200, "text/html; charset=utf-8");
  assert.deepEqual(await explainOf(server, "?refresh=1"), { appId: "explain", status: "unavailable" });
  sibling.handle = sendJson(VALID_FEED, 200, "application/json-seq");
  assert.equal((await explainOf(server, "?refresh=1")).status, "unavailable");
  sibling.handle = (req) => { req.socket.destroy(); };
  assert.equal((await explainOf(server, "?refresh=1")).status, "unavailable");
  sibling.handle = sendJson("{not json");
  assert.equal((await explainOf(server, "?refresh=1")).status, "unavailable");
  sibling.handle = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  };
  assert.equal((await explainOf(server, "?refresh=1")).status, "unavailable", "invalid UTF-8");

  assert.deepEqual(events.map((entry) => entry.fields.reason), ["status", "content-type", "content-type", "connect", "invalid", "invalid"]);
  for (const entry of events) {
    assert.equal(entry.event, "suite.read_failed");
    assert.deepEqual(Object.keys(entry.fields).sort(), ["appId", "ms", "reason"]);
    assert.equal(entry.fields.appId, "explain");
    assert.equal(typeof entry.fields.ms, "number");
  }
  const logged = JSON.stringify(events);
  assert.ok(!logged.includes("secret") && !logged.includes(new URL(sibling.origin).port) && !logged.includes("127.0.0.1"));
});

test("an invalid feed is refused whole; another schemaVersion also drops the cached feed", async (t) => {
  const item = (patch: Record<string, unknown>) => ({ ...VALID_FEED, items: [{ ...VALID_FEED.items[0], ...patch }, VALID_FEED.items[1]] });
  const sibling = await startSibling(t);
  const clock = fakeClock();
  const { events, log } = recordLog();
  const server = await personal(t, fetchEnv(sibling), { now: clock.now, log });
  for (const feed of [
    item({ answer: "F(ω)=∫f(t)e^{-iωt}dt" }),
    item({ href: "https://evil.example/#/review" }),
    { ...VALID_FEED, hints: ["積分"] },
    { ...VALID_FEED, appId: "pr", items: [] },
    { ...VALID_FEED, schemaVersion: 2 },
  ]) {
    sibling.handle = sendJson(feed);
    assert.deepEqual(await explainOf(server, "?refresh=1"), { appId: "explain", status: "unavailable" }, JSON.stringify(feed).slice(0, 120));
  }
  assert.deepEqual(events.map((entry) => entry.fields.reason), ["invalid", "invalid", "invalid", "invalid", "version"]);

  // An ordinary failure would leave a stale feed; a version mismatch leaves none.
  sibling.handle = sendJson(VALID_FEED);
  assert.equal((await explainOf(server, "?refresh=1")).status, "ready");
  const success = clock.iso();
  clock.advance(60_000);
  sibling.handle = sendJson({ ...VALID_FEED, items: [{ ...VALID_FEED.items[0], answer: "x" }] });
  assert.equal((await explainOf(server)).status, "stale");
  sibling.handle = sendJson({ ...VALID_FEED, schemaVersion: 2 });
  assert.deepEqual(await explainOf(server, "?refresh=1"), { appId: "explain", status: "unavailable", lastSuccessAt: success });
});

test("concurrent refreshes share one upstream read", async (t) => {
  const sibling = await startSibling(t, (_req, res) => {
    setTimeout(() => sendJson(VALID_FEED)(_req, res), 150);
  });
  const server = await personal(t, fetchEnv(sibling));
  const answers = await Promise.all([explainOf(server, "?refresh=1"), explainOf(server, "?refresh=1"), explainOf(server)]);
  assert.equal(sibling.requests.length, 1);
  for (const answer of answers) assert.equal(answer.status, "ready");
  assert.equal(new Set(answers.map((answer) => answer.lastSuccessAt)).size, 1);
});

test("no query parameter can choose or change what the server reads", async (t) => {
  const other = await startSibling(t);
  const sibling = await startSibling(t);
  const server = await personal(t, fetchEnv(sibling));
  const target = encodeURIComponent(`${other.origin}/api/suite/today`);
  await sources(server, `?refresh=1&origin=${encodeURIComponent(other.origin)}&url=${target}&target=${target}&appId=pr&app=pr&path=%2Fapi%2Fstatus&host=${encodeURIComponent(new URL(other.origin).host)}`);
  assert.equal((await server.call("GET", "/api/suite/sources/../../api/status?refresh=1")).status, 404);
  assert.equal((await server.call("GET", `/api/suite/sources/${encodeURIComponent(other.origin)}?refresh=1`)).status, 404);
  assert.equal(other.requests.length, 0);
  assert.equal(sibling.requests.length, 1);
  for (const read of sibling.requests) assert.equal(read.url, "/api/suite/today");
});

test("the sibling read never goes through the host's proxy settings", async (t) => {
  const sibling = await startSibling(t);
  const proxy = await startSibling(t, (_req, res) => { res.writeHead(502); res.end(); });
  const client = pathToFileURL(path.join(import.meta.dirname, "client.ts")).href;
  const script = `
    import http from "node:http";
    import { readSiblingJson } from ${JSON.stringify(client)};
    // Control: the global agent does follow the proxy settings in this process.
    const viaGlobalAgent = await new Promise((resolve) => {
      http.get(${JSON.stringify(`${sibling.origin}/control`)}, (res) => { res.resume(); resolve(res.statusCode); }).on("error", () => resolve("error"));
    });
    const feed = await readSiblingJson({ origin: ${JSON.stringify(sibling.origin)}, path: "/api/suite/today", timeoutMs: 3000, maxBytes: 65536 });
    process.stdout.write(JSON.stringify({ viaGlobalAgent, appId: feed.appId }));
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BELLPERSONAL_LOG: "off",
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxy.origin,
      http_proxy: proxy.origin,
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), { viaGlobalAgent: 502, appId: "explain" });
  assert.equal(proxy.requests.length, 1, "only the control request went through the proxy");
  assert.deepEqual(sibling.requests.map((read) => read.url), ["/api/suite/today"]);
});
