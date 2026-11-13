import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readRuntimeConfig } from "./runtime-config.js";

const key = Buffer.alloc(32, 1).toString("base64");

test("defaults suit local development", () => {
  const config = readRuntimeConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 4331);
  assert.equal(config.frontendPort, 4330);
  assert.deepEqual(config.allowedOrigins, []);
  assert.equal(config.dataDir, path.resolve("data"));
  assert.equal(config.secretsDir, path.resolve(".secrets"));
  assert.equal(config.masterKey, null);
  assert.equal(config.google, null);
  assert.equal(config.timeZone, "Asia/Taipei");
  assert.deepEqual(config.tailscaleUsers, []);
  assert.equal(config.maxAgentProcesses, 1);
  assert.equal(config.agentTimeoutScale, 1);
  assert.equal(config.drainSeconds, 10);
  assert.equal(config.claudePath, "claude");
  assert.equal(config.production, false);
});

test("production settings parse", () => {
  const config = readRuntimeConfig({
    NODE_ENV: "production",
    BELLPERSONAL_PORT: "20003",
    BELLPERSONAL_FRONTEND_PORT: "20003",
    BELLPERSONAL_ALLOWED_ORIGINS: "https://box.tailone.ts.net:20003",
    BELLPERSONAL_TAILSCALE_USERS: "alice@github, alice@github",
    BELLPERSONAL_MASTER_KEY: key,
    BELLPERSONAL_GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
    BELLPERSONAL_GOOGLE_CLIENT_SECRET: "secret",
    BELLPERSONAL_DATA_DIR: "/srv/data",
    CLAUDE_CLI_PATH: "/home/u/.local/bin/claude",
  });
  assert.equal(config.production, true);
  assert.equal(config.port, 20003);
  assert.deepEqual(config.tailscaleUsers, ["alice@github"]);
  assert.equal(config.masterKey?.length, 32);
  assert.deepEqual(config.google, { clientId: "id.apps.googleusercontent.com", clientSecret: "secret" });
  assert.equal(config.dataDir, "/srv/data");
  assert.equal(config.claudePath, "/home/u/.local/bin/claude");
});

test("every invalid value fails with a message naming its variable", () => {
  const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{ BELLPERSONAL_HOST: "http://x" }, /BELLPERSONAL_HOST/],
    [{ BELLPERSONAL_PORT: "80" }, /BELLPERSONAL_PORT/],
    [{ BELLPERSONAL_PORT: "4331x" }, /BELLPERSONAL_PORT/],
    [{ BELLPERSONAL_FRONTEND_PORT: "70000" }, /BELLPERSONAL_FRONTEND_PORT/],
    [{ BELLPERSONAL_ALLOWED_ORIGINS: "https://example.com/path" }, /BELLPERSONAL_ALLOWED_ORIGINS/],
    [{ BELLPERSONAL_ALLOWED_ORIGINS: Array.from({ length: 33 }, (_, i) => `https://h${i}.example`).join(",") }, /BELLPERSONAL_ALLOWED_ORIGINS/],
    [{ BELLPERSONAL_MASTER_KEY: Buffer.alloc(31).toString("base64") }, /BELLPERSONAL_MASTER_KEY/],
    [{ BELLPERSONAL_MASTER_KEY: "not base64!" }, /BELLPERSONAL_MASTER_KEY/],
    [{ BELLPERSONAL_TZ: "Mars/Base" }, /BELLPERSONAL_TZ/],
    [{ BELLPERSONAL_TAILSCALE_USERS: "no-at-sign" }, /BELLPERSONAL_TAILSCALE_USERS/],
    [{ NODE_ENV: "production" }, /BELLPERSONAL_TAILSCALE_USERS/],
    [{ NODE_ENV: "production", BELLPERSONAL_TAILSCALE_USERS: "alice@github" }, /BELLPERSONAL_ALLOWED_ORIGINS/],
    [{ NODE_ENV: "production", BELLPERSONAL_TAILSCALE_USERS: "alice@github", BELLPERSONAL_ALLOWED_ORIGINS: "http://127.0.0.1:20003,https://box.tailone.ts.net:20003" }, /BELLPERSONAL_ALLOWED_ORIGINS/],
    [{ BELLPERSONAL_MAX_AGENT_PROCESSES: "0" }, /BELLPERSONAL_MAX_AGENT_PROCESSES/],
    [{ BELLPERSONAL_MAX_AGENT_PROCESSES: "" }, /BELLPERSONAL_MAX_AGENT_PROCESSES/],
    [{ BELLPERSONAL_AGENT_TIMEOUT_SCALE: "11" }, /BELLPERSONAL_AGENT_TIMEOUT_SCALE/],
    [{ BELLPERSONAL_DRAIN_SECONDS: "14" }, /BELLPERSONAL_DRAIN_SECONDS/],
    [{ BELLPERSONAL_GOOGLE_CLIENT_ID: "only-id" }, /BELLPERSONAL_GOOGLE_CLIENT_SECRET/],
  ];
  for (const [env, pattern] of cases) assert.throws(() => readRuntimeConfig(env), pattern, JSON.stringify(env).slice(0, 80));
});

// suite-contract v1 config cases (bell-suite/contracts/v1/fixtures/config.cases.json), copied, plus Personal's own.
const ownOrigin = "https://box.tailone.ts.net:20003";

test("BELL Suite links accept loopback and Personal's own tailnet only", () => {
  const links = (value: string, env: NodeJS.ProcessEnv = {}) =>
    readRuntimeConfig({ BELLPERSONAL_ALLOWED_ORIGINS: ownOrigin, BELLPERSONAL_SUITE_LINKS: value, ...env }).suite.links;
  assert.deepEqual(links(""), {});
  assert.deepEqual(links("explain=http://127.0.0.1:21101"), { explain: "http://127.0.0.1:21101" });
  assert.deepEqual(links("explain=https://box.tailone.ts.net:20001, pr=http://localhost:4610"), {
    explain: "https://box.tailone.ts.net:20001",
    pr: "http://localhost:4610",
  });
  assert.deepEqual(links("explain=https://[::1]:21101,pr=https://127.8.9.10"), { explain: "https://[::1]:21101", pr: "https://127.8.9.10" });
  assert.deepEqual(links("explain=https://BOX.TailOne.TS.net:20001"), { explain: "https://box.tailone.ts.net:20001" });

  for (const [value, why] of [
    ["explain=http://box.tailone.ts.net:20001", "non-loopback http"],
    ["explain=https://box.othertailnet.ts.net:20001", "other tailnet"],
    ["explain=https://example.com", "arbitrary https"],
    ["explain=https://*.tailone.ts.net", "wildcard"],
    ["explain=https://user:pw@box.tailone.ts.net:20001", "credentials"],
    ["explain=http://127.0.0.1:21101/app", "path"],
    ["explain=http://127.0.0.1:21101?x=1", "query"],
    ["explain=http://127.0.0.1:21101#x", "fragment"],
    ["explain=http://127.0.0.1:21101/", "trailing slash"],
    ["personal=http://127.0.0.1:21103", "own app"],
    ["calendar=http://127.0.0.1:1", "unknown app"],
    ["explain=http://127.0.0.1:1,explain=http://127.0.0.1:2", "duplicate"],
    ["explain http://127.0.0.1:1", "format"],
    ["explain=http://127.0.0.1:0", "port 0"],
    ["explain=http://127.0.0.1:", "empty port"],
    ["explain=https://tailone.ts.net", "a tailnet name with three labels"],
    ["explain=https://192.168.1.10:20001", "LAN address"],
    ["explain=http://127.0.0.1:1,pr=http://127.0.0.1:2,explain=http://127.0.0.1:3,pr=http://127.0.0.1:4", "more than three"],
    ["explain=http://127.0.0.1:1,", "empty entry"],
    [`explain=${ownOrigin}`, "Personal's own origin"],
    ["explain=http://127.0.0.1:4331", "Personal's own port"],
    ["explain=http://localhost:4330", "Personal's own frontend port"],
  ] as const) assert.throws(() => links(value), /BELLPERSONAL_SUITE_LINKS/, why);
  // Without an own tailnet origin no MagicDNS link is accepted.
  assert.throws(() => readRuntimeConfig({ BELLPERSONAL_SUITE_LINKS: "explain=https://box.tailone.ts.net:20001" }), /BELLPERSONAL_SUITE_LINKS/);
});

test("BELL Suite server reads accept http on an IP-literal loopback only", () => {
  const fetch = (value: string) => readRuntimeConfig({ BELLPERSONAL_ALLOWED_ORIGINS: ownOrigin, BELLPERSONAL_SUITE_FETCH: value }).suite.fetch;
  assert.deepEqual(fetch(""), {});
  assert.deepEqual(fetch("explain=http://127.0.0.1:20001"), { explain: "http://127.0.0.1:20001" });
  assert.deepEqual(fetch("explain=http://[::1]:21101"), { explain: "http://[::1]:21101" });
  assert.deepEqual(fetch("explain=http://127.0.0.2:20001, pr=http://127.0.0.1:4610"), { explain: "http://127.0.0.2:20001", pr: "http://127.0.0.1:4610" });
  for (const [value, why] of [
    ["explain=http://localhost:21101", "DNS name"],
    ["explain=https://127.0.0.1:21101", "https"],
    ["explain=http://192.168.1.10:20001", "not loopback"],
    ["explain=https://box.tailone.ts.net:20001", "tailnet"],
    ["personal=http://127.0.0.1:21103", "own app"],
    ["explain=http://127.0.0.1:21101/api", "path"],
    ["explain=http://127.0.0.1:21101/", "trailing slash"],
    ["explain=http://127.0.0.1:21101?target=x", "query"],
    ["explain=http://user:pw@127.0.0.1:21101", "credentials"],
    ["explain=http://[::ffff:127.0.0.1]:21101", "IPv4-mapped address"],
    ["explain=http://127.0.0.1:0", "port 0"],
    ["explain=http://127.0.0.1:4331", "Personal's own port"],
    ["explain=http://127.0.0.1:1,explain=http://127.0.0.1:2", "duplicate"],
    ["explain", "format"],
  ] as const) assert.throws(() => fetch(value), /BELLPERSONAL_SUITE_FETCH/, why);
});

test("production boots without BELL Suite variables, and parses them when set", () => {
  const production = {
    NODE_ENV: "production",
    BELLPERSONAL_PORT: "20003",
    BELLPERSONAL_FRONTEND_PORT: "20003",
    BELLPERSONAL_ALLOWED_ORIGINS: ownOrigin,
    BELLPERSONAL_TAILSCALE_USERS: "alice@github",
  };
  assert.deepEqual(readRuntimeConfig(production).suite, { links: {}, fetch: {} });
  assert.deepEqual(readRuntimeConfig({}).suite, { links: {}, fetch: {} });
  assert.deepEqual(readRuntimeConfig({
    ...production,
    BELLPERSONAL_SUITE_LINKS: "explain=https://box.tailone.ts.net:20001",
    BELLPERSONAL_SUITE_FETCH: "explain=http://127.0.0.1:20001",
  }).suite, { links: { explain: "https://box.tailone.ts.net:20001" }, fetch: { explain: "http://127.0.0.1:20001" } });
  // Personal's own production port is never a sibling.
  assert.throws(() => readRuntimeConfig({ ...production, BELLPERSONAL_SUITE_FETCH: "explain=http://127.0.0.1:20003" }), /BELLPERSONAL_SUITE_FETCH/);
});
