import test from "node:test";
import assert from "node:assert/strict";
import type { QueueCandidate, TodayContribution, TodayPayload } from "../../../shared/today.js";
import { buildToday } from "../../../shared/today-logic.js";
import { deadlineWhen, queueAction } from "../../../shared/today-format.js";
import { AI_KEY_VAULT, type StoredAiKey } from "../../ai/connection-runtime.js";
import { AppError, SchemaValidationError, TransientAgentError } from "../../errors.js";
import type { FeatureModule } from "../../modules.js";
import { Vault } from "../../secrets/vault.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices, type RecordedCall } from "../../test-helpers.js";
import { BriefRejectedError, briefData, checkBriefText, fallbackReason, knownRefs } from "./generate.js";
import { briefModule } from "./index.js";
import { BriefScheduler } from "./scheduler.js";
import { BriefService } from "./service.js";
import { BriefStore } from "./store.js";

const TZ = "Asia/Taipei";
const taipei = (local: string) => new Date(`${local}:00+08:00`).toISOString();
/** Monday 2026-10-12 08:42 in Taipei (the mockup morning). */
const MORNING = new Date(taipei("2026-10-12T08:42"));

/* ------------------------------------------------------------ fixtures */

function row(id: string, kind: QueueCandidate["kind"], title: string, hints: QueueCandidate["hints"], extra: Partial<QueueCandidate> = {}): QueueCandidate {
  const [source] = id.split(":");
  return { id, kind, source: source as QueueCandidate["source"], title, meta: ["m"], actions: [queueAction("open"), queueAction("snooze")], hints, ...extra };
}

/** The mockup day: the professor's mail, HW3 due tonight, three events and the 15:30 slot. */
const mockupDay: TodayContribution = {
  queue: [
    row("gmail:lin", "mail.reply", "Re: OS 期末專題題目討論", { important: true, receivedAt: taipei("2026-10-12T08:05") }),
    row("moodle:30512", "assignment", "作業系統 HW3：CPU Scheduling 模擬", { dueAt: taipei("2026-10-12T23:59"), hardDeadline: true },
      { when: deadlineWhen(taipei("2026-10-12T23:59"), MORNING, TZ) }),
    row("github:127", "review", "審查 #127 新增議程頁深色模式", { receivedAt: taipei("2026-10-11T12:00") }),
  ],
  agenda: [
    { start: taipei("2026-10-12T10:10"), end: taipei("2026-10-12T12:00"), title: "作業系統", meta: "工程三館 EC115", kind: "event" },
    { start: taipei("2026-10-12T14:00"), end: taipei("2026-10-12T15:30"), title: "OS 讀書會 · Ch.5", meta: "浩然圖書館", kind: "event" },
    { start: taipei("2026-10-12T19:30"), end: taipei("2026-10-12T20:30"), title: "健身", meta: "光復校區 體育館", kind: "event" },
    { start: taipei("2026-10-12T23:59"), title: "HW3 截止", meta: "作業系統 · NYCU E3", kind: "due", itemId: "moodle:30512" },
  ],
  gapCandidates: [{ itemId: "moodle:30512", label: "適合寫 HW3", dueAt: taipei("2026-10-12T23:59") }],
};

const build = (contributions: TodayContribution[], now = MORNING, ai = true) =>
  buildToday({ now, timeZone: TZ, contributions, states: new Map(), handledLog: [], sources: [], ai: { enabled: ai, briefTime: "06:30" } }).payload;

/** A module serving fixed contributions (the rest of the day around the brief). */
const dayModule = (contribution: TodayContribution): FeatureModule => ({ name: "day", setup: () => ({ today: () => contribution }) });

/** The recorded Claude Code stream with `answer` as the structured output. */
function stream(answer: unknown): string {
  return claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = answer; copy.result = JSON.stringify(answer); }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
}

async function briefServer(t: test.TestContext, options: { answer?: (call: RecordedCall) => unknown; loggedIn?: boolean; contribution?: TodayContribution; now?: Date; clock?: () => Date } = {}) {
  const calls: RecordedCall[] = [];
  const fake = fakeCommand(async (call) => {
    calls.push(call);
    if (call.args.join(" ") === "auth status") return options.loggedIn === false ? undefined : "{}";
    if (call.args[0] !== "-p") return undefined;
    const answer = await options.answer?.(call);
    if (answer && typeof answer === "object" && "rawStream" in answer) return (answer as { rawStream: string }).rawStream;
    return answer === undefined ? undefined : stream(answer);
  });
  const services = testServices(t, { seams: { command: fake.runner, now: () => options.clock?.() ?? options.now ?? MORNING } });
  const app = await startTestServer(t, services, { modules: [dayModule(options.contribution ?? mockupDay), briefModule] });
  const today = async () => (await app.call("GET", "/api/today")).json as TodayPayload;
  const settle = async () => { for (const job of services.jobs.running("daily-brief")) await services.jobs.settled(job.id); };
  const modelCalls = () => calls.filter((call) => call.args[0] === "-p");
  return { ...app, today, settle, modelCalls };
}

const lines = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line));

/* ---------------------------------------------------------- rule brief */

test("the rule brief names replies, the nearest deadline, the first event and the free slot", () => {
  const payload = build([mockupDay]);
  assert.equal(payload.brief.text, "1 封信待回覆，1 項作業今晚 23:59 截止。第一個行程是 10:10 作業系統，15:30 後有 4 小時空檔。");
  assert.equal(payload.brief.source, "rule");
  assert.equal(payload.brief.state, "fallback");

  // Later in the day: the past event and the deadline are gone from the sentence.
  const evening = build([mockupDay], new Date(taipei("2026-10-12T20:45")));
  assert.equal(evening.brief.text, "1 封信待回覆，1 項作業今晚 23:59 截止。");

  // An assignment due tomorrow morning (within 24 h) and two replies, no events.
  const morning = build([{ queue: [
    row("gmail:a", "mail.reply", "A", { receivedAt: taipei("2026-10-12T07:00") }),
    row("gmail:b", "mail.reply", "B", { receivedAt: taipei("2026-10-12T07:30") }),
    row("canvas:1", "assignment", "Lab", { dueAt: taipei("2026-10-13T08:00"), hardDeadline: true }),
    row("canvas:2", "assignment", "Essay", { dueAt: taipei("2026-10-14T23:59"), hardDeadline: true }),
  ] }]);
  assert.equal(morning.brief.text, "2 封信待回覆，1 項作業明天 08:00 截止。", "only deadlines within 24 h count");
});

test("an empty day says so and points at the next event", () => {
  const saturday = new Date(taipei("2026-10-17T08:00"));
  const payload = build([{ later: { events: [{ start: taipei("2026-10-19T09:00"), title: "計算機網路", meta: "工程三館 EC122 · Google 行事曆" }] } }], saturday, false);
  assert.equal(payload.brief.text, "沒有到期的作業，也沒有行程。下一個是 10/19（一）09:00 計算機網路。");
  assert.equal(payload.brief.state, "off");
  assert.equal(build([], saturday).brief.text, "沒有到期的作業，也沒有行程。");
});

test("the brief module's state decides between the AI text and the rule brief", () => {
  const rule = build([mockupDay]).brief.text;
  const ready = build([mockupDay, { brief: { state: "ready", text: "先回林教授的信。", generatedAt: taipei("2026-10-12T06:30") } }]);
  assert.deepEqual([ready.brief.state, ready.brief.source, ready.brief.text, ready.brief.next], ["ready", "ai", "先回林教授的信。", "06:30"]);
  const generating = build([mockupDay, { brief: { state: "generating" } }]);
  assert.deepEqual([generating.brief.state, generating.brief.text], ["generating", rule]);
  const failed = build([mockupDay, { brief: { state: "fallback", reason: "Claude 尚未登入" } }]);
  assert.deepEqual([failed.brief.state, failed.brief.reason, failed.brief.text], ["fallback", "Claude 尚未登入", rule]);
  const off = build([mockupDay, { brief: { state: "ready", text: "x" } }], MORNING, false);
  assert.deepEqual([off.brief.state, off.brief.text], ["off", rule]);
});

/* ------------------------------------------------------- AI generation */

test("the model sees the compacted day and its answer must keep to the brief contract", () => {
  const payload = build([mockupDay]);
  const data = briefData(payload, TZ);
  assert.equal(data.date, "10/12（一）");
  assert.equal(data.now, "08:42");
  assert.deepEqual(data.queue.map((item) => [item.id, item.ref, item.group]), [
    ["moodle:30512", "assignment", "最重要"], ["gmail:lin", "mail", "最重要"], ["github:127", "github", "今天內"],
  ]);
  assert.deepEqual(data.agenda.map((item) => ("start" in item ? item.start : "")), ["10:10", "14:00", "19:30", "23:59"]);
  assert.deepEqual(data.gap, { start: "15:30", hours: 4, label: "適合寫 HW3", forItemId: "moodle:30512" });
  assert.deepEqual(data.counts, { open: 3, handled: 0, inboxUnread: 0, habitsLeft: 0 });

  // A secret-looking row never reaches the model.
  const leaky = briefData(build([{ queue: [row("gmail:x", "mail.action", `token ghp_${"a".repeat(36)}`, {})] }]), TZ);
  assert.equal(leaky.queue.length, 0);

  assert.equal(checkBriefText("  先回林教授的專題信，再把 OS HW3 收尾。 ", payload), "先回林教授的專題信，再把 OS HW3 收尾。");
  assert.equal(checkBriefText("3 件事裡先回 1 封信。", payload), "3 件事裡先回 1 封信。");
  assert.throws(() => checkBriefText("先回信。再寫 HW3。然後讀書會。", payload), (error: unknown) => error instanceof BriefRejectedError && error.rule === "sentences");
  assert.throws(() => checkBriefText("字".repeat(81), payload), (error: unknown) => error instanceof BriefRejectedError && error.rule === "length");
  assert.throws(() => checkBriefText("還有 5 封信待回覆。", payload), (error: unknown) => error instanceof BriefRejectedError && error.rule === "numbers");

  assert.deepEqual(knownRefs([{ kind: "event", id: "gmail:lin" }, { kind: "todo", id: "native:ghost" }, { kind: "mail", id: "gmail:lin" }], data), [{ kind: "mail", id: "gmail:lin" }]);

  assert.equal(fallbackReason(new AppError(503, "x"), "claude"), "Claude 尚未登入");
  assert.equal(fallbackReason(new AppError(503, "x"), "codex"), "Codex 尚未登入");
  assert.equal(fallbackReason(new AppError(504, "x"), "claude"), "產生逾時");
  assert.equal(fallbackReason(new BriefRejectedError("numbers"), "claude"), "回應格式不正確");
  assert.equal(fallbackReason(new AppError(429, "x"), "claude"), "額度已達上限", "a usage or rate limit is not a format problem");
  assert.equal(fallbackReason(new TransientAgentError("x"), "claude"), "暫時無法連線", "a login refresh race is not a missing login");
  assert.equal(fallbackReason(new AppError(502, "每日摘要未完成：模型沒有完成回覆，請稍後再試。"), "claude"), "暫時無法連線");
  assert.equal(fallbackReason(new SchemaValidationError("x", "每日摘要", []), "claude"), "回應格式不正確");
});

test("a usage limit says so, and the next open after half an hour retries once", async (t) => {
  let now = MORNING;
  let limited = true;
  const usageLimit = claudeFixtureEvents().map((event) => JSON.stringify(event.type === "result" ? { type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached" } : event)).join("\n");
  const app = await briefServer(t, { clock: () => now, answer: () => (limited ? { rawStream: usageLimit } : { text: "先回林教授的專題信。", refs: [] }) });
  assert.equal((await app.today()).brief.state, "generating");
  await app.settle();
  const failed = await app.today();
  assert.deepEqual([failed.brief.state, failed.brief.reason], ["fallback", "額度已達上限"]);
  assert.equal((await app.today()).brief.state, "fallback", "not retried at once");
  limited = false;
  now = new Date(MORNING.getTime() + 31 * 60_000);
  assert.equal((await app.today()).brief.state, "generating", "retried once the limit may have reset");
  await app.settle();
  assert.equal((await app.today()).brief.state, "ready");
  assert.equal(app.modelCalls().length, 2);
});

test("POST /api/brief/refresh streams the job and Today shows the AI brief", async (t) => {
  const answer = { text: "先回林教授的專題信，再把 OS HW3 收尾，今晚 23:59 截止。15:30 後有 4 小時空檔。", refs: [{ kind: "mail", id: "gmail:lin" }, { kind: "assignment", id: "moodle:30512" }, { kind: "event", id: "made-up" }] };
  const app = await briefServer(t, { answer: () => answer });
  app.services.settings.update({ "brief.onFirstOpen": false });

  const before = await app.today();
  assert.equal(before.brief.state, "fallback");
  assert.equal(before.brief.reason, undefined, "nothing failed yet");
  assert.equal(app.modelCalls().length, 0, "first open is off");

  const response = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-type"]), /ndjson/);
  const events = lines(response.text);
  assert.equal(events[0].type, "job");
  assert.ok(events.some((event) => event.type === "stage"));
  assert.deepEqual(events.at(-1), { type: "done", result: { day: "2026-10-12", source: "ai" } });

  const [call] = app.modelCalls();
  const input = call.options.input!;
  assert.match(input, /任務角色：每日摘要/);
  assert.match(input, /"id":"moodle:30512"/);
  assert.match(input, /"start":"15:30","hours":4/);

  const after = await app.today();
  assert.deepEqual([after.brief.state, after.brief.source, after.brief.text], ["ready", "ai", answer.text]);
  assert.equal(after.brief.generatedAt, MORNING.toISOString());
  const stored = new BriefStore(app.services).get("2026-10-12");
  assert.deepEqual(stored?.refs, [{ kind: "mail", id: "gmail:lin" }, { kind: "assignment", id: "moodle:30512" }]);
  assert.equal(stored?.modelExecution?.provider, "claude");
});

test("the first open of the day generates the brief once and shows generating meanwhile", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const app = await briefServer(t, { answer: async () => { await gate; return { text: "先回林教授的專題信。", refs: [] }; } });

  const first = await app.today();
  assert.equal(first.brief.state, "generating");
  assert.equal(first.brief.text, build([mockupDay]).brief.text, "the rule brief stands in");
  assert.equal((await app.today()).brief.state, "generating");
  const busy = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(busy.status, 429);
  assert.match(busy.json.error, /正在整理中/);

  release();
  await app.settle();
  const ready = await app.today();
  assert.deepEqual([ready.brief.state, ready.brief.text], ["ready", "先回林教授的專題信。"]);
  assert.equal(app.modelCalls().length, 1, "one generation per day");
});

test("a failed generation falls back to the rule brief with its reason, once per day", async (t) => {
  const app = await briefServer(t, { loggedIn: false });
  assert.equal((await app.today()).brief.state, "generating");
  await app.settle();
  const failed = await app.today();
  assert.deepEqual([failed.brief.state, failed.brief.source, failed.brief.reason], ["fallback", "rule", "Claude 尚未登入"]);
  assert.equal(failed.brief.text, build([mockupDay]).brief.text);
  // Not retried on every open.
  assert.equal((await app.today()).brief.state, "fallback");
  assert.equal(app.services.jobs.running("daily-brief").length, 0);
  const status = (await app.call("GET", "/api/status")).json;
  assert.deepEqual(status.modules.brief, { day: "2026-10-12", state: "fallback", reason: "Claude 尚未登入", generatedAt: MORNING.toISOString(), autoTime: "06:30" });

  // 重試 says why before any stream starts.
  const retry = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(retry.status, 503);
  assert.match(retry.json.error, /Claude 尚未登入/);
});

test("an answer that breaks the contract is refused; a later failure keeps a good brief", async (t) => {
  let answer: unknown = { text: "還有 5 封信待回覆，先回林教授。", refs: [] };
  const app = await briefServer(t, { answer: () => answer });
  app.services.settings.update({ "brief.onFirstOpen": false });

  const rejected = lines((await app.call("POST", "/api/brief/refresh", { body: {} })).text).at(-1);
  assert.equal(rejected.type, "error");
  assert.match(rejected.message, /不符合格式/);
  assert.deepEqual([(await app.today()).brief.state, (await app.today()).brief.reason], ["fallback", "回應格式不正確"]);

  answer = { text: "先回林教授的專題信。", refs: [] };
  assert.equal(lines((await app.call("POST", "/api/brief/refresh", { body: {} })).text).at(-1).type, "done");
  assert.equal((await app.today()).brief.state, "ready");

  answer = { text: "先回信，", unexpected: true };
  assert.equal(lines((await app.call("POST", "/api/brief/refresh", { body: {} })).text).at(-1).type, "error");
  const kept = await app.today();
  assert.deepEqual([kept.brief.state, kept.brief.text], ["ready", "先回林教授的專題信。"]);
});

test("with AI off the brief is off: no generation, refresh refused", async (t) => {
  const app = await briefServer(t, { answer: () => ({ text: "x", refs: [] }) });
  app.services.settings.update({ "ai.enabled": false });
  const today = await app.today();
  assert.deepEqual([today.brief.state, today.brief.source, today.brief.next], ["off", "rule", undefined]);
  const refused = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(refused.status, 503);
  assert.match(refused.json.error, /關閉 AI/);
  assert.equal(refused.json.code, undefined);
  assert.equal(app.modelCalls().length, 0);
  assert.equal((await app.call("POST", "/api/brief/refresh", { body: { force: true } })).status, 400);
});

test("POST /api/brief/refresh attaches structured 503 details for unready connections, ENOENT CLIs, expired auth, and streamed saved-key refusals without leaking sk-* secrets", async (t) => {
  const anthropicCanary = `sk-ant-api03-${"BriefKeySecret4".repeat(3)}`;
  const openaiCanary = `sk-proj-${"BriefOpenAiSecret8".repeat(3)}`;
  const cliState: {
    claudeInstalled: boolean;
    codexInstalled: boolean;
    claudeAuth: "subscription" | "api_key" | "signed_out" | "enoent";
    codexAuth: "subscription" | "api_key" | "signed_out" | "enoent";
    turnError?: string;
  } = {
    claudeInstalled: true,
    codexInstalled: true,
    claudeAuth: "signed_out",
    codexAuth: "signed_out",
  };

  const fake = fakeCommand(async (call) => {
    const cli = call.executable.includes("codex") ? "codex" : call.executable.includes("claude") ? "claude" : "other";
    if (cli === "other") return undefined;
    const args = call.args.join(" ");
    if (args === "--version") {
      return (cli === "claude" ? cliState.claudeInstalled : cliState.codexInstalled) ? "1.0.0" : undefined;
    }
    if (cli === "claude" && args === "auth status") {
      if (!cliState.claudeInstalled) return undefined;
      if (cliState.claudeAuth === "enoent") throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      if (cliState.claudeAuth === "signed_out") return { stdout: "", stderr: "Not logged in", code: 1 };
      return JSON.stringify(cliState.claudeAuth === "subscription" ? { loggedIn: true, authMethod: "claude.ai" } : { loggedIn: true, authMethod: "api_key" });
    }
    if (cli === "codex" && args === "login status") {
      if (!cliState.codexInstalled) return undefined;
      if (cliState.codexAuth === "enoent") throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      if (cliState.codexAuth === "signed_out") return { stdout: "", stderr: "Not logged in", code: 1 };
      return { stdout: "", stderr: cliState.codexAuth === "subscription" ? "Logged in using ChatGPT" : `API key configured - sk-proj-***`, code: 0 };
    }
    if (cli === "claude" && call.args[0] === "-p") {
      if (cliState.turnError) {
        return claudeFixtureEvents().map((event) =>
          JSON.stringify(event.type === "result" ? { type: "result", subtype: "error_during_execution", is_error: true, result: cliState.turnError } : event),
        ).join("\n");
      }
      return stream({ text: "先回林教授的專題信。", refs: [] });
    }
    return undefined;
  });

  const services = testServices(t, {
    seams: {
      command: fake.runner,
      now: () => MORNING,
      loadCodexCatalog: async () => ({
        source: "codex",
        models: [{ id: "gpt-5.5", name: "GPT-5.5", description: "Test", isDefault: true, reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "low" }],
      }),
    },
  });
  services.settings.update({ "brief.onFirstOpen": false });
  const app = await startTestServer(t, services, { modules: [dayModule(mockupDay), briefModule] });

  // 1. No active connection (ai.connection === null): auth-check failure -> ai_auth_expired (method omitted)
  cliState.claudeInstalled = true;
  cliState.claudeAuth = "signed_out";
  const claudeAuthFailed = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(claudeAuthFailed.status, 503);
  assert.deepEqual(claudeAuthFailed.json, {
    error: "Claude 尚未登入：請在伺服器的終端機執行 claude auth login。",
    code: "ai_auth_expired",
    provider: "claude",
  });

  services.provider.invalidate();
  cliState.codexAuth = "subscription";
  await services.provider.update({ provider: "codex" });
  cliState.codexAuth = "signed_out";
  const codexAuthFailed = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(codexAuthFailed.status, 503);
  assert.deepEqual(codexAuthFailed.json, {
    error: "Codex 尚未登入：請在伺服器的終端機執行 codex login。",
    code: "ai_auth_expired",
    provider: "codex",
  });

  // 2. No active connection: ENOENT / 503 spawn failure -> ai_cli_unavailable
  cliState.codexAuth = "enoent";
  const codexEnoent = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(codexEnoent.status, 503);
  assert.deepEqual(codexEnoent.json, {
    error: "Codex 尚未登入：請在伺服器的終端機執行 codex login。",
    code: "ai_cli_unavailable",
    provider: "codex",
  });

  await services.provider.update({ provider: "claude" });
  cliState.claudeInstalled = false;
  const claudeMissing = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(claudeMissing.status, 503);
  assert.deepEqual(claudeMissing.json, {
    error: "Claude 尚未登入：請在伺服器的終端機執行 claude auth login。",
    code: "ai_cli_unavailable",
    provider: "claude",
  });

  // 3. Unready active AI connections -> ai_connection_not_ready ({ method, reason })
  const unreadyCases = [
    {
      method: "chatgpt" as const,
      setup: async () => { cliState.codexInstalled = true; cliState.codexAuth = "signed_out"; },
      reason: "not_signed_in" as const,
    },
    {
      method: "chatgpt" as const,
      setup: async () => { cliState.codexInstalled = true; cliState.codexAuth = "api_key"; },
      reason: "wrong_login" as const,
    },
    {
      method: "chatgpt" as const,
      setup: async () => { cliState.codexInstalled = false; cliState.codexAuth = "signed_out"; },
      reason: "cli_not_installed" as const,
    },
    {
      method: "claude" as const,
      setup: async () => { cliState.claudeInstalled = true; cliState.claudeAuth = "api_key"; },
      reason: "wrong_login" as const,
    },
    {
      method: "openai-key" as const,
      setup: async () => { cliState.codexInstalled = true; cliState.codexAuth = "signed_out"; },
      reason: "key_missing" as const,
    },
    {
      method: "openai-key" as const,
      setup: async () => {
        cliState.codexInstalled = true;
        cliState.codexAuth = "signed_out";
        const otherVault = new Vault({ directory: services.config.secretsDir, key: Buffer.alloc(32, 9), now: () => MORNING });
        await otherVault.set(AI_KEY_VAULT.openai, { key: openaiCanary, verifiedAt: MORNING.toISOString() } satisfies StoredAiKey);
      },
      reason: "key_unreadable" as const,
    },
    {
      method: "anthropic-key" as const,
      setup: async () => { cliState.claudeInstalled = true; cliState.claudeAuth = "signed_out"; },
      reason: "key_missing" as const,
    },
  ];

  for (const item of unreadyCases) {
    await item.setup();
    services.status.invalidate();
    services.settings.update({ "ai.connection": item.method });
    const res = await app.call("POST", "/api/brief/refresh", { body: {} });
    assert.equal(res.status, 503, `${item.method}:${item.reason}`);
    assert.equal(res.json.code, "ai_connection_not_ready");
    assert.equal(res.json.method, item.method);
    assert.equal(res.json.reason, item.reason);
    assert.equal(typeof res.json.error, "string");
    assert.ok(res.json.error.length > 0);
  }
  await services.vault.delete(AI_KEY_VAULT.openai);

  // Also check vault_disabled on a server without a master key
  const keylessServices = testServices(t, {
    env: { BELLPERSONAL_MASTER_KEY: "" },
    seams: { command: fake.runner, now: () => MORNING },
  });
  keylessServices.settings.update({ "brief.onFirstOpen": false, "ai.connection": "openai-key" });
  cliState.codexInstalled = true;
  cliState.codexAuth = "signed_out";
  const keylessApp = await startTestServer(t, keylessServices, { modules: [dayModule(mockupDay), briefModule] });
  const vaultDisabled = await keylessApp.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(vaultDisabled.status, 503);
  assert.equal(vaultDisabled.json.code, "ai_connection_not_ready");
  assert.equal(vaultDisabled.json.method, "openai-key");
  assert.equal(vaultDisabled.json.reason, "vault_disabled");

  // 4. Cached ready active connection whose live CLI auth check then fails -> ai_auth_expired with method
  cliState.claudeInstalled = true;
  cliState.claudeAuth = "subscription";
  services.status.invalidate();
  services.settings.update({ "ai.connection": "claude" });
  const warmStatus = await services.aiConnections.activeStatus();
  assert.deepEqual(warmStatus, { method: "claude", ready: true, source: "cli" });
  // CLI session expires inside StatusService's 10s probe window before POST /api/brief/refresh runs loginCheck:
  cliState.claudeAuth = "signed_out";
  const expiredWithMethod = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(expiredWithMethod.status, 503);
  assert.deepEqual(expiredWithMethod.json, {
    error: "Claude 尚未登入：請在伺服器的終端機執行 claude auth login。",
    code: "ai_auth_expired",
    provider: "claude",
    method: "claude",
  });

  // 5. Saved API key (source === "bell") passes loginCheck without shared CLI auth, and forwards ai_key_invalid in stream + JobView without leaking sk-*
  await services.vault.set(AI_KEY_VAULT.anthropic, { key: anthropicCanary, verifiedAt: MORNING.toISOString() } satisfies StoredAiKey);
  cliState.claudeInstalled = true;
  cliState.claudeAuth = "signed_out";
  cliState.turnError = `401 Invalid API key · ${anthropicCanary}`;
  services.status.invalidate();
  services.settings.update({ "ai.connection": "anthropic-key" });

  const streamed = await app.call("POST", "/api/brief/refresh", { body: {} });
  assert.equal(streamed.status, 200);
  const streamedEvents = lines(streamed.text);
  assert.equal(streamedEvents[0].type, "job");
  const jobId = streamedEvents[0].id as string;
  assert.deepEqual(streamedEvents.at(-1), {
    type: "error",
    message: "每日摘要未完成：Anthropic 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。",
    detail: { code: "ai_key_invalid", provider: "anthropic", method: "anthropic-key" },
  });

  const jobRes = await app.call("GET", `/api/jobs/${jobId}`);
  assert.equal(jobRes.status, 200);
  assert.equal(jobRes.json.status, "failed");
  assert.deepEqual(jobRes.json.errorDetail, { code: "ai_key_invalid", provider: "anthropic", method: "anthropic-key" });

  const payload = JSON.stringify({ stream: streamed.text, job: jobRes.json, today: await app.call("GET", "/api/today") });
  for (const piece of [anthropicCanary, openaiCanary, anthropicCanary.slice(0, 14), openaiCanary.slice(0, 12), "sk-ant-", "sk-proj-"]) {
    assert.equal(payload.includes(piece), false, `canary piece leaked: ${piece}`);
  }
});

/* ----------------------------------------------------------- scheduler */

test("the 06:30 scheduler runs once a day after the local time, and catches up after a restart", () => {
  let now = new Date(taipei("2026-10-12T06:29"));
  let briefed = false;
  const runs: string[] = [];
  const settings = { "ai.enabled": true, "brief.autoTime": "06:30" };
  const scheduler = new BriefScheduler({
    now: () => now, timeZone: TZ, settings: () => settings,
    needsRun: () => !briefed,
    run: () => { runs.push(now.toISOString()); briefed = true; },
  });
  assert.equal(scheduler.tick(), false, "06:29 is too early");
  now = new Date(taipei("2026-10-12T06:30"));
  assert.equal(scheduler.tick(), true);
  assert.equal(scheduler.tick(), false, "once a day");
  now = new Date(taipei("2026-10-12T22:00"));
  assert.equal(scheduler.tick(), false);
  // Midnight in Taipei is 16:00 UTC: the next local day starts the cycle again.
  briefed = false;
  now = new Date("2026-10-12T22:31:00.000Z"); // 06:31 on 10/13 local
  assert.equal(scheduler.tick(), true);
  assert.deepEqual(runs, [taipei("2026-10-12T06:30"), "2026-10-12T22:31:00.000Z"]);

  // A server that was down at 06:30 catches up on its first check.
  const restarted = new BriefScheduler({ now: () => new Date(taipei("2026-10-14T09:15")), timeZone: TZ, settings: () => settings, needsRun: () => true, run: () => runs.push("catch-up") });
  assert.equal(restarted.tick(), true);
  // Already briefed today (first open at 05:00): nothing to do.
  const briefedEarly = new BriefScheduler({ now: () => new Date(taipei("2026-10-14T06:31")), timeZone: TZ, settings: () => settings, needsRun: () => false, run: () => runs.push("x") });
  assert.equal(briefedEarly.tick(), false);
  // AI off: never; a different time is honoured.
  const off = new BriefScheduler({ now: () => new Date(taipei("2026-10-14T09:00")), timeZone: TZ, settings: () => ({ "ai.enabled": false, "brief.autoTime": "06:30" }), needsRun: () => true, run: () => runs.push("x") });
  assert.equal(off.tick(), false);
  const late = new BriefScheduler({ now: () => new Date(taipei("2026-10-14T07:00")), timeZone: TZ, settings: () => ({ "ai.enabled": true, "brief.autoTime": "07:30" }), needsRun: () => true, run: () => runs.push("x") });
  assert.equal(late.tick(), false);
  assert.equal(late.autoAt("2026-10-14").toISOString(), taipei("2026-10-14T07:30"));
  // A throwing check never escapes the timer.
  const broken = new BriefScheduler({ now: () => MORNING, timeZone: TZ, settings: () => { throw new Error("closed"); }, needsRun: () => true, run: () => runs.push("x") });
  assert.equal(broken.tick(), false);
  assert.deepEqual(runs.slice(2), ["catch-up"]);
});

test("the scheduler's timers check at boot and every interval", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let checks = 0;
  const scheduler = new BriefScheduler({
    now: () => MORNING, timeZone: TZ, settings: () => ({ "ai.enabled": true, "brief.autoTime": "06:30" }),
    needsRun: () => { checks++; return false; }, run: () => {}, intervalMs: 60_000, bootDelayMs: 15_000,
  });
  scheduler.start();
  t.mock.timers.tick(14_999);
  assert.equal(checks, 0);
  t.mock.timers.tick(1);
  assert.equal(checks, 1, "the catch-up check after boot");
  t.mock.timers.tick(60_000);
  assert.equal(checks, 1, "the day is settled after one look");
  scheduler.close();
});

test("the service answers the scheduler: an AI brief or a failure after 06:30 settles the day", async (t) => {
  const services = testServices(t, { seams: { now: () => MORNING } });
  const store = new BriefStore(services);
  const service = new BriefService(services, store, { aggregate: async () => build([mockupDay]) });
  const at = new Date(taipei("2026-10-12T06:30"));
  assert.equal(service.needsRun("2026-10-12", at), true);
  store.put({ day: "2026-10-12", source: "rule", text: "", generatedAt: taipei("2026-10-12T05:10"), failure: "產生逾時" });
  assert.equal(service.needsRun("2026-10-12", at), true, "a failure from before 06:30 is retried at 06:30");
  store.put({ day: "2026-10-12", source: "rule", text: "", generatedAt: taipei("2026-10-12T06:31"), failure: "產生逾時" });
  assert.equal(service.needsRun("2026-10-12", at), false);
  store.put({ day: "2026-10-12", source: "ai", text: "先回信。", generatedAt: taipei("2026-10-12T05:10") });
  assert.equal(service.needsRun("2026-10-12", at), false);
});

test("stored briefs follow the mail retention window", (t) => {
  const services = testServices(t);
  const store = new BriefStore(services);
  store.put({ day: "2026-08-01", source: "ai", text: "舊摘要", generatedAt: "2026-08-01T00:00:00.000Z" });
  store.put({ day: "2026-10-12", source: "ai", text: "今天", generatedAt: "2026-10-12T00:00:00.000Z" });
  assert.equal(store.prune("2026-09-12"), 1);
  assert.equal(store.get("2026-08-01"), undefined);
  assert.ok(store.get("2026-10-12"));
});
