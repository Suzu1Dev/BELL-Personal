import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import type { CaptureParseResult, CaptureResponse, CaptureSearchResponse } from "../../../shared/connect.js";
import type { Idea } from "../../../shared/ideas.js";
import type { AiSuggestion, EventSuggestion } from "../../../shared/suggestions.js";
import type { Todo } from "../../../shared/todos.js";
import { AppError } from "../../errors.js";
import type { FeatureModule } from "../../modules.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices, type RecordedCall } from "../../test-helpers.js";
import { ideasModule } from "../ideas/index.js";
import { todosModule } from "../todos/index.js";
import { captureModule } from "./index.js";
import { optionFromAnswer, startParseJob } from "./parse-job.js";
import { whenPhrase } from "./create.js";

const taipei = (local: string) => new Date(`${local}:00+08:00`);
const NOW = taipei("2026-10-12T08:42");

function claudeStream(answer: unknown): string {
  return claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = answer; copy.result = JSON.stringify(answer); }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
}

function setup(t: test.TestContext, respond?: (call: RecordedCall) => string | undefined | Promise<string | undefined>) {
  const fake = fakeCommand((call) => {
    if (call.args.join(" ") === "auth status") return "{}";
    if (call.executable === "claude" && respond) return respond(call);
    return undefined;
  });
  const services = testServices(t, { seams: { now: () => NOW, command: fake.runner, sleep: async () => {} } });
  return { services, calls: fake.calls };
}

/** A stand-in for the calendar-events team's module: acceptSuggestion.event records what capture sent. */
function calendarStub(received: Array<{ suggestion: AiSuggestion; body: unknown }>, options: { fail?: boolean; undoPath?: string } = {}): FeatureModule {
  return {
    name: "calendar",
    setup() {
      return {
        acceptSuggestion: {
          event: (suggestion, _ctx, body) => {
            if (options.fail) throw new AppError(502, "Google 行事曆沒有回應。");
            received.push({ suggestion, body });
            return { resultId: "evt-1", result: { id: "evt-1", ...(options.undoPath ? { undoPath: options.undoPath } : {}) } };
          },
        },
      };
    },
  };
}

const modules = (extra: FeatureModule[] = []) => [...extra, todosModule, ideasModule, captureModule];

test("capture a todo: the rule parser decides, 復原 deletes it through undoPath", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  const created = await server.call("POST", "/api/capture", { body: { text: "明天 9:00 交報告" } });
  assert.equal(created.status, 201);
  const body = created.json as CaptureResponse;
  assert.equal(body.type, "todo");
  assert.equal(body.message, "已加入待辦「交報告」· 明天 09:00");
  assert.equal(body.undoPath, `/api/todos/${body.id}`);
  const todo = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.equal(todo.title, "交報告");
  assert.equal(todo.dueDay, "2026-10-13");
  assert.equal(todo.dueTime, "09:00");
  assert.equal(todo.origin, "quick-capture");
  const undone = await server.call("DELETE", body.undoPath, { body: {} });
  assert.equal(undone.status, 200);
  assert.equal((await server.call("GET", `/api/todos/${body.id}`)).status, 404);
});

test("capture with explicit fields: a date-only due, an estimate, the type switched to 靈感", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  const dateOnly = (await server.call("POST", "/api/capture", {
    body: { text: "週五前 繳電費", type: "todo", title: "繳中華電信帳單", due: taipei("2026-10-16T23:59").toISOString(), allDay: true, estimateMinutes: 10 },
  })).json as CaptureResponse;
  assert.equal(dateOnly.message, "已加入待辦「繳中華電信帳單」· 10/16（五）");
  const todo = (await server.call("GET", `/api/todos/${dateOnly.id}`)).json as Todo;
  assert.equal(todo.dueDay, "2026-10-16");
  assert.equal(todo.dueTime, undefined);
  assert.equal(todo.estimateMinutes, 10);

  const asIdea = (await server.call("POST", "/api/capture", { body: { text: "明天 9:00 交報告", type: "idea" } })).json as CaptureResponse;
  assert.equal(asIdea.type, "idea");
  assert.equal(asIdea.message, "已記下靈感");
  assert.equal(asIdea.undoPath, `/api/ideas/${asIdea.id}`);
  assert.equal(((await server.call("GET", `/api/ideas/${asIdea.id}`)).json as Idea).text, "明天 9:00 交報告");

  const noDue = (await server.call("POST", "/api/capture", { body: { text: "買 USB-C 轉接頭 #宿舍" } })).json as CaptureResponse;
  assert.equal(noDue.message, "已加入待辦「買 USB-C 轉接頭」");
  assert.equal(((await server.call("GET", `/api/todos/${noDue.id}`)).json as Todo).notes, "#宿舍");
});

test("capture an idea from 靈感： keeps its #tags", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  const body = (await server.call("POST", "/api/capture", { body: { text: "靈感：做一個 CTF 練習平台 #CTF" } })).json as CaptureResponse;
  assert.equal(body.type, "idea");
  const idea = (await server.call("GET", `/api/ideas/${body.id}`)).json as Idea;
  assert.equal(idea.text, "做一個 CTF 練習平台");
  assert.deepEqual(idea.tags, ["CTF"]);
  assert.equal(idea.origin, "quick-capture");
});

test("capture an event through the calendar module's event acceptor", async (t) => {
  const { services } = setup(t);
  const received: Array<{ suggestion: AiSuggestion; body: unknown }> = [];
  const server = await startTestServer(t, services, { modules: modules([calendarStub(received)]) });
  const created = await server.call("POST", "/api/capture", { body: { text: "明天下午三點 跟教授 meeting @工程三館" } });
  assert.equal(created.status, 201);
  const body = created.json as CaptureResponse;
  assert.deepEqual(body, { type: "event", id: "evt-1", message: "已加入行事曆「跟教授 meeting」· 明天 15:00", undoPath: "/api/calendar/events/evt-1" });
  assert.equal(received.length, 1);
  const payload = received[0].suggestion.payload as EventSuggestion;
  assert.deepEqual(payload, { title: "跟教授 meeting", start: taipei("2026-10-13T15:00").toISOString(), end: taipei("2026-10-13T16:00").toISOString(), allDay: false, location: "工程三館" });
  // The sentence goes along so the event keeps it (自動整理 and 整理 read it).
  assert.deepEqual(received[0].body, { via: "capture", originalText: "明天下午三點 跟教授 meeting @工程三館" });
  const record = services.suggestions.get(received[0].suggestion.id)!;
  assert.equal(record.status, "accepted");
  assert.equal(record.resultId, "evt-1");
  assert.equal(record.origin, "快速記下");
  // Not left as a pending 「從信件找到」 row on Today.
  assert.equal(services.suggestions.list({ status: "pending" }).length, 0);
});

test("an event acceptor may name its own undo path; failures leave no pending suggestion", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules([calendarStub([], { undoPath: "/api/calendar/manual/evt-1" })]) });
  const body = (await server.call("POST", "/api/capture", { body: { text: "10/25 SITCON 秋季交流會", type: "event" } })).json as CaptureResponse;
  assert.equal(body.undoPath, "/api/calendar/manual/evt-1");
  assert.equal(body.message, "已加入行事曆「SITCON 秋季交流會」· 10/25（日）");

  const { services: failing } = setup(t);
  const broken = await startTestServer(t, failing, { modules: modules([calendarStub([], { fail: true })]) });
  const refused = await broken.call("POST", "/api/capture", { body: { text: "明天 10:00 開會" } });
  assert.equal(refused.status, 502);
  assert.equal(failing.suggestions.list({ status: "pending" }).length, 0);
});

test("without a calendar module an event capture is 501 and creates nothing", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  const response = await server.call("POST", "/api/capture", { body: { text: "明天 10:00 開會" } });
  assert.equal(response.status, 501);
  assert.equal(services.suggestions.list().length, 0);
});

test("capture validation", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  assert.equal((await server.call("POST", "/api/capture", { body: { text: "   " } })).status, 400);
  assert.equal((await server.call("POST", "/api/capture", { body: { text: "x".repeat(501) } })).status, 400);
  assert.equal((await server.call("POST", "/api/capture", { body: { text: "x", type: "meeting" } })).status, 400);
  assert.equal((await server.call("POST", "/api/capture", { body: { text: "x", due: "next week" } })).status, 400);
  assert.equal((await server.call("POST", "/api/capture", { body: { text: "x", suggestionId: "missing" } })).status, 404);
});

test("AI parse: off → 503; on → a quick-capture suggestion the user confirms once", async (t) => {
  const answer = { type: "event", title: "跟林教授討論期末專題提案", date: "2026-10-14", time: "10:00", endTime: null, location: "工程三館", basis: "週三 meeting 前" };
  const { services, calls } = setup(t, () => claudeStream(answer));
  const received: Array<{ suggestion: AiSuggestion; body: unknown }> = [];
  const server = await startTestServer(t, services, { modules: modules([calendarStub(received)]) });
  services.settings.update({ "ai.enabled": false });
  assert.equal((await server.call("POST", "/api/capture/parse", { body: { text: "週三 meeting 前 跟教授 聊提案" } })).status, 503);
  services.settings.update({ "ai.enabled": true });

  const job = await server.call("POST", "/api/capture/parse", { body: { text: "週三 meeting 前 跟教授 聊提案" } });
  assert.equal(job.status, 200);
  const done = job.text.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.equal(done.type, "done");
  const result = done.result as CaptureParseResult;
  assert.deepEqual(result.option, {
    type: "event", title: "跟林教授討論期末專題提案", start: taipei("2026-10-14T10:00").toISOString(), end: taipei("2026-10-14T11:00").toISOString(),
    allDay: false, location: "工程三館", basis: "週三 meeting 前",
  });
  const prompt = calls.find((call) => call.args.includes("-p"))!.options.input!;
  assert.match(prompt, /任務角色：快速記下解析/);
  assert.match(prompt, /"today":"2026-10-12"/);
  assert.match(prompt, /"weekday":"週一"/);
  const suggestion = services.suggestions.get(result.suggestionId)!;
  assert.equal(suggestion.kind, "quick-capture");
  assert.equal(suggestion.status, "pending");

  const confirm = { text: "週三 meeting 前 跟教授 聊提案", type: result.option.type, title: result.option.title, start: result.option.start, end: result.option.end, allDay: false, location: result.option.location, suggestionId: result.suggestionId };
  const created = await server.call("POST", "/api/capture", { body: confirm });
  assert.equal(created.status, 201);
  assert.equal(created.json.message, "已加入行事曆「跟林教授討論期末專題提案」· 10/14（三）10:00");
  assert.equal(services.suggestions.get(result.suggestionId)!.status, "accepted");
  assert.equal(services.suggestions.get(result.suggestionId)!.resultId, "evt-1");
  assert.equal((await server.call("POST", "/api/capture", { body: confirm })).status, 409);
});

/** A CLI that answers after `ms` and honours command()'s timeout, like the real runner. */
function slowCli(ms: number, answer: unknown) {
  return (call: RecordedCall) => new Promise<string | undefined>((resolve, reject) => {
    const answerTimer = setTimeout(() => resolve(claudeStream(answer)), ms);
    const deadline = setTimeout(() => { clearTimeout(answerTimer); reject(new AppError(504, "claude 執行逾時。")); }, call.options.timeoutMs ?? 60_000);
    call.options.signal?.addEventListener("abort", () => { clearTimeout(answerTimer); clearTimeout(deadline); reject(new AppError(409, "工作已取消。")); }, { once: true });
  });
}

const PARSE_ANSWER = { type: "todo", title: "跟教授聊提案", date: null, time: null, endTime: null, location: null, basis: null };

test("AI parse gives up after its deadline with 產生逾時", async (t) => {
  const { services } = setup(t, slowCli(500, PARSE_ANSWER));
  const job = startParseJob(services, "下週找時間跟教授聊提案", 60);
  await services.jobs.settled(job.id);
  const view = services.jobs.get(job.id)!;
  assert.equal(view.status, "failed");
  assert.equal(view.error, "產生逾時");
});

test("AI parse: time queued behind other model work does not count against its deadline, and it goes first", async (t) => {
  const { services } = setup(t, slowCli(40, PARSE_ANSWER));
  const triage = await services.slots.acquire();
  let backgroundRan = false;
  const background = services.slots.acquire().then((release) => { backgroundRan = true; return release; });
  const job = startParseJob(services, "下週找時間跟教授聊提案", 150);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(services.slots.waiting, 2, "the parse waits for the slot, behind nothing but the running call");
  triage();
  await services.jobs.settled(job.id);
  assert.equal(services.jobs.get(job.id)!.status, "done", services.jobs.get(job.id)!.error);
  assert.equal(backgroundRan, true);
  (await background)();
});

test("AI parse: a newer parse cancels the older one still running", async (t) => {
  const { services } = setup(t, slowCli(200, PARSE_ANSWER));
  const first = startParseJob(services, "下週找時間跟教授聊", 5_000);
  const second = startParseJob(services, "下週找時間跟教授聊提案", 5_000);
  await Promise.all([services.jobs.settled(first.id), services.jobs.settled(second.id)]);
  assert.equal(services.jobs.get(first.id)!.status, "cancelled");
  assert.equal(services.jobs.get(second.id)!.status, "done");
});

test("AI parse: a request the palette aborts stops its job, before or after the job line", async (t) => {
  const { services } = setup(t, slowCli(5_000, PARSE_ANSWER));
  const server = await startTestServer(t, services, { modules: modules() });
  const body = JSON.stringify({ text: "下週找時間跟教授聊提案" });
  /** POST /api/capture/parse and drop the connection when `when` happens (fetch's abort does the same). */
  const abortedParse = (when: "response" | "data") => new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/api/capture/parse", headers: { host: "127.0.0.1:4331", "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      if (when === "response") { req.destroy(); resolve(); return; }
      res.once("data", () => { req.destroy(); resolve(); });
    });
    req.on("error", (error) => { if (!req.destroyed) reject(error); });
    req.end(body);
  });

  for (const when of ["response", "data"] as const) {
    await abortedParse(when);
    const job = services.jobs.list().find((view) => view.kind === "quick-capture" && view.status === "running") ?? services.jobs.list()[0];
    await Promise.race([services.jobs.settled(job.id), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    assert.equal(services.jobs.get(job.id)!.status, "cancelled", `aborted on ${when}: the job stops instead of holding the agent slot`);
  }
  assert.equal(services.slots.waiting, 0);
  assert.deepEqual(services.suggestions.list({ kind: "quick-capture" }), [], "no pending suggestion is left behind");

  // A parse whose request stays open still finishes.
  const { services: quick } = setup(t, () => claudeStream(PARSE_ANSWER));
  const kept = await startTestServer(t, quick, { modules: modules() });
  const done = await kept.call("POST", "/api/capture/parse", { body: { text: "下週找時間跟教授聊提案" } });
  assert.equal(done.text.trim().split("\n").map((line) => JSON.parse(line)).at(-1).type, "done");
  assert.equal(quick.jobs.list()[0].status, "done");
});

test("optionFromAnswer: todos, all-day events, ideas and the event → todo fallback", () => {
  const base = { location: null, basis: null, endTime: null };
  assert.deepEqual(optionFromAnswer({ ...base, type: "todo", title: "繳電費", date: "2026-10-16", time: null }, "Asia/Taipei", "2026-10-12"),
    { type: "todo", title: "繳電費", due: taipei("2026-10-16T23:59").toISOString(), allDay: true });
  assert.deepEqual(optionFromAnswer({ ...base, type: "event", title: "g0v 大松", date: "2026-10-24", time: null }, "Asia/Taipei", "2026-10-12"),
    { type: "event", title: "g0v 大松", start: "2026-10-24", end: "2026-10-25", allDay: true });
  assert.deepEqual(optionFromAnswer({ ...base, type: "event", title: "聊提案", date: null, time: null }, "Asia/Taipei", "2026-10-12"),
    { type: "todo", title: "聊提案", allDay: false });
  assert.deepEqual(optionFromAnswer({ ...base, type: "event", title: "晚場", date: "2026-10-12", time: "23:00", endTime: "01:00" }, "Asia/Taipei", "2026-10-12"),
    { type: "event", title: "晚場", start: taipei("2026-10-12T23:00").toISOString(), end: taipei("2026-10-13T01:00").toISOString(), allDay: false });
  assert.deepEqual(optionFromAnswer({ ...base, type: "idea", title: "CTF 平台", date: "2026-10-12", time: null, basis: "  " }, "Asia/Taipei", "2026-10-12"),
    { type: "idea", title: "CTF 平台", allDay: false });
});

test("search finds todos, ideas and projects", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  await server.call("POST", "/api/todos", { body: { title: "整理 OS 期末專題提案", dueDay: "2026-10-14" } });
  await server.call("POST", "/api/ideas", { body: { text: "用 eBPF 量 CFS 排程延遲，當期末專題", tags: ["OS"] } });
  const stamp = NOW.toISOString();
  services.db.personal.db.prepare("INSERT INTO projects (id, json, updated_at, status, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("os-final", JSON.stringify({ id: "os-final", name: "OS 期末專題", color: "task", status: "active", progress: 20, milestones: [], createdAt: stamp, updatedAt: stamp }), stamp, "active", stamp);
  services.db.personal.db.prepare("INSERT INTO projects (id, json, updated_at, status, created_at) VALUES (?, ?, ?, ?, ?)").run("broken", "{", stamp, "active", stamp);

  const results = ((await server.call("GET", `/api/capture/search?q=${encodeURIComponent("期末專題")}`)).json as CaptureSearchResponse).results;
  assert.deepEqual(results.map((result) => [result.kind, result.title]), [
    ["todo", "整理 OS 期末專題提案"], ["idea", "用 eBPF 量 CFS 排程延遲，當期末專題"], ["project", "OS 期末專題"],
  ]);
  assert.equal(results[0].dueDay, "2026-10-14");
  assert.match(results[0].href, /^#\/tasks\?focus=/);
  assert.equal(results[2].href, "#/work/projects/os-final");
  assert.equal(results[2].pct, 20);
  assert.deepEqual(((await server.call("GET", "/api/capture/search?q=%20")).json as CaptureSearchResponse).results, []);

  // 初次設定 › 你是…: ⌘K finds no project when the roles hide 專案 (students and developers have it).
  const kinds = async () => ((await server.call("GET", `/api/capture/search?q=${encodeURIComponent("期末專題")}`)).json as CaptureSearchResponse).results.map((result) => result.kind);
  for (const [roles, expected] of [[["ctf"], ["todo", "idea"]], [[], ["todo", "idea"]], [["student"], ["todo", "idea", "project"]], [["developer"], ["todo", "idea", "project"]]] as const) {
    assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": roles } })).status, 200);
    assert.deepEqual(await kinds(), expected, JSON.stringify(roles));
  }
  // A manual switch wins: 專案 on for a CTF 選手, off for a student.
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["ctf"], "features.overrides": { projects: true } } })).status, 200);
  assert.deepEqual(await kinds(), ["todo", "idea", "project"]);
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["student"], "features.overrides": { projects: false } } })).status, 200);
  assert.deepEqual(await kinds(), ["todo", "idea"]);
});

test("GET /api/status tells the capture UI whether AI parse is on and where events go", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: modules() });
  assert.deepEqual((await server.call("GET", "/api/status")).json.modules.capture, { aiParse: true, eventTarget: "local" });
  services.settings.update({ "ai.enabled": false });
  assert.deepEqual((await server.call("GET", "/api/status")).json.modules.capture, { aiParse: false, eventTarget: "local" });
});

test("AI parse is not offered while the selected CLI is not signed in", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  const server = await startTestServer(t, services, { modules: modules() });
  assert.deepEqual((await server.call("GET", "/api/status")).json.modules.capture, { aiParse: false, eventTarget: "local" });
});

test("whenPhrase: today, tomorrow, later dates and all-day", () => {
  assert.equal(whenPhrase(taipei("2026-10-12T14:00").toISOString(), false, NOW, "Asia/Taipei"), "今天 14:00");
  assert.equal(whenPhrase("2026-10-13", true, NOW, "Asia/Taipei"), "明天");
  assert.equal(whenPhrase(taipei("2026-10-25T13:30").toISOString(), false, NOW, "Asia/Taipei"), "10/25（日）13:30");
});
