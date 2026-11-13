import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeFixtureEvents as fixtureEvents, tempDir } from "../test-helpers.js";
import { agentCommand, agentEventReader, agentLoginCheck, applyReportedModel, claudeInitViolation, retryTransientAuth, type AgentEvent } from "./agent-cli.js";
import { claudeEnvironment } from "./process.js";
import type { ModelExecution } from "../../shared/models.js";

test("Claude Code gets the exact tool-less, schema-bound argv (verified on this host)", async (t) => {
  const directory = tempDir(t);
  const schemaPath = path.join(directory, "response-schema.json");
  const schema = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}';
  await writeFile(schemaPath, schema);
  const command = await agentCommand(
    { provider: "claude", model: "sonnet", reasoningEffort: "low", source: "selected" },
    { cwd: directory, outputSchema: schemaPath, executable: "/home/u/.local/bin/claude" },
  );
  assert.equal(command.executable, "/home/u/.local/bin/claude");
  assert.deepEqual(command.args, [
    "-p", "--safe-mode",
    "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--strict-mcp-config",
    "--setting-sources", "user",
    "--disable-slash-commands",
    "--model", "sonnet",
    "--effort", "low",
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--json-schema", schema,
  ]);
  assert.ok(!command.args.includes("--bare"), "--bare would ignore the subscription login");
  const fallback = await agentCommand({ provider: "claude", source: "cli-default" }, { cwd: directory, outputSchema: schemaPath });
  assert.equal(fallback.executable, "claude");
  assert.ok(!fallback.args.includes("--model"));
  assert.ok(!fallback.args.includes("--effort"));
  await assert.rejects(agentCommand({ provider: "claude", model: "--dangerously", source: "selected" }, { cwd: directory, outputSchema: schemaPath }));
  await assert.rejects(agentCommand({ provider: "codex", source: "cli-default" }, { cwd: directory, outputSchema: schemaPath }));
  assert.deepEqual(agentLoginCheck("claude"), { executable: "claude", args: ["auth", "status"] });
  assert.deepEqual(agentLoginCheck("codex", "/bin/codex"), { executable: "/bin/codex", args: ["login", "status"] });
});

test("the CLI environment is an allow-list: no API key, no BELLPERSONAL values", () => {
  const env = claudeEnvironment({ HOME: "/home/u", PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant", BELLPERSONAL_MASTER_KEY: "k", CLAUDECODE: "1", LANG: "C.UTF-8" });
  assert.deepEqual(env, { HOME: "/home/u", PATH: "/bin", LANG: "C.UTF-8", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
});

test("the recorded stream yields the session, usage and the structured answer, and passes isolation", () => {
  const read = agentEventReader();
  const events = fixtureEvents().flatMap((event) => read(event));
  const kinds = events.map((event) => event.kind);
  assert.ok(!kinds.includes("tool"), "StructuredOutput is the expected way --json-schema answers");
  assert.ok(!kinds.includes("error"));
  assert.deepEqual(events.find((event) => event.kind === "session"), { kind: "session", model: "claude-sonnet-5-5", cliVersion: "2.1.292" });
  assert.deepEqual(events.find((event) => event.kind === "final"), { kind: "final", text: '{"ok":true}' });
  assert.ok(events.some((event) => event.kind === "usage"));
  const execution: ModelExecution = { provider: "claude", model: "sonnet", source: "selected" };
  for (const event of events) applyReportedModel(execution, event);
  assert.equal(execution.reported?.model, "claude-sonnet-5-5");
  assert.deepEqual(execution.reported?.modelsUsed, ["claude-sonnet-5-5"]);
});

test("an init event with real tools, MCP servers, skills or user plugins is an isolation failure", () => {
  const init = fixtureEvents().find((event) => event.subtype === "init")!;
  assert.equal(claudeInitViolation(init), undefined);
  assert.equal(claudeInitViolation({ ...init, tools: ["StructuredOutput", "Bash"] }), "tools");
  assert.equal(claudeInitViolation({ ...init, mcp_servers: [{ name: "gmail" }] }), "mcp_servers");
  assert.equal(claudeInitViolation({ ...init, skills: ["x"] }), "skills");
  assert.equal(claudeInitViolation({ ...init, slash_commands: ["/x"] }), "slash_commands");
  assert.equal(claudeInitViolation({ ...init, plugins: [{ name: "mine", path: "/home/u/.claude/plugins/mine", source: "mine@local" }] }), "plugins");
  assert.equal(claudeInitViolation({ ...init, permissionMode: "acceptEdits" }), "permissionMode");
  const read = agentEventReader();
  assert.deepEqual(read({ ...init, tools: ["Bash"] }).at(-1), { kind: "error", terminal: true, message: "isolation:tools" });
  const toolUse = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat ~/.ssh/id_rsa" } }] } };
  assert.deepEqual(read(toolUse), [{ kind: "tool", name: "Bash" }]);
  assert.deepEqual(read({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] } }), [{ kind: "tool", name: "tool_result" }]);
});

test("a lost OAuth refresh race is retryable and retried after 15 s, then 45 s", async () => {
  const read = agentEventReader();
  const [failure] = read({ type: "result", subtype: "error_during_execution", is_error: true, result: "Failed to refresh OAuth token" });
  assert.deepEqual(failure, { kind: "error", terminal: true, message: "Failed to refresh OAuth token", retryable: true });
  const waits: number[] = [];
  const notices: string[] = [];
  let attempts = 0;
  const result = await retryTransientAuth(async () => ({ retryable: ++attempts < 3 }), {
    signal: new AbortController().signal,
    sleep: async (ms) => { waits.push(ms); },
    onRetry: (notice) => notices.push(notice),
  });
  assert.deepEqual(result, { retryable: false });
  assert.deepEqual(waits, [15_000, 45_000]);
  assert.match(notices[0], /第 2\/3 次/);
  const rateLimit = read({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", utilization: 1 } }) as AgentEvent[];
  assert.match((rateLimit[0] as { message: string }).message, /已達上限/);
});

test("CLI text in notices and errors is masked, with the run's own key and any key-shaped echo", () => {
  const key = `sk-ant-api03-${"q".repeat(40)}`;
  const read = agentEventReader({ secrets: [key] });
  const retry = read({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, error: `authentication_error: invalid x-api-key ${key}`, retry_delay_ms: 1000 });
  const failure = read({ type: "result", subtype: "success", is_error: true, result: `Invalid API key · Fix external API key (${key.slice(0, 14)}…${key.slice(-6)})` });
  const quoted = read({ type: "result", subtype: "error_during_execution", errors: [`upstream refused ${key.slice(13, 30)}`] });
  const text = JSON.stringify([retry, failure, quoted]);
  for (const fragment of [key, key.slice(0, 14), key.slice(-6), key.slice(13, 30)]) assert.ok(!text.includes(fragment), fragment.slice(0, 4));
  assert.match((retry[0] as { message: string }).message, /^Claude Code 重試中（第 1\/3 次，原因 authentication_error: invalid x-api-key \[REDACTED\]，1 秒後重試）。$/);
  assert.equal((failure[0] as { message: string }).message, "Invalid API key · Fix external API key ([REDACTED])");
  // Without a key (a sign-in run) a key-shaped echo is still masked; isolation codes are left as they are.
  assert.equal((agentEventReader()({ type: "result", subtype: "success", is_error: true, result: "bad sk-proj-abc*****wxyz" })[0] as { message: string }).message, "bad [REDACTED]");
  const init = fixtureEvents().find((event) => event.subtype === "init")!;
  assert.deepEqual(read({ ...init, tools: ["Bash"] }).at(-1), { kind: "error", terminal: true, message: "isolation:tools" });
});
