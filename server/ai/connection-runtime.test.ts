import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { z } from "zod";
import type { AiConnectionMethod } from "../../shared/ai-connections.js";
import { loggablePath } from "../app.js";
import { AppError } from "../errors.js";
import { redactCliOutput } from "../secrets/redact.js";
import { VAULT_FILE, Vault } from "../secrets/vault.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, tempDir, testServices, type RecordedCall } from "../test-helpers.js";
import type { ModelCatalog } from "../../shared/models.js";
import { AI_KEY_VAULT, AiConnectionRuntime, BELL_OPENAI_PROVIDER_CONFIG, keyNotReady, loginError, missingKeyMessage, unreadableKeyMessage, vaultDisabledKeyMessage, type AiConnectionPlan } from "./connection-runtime.js";

// Key-shaped values built at run time so the source never holds anything that looks like a real credential.
const OPENAI_KEY = `sk-proj-${"k".repeat(40)}`;
const OPENAI_REVOKED = `sk-proj-${"r".repeat(40)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${"k".repeat(40)}`;
const ANTHROPIC_REVOKED = `sk-ant-api03-${"r".repeat(40)}`;
/** Makes the fake Claude Code crash with the key quoted on stderr, as an unexpected CLI failure might. */
const ANTHROPIC_CRASH = `sk-ant-api03-${"e".repeat(40)}`;
const ANSWER = { summary: "好", priority: "low" };
const schema = z.object({ summary: z.string(), priority: z.enum(["high", "low"]) }).strict();

/**
 * A stand-in for `codex app-server` (codex-cli 0.167): JSON-RPC on stdio, the
 * key read only from the variable a configured provider names, a state file
 * written into CODEX_HOME like the real one, and, for a revoked key, the
 * real 401 shape whose text and stderr quote part of the key.
 */
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const keyMode = process.argv.includes('model_provider="bell_openai"');
const key = keyMode ? process.env.BELL_OPENAI_API_KEY : undefined;
const home = process.env.CODEX_HOME;
appendFileSync(join(__dirname, "spawns.jsonl"), JSON.stringify({
  argv: process.argv.slice(2), home, homeExisted: !!home && existsSync(home), key,
  openaiKey: process.env.OPENAI_API_KEY, codexKey: process.env.CODEX_API_KEY,
}) + "\n");
if (home && existsSync(home)) writeFileSync(join(home, "state_5.sqlite"), "state");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) continue;
    if (method === "initialize") send({ id, result: {} });
    else if (method === "account/read") send({ id, result: keyMode ? { account: null, requiresOpenaiAuth: false } : { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
    else if (method === "model/list") send({ id, result: { data: [{ model: "gpt-test", displayName: "GPT Test", description: "", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }] }] } });
    else if (method === "config/read") send({ id, result: { config: {} } });
    else if (method === "thread/start") {
      if (params.modelProvider !== (keyMode ? "bell_openai" : "openai")) { send({ id, error: { code: -32600, message: "modelProviderMismatch" } }); continue; }
      send({ id, result: { thread: { id: "th1" }, model: params.model || "gpt-test", reasoningEffort: "low", sandbox: { type: "readOnly", networkAccess: false } } });
    } else if (method === "turn/start") {
      send({ id, result: {} });
      if (keyMode && key !== ${JSON.stringify(OPENAI_KEY)}) {
        const message = "unexpected status 401 Unauthorized: Incorrect API key provided: " + key.slice(0, 12) + "*****" + key.slice(-4);
        process.stderr.write(message + "\n");
        send({ method: "error", params: { threadId: "th1", willRetry: true, error: { message, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } } } });
        send({ method: "turn/completed", params: { threadId: "th1", turn: { status: "failed", error: { message, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } } } });
      } else {
        send({ method: "item/completed", params: { threadId: "th1", item: { id: "m1", type: "agentMessage", text: ${JSON.stringify(JSON.stringify(ANSWER))} } } });
        send({ method: "turn/completed", params: { threadId: "th1", turn: { status: "completed" } } });
      }
    } else send({ id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function claudeStream(change: (event: Record<string, any>) => Record<string, any> = (event) => event): string {
  return claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = ANSWER; copy.result = JSON.stringify(ANSWER); }
    if (copy.type === "assistant") copy.message.content[0].input = ANSWER;
    return JSON.stringify(change(copy));
  }).join("\n");
}

interface ClaudeRun { call: RecordedCall; homeExisted: boolean }

/**
 * Services with both CLIs faked, the shared CLI homes pointed at empty
 * directories of the test's own, and a mutable view of how each CLI is
 * signed in. The real Codex launcher runs FAKE_CODEX.
 */
function harness(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const dir = tempDir(t);
  const shared = { codex: join(dir, "shared-codex"), claude: join(dir, "shared-claude") };
  mkdirSync(shared.codex); mkdirSync(shared.claude);
  const codexPath = join(dir, "bin", "codex");
  mkdirSync(dirname(codexPath));
  writeFileSync(codexPath, FAKE_CODEX);
  chmodSync(codexPath, 0o755);
  for (const [name, value] of [["CODEX_HOME", shared.codex], ["CLAUDE_CONFIG_DIR", shared.claude], ["OPENAI_API_KEY", undefined], ["CODEX_API_KEY", undefined], ["ANTHROPIC_API_KEY", undefined]] as const) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }

  const signedIn = { claude: "subscription" as "subscription" | "api_key", codex: "subscription" as "subscription" | "api_key" };
  const claudeRuns: ClaudeRun[] = [];
  const fake = fakeCommand((call) => {
    const joined = call.args.join(" ");
    if (joined === "--version") return call.executable.includes("claude") ? "2.1.321 (Claude Code)" : "codex-cli 0.167.0";
    if (joined === "auth status") return JSON.stringify(signedIn.claude === "subscription" ? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" } : { loggedIn: true, authMethod: "api_key" });
    if (joined === "login status") return { stdout: "", stderr: signedIn.codex === "subscription" ? "Logged in using ChatGPT" : "API key configured - sk-proj-***", code: 0 };
    if (call.args[0] === "-p" || call.args.includes("--output-format")) {
      const home = call.options.env?.CLAUDE_CONFIG_DIR;
      claudeRuns.push({ call, homeExisted: !!home && existsSync(home) });
      const key = call.options.env?.ANTHROPIC_API_KEY;
      if (key === ANTHROPIC_CRASH) throw new AppError(422, `claude 執行失敗：Error: upstream refused ${key} (${key.slice(0, 16)}…${key.slice(-6)})`);
      if (key && key !== ANTHROPIC_KEY) {
        // Claude Code's own text for a bad key, plus an echo some versions print to stderr.
        return { stdout: claudeStream((event) => event.type === "result" ? { ...event, is_error: true, subtype: "success", api_error_status: 401, result: `Invalid API key · Fix external API key (${key.slice(0, 14)}…)` } : event), stderr: "", code: 1 };
      }
      return claudeStream();
    }
    return undefined;
  });
  const services = testServices(t, { env: { CODEX_CLI_PATH: codexPath, ...env }, seams: { command: fake.runner } });
  const spawns = () => {
    const file = join(dirname(codexPath), "spawns.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  };
  const choose = (method: AiConnectionMethod | null) => services.settings.update({ "ai.connection": method });
  const aiRoot = join(services.config.dataDir, "ai");
  const run = () => services.ai.runStructured({ role: "信件整理", schema, prompt: "摘要這封信。", data: { email: "週五交報告" }, signal: new AbortController().signal });
  return { services, shared, signedIn, calls: fake.calls, claudeRuns, spawns, choose, aiRoot, run };
}

/** The `ai_connection_not_ready` detail of a 503, if that is what `error` is. */
const notReady = (error: unknown) =>
  error instanceof AppError && error.status === 503 && error.detail?.code === "ai_connection_not_ready" ? { method: error.detail.method, reason: error.detail.reason, message: error.message } : undefined;

const loginChecks = (calls: RecordedCall[]) => calls.filter((call) => ["auth status", "login status"].includes(call.args.join(" "))).map((call) => call.args.join(" "));

/** Everything logEvent writes while `task` runs (logging is off in tests). */
async function capturingLogs<T>(task: () => Promise<T>): Promise<{ value: T | undefined; error: unknown; lines: string[] }> {
  const lines: string[] = [];
  const previous = process.env.BELLPERSONAL_LOG;
  const write = process.stdout.write;
  process.env.BELLPERSONAL_LOG = "on";
  // Only logEvent's lines: the test runner reports through stdout too, and those writes must go through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"time":')) { lines.push(chunk); return true; }
    return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return { value: await task(), error: undefined, lines };
  } catch (error) {
    return { value: undefined, error, lines };
  } finally {
    process.stdout.write = write;
    process.env.BELLPERSONAL_LOG = previous;
  }
}

test("each active connection runs its CLI with its own sign-in, environment and config home", async (t) => {
  const h = harness(t);
  await h.services.vault.set(AI_KEY_VAULT.openai, { key: OPENAI_KEY, verifiedAt: "2026-11-09T00:00:00.000Z" });
  await h.services.vault.set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_KEY, verifiedAt: "2026-11-09T00:00:00.000Z" });

  // Anthropic key: no login check, the key in the environment only, a throwaway CLAUDE_CONFIG_DIR under <data>/ai.
  h.choose("anthropic-key");
  assert.equal((await h.run()).execution.provider, "claude");
  assert.deepEqual(loginChecks(h.calls), [], "a key saved in BELL never asks the shared login");
  const keyed = h.claudeRuns.at(-1)!;
  const claudeHome = String(keyed.call.options.env?.CLAUDE_CONFIG_DIR);
  assert.equal(dirname(claudeHome), h.aiRoot);
  assert.match(claudeHome, /claude-home-/);
  assert.equal(keyed.homeExisted, true);
  assert.equal(existsSync(claudeHome), false, "removed after the run");
  assert.equal(keyed.call.options.env?.ANTHROPIC_API_KEY, ANTHROPIC_KEY);
  assert.ok(!keyed.call.args.some((arg) => arg.includes(ANTHROPIC_KEY)) && !keyed.call.options.input?.includes(ANTHROPIC_KEY), "never in argv or the prompt");

  // OpenAI key: BELL's provider, the key in BELL_OPENAI_API_KEY, a throwaway CODEX_HOME under <data>/ai.
  h.choose("openai-key");
  assert.equal(h.services.provider.settings().provider, "codex");
  const codexResult = await h.run();
  assert.deepEqual(codexResult.value, ANSWER);
  assert.equal(codexResult.execution.provider, "codex");
  assert.deepEqual(loginChecks(h.calls), []);
  const keyedSpawns = h.spawns();
  assert.ok(keyedSpawns.length >= 2, "the model list and the turn");
  for (const spawn of keyedSpawns) {
    assert.equal(dirname(spawn.home), h.aiRoot);
    assert.match(spawn.home, /codex-home-/);
    assert.equal(spawn.homeExisted, true);
    assert.equal(existsSync(spawn.home), false, "removed after the run");
    assert.equal(spawn.key, OPENAI_KEY);
    assert.equal(spawn.openaiKey, undefined);
    assert.equal(spawn.codexKey, undefined);
    assert.deepEqual(spawn.argv.slice(-BELL_OPENAI_PROVIDER_CONFIG.length), [...BELL_OPENAI_PROVIDER_CONFIG]);
    assert.ok(!spawn.argv.some((arg: string) => arg.includes(OPENAI_KEY)), "never in argv");
  }
  assert.deepEqual(readdirSync(h.aiRoot), [], "nothing left under <data>/ai");
  assert.deepEqual([readdirSync(h.shared.codex), readdirSync(h.shared.claude)], [[], []], "key mode never touches the shared CLI homes");

  // ChatGPT sign-in: the shared CODEX_HOME, no key, Codex's own provider, after `codex login status`.
  h.choose("chatgpt");
  await h.run();
  assert.deepEqual(loginChecks(h.calls), ["login status"]);
  const signedInSpawns = h.spawns().slice(keyedSpawns.length);
  assert.ok(signedInSpawns.length >= 1);
  for (const spawn of signedInSpawns) {
    assert.equal(spawn.home, h.shared.codex);
    assert.equal(spawn.key, undefined);
    assert.ok(!spawn.argv.includes('model_provider="bell_openai"'));
  }

  // Claude sign-in: the shared CLAUDE_CONFIG_DIR, no key.
  h.choose("claude");
  assert.equal((await h.run()).execution.provider, "claude");
  assert.deepEqual(loginChecks(h.calls), ["login status", "auth status"]);
  const plan = h.claudeRuns.at(-1)!.call.options.env!;
  assert.equal(plan.CLAUDE_CONFIG_DIR, h.shared.claude);
  assert.equal(plan.ANTHROPIC_API_KEY, undefined);
});

test("a chosen connection needs the right kind of login; a key method without a saved key uses the CLI's own key login", async (t) => {
  const h = harness(t);
  // Codex holds an API key, but the user picked their ChatGPT plan: refuse rather than bill the key.
  h.signedIn.codex = "api_key";
  h.choose("chatgpt");
  await assert.rejects(h.run(), (error: AppError) => error.status === 503 && /API 金鑰登入，不是 ChatGPT/.test(error.message));
  h.signedIn.claude = "api_key";
  h.choose("claude");
  await assert.rejects(h.run(), (error: AppError) => error.status === 503 && /API 金鑰登入，不是 Claude 訂閱/.test(error.message));

  // Anthropic key picked, nothing in the vault, the CLI signed in with its own key: that login is used, as is.
  h.choose("anthropic-key");
  await h.run();
  const env = h.claudeRuns.at(-1)!.call.options.env!;
  assert.equal(env.CLAUDE_CONFIG_DIR, h.shared.claude);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  // …but a CLI on a subscription is not a key: say what is missing (once 重新檢查 drops the cached login check).
  h.signedIn.claude = "subscription";
  await h.run();
  await h.services.aiConnections.list(true);
  await assert.rejects(h.run(), (error: AppError) => error.status === 503 && /還沒有保存金鑰/.test(error.message));

  // Not chosen: any login, exactly as before this setting.
  h.choose(null);
  h.signedIn.claude = "api_key";
  await h.run();
  assert.equal(h.claudeRuns.at(-1)!.call.options.env!.ANTHROPIC_API_KEY, undefined);
});

test("a key connection synced from another device: not ready here with a reason, and jobs never fall back", async (t) => {
  const h = harness(t);
  const server = await startTestServer(t, h.services);
  // ai.connection syncs with the other settings; the key stays in the other device's vault.
  h.choose("anthropic-key");
  const status = async () => (await server.call("GET", "/api/status")).json.ai.connection;
  const missing = await status();
  assert.deepEqual([missing.method, missing.ready, missing.reason], ["anthropic-key", false, "key_missing"]);
  assert.match(missing.message, /還沒有保存金鑰/);
  assert.deepEqual((await server.call("GET", "/api/ai/connections")).json.activeStatus, missing, "the same status on both endpoints");
  await assert.rejects(h.run(), (error: AppError) => error.status === 503 && /還沒有保存金鑰/.test(error.message));
  assert.equal(h.claudeRuns.length, 0, "the Claude subscription login is not used instead");

  // A key sealed with another device's master key (a copied secrets file): unreadable, even with a CLI key login to fall back on.
  await new Vault({ directory: h.services.config.secretsDir, key: Buffer.alloc(32, 9) })
    .set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_KEY, verifiedAt: "2026-11-09T00:00:00.000Z" });
  h.signedIn.claude = "api_key";
  await h.services.aiConnections.list(true);
  const foreign = await status();
  assert.deepEqual([foreign.ready, foreign.reason], [false, "key_unreadable"]);
  assert.match(foreign.message, /主金鑰解不開/);
  const listed = (await server.call("GET", "/api/ai/connections")).json.connections.find((item: { method: string }) => item.method === "anthropic-key");
  assert.deepEqual([listed.state, listed.reason], ["failed", "key_unreadable"]);
  await assert.rejects(h.run(), (error: AppError) => error.status === 503 && /主金鑰解不開/.test(error.message));
  assert.equal(h.claudeRuns.length, 0, "nor the CLI's own key");
  const again = await server.call("PUT", "/api/ai/connections/active", { body: { method: "anthropic-key" } });
  assert.deepEqual([again.status, again.json.reason], [409, "key_unreadable"]);
  assert.doesNotMatch(JSON.stringify(await Promise.all(["/api/status", "/api/ai/connections"].map(async (path) => (await server.call("GET", path)).text))), /sk-ant-/);

  // A device with no master key at all.
  const off = testServices(t, { env: { BELLPERSONAL_MASTER_KEY: "" }, seams: { command: fakeCommand((call) => call.args[0] === "--version" ? "codex-cli 0.167.0" : call.args.join(" ") === "login status" ? { stdout: "", stderr: "Logged in using ChatGPT", code: 0 } : undefined).runner } });
  off.settings.update({ "ai.connection": "openai-key" });
  const disabled = await off.aiConnections.activeStatus();
  assert.deepEqual(disabled && !disabled.ready ? [disabled.reason] : [], ["vault_disabled"]);
  assert.match((disabled as { message: string }).message, /主金鑰/);
});

test("an OpenAI key connection with no key here checks the login before the model list: no CLI starts on the shared CODEX_HOME", async (t) => {
  const h = harness(t);
  // Codex is signed in with ChatGPT; the user picked their own OpenAI key, which only another device holds.
  h.choose("openai-key");
  let failure: unknown;
  await h.run().catch((error: unknown) => { failure = error; });
  const refused = notReady(failure);
  assert.deepEqual(refused && [refused.method, refused.reason], ["openai-key", "key_missing"]);
  assert.match(refused!.message, /還沒有保存金鑰/);
  assert.deepEqual(h.spawns(), [], "no codex app-server (the model list) was started");
  assert.deepEqual(h.calls.map((call) => call.args.join(" ")), ["login status"], "only the read-only login check ran");
  assert.deepEqual(readdirSync(h.shared.codex), [], "the shared CODEX_HOME is untouched");

  // The CLI's own API-key login stays the fallback: then the job runs on it, in the shared home, with Codex's own provider.
  h.signedIn.codex = "api_key";
  assert.deepEqual((await h.run()).value, ANSWER);
  const spawns = h.spawns();
  assert.ok(spawns.length >= 1);
  for (const spawn of spawns) {
    assert.equal(spawn.home, h.shared.codex);
    assert.equal(spawn.key, undefined);
    assert.ok(!spawn.argv.includes('model_provider="bell_openai"'));
  }
});

test("the settings model list on a key connection with no usable key: the key message, nothing started, and a model save is refused", async (t) => {
  const h = harness(t);
  const server = await startTestServer(t, h.services);
  const codexCatalog = async (refresh = false) =>
    ((await server.call("GET", `/api/settings/provider${refresh ? "?refresh=true" : ""}`)).json.catalogs as ModelCatalog[]).find((catalog) => catalog.source === "codex");
  // Codex is signed in with ChatGPT; the OpenAI key connection was picked on a device that holds the key.
  h.choose("openai-key");
  assert.deepEqual(await codexCatalog(), { source: "codex", models: [], error: missingKeyMessage("openai"), notReady: { method: "openai-key", reason: "key_missing" } });
  assert.deepEqual(h.spawns(), [], "no codex app-server listed models through the ChatGPT login");
  assert.deepEqual(readdirSync(h.shared.codex), [], "the shared CODEX_HOME is untouched");
  const refused = await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } });
  assert.equal(refused.status, 503);
  assert.deepEqual([refused.json.code, refused.json.method, refused.json.reason, refused.json.error], ["ai_connection_not_ready", "openai-key", "key_missing", missingKeyMessage("openai")]);
  assert.equal(h.services.provider.settings().model, "", "no model saved for a login that cannot run");
  assert.deepEqual(h.spawns(), []);
  assert.ok(loginChecks(h.calls).length >= 1 && loginChecks(h.calls).every((check) => check === "login status"), "only the read-only login check ran");

  // The CLI's own API-key login stays the fallback: the list and the save go through it.
  h.signedIn.codex = "api_key";
  assert.deepEqual((await codexCatalog(true))!.models.map((model) => model.id), ["gpt-test"]);
  const saved = await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.model, "gpt-test");
  for (const spawn of h.spawns()) assert.deepEqual([spawn.home, spawn.key], [h.shared.codex, undefined]);

  // Anthropic key, none here, Claude Code on a subscription: the save is refused the same way.
  h.signedIn.claude = "subscription";
  h.choose("anthropic-key");
  const claude = await server.call("PUT", "/api/settings/provider", { body: { model: "haiku" } });
  assert.equal(claude.status, 503);
  assert.deepEqual([claude.json.code, claude.json.method, claude.json.reason, claude.json.error], ["ai_connection_not_ready", "anthropic-key", "key_missing", missingKeyMessage("anthropic")]);
  assert.equal(h.services.provider.settings().model, "");
  h.signedIn.claude = "api_key";
  assert.equal((await server.call("PUT", "/api/settings/provider", { body: { model: "haiku" } })).json.settings.model, "haiku");
});

test("the settings model list on a server without a master key names vault_disabled and starts nothing", async (t) => {
  const h = harness(t, { BELLPERSONAL_MASTER_KEY: "" });
  const server = await startTestServer(t, h.services);
  h.choose("openai-key");
  const snapshot = (await server.call("GET", "/api/settings/provider")).json;
  assert.deepEqual((snapshot.catalogs as ModelCatalog[]).find((catalog) => catalog.source === "codex"), { source: "codex", models: [], error: vaultDisabledKeyMessage("openai"), notReady: { method: "openai-key", reason: "vault_disabled" } });
  assert.deepEqual(h.spawns(), []);
  const refused = await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } });
  assert.deepEqual([refused.status, refused.json.reason], [503, "vault_disabled"]);
});

test("a key connection on a server without a master key: the job names vault_disabled, not a missing key", async (t) => {
  const h = harness(t, { BELLPERSONAL_MASTER_KEY: "" });
  h.choose("openai-key");
  let failure: unknown;
  await h.run().catch((error: unknown) => { failure = error; });
  const refused = notReady(failure);
  assert.deepEqual(refused && [refused.method, refused.reason], ["openai-key", "vault_disabled"]);
  assert.match(refused!.message, /尚未設定主金鑰/);
  assert.doesNotMatch(refused!.message, /還沒有保存金鑰/);
  assert.deepEqual(h.spawns(), []);
});

test("a corrupt secrets file: the job names key_unreadable and never uses the CLI's own key instead", async (t) => {
  const h = harness(t);
  await h.services.vault.set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_KEY, verifiedAt: "2026-11-09T00:00:00.000Z" });
  writeFileSync(join(h.services.config.secretsDir, VAULT_FILE), "{ not json");
  h.signedIn.claude = "api_key";
  h.choose("anthropic-key");
  let failure: unknown;
  await h.run().catch((error: unknown) => { failure = error; });
  const refused = notReady(failure);
  assert.deepEqual(refused && [refused.method, refused.reason], ["anthropic-key", "key_unreadable"]);
  assert.match(refused!.message, /主金鑰解不開/);
  assert.equal(h.claudeRuns.length, 0);
  assert.deepEqual(loginChecks(h.calls), [], "no CLI login is asked either");
  assert.deepEqual([(await h.services.aiConnections.activeStatus()) as unknown], [{ method: "anthropic-key", ready: false, reason: "key_unreadable", message: refused!.message }]);
});

test("spawn() reads the key at spawn time and maps every vault failure to its reason, never to 'not saved'", async (t) => {
  const plan: AiConnectionPlan = { provider: "codex", method: "openai-key", home: "bell" };
  const runtime = (vault: object) => new AiConnectionRuntime({ vault: vault as Vault, active: () => "openai-key", root: join(tempDir(t), "ai") });
  const reasonOf = async (vault: object) => {
    let failure: unknown;
    await runtime(vault).spawn(plan).then(() => assert.fail("spawn() should fail"), (error: unknown) => { failure = error; });
    return notReady(failure);
  };
  const disabled = await reasonOf({ enabled: false, get: async () => assert.fail("a disabled vault is not read") });
  assert.deepEqual(disabled && [disabled.reason], ["vault_disabled"]);
  assert.match(disabled!.message, /尚未設定主金鑰/);
  // Vault.load() on a file that does not parse, and on a key sealed with another master key.
  for (const thrown of [new AppError(500, "憑證檔案格式不正確，請移開損毀的檔案後重新連線來源。"), new Error("another master key")]) {
    const unreadable = await reasonOf({ enabled: true, get: async () => { throw thrown; } });
    assert.deepEqual(unreadable && [unreadable.method, unreadable.reason], ["openai-key", "key_unreadable"]);
    assert.match(unreadable!.message, /主金鑰解不開/);
  }
  const malformed = await reasonOf({ enabled: true, get: async () => ({ verifiedAt: "2026-11-09T00:00:00.000Z" }) });
  assert.deepEqual(malformed && [malformed.reason], ["key_unreadable"]);
  const missing = await reasonOf({ enabled: true, get: async () => undefined });
  assert.deepEqual(missing && [missing.reason], ["key_missing"]);
  assert.match(missing!.message, /還沒有保存金鑰/);
});

test("GET /api/status says where a ready connection's login comes from (source cli or bell)", async (t) => {
  const h = harness(t);
  const server = await startTestServer(t, h.services);
  const status = async () => (await server.call("GET", "/api/status")).json.ai.connection;
  // No key saved here, Claude Code signed in with its own key: ready on the CLI's key (the kept fallback).
  h.signedIn.claude = "api_key";
  h.choose("anthropic-key");
  assert.deepEqual(await status(), { method: "anthropic-key", ready: true, source: "cli" });
  assert.deepEqual((await server.call("GET", "/api/ai/connections")).json.activeStatus, { method: "anthropic-key", ready: true, source: "cli" });
  await h.services.vault.set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_KEY, verifiedAt: "2026-11-09T00:00:00.000Z" });
  assert.deepEqual(await status(), { method: "anthropic-key", ready: true, source: "bell" });
  h.choose("chatgpt");
  assert.deepEqual(await status(), { method: "chatgpt", ready: true, source: "cli" });
});

test("with an active connection a job's override for the other CLI is dropped", async (t) => {
  const h = harness(t);
  h.choose("claude");
  const result = await h.services.ai.runStructured({
    role: "信件整理", schema, prompt: "摘要這封信。", data: {}, signal: new AbortController().signal,
    settings: { provider: "codex", model: "", reasoningEffort: "" },
  });
  assert.equal(result.execution.provider, "claude");
  assert.deepEqual(h.spawns(), []);
});

test("a revoked saved key fails with a fixed message; the key and its echoes stay out of errors, logs and responses", async (t) => {
  const h = harness(t);
  const server = await startTestServer(t, h.services);
  await h.services.vault.set(AI_KEY_VAULT.openai, { key: OPENAI_REVOKED, verifiedAt: "2026-11-09T00:00:00.000Z" });
  await h.services.vault.set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_REVOKED, verifiedAt: "2026-11-09T00:00:00.000Z" });

  const outcomes: { error: unknown; lines: string[] }[] = [];
  for (const method of ["openai-key", "anthropic-key"] as const) {
    h.choose(method);
    const outcome = await capturingLogs(h.run);
    outcomes.push(outcome);
    const error = outcome.error as AppError;
    assert.ok(error instanceof AppError, method);
    assert.equal(error.status, 503, method);
    assert.match(error.message, method === "openai-key" ? /OpenAI 不接受目前保存的 API 金鑰/ : /Anthropic 不接受目前保存的 API 金鑰/);
    assert.match(error.message, /設定 › 連接 AI/);
  }
  assert.ok(h.spawns().some((spawn) => spawn.key === OPENAI_REVOKED), "the fake really saw the key (and echoed it)");

  // A crash with no result event: the logged tail is masked, the error is fixed text.
  await h.services.vault.set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_CRASH, verifiedAt: "2026-11-09T00:00:00.000Z" });
  const crash = await capturingLogs(h.run);
  outcomes.push(crash);
  assert.equal((crash.error as AppError).status, 502);
  assert.match((crash.error as AppError).message, /沒有正常結束/);
  const failed = crash.lines.find((line) => line.includes('"event":"ai.cli_failed"'));
  assert.ok(failed, "the failure is still logged");
  assert.match(failed!, /upstream refused \[REDACTED\]/);

  const responses = await Promise.all(["/api/ai/connections", "/api/settings/provider", "/api/settings/app", "/api/status", "/api/export?include=sources"].map((path) => server.call("GET", path)));
  const surfaces: [string, string][] = [
    ["errors", outcomes.map((item) => `${(item.error as Error).message}\n${(item.error as Error).stack}`).join("\n")],
    ["logs", outcomes.flatMap((item) => item.lines).join("")],
    ["responses", responses.map((item) => item.text).join("\n")],
    ["argv", [...h.calls.flatMap((call) => call.args), ...h.spawns().flatMap((spawn) => spawn.argv)].join(" ")],
  ];
  // The whole key, the prefix the CLIs echo (12–16 characters) and the tail.
  for (const key of [OPENAI_REVOKED, ANTHROPIC_REVOKED, ANTHROPIC_CRASH])
    for (const [where, text] of surfaces)
      for (const fragment of [key, key.slice(0, key.startsWith("sk-ant-") ? 14 : 12), key.slice(-8)])
        assert.ok(!text.includes(fragment), `${where} must not carry ${fragment.slice(0, 6)}…`);
  assert.deepEqual(readdirSync(h.aiRoot), [], "the throwaway homes are gone after a failure too");
});

test("redactCliOutput masks the run's own key and any shortened sk- echo", () => {
  const key = `sk-ant-api03-${"z".repeat(40)}`;
  assert.equal(redactCliOutput(`bad key ${key} rejected`, [key]), "bad key [REDACTED] rejected");
  assert.equal(redactCliOutput("Incorrect API key provided: sk-proj-abc*****wxyz."), "Incorrect API key provided: [REDACTED].");
  assert.equal(redactCliOutput("API key configured - sk-proj-***"), "API key configured - [REDACTED]");
  assert.equal(redactCliOutput("plain failure"), "plain failure");
  assert.equal(redactCliOutput("short", ["abc"]), "short", "too short to be a key: left alone");
});

test("redactCliOutput: the release gate's nine echo forms, with the active key and from shape alone", () => {
  // The shapes of the 2026-11-09 review's probe (evidence/redact-probe.log), keys built at run time.
  const openai = `sk-proj-${"rIgElFaKe0".repeat(6)}`;
  const anthropic = `sk-ant-api03-${"rIgElFaKe1".repeat(6)}`;
  const forms: [string, string, string][] = [
    ["full key in a sentence", `Incorrect API key provided: ${openai}.`, openai],
    ["stars and the last 4", `Incorrect API key provided: sk-proj-${"*".repeat(40)}${openai.slice(-4)}. You can find your API key at`, openai],
    ["prefix 12 … last 6", `401 Unauthorized key=${openai.slice(0, 12)}…${openai.slice(-6)}`, openai],
    ["a fragment without sk-", `fragment:${openai.slice(3, 30)}`, openai],
    ["glued after an underscore", `OPENAI_API_KEY_${openai}`, openai],
    ["glued after letters", `Bearer${openai}`, openai],
    ["Anthropic full key", `invalid x-api-key ${anthropic}`, anthropic],
    ["Anthropic fragment", anthropic.slice(7, 30), anthropic],
    ["trailing dash", `${openai}-`, openai],
  ];
  const leaks = (text: string, key: string) => {
    for (let index = 0; index + 8 <= key.length; index++) if (text.includes(key.slice(index, index + 8))) return key.slice(index, index + 8);
    // A shortened echo (prefix … suffix) keeps its visible pieces.
    return [key.slice(0, 12), key.slice(-6), key.slice(-4)].find((piece) => text.includes(piece));
  };
  for (const [name, text, key] of forms) {
    for (const secrets of [[key], []]) {
      const out = redactCliOutput(text, secrets);
      assert.equal(leaks(out, key), undefined, `${name} (${secrets.length ? "key mode" : "shape only"}): ${out}`);
      assert.match(out, /\[REDACTED\]/, name);
    }
  }
  // Key mode: any 8-character piece of the active key, or a shortened echo of it, even with no key shape at all.
  for (const text of [`echo ${openai.slice(20, 29)} done`, `${openai.slice(10, 14)}…${openai.slice(-6)}`, `tail ${anthropic.slice(-8)}`]) {
    const key = text.includes(anthropic.slice(-8)) ? anthropic : openai;
    assert.equal(leaks(redactCliOutput(text, [key]), key), undefined, text);
  }
  // Ordinary CLI text stays readable.
  for (const text of ["task-force risk-free", "server/ai/codex.ts:12", "Use claude auth login.", "exit 1", "spawn codex ENOENT", "https://api.openai.com/v1/responses", "model gpt-5.5-codex, effort high"])
    assert.equal(redactCliOutput(text, [openai, anthropic]), text, text);
});

test("a key typed into the URL path is refused and logged as [REDACTED]", async (t) => {
  const services = testServices(t);
  const server = await startTestServer(t, services);
  const key = `sk-proj-${"u".repeat(40)}`;
  const { value: response, lines } = await capturingLogs(() => server.call("PUT", `/api/ai/connections/keys/${key}`, { body: { key: "x" } }));
  assert.equal(response?.status, 400);
  assert.ok(!response!.text.includes(key.slice(0, 12)), "the 400 does not echo it");
  const logged = lines.join("");
  assert.match(logged, /"path":"\/api\/ai\/connections\/keys\/\[REDACTED\]"/);
  assert.ok(!logged.includes(key.slice(0, 12)) && !logged.includes(key.slice(-8)));
  assert.equal(loggablePath("/api/gmail/threads/18c2f0a1b2c3d4e5"), "/api/gmail/threads/18c2f0a1b2c3d4e5", "ordinary ids stay");
});

test("loginError attaches ai_connection_not_ready for chatgpt, claude and key plans, leaves method null bare, and preserves zh-TW messages", () => {
  const chatgptPlan: AiConnectionPlan = { provider: "codex", method: "chatgpt", home: "shared", expect: "subscription" };
  const claudePlan: AiConnectionPlan = { provider: "claude", method: "claude", home: "shared", expect: "subscription" };

  const chatgptOut = loginError(chatgptPlan, undefined);
  assert.equal(chatgptOut.status, 503);
  assert.equal(chatgptOut.message, "無法使用 Codex：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。");
  assert.deepEqual(chatgptOut.detail, { code: "ai_connection_not_ready", method: "chatgpt", reason: "not_signed_in" });

  const chatgptWrong = loginError(chatgptPlan, "api_key");
  assert.equal(chatgptWrong.status, 503);
  assert.equal(chatgptWrong.message, "伺服器上的 Codex 目前用 API 金鑰登入，不是 ChatGPT 帳號。請到 設定 › 連接 AI 改選「OpenAI API 金鑰」，或在伺服器重新執行 codex login 改用 ChatGPT 登入。");
  assert.deepEqual(chatgptWrong.detail, { code: "ai_connection_not_ready", method: "chatgpt", reason: "wrong_login" });

  const claudeOut = loginError(claudePlan, undefined);
  assert.equal(claudeOut.status, 503);
  assert.equal(claudeOut.message, "無法使用 Claude Code：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。");
  assert.deepEqual(claudeOut.detail, { code: "ai_connection_not_ready", method: "claude", reason: "not_signed_in" });

  const claudeWrong = loginError(claudePlan, "api_key");
  assert.equal(claudeWrong.status, 503);
  assert.equal(claudeWrong.message, "伺服器上的 Claude Code 目前用 API 金鑰登入，不是 Claude 訂閱。請到 設定 › 連接 AI 改選「Anthropic API 金鑰」，或在伺服器重新執行 claude auth login。");
  assert.deepEqual(claudeWrong.detail, { code: "ai_connection_not_ready", method: "claude", reason: "wrong_login" });

  for (const [method, cli, keyProvider] of [["openai-key", "codex", "openai"], ["anthropic-key", "claude", "anthropic"]] as const) {
    const missing = loginError({ provider: cli, method, home: "shared", expect: "api_key", keyReason: "key_missing" }, undefined);
    assert.equal(missing.status, 503);
    assert.equal(missing.message, missingKeyMessage(keyProvider));
    assert.deepEqual(missing.detail, { code: "ai_connection_not_ready", method, reason: "key_missing" });

    const disabled = loginError({ provider: cli, method, home: "shared", expect: "api_key", keyReason: "vault_disabled" }, "subscription");
    assert.equal(disabled.status, 503);
    assert.equal(disabled.message, vaultDisabledKeyMessage(keyProvider));
    assert.deepEqual(disabled.detail, { code: "ai_connection_not_ready", method, reason: "vault_disabled" });

    const unreadable = keyNotReady(method, "key_unreadable");
    assert.equal(unreadable.status, 503);
    assert.equal(unreadable.message, unreadableKeyMessage(keyProvider));
    assert.deepEqual(unreadable.detail, { code: "ai_connection_not_ready", method, reason: "key_unreadable" });
  }

  const nullClaude = loginError({ provider: "claude", method: null, home: "shared" }, undefined);
  assert.equal(nullClaude.status, 503);
  assert.equal(nullClaude.message, "無法使用 Claude Code：請在伺服器的終端機執行 claude auth login。");
  assert.equal(nullClaude.detail, undefined);

  const nullCodex = loginError({ provider: "codex", method: null, home: "shared" }, "api_key");
  assert.equal(nullCodex.status, 503);
  assert.equal(nullCodex.message, "無法使用 Codex：請在伺服器的終端機執行 codex login。");
  assert.equal(nullCodex.detail, undefined);
});

test("PUT /api/settings/provider returns 503 ai_connection_not_ready across all 4 methods, keeps method null without code, and keeps job publicError message-only", async (t) => {
  const cliState: {
    claudeInstalled: boolean;
    codexInstalled: boolean;
    claudeLogin: "subscription" | "api_key" | "signed_out";
    codexLogin: "subscription" | "api_key" | "signed_out";
  } = {
    claudeInstalled: true,
    codexInstalled: true,
    claudeLogin: "subscription",
    codexLogin: "subscription",
  };
  let codexLoads = 0;
  const fake = fakeCommand((call) => {
    const cli = call.executable.includes("claude") ? "claude" : call.executable.includes("codex") ? "codex" : "other";
    if (cli === "claude" && !cliState.claudeInstalled) return undefined;
    if (cli === "codex" && !cliState.codexInstalled) return undefined;
    const joined = call.args.join(" ");
    if (joined === "--version") return cli === "claude" ? "2.1.321 (Claude Code)" : "codex-cli 0.167.0";
    if (cli === "claude" && joined === "auth status") {
      if (cliState.claudeLogin === "signed_out") return { stdout: "", stderr: "Not logged in", code: 1 };
      return JSON.stringify(cliState.claudeLogin === "subscription"
        ? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }
        : { loggedIn: true, authMethod: "api_key" });
    }
    if (cli === "codex" && joined === "login status") {
      if (cliState.codexLogin === "signed_out") return { stdout: "", stderr: "Not logged in", code: 1 };
      return { stdout: "", stderr: cliState.codexLogin === "subscription" ? "Logged in using ChatGPT" : "API key configured - sk-proj-***", code: 0 };
    }
    return undefined;
  });
  const services = testServices(t, {
    seams: {
      command: fake.runner,
      loadCodexCatalog: async () => {
        codexLoads++;
        if (!cliState.codexInstalled) throw new AppError(503, "無法啟動 Codex CLI。請安裝 Codex 並在伺服器執行 codex login。");
        if (cliState.codexLogin === "signed_out") return { source: "codex", models: [], error: "尚未登入 Codex。請在伺服器終端機執行 codex login，完成後重新整理。" };
        return { source: "codex", models: [{ id: "gpt-test", name: "GPT Test", description: "", isDefault: true, reasoningEfforts: ["low"], defaultReasoningEffort: "low" }] };
      },
    },
  });
  const server = await startTestServer(t, services);
  const choose = (method: AiConnectionMethod | null) => {
    services.settings.update({ "ai.connection": method });
    services.provider.invalidate();
    services.ai.forgetLogins();
  };

  // 1. chatgpt: not_signed_in, wrong_login, cli_not_installed
  choose("chatgpt");
  cliState.codexInstalled = true;
  cliState.codexLogin = "signed_out";
  services.provider.invalidate();
  services.ai.forgetLogins();
  const chatgptOut = await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } });
  assert.equal(chatgptOut.status, 503);
  assert.deepEqual(chatgptOut.json, {
    error: "無法使用 Codex：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。",
    code: "ai_connection_not_ready",
    method: "chatgpt",
    reason: "not_signed_in",
  });
  assert.equal(codexLoads, 0, "the Codex catalog loader does not run when chatgpt is signed out");

  cliState.codexLogin = "api_key";
  services.provider.invalidate();
  services.ai.forgetLogins();
  const chatgptWrong = await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } });
  assert.equal(chatgptWrong.status, 503);
  assert.deepEqual(chatgptWrong.json, {
    error: "伺服器上的 Codex 目前用 API 金鑰登入，不是 ChatGPT 帳號。請到 設定 › 連接 AI 改選「OpenAI API 金鑰」，或在伺服器重新執行 codex login 改用 ChatGPT 登入。",
    code: "ai_connection_not_ready",
    method: "chatgpt",
    reason: "wrong_login",
  });
  assert.equal(codexLoads, 0, "an API-key login never lists models for chatgpt");

  cliState.codexInstalled = false;
  services.provider.invalidate();
  services.ai.forgetLogins();
  const chatgptMissingCli = await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } });
  assert.equal(chatgptMissingCli.status, 503);
  assert.deepEqual(chatgptMissingCli.json, {
    error: "無法使用 Codex：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。",
    code: "ai_connection_not_ready",
    method: "chatgpt",
    reason: "cli_not_installed",
  });

  // 2. claude: not_signed_in, wrong_login, cli_not_installed
  cliState.codexInstalled = true;
  cliState.codexLogin = "subscription";
  choose("claude");
  cliState.claudeInstalled = true;
  cliState.claudeLogin = "signed_out";
  services.provider.invalidate();
  services.ai.forgetLogins();
  const claudeOut = await server.call("PUT", "/api/settings/provider", { body: { model: "haiku" } });
  assert.equal(claudeOut.status, 503);
  assert.deepEqual(claudeOut.json, {
    error: "無法使用 Claude Code：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。",
    code: "ai_connection_not_ready",
    method: "claude",
    reason: "not_signed_in",
  });

  cliState.claudeLogin = "api_key";
  services.provider.invalidate();
  services.ai.forgetLogins();
  const claudeWrong = await server.call("PUT", "/api/settings/provider", { body: { model: "haiku" } });
  assert.equal(claudeWrong.status, 503);
  assert.deepEqual(claudeWrong.json, {
    error: "伺服器上的 Claude Code 目前用 API 金鑰登入，不是 Claude 訂閱。請到 設定 › 連接 AI 改選「Anthropic API 金鑰」，或在伺服器重新執行 claude auth login。",
    code: "ai_connection_not_ready",
    method: "claude",
    reason: "wrong_login",
  });

  cliState.claudeInstalled = false;
  services.provider.invalidate();
  services.ai.forgetLogins();
  const claudeMissingCli = await server.call("PUT", "/api/settings/provider", { body: { model: "haiku" } });
  assert.equal(claudeMissingCli.status, 503);
  assert.deepEqual(claudeMissingCli.json, {
    error: "無法使用 Claude Code：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。",
    code: "ai_connection_not_ready",
    method: "claude",
    reason: "cli_not_installed",
  });

  // 3. openai-key & anthropic-key: key_missing, key_unreadable, vault_disabled
  cliState.claudeInstalled = true;
  cliState.claudeLogin = "subscription";
  cliState.codexInstalled = true;
  cliState.codexLogin = "subscription";
  for (const [method, keyProvider, model] of [["openai-key", "openai", "gpt-test"], ["anthropic-key", "anthropic", "haiku"]] as const) {
    choose(method);
    const missing = await server.call("PUT", "/api/settings/provider", { body: { model } });
    assert.equal(missing.status, 503);
    assert.deepEqual(missing.json, {
      error: missingKeyMessage(keyProvider),
      code: "ai_connection_not_ready",
      method,
      reason: "key_missing",
    });

    await new Vault({ directory: services.config.secretsDir, key: Buffer.alloc(32, 11) })
      .set(AI_KEY_VAULT[keyProvider], { key: keyProvider === "openai" ? OPENAI_KEY : ANTHROPIC_KEY, verifiedAt: "2026-11-09T00:00:00.000Z" });
    services.provider.invalidate();
    services.ai.forgetLogins();
    const unreadable = await server.call("PUT", "/api/settings/provider", { body: { model } });
    assert.equal(unreadable.status, 503);
    assert.deepEqual(unreadable.json, {
      error: unreadableKeyMessage(keyProvider),
      code: "ai_connection_not_ready",
      method,
      reason: "key_unreadable",
    });
    rmSync(join(services.config.secretsDir, VAULT_FILE), { force: true });
  }

  const noVaultServices = testServices(t, {
    env: { BELLPERSONAL_MASTER_KEY: "" },
    seams: { command: fake.runner },
  });
  const noVaultServer = await startTestServer(t, noVaultServices);
  for (const [method, keyProvider, model] of [["openai-key", "openai", "gpt-test"], ["anthropic-key", "anthropic", "haiku"]] as const) {
    noVaultServices.settings.update({ "ai.connection": method });
    noVaultServices.provider.invalidate();
    noVaultServices.ai.forgetLogins();
    const disabled = await noVaultServer.call("PUT", "/api/settings/provider", { body: { model } });
    assert.equal(disabled.status, 503);
    assert.deepEqual(disabled.json, {
      error: vaultDisabledKeyMessage(keyProvider),
      code: "ai_connection_not_ready",
      method,
      reason: "vault_disabled",
    });
  }

  // 4. plan.method === null: 503 carries error only (code === undefined)
  choose(null);
  cliState.codexLogin = "signed_out";
  services.provider.invalidate();
  const bareCodex = await server.call("PUT", "/api/settings/provider", { body: { provider: "codex" } });
  assert.equal(bareCodex.status, 503);
  assert.equal(bareCodex.json.code, undefined);
  assert.deepEqual(Object.keys(bareCodex.json), ["error"]);

  cliState.codexInstalled = false;
  services.provider.invalidate();
  const bareMissing = await server.call("PUT", "/api/settings/provider", { body: { provider: "codex" } });
  assert.equal(bareMissing.status, 503);
  assert.equal(bareMissing.json.code, undefined);
  assert.deepEqual(Object.keys(bareMissing.json), ["error"]);

  // 5. JobRegistry forwards structured errorDetail / detail while keeping top-level JobView code omitted
  choose("claude");
  cliState.claudeInstalled = true;
  cliState.claudeLogin = "api_key";
  services.ai.forgetLogins();
  const job = services.jobs.start({ kind: "daily-brief", title: "每日摘要" }, (_emit, signal) =>
    services.ai.runStructured({ role: "每日摘要", schema, prompt: "摘要。", data: {}, signal }));
  await services.jobs.settled(job.id);
  const events: unknown[] = [];
  services.jobs.follow(job.id, 0, (event) => events.push(event), () => {});
  const finished = services.jobs.get(job.id)!;
  assert.equal(finished.status, "failed");
  assert.equal(finished.error, "伺服器上的 Claude Code 目前用 API 金鑰登入，不是 Claude 訂閱。請到 設定 › 連接 AI 改選「Anthropic API 金鑰」，或在伺服器重新執行 claude auth login。");
  assert.equal("code" in finished, false);
  assert.deepEqual(finished.errorDetail, { code: "ai_connection_not_ready", method: "claude", reason: "wrong_login" });
  assert.deepEqual(events, [{
    type: "error",
    message: "伺服器上的 Claude Code 目前用 API 金鑰登入，不是 Claude 訂閱。請到 設定 › 連接 AI 改選「Anthropic API 金鑰」，或在伺服器重新執行 claude auth login。",
    detail: { code: "ai_connection_not_ready", method: "claude", reason: "wrong_login" },
  }]);
});
