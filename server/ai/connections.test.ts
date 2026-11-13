import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { TestContext } from "node:test";
import type { AiConnection, AiConnectionsResponse } from "../../shared/ai-connections.js";
import { AppError } from "../errors.js";
import { claudeAccount, codexAccount } from "../status.js";
import { startTestServer, testServices } from "../test-helpers.js";
import type { ServiceSeams } from "../services.js";
import { command, type CommandOptions, type CommandResult, type CommandRunner } from "./process.js";
import { AI_CONNECTION_ARGS, AI_KEY_META_VAULT, AI_KEY_VAULT, anthropicKeyCheck, deviceCode, keyHint, loginFailure, loginSignal, loginUrl, openaiKeyCheck } from "./connections.js";

// Key-shaped values built at run time so the source never holds anything that looks like a real credential.
const fakeKey = (prefix: string, fill: string) => `${prefix}${fill.repeat(40)}`;
const OPENAI_GOOD = fakeKey("sk-proj-", "g");
const OPENAI_BAD = fakeKey("sk-proj-", "b");
const OPENAI_BROKE = fakeKey("sk-proj-", "q");
const OPENAI_OFFLINE = fakeKey("sk-proj-", "o");
// A second good key whose ends are all different characters, so a slice longer than the hint would show.
const OPENAI_GOOD_2 = `sk-proj-${"h".repeat(30)}Ab12Cd34`;
const ANTHROPIC_GOOD = fakeKey("sk-ant-api03-", "g");
const ANTHROPIC_BAD = fakeKey("sk-ant-api03-", "b");
const ANTHROPIC_BROKE = fakeKey("sk-ant-api03-", "q");
const CLAUDE_GOOD_CODE = `${"c".repeat(40)}#${"s".repeat(40)}`;
/** A code the fake Claude never answers, like a token exchange that hangs. */
const CLAUDE_SLOW_CODE = `${"z".repeat(40)}#${"s".repeat(40)}`;
const DEVICE_CODE = "ABCD-EFGH2";
const CLAUDE_URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";

interface Call { executable: string; args: string[]; options: CommandOptions; cwdExisted?: boolean }

/**
 * A stand-in for both CLIs that behaves like the versions probed on this
 * host (Claude Code 2.1.321, codex-cli 0.167.0): status probes, the two
 * sign-ins (which wait like the real ones until approved, given a code, aborted
 * or timed out) and the key-check turns. A failing sign-in prints `says`
 * (approve(false, says), state.claudeSays for a wrong code) and exits non-zero.
 */
function fakeClis(state: { claude?: "max" | "api_key" | false; codex?: "chatgpt" | "api_key" | false; installed?: { claude?: boolean; codex?: boolean }; chatgptPrints?: string[]; claudeSays?: string[] } = {}) {
  const calls: Call[] = [];
  let approve: ((ok: boolean, says: string[]) => void) | undefined;
  const aborted: string[] = [];
  const installed = { claude: state.installed?.claude ?? true, codex: state.installed?.codex ?? true };

  const waitFor = (options: CommandOptions, name: string, until: (done: (result: CommandResult) => void, fail: (error: AppError) => void) => void) =>
    new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError(504, `${name} 逾時`)), options.timeoutMs ?? 60_000);
      const settle = <T>(fn: (value: T) => void) => (value: T) => { clearTimeout(timer); fn(value); };
      options.signal?.addEventListener("abort", () => { aborted.push(name); settle(reject)(new AppError(409, "工作已取消。")); }, { once: true });
      until(settle(resolve), settle(reject));
    });

  const runner: CommandRunner = async (executable, args, options = {}) => {
    const call: Call = { executable, args, options, ...(options.cwd ? { cwdExisted: existsSync(options.cwd) } : {}) };
    calls.push(call);
    const cli = executable.includes("claude") ? "claude" : executable.includes("codex") ? "codex" : "gh";
    if (cli === "gh" || !installed[cli]) throw new AppError(503, `${executable} 無法啟動：not found`);
    const joined = args.join(" ");
    if (joined === "--version") return { stdout: cli === "claude" ? "2.1.321 (Claude Code)" : "codex-cli 0.167.0", stderr: "", code: 0 };
    if (cli === "claude" && joined === "auth status") {
      if (!state.claude) throw new AppError(422, `${executable} 執行失敗`);
      const body = state.claude === "max"
        ? { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "someone@example.com" }
        : { loggedIn: true, authMethod: "api_key" };
      return { stdout: JSON.stringify(body), stderr: "", code: 0 };
    }
    if (cli === "codex" && joined === "login status") {
      if (!state.codex) throw new AppError(422, `${executable} 執行失敗`);
      return { stdout: "", stderr: state.codex === "chatgpt" ? "Logged in using ChatGPT" : "API key configured - sk-proj-***", code: 0 };
    }
    if (cli === "codex" && joined === "login --device-auth") {
      return waitFor(options, "chatgpt", (done, fail) => {
        const lines = state.chatgptPrints ?? [
          "Welcome to Codex [v0.167.0]",
          "Follow these steps to sign in with ChatGPT using device code authorization:",
          "Not this one: https://evil.example/codex/device",
          "1. Open this link in your browser and sign in to your account",
          "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
          "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
          `   \u001b[94m${DEVICE_CODE}\u001b[0m`,
        ];
        for (const line of lines) options.onLine?.(line, "stderr");
        approve = (ok, says) => {
          if (!ok) {
            for (const line of says) options.onLine?.(line, "stderr");
            return fail(new AppError(422, `${executable} 執行失敗`));
          }
          state.codex = "chatgpt";
          done({ stdout: "Successfully logged in", stderr: "", code: 0 });
        };
      });
    }
    if (cli === "claude" && joined === "auth login --claudeai") {
      return waitFor(options, "claude", (done, fail) => {
        options.onLine?.("Opening browser to sign in…", "stdout");
        options.onLine?.(`If the browser didn't open, visit: ${CLAUDE_URL}`, "stdout");
        options.onLine?.("Paste code here if prompted > ", "stdout");
        let input = "";
        const stdin = options.stdin as Readable;
        stdin.on("data", (chunk: Buffer) => { input += chunk.toString("utf8"); });
        stdin.on("end", () => {
          if (input === `${CLAUDE_GOOD_CODE}\n`) {
            state.claude = "max";
            done({ stdout: "Login successful.", stderr: "", code: 0 });
          } else if (input !== `${CLAUDE_SLOW_CODE}\n`) {
            for (const line of state.claudeSays ?? []) options.onLine?.(line, "stderr");
            fail(new AppError(422, `${executable} 執行失敗：Login failed`));
          }
        });
      });
    }
    if (cli === "claude" && args[0] === "-p") {
      const key = options.env?.ANTHROPIC_API_KEY;
      if (key === ANTHROPIC_GOOD) return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK" }), stderr: "", code: 0 };
      if (key === ANTHROPIC_BROKE) return { stdout: JSON.stringify({ type: "result", is_error: true, api_error_status: 400, result: "Credit balance is too low" }), stderr: "", code: 1 };
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Invalid API key · Fix external API key" }), stderr: "", code: 1 };
    }
    if (cli === "codex" && args[0] === "exec") {
      // Like codex-cli 0.167: the key is read from the variable a configured provider names, nothing else.
      const key = args.includes('model_provider="bell_openai"') ? options.env?.BELL_OPENAI_API_KEY : undefined;
      const events = (lines: object[]) => lines.map((line) => JSON.stringify(line)).join("\n");
      if (key === OPENAI_GOOD || key === OPENAI_GOOD_2) return { stdout: events([{ type: "thread.started" }, { type: "item.completed", item: { type: "agent_message", text: "OK" } }, { type: "turn.completed" }]), stderr: "", code: 0 };
      if (key === OPENAI_OFFLINE) throw new AppError(504, `${executable} 逾時`);
      const message = key === OPENAI_BROKE
        ? "unexpected status 429 Too Many Requests: You exceeded your current quota"
        : `unexpected status 401 Unauthorized: Incorrect API key provided: ${key}`;
      return { stdout: events([{ type: "error", message }, { type: "turn.failed", error: { message } }]), stderr: "", code: 1 };
    }
    throw new Error(`unexpected command ${executable} ${joined}`);
  };
  return { runner, calls, aborted, state, approve: (ok = true, says: string[] = []) => approve?.(ok, says) };
}

async function setup(t: TestContext, clis: ReturnType<typeof fakeClis>, options: { env?: NodeJS.ProcessEnv; seams?: ServiceSeams } = {}) {
  const services = testServices(t, { env: options.env, seams: { command: clis.runner, statusCacheMs: 0, ...options.seams } });
  return { services, server: await startTestServer(t, services) };
}

const byMethod = (body: AiConnectionsResponse) => Object.fromEntries(body.connections.map((item) => [item.method, item])) as Record<AiConnection["method"], AiConnection>;
const logins = (clis: ReturnType<typeof fakeClis>) => clis.calls.filter((call) => call.args.includes("login") && !call.args.includes("status"));

/** Everything logEvent writes while `task` runs (logging is off in tests). */
async function capturingLogs<T>(task: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
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
    return { value: await task(), lines };
  } finally {
    process.stdout.write = write;
    process.env.BELLPERSONAL_LOG = previous;
  }
}

test("GET /api/ai/connections: one state per method, plan but never the account, not cached", async (t) => {
  const none = fakeClis();
  const { server } = await setup(t, none);
  const empty = await server.call("GET", "/api/ai/connections");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers["cache-control"], "no-store");
  assert.deepEqual(empty.json.connections.map((item: AiConnection) => [item.method, item.cli, item.installed, item.state]), [
    ["chatgpt", "codex", true, "not_set"],
    ["claude", "claude", true, "not_set"],
    ["openai-key", "codex", true, "not_set"],
    ["anthropic-key", "claude", true, "not_set"],
  ]);
  assert.deepEqual(empty.json.connections.map((item: AiConnection) => item.reason), ["not_signed_in", "not_signed_in", "key_missing", "key_missing"], "every state but detected says why");
  assert.deepEqual(empty.json.vault, { enabled: true });
  assert.equal(empty.json.activeStatus, null, "nothing chosen");

  const signedIn = fakeClis({ claude: "max", codex: "chatgpt" });
  const both = await setup(t, signedIn);
  const body = (await both.server.call("GET", "/api/ai/connections")).json as AiConnectionsResponse;
  const methods = byMethod(body);
  assert.deepEqual(methods.chatgpt, { method: "chatgpt", cli: "codex", installed: true, state: "detected", source: "cli" });
  assert.deepEqual(methods.claude, { method: "claude", cli: "claude", installed: true, state: "detected", source: "cli", plan: "max" });
  assert.equal(methods["openai-key"].state, "not_set", "a ChatGPT login is not an API key");
  assert.doesNotMatch(JSON.stringify(body), /someone@example\.com/);

  // Keys set up in a terminal (codex login --with-api-key, ANTHROPIC_API_KEY) show on the key methods instead.
  const keyed = fakeClis({ claude: "api_key", codex: "api_key" });
  const viaKeys = byMethod((await (await setup(t, keyed)).server.call("GET", "/api/ai/connections")).json);
  assert.deepEqual([viaKeys.chatgpt.state, viaKeys.chatgpt.reason], ["not_set", "wrong_login"]);
  assert.deepEqual([viaKeys.claude.state, viaKeys.claude.reason], ["not_set", "wrong_login"]);
  assert.deepEqual([viaKeys["openai-key"].state, viaKeys["openai-key"].source], ["detected", "cli"]);
  assert.deepEqual([viaKeys["anthropic-key"].state, viaKeys["anthropic-key"].source], ["detected", "cli"]);

  const missing = fakeClis({ installed: { claude: false } });
  const noClaude = byMethod((await (await setup(t, missing)).server.call("GET", "/api/ai/connections")).json);
  assert.equal(noClaude.claude.installed, false);
  assert.equal(noClaude["anthropic-key"].installed, false);
  assert.deepEqual([noClaude.claude.reason, noClaude["anthropic-key"].reason], ["cli_not_installed", "cli_not_installed"]);
});

test("ChatGPT sign-in: device code link and code only, one CLI per method, approval shows it detected", async (t) => {
  const clis = fakeClis();
  const { server } = await setup(t, clis);

  assert.equal((await server.call("POST", "/api/ai/connections/chatgpt/login", { body: { args: ["--with-api-key"] } })).status, 400, "no options: the argv is fixed");
  assert.equal((await server.call("POST", "/api/ai/connections/gemini/login", { body: {} })).status, 400);
  // The usual guards apply: a form post or a foreign origin never starts a sign-in.
  assert.equal((await server.call("POST", "/api/ai/connections/chatgpt/login", { body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {}, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(logins(clis).length, 0);

  const started = await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  assert.equal(started.status, 200);
  assert.equal(started.json.state, "pending");
  assert.equal(started.json.prompt.kind, "device_code");
  assert.equal(started.json.prompt.url, "https://auth.openai.com/codex/device", "the vetted link, not the first one printed");
  assert.equal(started.json.prompt.code, DEVICE_CODE, "colour codes stripped");
  assert.ok(Date.parse(started.json.prompt.expiresAt) > Date.now() + 14 * 60_000);
  assert.doesNotMatch(started.text, /Welcome|evil/, "nothing else the CLI printed");

  const again = await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  assert.deepEqual(again.json.prompt, started.json.prompt, "a second tab rejoins the same sign-in");
  assert.equal(logins(clis).length, 1);
  const [login] = logins(clis);
  assert.deepEqual(login.args, [...AI_CONNECTION_ARGS.chatgptLogin]);
  assert.equal(login.executable, server.services.config.codexPath);

  const polled = byMethod((await server.call("GET", "/api/ai/connections")).json);
  assert.equal(polled.chatgpt.state, "pending");
  assert.equal(polled.chatgpt.prompt?.kind, "device_code");

  clis.approve();
  await new Promise((resolve) => setImmediate(resolve));
  const done = byMethod((await server.call("GET", "/api/ai/connections")).json);
  assert.deepEqual([done.chatgpt.state, done.chatgpt.source, done.chatgpt.prompt], ["detected", "cli", undefined]);
});

test("a sign-in is refused while that CLI is signed in or missing: no silent account swap", async (t) => {
  const clis = fakeClis({ codex: "api_key", installed: { claude: false } });
  const { server } = await setup(t, clis);
  const swap = await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  assert.equal(swap.status, 409);
  assert.match(swap.json.error, /codex logout/);
  const missing = await server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  assert.equal(missing.status, 503);
  assert.match(missing.json.error, /沒有安裝 Claude Code/);
  assert.equal(logins(clis).length, 0, "no login process started");
  assert.equal(byMethod((await server.call("GET", "/api/ai/connections")).json).chatgpt.state, "not_set", "a refusal is not a failed attempt");
});

test("sign-in endings: cancel is quiet; denial, expiry, a CLI error and a missing link are failures with a reason code and a message", async (t) => {
  const clis = fakeClis();
  const { server, services } = await setup(t, clis, { seams: { aiConnectionTimeouts: { chatgptLogin: 200 } } });
  const chatgpt = async () => byMethod((await server.call("GET", "/api/ai/connections")).json).chatgpt;
  const failWith = async (says: string[]) => {
    await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
    clis.approve(false, says);
    await new Promise((resolve) => setImmediate(resolve));
    const row = await chatgpt();
    return [row.state, row.failure, row.message];
  };
  const CLI_ERROR = "Codex 的登入程式出錯，沒有完成登入。請再試一次；一直失敗的話，請確認伺服器連得上網路。";

  await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  const cancelled = await server.call("DELETE", "/api/ai/connections/chatgpt/login", { body: {} });
  assert.equal(cancelled.status, 204);
  assert.deepEqual(clis.aborted, ["chatgpt"]);
  const quietRow = await chatgpt();
  assert.deepEqual([quietRow.state, quietRow.failure, quietRow.message], ["not_set", undefined, undefined], "BELL's own 取消 is not a failure");
  assert.equal((await server.call("DELETE", "/api/ai/connections/chatgpt/login", { body: {} })).status, 204, "idempotent");

  // Denied on the sign-in page: only when the CLI says so.
  const { value: denied, lines: logs } = await capturingLogs(() => failWith(["Error logging in with device code: access_denied"]));
  assert.deepEqual(denied, ["failed", "denied", "登入被取消或拒絕了，請重新開始。"]);
  const failedLog = logs.map((line) => JSON.parse(line)).find((line) => line.step === "failed");
  assert.deepEqual([failedLog.failure, failedLog.reason], ["denied", "denied"]);
  assert.ok(logs.every((line) => !line.includes("access_denied")), "the CLI's words are not logged");

  // A non-zero exit that says nothing, or a network problem, is the CLI's error, not the user's choice.
  assert.deepEqual(await failWith([]), ["failed", "cli_error", CLI_ERROR]);
  assert.deepEqual(await failWith(["Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/token)", "Caused by: tcp connect error: Connection refused (os error 111)"]), ["failed", "cli_error", CLI_ERROR]);
  assert.deepEqual(await failWith(["thread 'main' panicked at src/login.rs:1:1"]), ["failed", "cli_error", CLI_ERROR]);
  // The CLI's own time limit, and BELL's.
  assert.deepEqual(await failWith(["Error logging in with device code: device auth timed out after 15 minutes"]), ["failed", "timed_out", "登入逾時，請重新開始。"]);
  await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const expired = await chatgpt();
  assert.deepEqual([expired.state, expired.failure, expired.message], ["failed", "timed_out", "登入逾時，請重新開始。"]);
  const body = JSON.stringify((await server.call("GET", "/api/ai/connections")).json);
  for (const raw of ["access_denied", "tcp connect", "panicked", "15 minutes", "someone@example.com"]) assert.ok(!body.includes(raw), raw);

  // A CLI whose output changed and never shows a link is stopped, not left waiting.
  const silent = fakeClis({ chatgptPrints: ["Something new"] });
  const quiet = await setup(t, silent, { seams: { aiConnectionTimeouts: { prompt: 50 } } });
  const noLink = await quiet.server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  assert.equal(noLink.status, 502);
  assert.equal(noLink.json.error, "沒有取得登入連結，請再試一次。");
  assert.deepEqual(silent.aborted, ["chatgpt"]);
  const noLinkRow = byMethod((await quiet.server.call("GET", "/api/ai/connections")).json).chatgpt;
  assert.deepEqual([noLinkRow.state, noLinkRow.failure], ["failed", "cli_error"]);

  // Shutting down stops a sign-in still waiting.
  await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  await services.aiConnections.close();
  assert.deepEqual(clis.aborted, ["chatgpt", "chatgpt"]);
});

test("Claude sign-in: the pasted code goes to the waiting CLI's stdin, never an argv", async (t) => {
  const clis = fakeClis();
  const { server } = await setup(t, clis);
  assert.equal((await server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: CLAUDE_GOOD_CODE } })).status, 409, "no sign-in waiting");

  const started = await server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  assert.equal(started.status, 200);
  assert.deepEqual({ ...started.json.prompt, expiresAt: undefined }, { kind: "paste_code", url: CLAUDE_URL, expiresAt: undefined });
  assert.deepEqual(logins(clis)[0].args, [...AI_CONNECTION_ARGS.claudeLogin]);

  for (const code of ["short", `${CLAUDE_GOOD_CODE}\n--console`, `${CLAUDE_GOOD_CODE} x`, "x".repeat(1200)]) {
    const refused = await server.call("POST", "/api/ai/connections/claude/login/code", { body: { code } });
    assert.equal(refused.status, 400, JSON.stringify(code).slice(0, 40));
  }
  assert.equal((await server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: CLAUDE_GOOD_CODE, flags: "--sso" } })).status, 400);

  const done = await server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: `  ${CLAUDE_GOOD_CODE}  ` } });
  assert.equal(done.status, 200);
  assert.deepEqual([done.json.state, done.json.plan], ["detected", "max"]);
  assert.ok(clis.calls.every((call) => !call.args.some((arg) => arg.includes(CLAUDE_GOOD_CODE))));

  // A rejected code fails the attempt with a message; starting again is the way back.
  const fresh = fakeClis();
  const second = await setup(t, fresh);
  await second.server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  const wrong = await second.server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: "w".repeat(30) } });
  assert.equal(wrong.status, 422);
  assert.match(wrong.json.error, /沒有被接受/);
  const after = byMethod((await second.server.call("GET", "/api/ai/connections")).json).claude;
  assert.deepEqual([after.state, after.prompt, after.failure], ["failed", undefined, "code_rejected"]);

  // What Claude Code says about a bad code is the same reason; a check that hangs is a timeout.
  for (const says of [["Authentication failed: Invalid authorization code"], ["This device code has already been used or has expired."], ["That code is not from this sign-in."]]) {
    const named = fakeClis({ claudeSays: says });
    const third = await setup(t, named);
    await third.server.call("POST", "/api/ai/connections/claude/login", { body: {} });
    assert.equal((await third.server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: "w".repeat(30) } })).status, 422);
    const row = byMethod((await third.server.call("GET", "/api/ai/connections")).json).claude;
    assert.deepEqual([row.state, row.failure], ["failed", "code_rejected"], says[0]);
    assert.ok(!row.message?.includes(says[0]));
  }
  const slow = fakeClis();
  const fourth = await setup(t, slow, { seams: { aiConnectionTimeouts: { codeExchange: 50 } } });
  await fourth.server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  const hung = await fourth.server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: CLAUDE_SLOW_CODE } });
  assert.deepEqual([hung.status, hung.json.error], [422, "確認代碼逾時，請重新開始登入。"]);
  assert.deepEqual(slow.aborted, ["claude"]);
  assert.equal(byMethod((await fourth.server.call("GET", "/api/ai/connections")).json).claude.failure, "timed_out");
});

test("取消 after a failed sign-in clears it: reopening never shows the old error (PO-15)", async (t) => {
  const clis = fakeClis();
  const { server } = await setup(t, clis, { seams: { aiConnectionTimeouts: { chatgptLogin: 50 } } });
  const row = async (method: AiConnection["method"]) => {
    const { state, failure, message, reason } = byMethod((await server.call("GET", "/api/ai/connections")).json)[method];
    return [state, failure, message, reason];
  };

  // A rejected Claude code leaves no sign-in running; 取消 (or 上一步) still clears the rejection.
  await server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  assert.equal((await server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: "w".repeat(30) } })).status, 422);
  assert.deepEqual((await row("claude")).slice(0, 2), ["failed", "code_rejected"]);
  assert.equal((await server.call("DELETE", "/api/ai/connections/claude/login", { body: {} })).status, 204);
  assert.deepEqual(await row("claude"), ["not_set", undefined, undefined, "not_signed_in"]);

  // Same for a sign-in that ended on its own (BELL's time limit).
  await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual((await row("chatgpt")).slice(0, 2), ["failed", "timed_out"]);
  assert.equal((await server.call("DELETE", "/api/ai/connections/chatgpt/login", { body: {} })).status, 204);
  assert.deepEqual(await row("chatgpt"), ["not_set", undefined, undefined, "not_signed_in"]);

  // Cancelling one method leaves the other's failure alone.
  await server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  await server.call("POST", "/api/ai/connections/claude/login/code", { body: { code: "w".repeat(30) } });
  await server.call("DELETE", "/api/ai/connections/chatgpt/login", { body: {} });
  assert.deepEqual((await row("claude")).slice(0, 2), ["failed", "code_rejected"]);
});

test("sign-in failure reasons: what the CLIs print (codex-cli 0.167.0, Claude Code 2.1.321) and how BELL ended it", () => {
  const prompts = [
    "Welcome to Codex [v0.167.0]",
    "Follow these steps to sign in with ChatGPT using device code authorization:",
    "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
    "Device codes are a common phishing target. Never share this code.",
    "If a website or another person gave you this code, cancel.",
    "Opening browser to sign in…",
    `If the browser didn't open, visit: ${CLAUDE_URL}`,
    "Paste code here if prompted > ",
    "Login successful.",
  ];
  for (const line of prompts) assert.equal(loginSignal(line), undefined, line);
  const said: Array<[string, ReturnType<typeof loginSignal>]> = [
    ["Error logging in with device code: access_denied", "denied"],
    ["OAuth login cancelled", "denied"],
    ["provider OAuth sign-in was cancelled", "denied"],
    ["OAuth authorization was denied or failed", "denied"],
    ["Login interrupted.", "denied"],
    ["Authentication failed: Invalid authorization code", "code"],
    ["Invalid code. Please make sure the full code was copied.", "code"],
    ["That code is not from this sign-in.", "code"],
    ["This device code has already been used or has expired.", "code"],
    ["Token exchange failed (400)", "code"],
    ["Failed to exchange authorization code for access token. Please try again.", "code"],
    ["\u001b[31mError: expired_token\u001b[0m", "expired"],
    ["Error logging in with device code: device auth timed out after 15 minutes", "timeout"],
    ["Authentication timeout", "timeout"],
    ["error sending request for url (https://auth.openai.com/oauth/token)", "network"],
    ["getaddrinfo ENOTFOUND platform.claude.com", "network"],
    ["TypeError: fetch failed", "network"],
    ["Error logging in with device code: device auth failed with status 500 Internal Server Error", undefined],
    ["OAuth login failed: x. Run with --debug for the underlying error.", undefined],
  ];
  for (const [line, signal] of said) assert.equal(loginSignal(line), signal, line);

  // BELL's own endings and the runner's status first, then what the CLI said, then a plain exit.
  assert.equal(loginFailure("exchange_timeout", 409, "denied", true), "timed_out");
  assert.equal(loginFailure("no_prompt", 409, undefined, false), "cli_error");
  assert.equal(loginFailure(undefined, 503, undefined, false), "cli_error");
  assert.equal(loginFailure(undefined, 504, "denied", false), "timed_out", "BELL's time limit, even if the killed CLI says interrupted");
  assert.equal(loginFailure(undefined, 422, "network", true), "cli_error");
  assert.equal(loginFailure(undefined, 422, "denied", false), "denied");
  assert.equal(loginFailure(undefined, 422, "timeout", false), "timed_out");
  assert.equal(loginFailure(undefined, 422, "expired", false), "timed_out");
  assert.equal(loginFailure(undefined, 422, "expired", true), "code_rejected");
  assert.equal(loginFailure(undefined, 422, "code", false), "cli_error", "no code was sent, so it is not the user's code");
  assert.equal(loginFailure(undefined, 422, "code", true), "code_rejected");
  assert.equal(loginFailure(undefined, 422, undefined, true), "code_rejected");
  assert.equal(loginFailure(undefined, 422, undefined, false), "cli_error");
  assert.equal(loginFailure(undefined, 500, undefined, false), "cli_error");
});

test("API keys: checked with one throwaway CLI run, kept only in the vault, never returned, logged or exported", async (t) => {
  const clis = fakeClis();
  const { server, services } = await setup(t, clis);

  const shapes: [string, string, RegExp][] = [
    ["openai", ANTHROPIC_GOOD, /請改選 Anthropic/],
    ["anthropic", OPENAI_GOOD, /請改選 OpenAI/],
    ["openai", "hello", /以 sk- 開頭/],
    ["anthropic", "sk-ant-short", /以 sk-ant- 開頭/],
    ["openai", `${OPENAI_GOOD} extra`, /以 sk- 開頭/],
  ];
  for (const [provider, key, message] of shapes) {
    const refused = await server.call("PUT", `/api/ai/connections/keys/${provider}`, { body: { key } });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, message);
    assert.ok(!refused.text.includes(key), "the error never quotes the key");
  }
  assert.equal((await server.call("PUT", "/api/ai/connections/keys/google", { body: { key: OPENAI_GOOD } })).status, 400);
  assert.equal((await server.call("PUT", "/api/ai/connections/keys/openai", { body: { key: "x".repeat(600) } })).status, 400);
  assert.equal(clis.calls.filter((call) => call.args[0] === "exec" || call.args[0] === "-p").length, 0, "shape errors cost no model call");

  const { value: outcomes, lines } = await capturingLogs(async () => {
    const results = [];
    for (const [provider, key] of [["openai", OPENAI_BAD], ["openai", OPENAI_BROKE], ["openai", OPENAI_OFFLINE], ["anthropic", ANTHROPIC_BAD], ["anthropic", ANTHROPIC_BROKE], ["openai", OPENAI_GOOD], ["anthropic", ANTHROPIC_GOOD]])
      results.push(await server.call("PUT", `/api/ai/connections/keys/${provider}`, { body: { key } }));
    return results;
  });
  assert.deepEqual(outcomes.map((item) => item.status), [422, 422, 502, 422, 422, 200, 200]);
  assert.deepEqual(outcomes.map((item) => item.json.code), ["ai_key_invalid", "ai_key_no_credit", undefined, "ai_key_invalid", "ai_key_no_credit", undefined, undefined]);
  assert.match(outcomes[0].json.error, /OpenAI 不接受這把金鑰/);
  assert.match(outcomes[1].json.error, /沒有可用額度/);
  assert.match(outcomes[2].json.error, /金鑰沒有保存/);
  assert.match(outcomes[4].json.error, /沒有可用額度/);
  assert.deepEqual([outcomes[5].json.state, outcomes[5].json.source], ["detected", "bell"]);
  assert.deepEqual([outcomes[6].json.method, outcomes[6].json.state], ["anthropic-key", "detected"]);

  const checks = clis.calls.filter((call) => call.args[0] === "exec" || call.args[0] === "-p");
  assert.equal(checks.length, 7);
  for (const check of checks) {
    const openai = check.args[0] === "exec";
    assert.deepEqual(check.args, [...(openai ? AI_CONNECTION_ARGS.openaiKeyCheck : AI_CONNECTION_ARGS.anthropicKeyCheck)], "the key is never an argument");
    const home = openai ? check.options.env?.CODEX_HOME : check.options.env?.CLAUDE_CONFIG_DIR;
    assert.equal(dirname(dirname(String(home))), join(services.config.dataDir, "ai"), "a throwaway config home under <data>/ai, never the server's login");
    assert.match(basename(dirname(String(home))), /^keycheck-/);
    assert.equal(check.cwdExisted, true);
    assert.equal(existsSync(join(String(home), "..")), false, "deleted afterwards");
    assert.equal(check.options.env?.OPENAI_API_KEY, undefined);
    assert.equal(check.options.env?.CODEX_API_KEY, undefined);
    if (openai) {
      assert.equal(check.options.env?.ANTHROPIC_API_KEY, undefined);
      assert.ok(check.args.includes('model_provider="bell_openai"'), "checked through the same provider AI jobs use");
    } else assert.equal(check.options.env?.BELL_OPENAI_API_KEY, undefined);
  }

  const vaulted = await services.vault.get<{ key: string; verifiedAt: string }>(AI_KEY_VAULT.openai);
  assert.equal(vaulted?.key, OPENAI_GOOD);
  assert.ok(vaulted?.verifiedAt);
  assert.equal((await services.vault.get<{ key: string }>(AI_KEY_VAULT.anthropic))?.key, ANTHROPIC_GOOD);
  const vaultFile = readFileSync(services.vault.file, "utf8");
  const listed = await server.call("GET", "/api/ai/connections");
  const status = await server.call("GET", "/api/status");
  const exported = await server.call("GET", "/api/export?include=sources");
  assert.equal(exported.status, 200);
  for (const key of [OPENAI_GOOD, OPENAI_BAD, OPENAI_BROKE, OPENAI_OFFLINE, ANTHROPIC_GOOD, ANTHROPIC_BAD, ANTHROPIC_BROKE]) {
    for (const [where, text] of [["responses", outcomes.map((item) => item.text).join("\n")], ["list", listed.text], ["status", status.text], ["export", exported.text], ["logs", lines.join("")], ["vault file", vaultFile]])
      assert.ok(!text.includes(key) && !text.includes(key.slice(-24)), `${where} must not carry a key`);
  }
  assert.ok(lines.some((line) => line.includes('"event":"ai.key_check"') && line.includes('"outcome":"invalid"')));

  assert.equal((await server.call("DELETE", "/api/ai/connections/keys/openai", { body: {} })).status, 204);
  assert.equal(await services.vault.has(AI_KEY_VAULT.openai), false);
  assert.equal(byMethod((await server.call("GET", "/api/ai/connections")).json)["openai-key"].state, "not_set");
});

test("a saved key shows only its provider, a 4-character hint and when its check passed; a failed check keeps the old one", async (t) => {
  const clis = fakeClis({ codex: "chatgpt", claude: "max" });
  let clock = new Date("2026-11-10T01:00:00.000Z");
  const { server, services } = await setup(t, clis, { seams: { now: () => clock } });
  const rows = async () => byMethod((await server.call("GET", "/api/ai/connections")).json);
  const keys = [OPENAI_GOOD_2, OPENAI_GOOD, OPENAI_BAD, ANTHROPIC_GOOD];

  const { value: texts, lines } = await capturingLogs(async () => {
    const seen: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await server.call(method, path, body === undefined ? {} : { body });
      seen.push(response.text);
      return response;
    };

    const before = byMethod((await call("GET", "/api/ai/connections")).json);
    for (const method of ["openai-key", "anthropic-key", "chatgpt", "claude"] as const) assert.equal("savedKey" in before[method], false, `${method}: nothing saved yet`);

    const first = await call("PUT", "/api/ai/connections/keys/openai", { key: OPENAI_GOOD_2 });
    assert.equal(first.status, 200);
    const firstKey = { provider: "openai", hint: "\u2022\u2022\u2022\u2022Cd34", verifiedAt: "2026-11-10T01:00:00.000Z" };
    assert.deepEqual(first.json.savedKey, firstKey, "the PUT answer carries the row's new metadata");
    assert.deepEqual((await rows())["openai-key"].savedKey, firstKey);
    assert.deepEqual(await services.vault.get(AI_KEY_META_VAULT.openai), { hint: firstKey.hint, verifiedAt: firstKey.verifiedAt });

    clock = new Date("2026-11-10T02:00:00.000Z");
    assert.equal((await call("PUT", "/api/ai/connections/keys/openai", { key: OPENAI_BAD })).status, 422);
    assert.deepEqual((await rows())["openai-key"].savedKey, firstKey, "a refused replacement changes neither the hint nor verifiedAt");

    clock = new Date("2026-11-10T03:00:00.000Z");
    const replaced = await call("PUT", "/api/ai/connections/keys/openai", { key: OPENAI_GOOD });
    assert.deepEqual(replaced.json.savedKey, { provider: "openai", hint: "\u2022\u2022\u2022\u2022gggg", verifiedAt: "2026-11-10T03:00:00.000Z" }, "a replacement gets its own hint and verifiedAt");
    const anthropic = await call("PUT", "/api/ai/connections/keys/anthropic", { key: ANTHROPIC_GOOD });
    assert.deepEqual(anthropic.json.savedKey, { provider: "anthropic", hint: "\u2022\u2022\u2022\u2022gggg", verifiedAt: "2026-11-10T03:00:00.000Z" });
    const listed = await rows();
    assert.equal("savedKey" in listed.chatgpt || "savedKey" in listed.claude, false, "sign-in rows have no key");

    assert.equal((await call("DELETE", "/api/ai/connections/keys/openai", {})).status, 204);
    const removed = await rows();
    assert.equal(removed["openai-key"].state, "not_set");
    assert.equal("savedKey" in removed["openai-key"], false, "removing the key removes its metadata");
    assert.equal(await services.vault.has(AI_KEY_VAULT.openai), false);
    assert.equal(await services.vault.has(AI_KEY_META_VAULT.openai), false);
    assert.equal(removed["anthropic-key"].savedKey?.provider, "anthropic", "the other provider's key stays");

    clock = new Date("2026-11-10T04:00:00.000Z");
    const again = await call("PUT", "/api/ai/connections/keys/openai", { key: OPENAI_GOOD_2 });
    assert.equal(again.json.savedKey.verifiedAt, "2026-11-10T04:00:00.000Z", "saving the first key again is a new check, not the old time");

    seen.push((await call("GET", "/api/status")).text, (await call("GET", "/api/export?include=sources")).text);
    return seen;
  });

  for (const key of keys) {
    for (const [where, text] of [["responses", texts.join("\n")], ["logs", lines.join("")]]) {
      assert.ok(!text.includes(key), `${where} must not carry a whole key`);
      assert.ok(!text.includes(key.slice(-5)), `${where} must not carry more than the last 4 characters`);
      assert.ok(!text.includes(key.slice(8, 20)), `${where} must not carry the middle of a key`);
    }
  }
});

test("key metadata survives a restart; a key saved before it shows a hint read from the key and verifiedAt null", async (t) => {
  const first = await setup(t, fakeClis(), { seams: { now: () => new Date("2026-11-10T01:00:00.000Z") } });
  assert.equal((await first.server.call("PUT", "/api/ai/connections/keys/openai", { body: { key: OPENAI_GOOD_2 } })).status, 200);
  const saved = byMethod((await first.server.call("GET", "/api/ai/connections")).json)["openai-key"].savedKey;

  // A new server on the same secrets directory, like a restart.
  const { server, services } = await setup(t, fakeClis(), { env: { BELLPERSONAL_SECRETS_DIR: first.services.config.secretsDir } });
  const rows = async () => byMethod((await server.call("GET", "/api/ai/connections")).json);
  assert.deepEqual((await rows())["openai-key"].savedKey, saved);
  assert.deepEqual(saved, { provider: "openai", hint: "\u2022\u2022\u2022\u2022Cd34", verifiedAt: "2026-11-10T01:00:00.000Z" });

  // Saved before BELL kept metadata: only the key record, even one with its own verifiedAt.
  await services.vault.set(AI_KEY_VAULT.anthropic, { key: ANTHROPIC_GOOD, verifiedAt: "2026-11-01T00:00:00.000Z" });
  const legacy = (await rows())["anthropic-key"];
  assert.deepEqual([legacy.state, legacy.source], ["detected", "bell"]);
  assert.deepEqual(legacy.savedKey, { provider: "anthropic", hint: "\u2022\u2022\u2022\u2022gggg", verifiedAt: null });
  assert.equal(await services.vault.has(AI_KEY_META_VAULT.anthropic), false, "reading the list writes nothing");

  // Too short to show any of it (only a record written outside the API can be this short).
  await services.vault.delete(AI_KEY_META_VAULT.openai);
  await services.vault.set(AI_KEY_VAULT.openai, { key: "sk-1234" });
  assert.deepEqual((await rows())["openai-key"].savedKey, { provider: "openai", hint: null, verifiedAt: null });

  // Metadata that is not a hint and a time is ignored, so it can never show more than the key's last 4.
  await services.vault.set(AI_KEY_VAULT.openai, { key: OPENAI_GOOD_2, verifiedAt: "2026-11-01T00:00:00.000Z" });
  await services.vault.set(AI_KEY_META_VAULT.openai, { hint: OPENAI_GOOD_2, verifiedAt: "2026-11-10T01:00:00.000Z" });
  assert.deepEqual((await rows())["openai-key"].savedKey, { provider: "openai", hint: "\u2022\u2022\u2022\u2022Cd34", verifiedAt: null });
  await services.vault.set(AI_KEY_META_VAULT.openai, { hint: "\u2022\u2022\u2022\u2022Cd34", verifiedAt: "yesterday" });
  assert.equal((await rows())["openai-key"].savedKey?.verifiedAt, null);
});

test("a CLI's own API-key login is not a saved key: no hint", async (t) => {
  const { server } = await setup(t, fakeClis({ codex: "api_key", claude: "api_key" }));
  const rows = byMethod((await server.call("GET", "/api/ai/connections")).json);
  for (const method of ["openai-key", "anthropic-key"] as const) {
    assert.deepEqual([rows[method].state, rows[method].source], ["detected", "cli"]);
    assert.equal("savedKey" in rows[method], false);
  }
});

test("keyHint: the last 4 characters behind a mask, nothing for a key shorter than 8", () => {
  assert.equal(keyHint("sk-1234"), null);
  assert.equal(keyHint(""), null);
  assert.equal(keyHint("sk-12345"), "\u2022\u2022\u2022\u20222345");
  assert.equal(keyHint(OPENAI_GOOD_2), "\u2022\u2022\u2022\u2022Cd34");
  assert.equal(keyHint(OPENAI_GOOD_2)?.length, 8);
});

test("API keys need the master key; a key check already running refuses a second one", async (t) => {
  const clis = fakeClis();
  const { server } = await setup(t, clis, { env: { BELLPERSONAL_MASTER_KEY: "" } });
  const off = await server.call("PUT", "/api/ai/connections/keys/openai", { body: { key: OPENAI_GOOD } });
  assert.equal(off.status, 503);
  assert.match(off.json.error, /主金鑰/);
  assert.deepEqual((await server.call("GET", "/api/ai/connections")).json.vault, { enabled: false });

  let release: (() => void) | undefined;
  const slow = fakeClis();
  const runner: CommandRunner = async (executable, args, options) => {
    if (args[0] === "exec") await new Promise<void>((resolve) => { release = resolve; });
    return slow.runner(executable, args, options);
  };
  const busy = await setup(t, slow, { seams: { command: runner } });
  const first = busy.server.call("PUT", "/api/ai/connections/keys/openai", { body: { key: OPENAI_GOOD } });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(byMethod((await busy.server.call("GET", "/api/ai/connections")).json)["openai-key"].state, "pending");
  assert.equal((await busy.server.call("PUT", "/api/ai/connections/keys/openai", { body: { key: OPENAI_BAD } })).status, 409);
  release();
  assert.equal((await first).status, 200);
});

test("login output parsing: only https links on the provider's sign-in hosts, codes without colour", () => {
  assert.equal(loginUrl("   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m", "chatgpt"), "https://auth.openai.com/codex/device");
  assert.equal(loginUrl("\u001b]8;;https://auth.openai.com/codex/device\u0007link\u001b]8;;\u0007", "chatgpt"), undefined, "an OSC hyperlink target is not shown text");
  for (const line of ["http://auth.openai.com/codex/device", "https://auth.openai.com.evil.example/x", "https://user:pw@auth.openai.com/x", "https://auth.openai.com:8443/x", "https://claude.com/x"])
    assert.equal(loginUrl(line, "chatgpt"), undefined, line);
  assert.equal(loginUrl(`visit: ${CLAUDE_URL}.`, "claude"), CLAUDE_URL);
  assert.equal(loginUrl("https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback", "claude"), undefined, "the localhost callback only works on the server");
  assert.equal(loginUrl("https://auth.openai.com/codex/device", "claude"), undefined);
  assert.equal(deviceCode(`   \u001b[94m${DEVICE_CODE}\u001b[0m`), DEVICE_CODE);
  assert.equal(deviceCode("Welcome to Codex [v0.167.0]"), undefined);
});

test("key check classification follows what the CLIs print (Claude Code 2.1.321, codex-cli 0.167.0)", () => {
  const result = (stdout: string, code: number): CommandResult => ({ stdout, stderr: "", code });
  assert.equal(anthropicKeyCheck(result('{"type":"result","is_error":false,"result":"OK"}', 0)), "ok");
  assert.equal(anthropicKeyCheck(result('{"type":"result","is_error":true,"api_error_status":401,"result":"Invalid API key"}', 1)), "invalid");
  assert.equal(anthropicKeyCheck(result('{"type":"result","is_error":true,"api_error_status":429}', 1)), "quota");
  assert.equal(anthropicKeyCheck(result('{"type":"result","is_error":true,"api_error_status":529}', 1)), "unreachable");
  assert.equal(anthropicKeyCheck(result("not json", 1)), "unreachable");
  assert.equal(anthropicKeyCheck(result('{"type":"result","is_error":true}', 0)), "unreachable", "exit 0 alone is not success");
  assert.equal(openaiKeyCheck(result('{"type":"turn.completed"}', 0)), "ok");
  assert.equal(openaiKeyCheck(result('{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}', 1)), "invalid");
  assert.equal(openaiKeyCheck(result('{"type":"error","message":"insufficient_quota"}\n{"type":"turn.failed","error":{"message":"x"}}', 1)), "quota");
  assert.equal(openaiKeyCheck(result('{"type":"turn.failed","error":{"message":"stream disconnected"}}', 1)), "unreachable");
});

test("status keeps the kind of sign-in and the plan, never the email", () => {
  assert.deepEqual(claudeAccount('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"Max","email":"a@b.c"}'), { kind: "subscription", plan: "max" });
  assert.deepEqual(claudeAccount('{"loggedIn":true,"authMethod":"api_key"}'), { kind: "api_key" });
  assert.deepEqual(claudeAccount('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"<b>x</b>"}'), { kind: "subscription" });
  assert.equal(claudeAccount('{"loggedIn":false,"authMethod":"none"}'), undefined);
  assert.equal(claudeAccount("Logged in"), undefined);
  assert.deepEqual(codexAccount("\nLogged in using ChatGPT"), { kind: "subscription" });
  assert.deepEqual(codexAccount("API key configured - sk-proj-***"), { kind: "api_key" });
  assert.equal(codexAccount("Not logged in"), undefined);
});

test("PUT /api/ai/connections/active: only a ready method; the model settings follow its CLI", async (t) => {
  const clis = fakeClis({ claude: "max", codex: "api_key" });
  const catalog = { source: "codex" as const, models: [{ id: "gpt-test", name: "GPT Test", description: "", isDefault: true, reasoningEfforts: ["low" as const], defaultReasoningEffort: "low" as const }] };
  const { server, services } = await setup(t, clis, { seams: { loadCodexCatalog: async () => catalog } });
  const active = async () => (await server.call("GET", "/api/ai/connections")).json.active;
  assert.equal(await active(), null, "not chosen: whatever the CLIs are signed in with, as before");

  for (const [method, reason, message] of [["chatgpt", "wrong_login", /API 金鑰登入，不是 ChatGPT 帳號/], ["anthropic-key", "key_missing", /還沒有可用的金鑰/]] as const) {
    const refused = await server.call("PUT", "/api/ai/connections/active", { body: { method } });
    assert.equal(refused.status, 409, `${method} is not ready`);
    assert.match(refused.json.error, message);
    assert.deepEqual([refused.json.code, refused.json.method, refused.json.reason], ["ai_connection_not_ready", method, reason]);
  }
  for (const body of [{ method: "gemini" }, { method: "claude", extra: true }, {}])
    assert.equal((await server.call("PUT", "/api/ai/connections/active", { body })).status, 400, JSON.stringify(body));
  assert.equal(await active(), null);

  // The stored row says Claude; picking an OpenAI connection moves every job to Codex.
  const picked = await server.call("PUT", "/api/ai/connections/active", { body: { method: "openai-key" } });
  assert.equal(picked.status, 200);
  assert.equal(picked.json.active, "openai-key");
  assert.equal(services.settings.value("ai.connection"), "openai-key");
  const provider = (await server.call("GET", "/api/settings/provider")).json;
  assert.deepEqual([provider.settings.provider, provider.settings.model, provider.connection], ["codex", "", "openai-key"]);
  assert.equal(services.provider.settings().provider, "codex");
  const other = await server.call("PUT", "/api/settings/provider", { body: { provider: "claude" } });
  assert.equal(other.status, 409);
  assert.match(other.json.error, /設定 › 連接 AI/);
  assert.equal((await server.call("PUT", "/api/settings/provider", { body: { model: "gpt-test" } })).json.settings.model, "gpt-test", "a model on the connection's CLI is fine");

  assert.equal((await server.call("PUT", "/api/ai/connections/active", { body: { method: "claude" } })).json.active, "claude");
  assert.deepEqual([services.provider.settings().provider, services.provider.settings().model], ["claude", ""], "the other CLI's stored model does not carry over");
  assert.equal((await server.call("PUT", "/api/ai/connections/active", { body: { method: null } })).json.active, null);
  assert.equal(services.provider.settings().provider, "codex", "back to the stored row");
  assert.deepEqual(logins(clis), [], "picking a connection never signs anything in or out");
});

test("PUT /api/settings/app: a new ai.connection is checked like PUT /active, and a refused patch writes nothing", async (t) => {
  const clis = fakeClis({ claude: "max", installed: { codex: false } });
  const { server, services } = await setup(t, clis);
  const put = (body: unknown) => server.call("PUT", "/api/settings/app", { body });

  for (const [method, reason] of [["chatgpt", "cli_not_installed"], ["openai-key", "cli_not_installed"], ["anthropic-key", "key_missing"]] as const) {
    const refused = await put({ "ai.connection": method, "ai.ideaTags": true });
    assert.equal(refused.status, 409, method);
    assert.deepEqual([refused.json.code, refused.json.method, refused.json.reason], ["ai_connection_not_ready", method, reason]);
    assert.equal(typeof refused.json.error, "string");
  }
  assert.deepEqual([services.settings.value("ai.connection"), services.settings.value("ai.ideaTags")], [null, false], "the other key in a refused patch is not written either");
  assert.equal((await put({ "ai.connection": "gemini" })).status, 400);

  const picked = await put({ "ai.connection": "claude", "ai.ideaTags": true });
  assert.equal(picked.status, 200);
  assert.deepEqual([picked.json["ai.connection"], picked.json["ai.ideaTags"]], ["claude", true]);
  assert.equal(services.provider.settings().provider, "claude", "the model settings follow, as with PUT /active");

  // Signed out later (or on another device): saving the form again with the same value is not a new choice.
  clis.state.claude = false;
  const resaved = await put({ "ai.connection": "claude", "ai.ideaTags": false });
  assert.equal(resaved.status, 200);
  assert.equal(resaved.json["ai.ideaTags"], false);
  const status = (await server.call("GET", "/api/ai/connections")).json as AiConnectionsResponse;
  assert.equal(status.activeStatus?.ready, false);
  assert.deepEqual(status.activeStatus && !status.activeStatus.ready ? [status.activeStatus.method, status.activeStatus.reason] : [], ["claude", "not_signed_in"]);
  assert.match((status.activeStatus as { message: string }).message, /還沒有登入/);

  const cleared = await put({ "ai.connection": null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json["ai.connection"], null, "clearing is always allowed");
  assert.equal((await server.call("GET", "/api/ai/connections")).json.activeStatus, null);
  assert.deepEqual(logins(clis), []);
});

test("only one sign-in runs at a time: a second method gets 409 and starts no CLI until the first ends", async (t) => {
  const clis = fakeClis();
  const { server } = await setup(t, clis);
  assert.equal((await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} })).status, 200);
  const other = await server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  assert.equal(other.status, 409);
  assert.match(other.json.error, /ChatGPT 的登入還在進行中/);
  assert.equal(logins(clis).length, 1, "no Claude sign-in process");
  assert.equal(byMethod((await server.call("GET", "/api/ai/connections")).json).claude.state, "not_set", "a refusal is not a failed attempt");
  assert.equal((await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} })).status, 200, "the same method still rejoins");

  assert.equal((await server.call("DELETE", "/api/ai/connections/chatgpt/login", { body: {} })).status, 204);
  const claude = await server.call("POST", "/api/ai/connections/claude/login", { body: {} });
  assert.equal(claude.status, 200, claude.text);
  assert.equal(claude.json.prompt.kind, "paste_code");
  assert.equal((await server.call("POST", "/api/ai/connections/chatgpt/login", { body: {} })).status, 409, "and the other way round");
  assert.equal(logins(clis).length, 2);
});

test("shutdown waits for a sign-in CLI that ignores SIGTERM: it is killed, not orphaned", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bell-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "fake-cli");
  const pidFile = join(dir, "login.pid");
  // Both CLIs: not signed in; `codex login --device-auth` prints its code, then ignores SIGTERM and waits.
  writeFileSync(cli, `#!/usr/bin/env node
const { writeFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2).join(" ");
if (args === "--version") { console.log("codex-cli 0.167.0"); process.exit(0); }
if (args === "login status" || args === "auth status") { console.error("Not logged in"); process.exit(1); }
if (args === "login --device-auth") {
  process.on("SIGTERM", () => appendFileSync(${JSON.stringify(join(dir, "sigterm"))}, "ignored\\n"));
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  console.error("1. Open this link in your browser and sign in to your account");
  console.error("   https://auth.openai.com/codex/device");
  console.error("2. Enter this one-time code (expires in 15 minutes)");
  console.error("   ${DEVICE_CODE}");
  setInterval(() => {}, 1000);
} else process.exit(2);
`);
  chmodSync(cli, 0o755);
  const services = testServices(t, { env: { CODEX_CLI_PATH: cli, CLAUDE_CLI_PATH: cli, GH_CLI_PATH: cli }, seams: { command, statusCacheMs: 0 } });
  const prompt = await services.aiConnections.startLogin("chatgpt");
  assert.equal(prompt.prompt?.kind, "device_code");
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
  assert.doesNotThrow(() => process.kill(pid, 0), "the sign-in CLI is running");

  await services.close();
  assert.equal(readFileSync(join(dir, "sigterm"), "utf8"), "ignored\n", "it really ignored SIGTERM");
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH", "gone once close() resolves");
  await services.close();
});
