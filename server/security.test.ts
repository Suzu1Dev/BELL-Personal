import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { FeatureModule } from "./modules.js";
import { localhostGuard, parseAllowedOrigins } from "./security.js";
import { startTestServer, tempDir, testServices } from "./test-helpers.js";

const remoteOrigin = "https://box.tailone.ts.net:20003";
const remoteHost = new URL(remoteOrigin).host;
const projectRoot = path.resolve(import.meta.dirname, "..");

/** A JSON write endpoint and the OAuth callback, so the guard can be exercised end to end. */
function probeModule(counter: { writes: number; callbacks: number }): FeatureModule {
  return {
    name: "probe",
    setup() {
      const router = Router();
      router.post("/", (req, res) => {
        if (!req.body?.source) { res.status(400).json({ error: "source 必填" }); return; }
        counter.writes++;
        res.status(201).json({ ok: true });
      });
      const oauth = Router();
      oauth.get("/callback", (_req, res) => { counter.callbacks++; res.status(200).json({ ok: true }); });
      oauth.get("/start", (_req, res) => res.json({ ok: true }));
      return { router, routes: [{ path: "/oauth/google", router: oauth }] };
    },
  };
}

test("origin configuration accepts precise HTTP(S) origins and rejects ambiguous values", () => {
  assert.deepEqual(parseAllowedOrigins(), []);
  assert.deepEqual(
    parseAllowedOrigins(` ${remoteOrigin}, https://EXAMPLE.COM:443,http://example.com:80 `),
    [remoteOrigin, "https://example.com", "http://example.com"],
  );
  for (const value of [
    "*",
    "https://*.example.com",
    "https://%2a.example.com",
    "ftp://example.com",
    "https://user:secret@example.com",
    "https://@example.com",
    "https://example.com/",
    "https://example.com/path",
    "https://example.com?query=1",
    "https://example.com#fragment",
    "https://example.com:0",
    "https://example.com:",
    "https://example.com:65536",
    "https://example.com:invalid",
    "https://exam\nple.com",
    "https://example.com\\path",
    `${remoteOrigin},`,
  ]) {
    assert.throws(() => localhostGuard([4331], value), /BELLPERSONAL_ALLOWED_ORIGINS/, value);
  }
});

test("configured proxy supports same-origin JSON API requests without weakening local guards", async (t) => {
  const counter = { writes: 0, callbacks: 0 };
  const services = testServices(t, { env: { BELLPERSONAL_ALLOWED_ORIGINS: remoteOrigin } });
  const server = await startTestServer(t, services, { modules: [probeModule(counter)] });
  const post = (headers: Record<string, string | undefined>, body: unknown = { source: "test" }) => server.call("POST", "/api/probe", { headers, body });

  const success = await post({ host: remoteHost.toUpperCase(), origin: remoteOrigin });
  assert.equal(success.status, 201);
  assert.equal(success.headers["x-content-type-options"], "nosniff");
  assert.equal(success.headers["referrer-policy"], "no-referrer");
  assert.equal(success.headers["x-frame-options"], "DENY");
  assert.equal(success.headers["cache-control"], "no-store");
  assert.match(String(success.headers["content-security-policy"]), /default-src 'self'; script-src 'self'/);
  assert.match(String(success.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal((await post({ host: "127.0.0.1:4331", origin: "http://localhost:4330" })).status, 201);
  assert.equal((await post({ host: "localhost:4331" })).status, 201);
  for (const headers of [
    { host: "evil.example:20003", origin: remoteOrigin },
    { host: remoteHost, origin: "https://evil.example" },
    { host: remoteHost, origin: `${remoteOrigin}/` },
    { host: remoteHost, origin: remoteOrigin.replace("https:", "http:") },
    { host: remoteHost, origin: "null" },
    { host: remoteHost, origin: "http://localhost:4330" },
    { host: "localhost:4331", origin: remoteOrigin },
    { host: remoteHost, origin: remoteOrigin, "sec-fetch-site": "cross-site" },
  ]) {
    assert.equal((await post(headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal((await post({ host: remoteHost, origin: remoteOrigin, "content-type": "text/plain" })).status, 415);
  assert.equal((await post({ host: remoteHost, origin: remoteOrigin }, {})).status, 400);
  assert.equal(counter.writes, 3);
});

test("only a GET to the exact OAuth callback without an Origin may arrive cross-site", async (t) => {
  const counter = { writes: 0, callbacks: 0 };
  const services = testServices(t, { env: { BELLPERSONAL_ALLOWED_ORIGINS: remoteOrigin } });
  const server = await startTestServer(t, services, { modules: [probeModule(counter)] });
  const crossSite = { host: remoteHost, "sec-fetch-site": "cross-site" };

  const allowed = await server.call("GET", "/oauth/google/callback?code=abc&state=xyz", { headers: crossSite });
  assert.equal(allowed.status, 200);
  assert.equal(counter.callbacks, 1);
  assert.match(String(allowed.headers["content-security-policy"]), /default-src 'self'/);

  for (const [method, url, headers] of [
    ["GET", "/oauth/google/callback", { ...crossSite, origin: "https://accounts.google.com" }],
    ["GET", "/oauth/google/start", crossSite],
    ["GET", "/oauth/google/callback/extra", crossSite],
    ["GET", "/api/status", crossSite],
    ["HEAD", "/oauth/google/callback", crossSite],
  ] as const) {
    assert.equal((await server.call(method, url, { headers })).status, 403, `${method} ${url}`);
  }
  const post = await server.call("POST", "/oauth/google/callback", { headers: crossSite, body: {} });
  assert.equal(post.status, 403);
  // The host check still applies to the callback.
  assert.equal((await server.call("GET", "/oauth/google/callback", { headers: { host: "evil.example", "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal(counter.callbacks, 1);
});

test("a cross-site top-level navigation may open the page shell, but never /api or /oauth", async (t) => {
  const counter = { writes: 0, callbacks: 0 };
  const services = testServices(t, { env: { BELLPERSONAL_ALLOWED_ORIGINS: remoteOrigin } });
  const server = await startTestServer(t, services, { modules: [probeModule(counter)] });
  // What a browser sends for the page that follows Google's redirect to the callback.
  const navigate = { host: remoteHost, "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  for (const url of ["/", "/privacy"]) {
    assert.notEqual((await server.call("GET", url, { headers: navigate })).status, 403, url);
  }
  for (const [method, url, headers] of [
    ["GET", "/api/status", navigate],
    ["GET", "/oauth/google/start", navigate],
    ["GET", "/", { ...navigate, origin: "https://evil.example" }],
    ["GET", "/", { ...navigate, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }],
    ["GET", "/", { ...navigate, "sec-fetch-dest": "iframe" }],
    ["GET", "/", { host: remoteHost, "sec-fetch-site": "cross-site" }],
  ] as const) {
    assert.equal((await server.call(method, url, { headers })).status, 403, `${method} ${url} ${JSON.stringify(headers)}`);
  }
  assert.equal((await server.call("POST", "/api/probe", { headers: navigate, body: { source: "x" } })).status, 403);
  assert.equal((await server.call("GET", "/", { headers: { ...navigate, host: "evil.example" } })).status, 403);
  assert.equal(counter.writes, 0);
});

test("the Tailscale identity gate admits only listed logins from the loopback proxy; health is exempt", async (t) => {
  const services = testServices(t, { env: { BELLPERSONAL_TAILSCALE_USERS: "alice@github" } });
  const server = await startTestServer(t, services);
  assert.equal((await server.call("GET", "/api/status")).status, 403, "missing login");
  const wrong = await server.call("GET", "/api/status", { headers: { "tailscale-user-login": "someone@example.com" } });
  assert.equal(wrong.status, 403, "wrong login");
  assert.equal(wrong.json.error, "此服務只開放給擁有者的 Tailscale 帳號。");
  assert.equal((await server.call("GET", "/api/status", { headers: { "tailscale-user-login": "alice@github" } })).status, 200, "right login");
  assert.equal((await server.call("GET", "/", { headers: {} })).status, 403, "the page itself is gated");
  const health = await server.call("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), ["release", "status", "uptimeSeconds", "version"]);
  // The gate runs after the origin guard: a foreign Host is still refused on health.
  assert.equal((await server.call("GET", "/api/health", { headers: { host: "evil.example" } })).status, 403);
});

test("an empty user list leaves development open", async (t) => {
  const services = testServices(t);
  const server = await startTestServer(t, services);
  assert.equal((await server.call("GET", "/api/settings/app")).status, 200);
});

for (const [name, env, pattern] of [
  ["production without Tailscale users", { NODE_ENV: "production" }, /BELLPERSONAL_TAILSCALE_USERS/],
  ["an invalid origin", { BELLPERSONAL_ALLOWED_ORIGINS: "https://*.example.com" }, /BELLPERSONAL_ALLOWED_ORIGINS/],
  ["a short master key", { BELLPERSONAL_MASTER_KEY: "c2hvcnQ=" }, /BELLPERSONAL_MASTER_KEY/],
] as const) {
  test(`boot fails with ${name} before creating application data`, (t) => {
    const directory = tempDir(t);
    const dataDirectory = path.join(directory, "data");
    const result = spawnSync(process.execPath, ["--import", "tsx", "server/index.ts"], {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        BELLPERSONAL_LOG: "off",
        BELLPERSONAL_PORT: "20093",
        BELLPERSONAL_DATA_DIR: dataDirectory,
        BELLPERSONAL_SECRETS_DIR: path.join(directory, "secrets"),
        ...env,
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(dataDirectory), false);
  });
}
