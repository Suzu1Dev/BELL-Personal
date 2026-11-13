import assert from "node:assert/strict";
import test from "node:test";
import { parseCapture } from "../../../shared/capture-parse.js";
import type { ManualEvent } from "../../../shared/calendar.js";
import type { CaptureResponse, CaptureTidyResult, CaptureTidyStart, CaptureTidyUndoResponse } from "../../../shared/connect.js";
import type { Todo } from "../../../shared/todos.js";
import { AppError } from "../../errors.js";
import type { CoreServices } from "../../services.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices, type RecordedCall } from "../../test-helpers.js";
import { calendarModule } from "../calendar/index.js";
import { calendarService } from "../calendar/store.js";
import { connectGoogle, fakeNetwork } from "../calendar/testing.js";
import { ideasModule } from "../ideas/index.js";
import { todosModule } from "../todos/index.js";
import { todoStore } from "../todos/store.js";
import { captureModule } from "./index.js";
import { collectItems } from "../calendar/agenda.js";
import { inventedPart, judgeTidy, keepsKeyTerms, noteProblem, startTidy, tidyMessage, worthTidying, type TidyAnswer } from "./tidy.js";

const taipei = (local: string) => new Date(`${local}:00+08:00`);
/** Thursday 2026-10-15 10:00 in Taipei, the day of the user's report. */
const NOW = taipei("2026-10-15T10:00");
const TZ = "Asia/Taipei";
const REPORT = "Deep Hacking 簡報 要在周日前生出來，主題是 Windows Administrator Protection";
const RULE_TITLE = "Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection";

const TIDY: TidyAnswer = {
  title: "Deep Hacking 簡報", notes: ["主題：Windows Administrator Protection"],
  dueDay: "2026-10-18", dueTime: null, location: null, confidence: "high",
};

function claudeStream(answer: unknown): string {
  return claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = answer; copy.result = JSON.stringify(answer); }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
}

/** A CLI that answers after `ms` and stops when its signal aborts, like the real runner. */
function slowCli(ms: number, answer: unknown) {
  return (call: RecordedCall) => new Promise<string | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(claudeStream(answer)), ms);
    call.options.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new AppError(409, "工作已取消。")); }, { once: true });
  });
}

interface SetupOptions {
  respond?: (call: RecordedCall) => string | undefined | Promise<string | undefined>;
  loggedIn?: boolean;
  network?: ReturnType<typeof fakeNetwork>;
}

function setup(t: test.TestContext, options: SetupOptions = {}) {
  const fake = fakeCommand((call) => {
    if (call.args.join(" ") === "auth status") return options.loggedIn === false ? undefined : "{}";
    if (call.executable === "claude" && options.respond) return options.respond(call);
    return undefined;
  });
  const services = testServices(t, { seams: { now: () => NOW, command: fake.runner, sleep: async () => {}, ...(options.network ? { fetch: options.network.fetch } : {}) } });
  t.after(() => calendarService(services).dropPending());
  const modelCalls = () => fake.calls.filter((call) => call.args.includes("-p"));
  return { services, calls: fake.calls, modelCalls };
}

async function serve(t: test.TestContext, services: CoreServices) {
  return startTestServer(t, services, { modules: [calendarModule, todosModule, ideasModule, captureModule], today: { moduleTimeoutMs: 2_000, commitMs: 60_000 } });
}

const resultOf = (services: CoreServices, jobId: string) => services.jobs.get(jobId);

async function settle(services: CoreServices, start: CaptureTidyStart | undefined): Promise<CaptureTidyResult> {
  assert.ok(start, "a tidy started");
  await services.jobs.settled(start.jobId);
  const job = resultOf(services, start.jobId)!;
  assert.equal(job.status, "done", job.error);
  const events: unknown[] = [];
  services.jobs.follow(start.jobId, 0, (event) => events.push(event), () => {});
  const done = events.at(-1) as { type: string; result: CaptureTidyResult };
  assert.equal(done.type, "done");
  return done.result;
}

/* ------------------------------------------------------------------ pure checks */

const subject = { kind: "todo" as const, title: RULE_TITLE, notes: undefined, location: undefined, day: "2026-10-18", time: undefined, text: REPORT };
const rule = parseCapture(REPORT, { now: NOW, timeZone: TZ });

test("judgeTidy: the user's sentence becomes a short title with the topic as a note", () => {
  assert.deepEqual(judgeTidy(TIDY, subject, rule), {
    ok: true, title: "Deep Hacking 簡報", addedNotes: ["主題：Windows Administrator Protection"], notes: "主題：Windows Administrator Protection",
  });
  // The same when-part as the capture toast just before it (「已加入待辦「…」· 10/18（日）」).
  assert.equal(tidyMessage("Deep Hacking 簡報", "2026-10-18", undefined, NOW, TZ), "已整理成「Deep Hacking 簡報」· 10/18（日）");
  assert.equal(tidyMessage("交報告", "2026-10-16", "09:00", NOW, TZ), "已整理成「交報告」· 明天 09:00");
  assert.equal(tidyMessage("SITCON", "2026-10-25", "13:30", NOW, TZ), "已整理成「SITCON」· 10/25（日）13:30");
  assert.equal(tidyMessage("讀書", undefined, undefined, NOW, TZ), "已整理成「讀書」");
});

test("judgeTidy: a Chinese label in a note takes the full-width colon (seen from the real CLI)", () => {
  const verdict = judgeTidy({ ...TIDY, notes: ["主題:Windows Administrator Protection", "Note: Administrator Protection"] }, subject, rule);
  assert.deepEqual(verdict.ok && verdict.addedNotes, ["主題：Windows Administrator Protection", "Note: Administrator Protection"]);
});

test("judgeTidy: nothing to write when the answer equals the record or the model is unsure", () => {
  assert.deepEqual(judgeTidy({ ...TIDY, title: ` ${RULE_TITLE} `, notes: [] }, subject, rule), { ok: false, reason: "same", detail: "same" });
  // A note the record already has is not new.
  assert.equal(judgeTidy({ ...TIDY, title: "交報告", notes: ["#宿舍"] }, { ...subject, title: "交報告", text: "交報告 #宿舍", notes: "#宿舍" }, rule).ok, false);
  assert.deepEqual(judgeTidy({ ...TIDY, confidence: "low" }, subject, rule), { ok: false, reason: "unsure", detail: "confidence" });
});

test("judgeTidy: dates must be grounded in the rule parse or the record", () => {
  assert.equal(judgeTidy({ ...TIDY, dueDay: null }, subject, rule).ok, true, "no date is fine: the saved one stays");
  assert.deepEqual(judgeTidy({ ...TIDY, dueDay: "2026-10-20" }, subject, rule), { ok: false, reason: "rejected", detail: "dates" });
  assert.deepEqual(judgeTidy({ ...TIDY, dueTime: "09:00" }, subject, rule), { ok: false, reason: "rejected", detail: "dates" });
  // An older record whose title lost its date words: the saved day still grounds it.
  const older = { ...subject, title: "Deep Hacking 簡報 要在 生出來，主題是 Windows Administrator Protection", text: "Deep Hacking 簡報 要在 生出來，主題是 Windows Administrator Protection" };
  assert.equal(judgeTidy(TIDY, older, parseCapture(older.text, { now: NOW, timeZone: TZ })).ok, true);
});

test("judgeTidy: a title that drops every key word, an over-long title or an invented place is refused", () => {
  assert.deepEqual(judgeTidy({ ...TIDY, title: "準備報告" }, subject, rule), { ok: false, reason: "rejected", detail: "nouns" });
  assert.deepEqual(judgeTidy({ ...TIDY, title: `Deep Hacking ${"很長".repeat(40)}` }, subject, rule), { ok: false, reason: "rejected", detail: "length" });
  assert.equal(keepsKeyTerms("Deep Hacking 簡報", REPORT), true);
  assert.equal(keepsKeyTerms("windows 簡報", REPORT), true, "case-insensitive");
  assert.equal(keepsKeyTerms("其他事情", REPORT), false);
  const event = { kind: "event" as const, title: "跟教授 meeting 討論期末專題", notes: undefined, location: undefined, day: "2026-10-16", time: "15:00", text: "明天下午三點 跟教授 meeting 討論期末專題 在工程三館" };
  const answer = { ...TIDY, title: "跟教授討論期末專題", notes: [], dueDay: null, location: "工程三館" };
  assert.equal((judgeTidy(answer, event, { day: "2026-10-16", time: "15:00" }) as { location?: string }).location, "工程三館");
  assert.equal((judgeTidy({ ...answer, location: "台北 101" }, event, { day: "2026-10-16", time: "15:00" }) as { location?: string }).location, undefined, "a place not in the text is not added");
});

test("judgeTidy: a title of filler words only, or one that invents a subject, is refused", () => {
  // Every word of these is in the sentence, but none of them names the thing.
  for (const title of ["生出來", "主題是", "要在", "要在周日前", "Finish"]) assert.deepEqual(judgeTidy({ ...TIDY, title }, subject, rule), { ok: false, reason: "rejected", detail: "nouns" }, title);
  // Shares 'Windows' with the sentence but adds 更新, which the user never wrote.
  assert.deepEqual(judgeTidy({ ...TIDY, title: "Windows 更新" }, subject, rule), { ok: false, reason: "rejected", detail: "invented" });
  assert.equal(inventedPart("Windows 更新", REPORT), "更");
  assert.equal(inventedPart("Deep Hacking 的簡報", REPORT), undefined, "a joining 的 invents nothing");
  assert.equal(inventedPart("Deep Hacking 週日簡報", REPORT), undefined, "週 for the user's 周 is the same word");
  assert.equal(inventedPart("Deep Learning 簡報", REPORT), "learning");
  // Still fine: the expected answer, and a title that keeps more of the sentence.
  assert.equal(judgeTidy(TIDY, subject, rule).ok, true);
  assert.equal(judgeTidy({ ...TIDY, title: "Deep Hacking 簡報：Windows Administrator Protection", notes: [] }, subject, rule).ok, true);
});

test("judgeTidy: every note says only what the text says, and names no other date", () => {
  assert.deepEqual(judgeTidy({ ...TIDY, notes: ["截止：10/25"] }, subject, rule), { ok: false, reason: "rejected", detail: "dates" });
  assert.deepEqual(judgeTidy({ ...TIDY, notes: ["主題：Windows Administrator Protection", "備註：記得帶筆電去找教授"] }, subject, rule), { ok: false, reason: "rejected", detail: "notes" });
  assert.equal(noteProblem("截止：週日", REPORT), undefined, "a day the text names (周日) may be repeated");
  assert.equal(noteProblem("截止：週五", REPORT), "dates");
  assert.equal(noteProblem("時間：明天 9點", REPORT), "dates");
  assert.equal(noteProblem("主題：Windows Administrator Protection", REPORT), undefined, "the label is the model's, the value the user's");
  assert.equal(noteProblem("記得帶筆電", "明天下午三點 跟林教授 meeting 討論期末專題提案，記得帶筆電 @工程三館"), undefined);
  // Nothing was written: the saved due day stays the only date.
  assert.equal(judgeTidy({ ...TIDY, notes: ["截止：10/25", "主題：Windows Administrator Protection"] }, subject, rule).ok, false);
});

test("worthTidying: short, clean titles never cost a model call", () => {
  assert.equal(worthTidying("交報告"), false);
  assert.equal(worthTidying("跟教授 meeting"), false);
  assert.equal(worthTidying(RULE_TITLE), true);
  assert.equal(worthTidying("買牛奶，順便買蛋"), true);
});

/* ---------------------------------------------------------------- HTTP flow */

test("POST /api/capture → 自動整理 rewrites the todo in the background → 復原 restores the rule result", async (t) => {
  const { services, modelCalls } = setup(t, { respond: () => claudeStream(TIDY) });
  const server = await serve(t, services);
  const created = await server.call("POST", "/api/capture", { body: { text: REPORT } });
  assert.equal(created.status, 201, created.text);
  const body = created.json as CaptureResponse;
  // The save answers at once with the rule result; the tidy runs behind it.
  assert.equal(body.message, `已加入待辦「${RULE_TITLE}」· 10/18（日）`);
  assert.deepEqual({ kind: body.tidy?.kind, id: body.tidy?.id }, { kind: "todo", id: body.id });

  const result = await settle(services, body.tidy);
  assert.equal(result.applied, true);
  assert.equal(result.message, "已整理成「Deep Hacking 簡報」· 10/18（日）", "the same when-part as the capture toast");
  const todo = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.equal(todo.title, "Deep Hacking 簡報");
  assert.equal(todo.notes, "主題：Windows Administrator Protection");
  assert.equal(todo.dueDay, "2026-10-18");
  assert.equal(todo.dueTime, undefined);
  assert.equal(todo.originalText, REPORT);
  assert.equal(todo.tidiedAt, NOW.toISOString());
  assert.deepEqual(todo.pretidy, { title: RULE_TITLE }, "what the tidy replaced stays on the record for 復原整理");

  // The model got the user's own text after the trust boundary, zero tools.
  const call = modelCalls()[0];
  assert.match(call.options.input!, /任務角色：快速記下整理/);
  assert.match(call.options.input!, /"text":"Deep Hacking 簡報 要在周日前生出來/);
  assert.match(call.options.input!, /"weekday":"週四"/);
  assert.ok(call.args.includes("--tools"));

  const undone = await server.call("POST", "/api/capture/tidy/undo", { body: { token: result.undoToken } });
  assert.equal(undone.status, 200, undone.text);
  assert.deepEqual(undone.json as CaptureTidyUndoResponse, { restored: true, kind: "todo", id: body.id, title: RULE_TITLE });
  const restored = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.equal(restored.title, RULE_TITLE);
  assert.equal(restored.notes, undefined);
  assert.equal(restored.tidiedAt, undefined);
  assert.equal(restored.pretidy, undefined);
  assert.equal(restored.originalText, REPORT, "the sentence the user typed stays");
  assert.equal(restored.dueDay, "2026-10-18");
  assert.equal((await server.call("POST", "/api/capture/tidy/undo", { body: { token: result.undoToken } })).status, 404, "復原 runs once");
});

test("an answer equal to the saved record changes nothing", async (t) => {
  const { services } = setup(t, { respond: () => claudeStream({ ...TIDY, title: RULE_TITLE, notes: [] }) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  const before = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  const result = await settle(services, body.tidy);
  assert.deepEqual({ applied: result.applied, reason: result.reason, undoToken: result.undoToken }, { applied: false, reason: "same", undoToken: undefined });
  assert.deepEqual((await server.call("GET", `/api/todos/${body.id}`)).json, before);
});

test("an answer with a date the text does not give is refused whole", async (t) => {
  const { services } = setup(t, { respond: () => claudeStream({ ...TIDY, dueDay: "2026-10-20" }) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  const result = await settle(services, body.tidy);
  assert.deepEqual({ applied: result.applied, reason: result.reason }, { applied: false, reason: "rejected" });
  const todo = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.equal(todo.title, RULE_TITLE);
  assert.equal(todo.dueDay, "2026-10-18");
  assert.equal(todo.tidiedAt, undefined);
});

test("an answer carrying a secret is refused by the model layer and nothing is written", async (t) => {
  const { services } = setup(t, { respond: () => claudeStream({ ...TIDY, notes: [`token ghp_${"a".repeat(36)}`] }) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  await services.jobs.settled(body.tidy!.jobId);
  assert.equal(resultOf(services, body.tidy!.jobId)!.status, "failed");
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).title, RULE_TITLE);
});

test("editing the todo while it is tidied cancels the tidy; the user's edit stays", async (t) => {
  const { services } = setup(t, { respond: slowCli(5_000, TIDY) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const edited = await server.call("PATCH", `/api/todos/${body.id}`, { body: { title: "Deep Hacking 期末簡報" } });
  assert.equal(edited.status, 200);
  await services.jobs.settled(body.tidy!.jobId);
  assert.equal(resultOf(services, body.tidy!.jobId)!.status, "cancelled");
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).title, "Deep Hacking 期末簡報");
});

test("a record changed by another path while the model ran is left alone (edited)", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { services } = setup(t, { respond: async () => { await gate; return claudeStream(TIDY); } });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  // 完成 from Today goes through the action queue, not PATCH /api/todos: the fingerprint still catches it.
  todoStore(services).complete(body.id);
  release();
  const result = await settle(services, body.tidy);
  assert.deepEqual({ applied: result.applied, reason: result.reason }, { applied: false, reason: "edited" });
  const todo = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.equal(todo.title, RULE_TITLE);
  assert.equal(todo.status, "done");
});

test("自動整理 off, AI off or a short title: no tidy, no model call; the manual 整理 says AI is off", async (t) => {
  const { services, modelCalls } = setup(t, { respond: () => claudeStream(TIDY) });
  const server = await serve(t, services);
  const short = (await server.call("POST", "/api/capture", { body: { text: "明天 交報告" } })).json as CaptureResponse;
  assert.equal(short.tidy, undefined);
  services.settings.update({ "ai.captureTidy": false });
  assert.equal(((await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse).tidy, undefined);
  services.settings.update({ "ai.captureTidy": true, "ai.enabled": false });
  const off = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  assert.equal(off.tidy, undefined);
  assert.equal(modelCalls().length, 0);
  const manual = await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: off.id } });
  assert.equal(manual.status, 503);
  assert.equal(manual.json.error, "AI 已關閉，無法整理。");
  // The rule result is kept as it was.
  assert.equal(((await server.call("GET", `/api/todos/${off.id}`)).json as Todo).title, RULE_TITLE);
});

test("a CLI the status probe found signed out starts no tidy (no 整理中…); the save never waits for a probe", async (t) => {
  const { services, calls, modelCalls } = setup(t, { loggedIn: false, respond: () => claudeStream(TIDY) });
  const server = await serve(t, services);
  // GET /api/status (the client polls it) has probed the CLIs: 「Claude 尚未登入」.
  assert.equal(((await server.call("GET", "/api/status")).json as { modules: { capture: { aiParse: boolean } } }).modules.capture.aiParse, false);
  const probes = calls.length;
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  assert.equal(body.tidy, undefined);
  assert.equal(calls.length, probes, "no CLI was spawned for the capture");
  assert.equal(modelCalls().length, 0);
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).title, RULE_TITLE);
});

test("before any status probe, a signed-out CLI fails the tidy quietly and keeps the rule result", async (t) => {
  const { services, modelCalls } = setup(t, { loggedIn: false, respond: () => claudeStream(TIDY) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  assert.equal(body.tidy?.kind, "todo");
  await services.jobs.settled(body.tidy!.jobId);
  assert.equal(resultOf(services, body.tidy!.jobId)!.status, "failed");
  assert.equal(modelCalls().length, 0);
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).title, RULE_TITLE);
});

test("the manual 整理 fixes an item saved before this change; one tidy per record", async (t) => {
  const { services, modelCalls } = setup(t, { respond: slowCli(50, TIDY) });
  const server = await serve(t, services);
  // The stored row from the report: the old parser left 「要在」 and a hole, and kept no original text.
  const old = (await server.call("POST", "/api/todos", { body: { title: "Deep Hacking 簡報 要在 生出來，主題是 Windows Administrator Protection", dueDay: "2026-10-18" } })).json as Todo;
  const first = await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: old.id } });
  assert.equal(first.status, 202, first.text);
  const again = await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: old.id } });
  assert.equal((again.json as CaptureTidyStart).jobId, (first.json as CaptureTidyStart).jobId, "idempotent while it runs");
  const result = await settle(services, first.json as CaptureTidyStart);
  assert.equal(result.applied, true);
  assert.equal(modelCalls().length, 1);
  assert.match(modelCalls()[0].options.input!, /"dueDay":"2026-10-18"/);
  const todo = (await server.call("GET", `/api/todos/${old.id}`)).json as Todo;
  assert.equal(todo.title, "Deep Hacking 簡報");
  assert.equal(todo.originalText, "Deep Hacking 簡報 要在 生出來，主題是 Windows Administrator Protection");
  assert.equal((await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: "missing" } })).status, 404);
  // A todo made from a mail (轉待辦) holds source text: it is never sent to the model.
  const fromMail = todoStore(services).create({ title: "Re: OS 期末專題題目討論，請在週五前回覆", origin: "mail" });
  const refused = await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: fromMail.id } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "這一項來自信件或其他來源，不能用 AI 整理。");
  assert.equal(modelCalls().length, 1);
  assert.equal((await server.call("POST", "/api/capture/tidy", { body: { kind: "idea", id: old.id } })).status, 400);
  assert.equal((await server.call("POST", "/api/capture/tidy/undo", { body: { token: "nope" } })).status, 400);
});

test("復原 after the user edited the tidied record is refused", async (t) => {
  const { services } = setup(t, { respond: () => claudeStream(TIDY) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  const result = await settle(services, body.tidy);
  await server.call("PATCH", `/api/todos/${body.id}`, { body: { notes: "主題：Windows Administrator Protection\n要 demo" } });
  const undone = await server.call("POST", "/api/capture/tidy/undo", { body: { token: result.undoToken } });
  assert.equal(undone.status, 409);
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).title, "Deep Hacking 簡報");
});

test("復原整理 on the record puts the rule result back any time later, until the user edits the title or notes", async (t) => {
  const { services } = setup(t, { respond: () => claudeStream(TIDY) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  await settle(services, body.tidy);
  // Long after the toast: 重要 set meanwhile stays, the tidy goes.
  await server.call("PATCH", `/api/todos/${body.id}`, { body: { priority: "high" } });
  assert.deepEqual(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).pretidy, { title: RULE_TITLE }, "重要 is not an edit of the tidied words");
  const reverted = await server.call("POST", "/api/capture/tidy/revert", { body: { kind: "todo", id: body.id } });
  assert.equal(reverted.status, 200, reverted.text);
  assert.deepEqual(reverted.json as CaptureTidyUndoResponse, { restored: true, kind: "todo", id: body.id, title: RULE_TITLE });
  const todo = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.deepEqual({ title: todo.title, notes: todo.notes, priority: todo.priority, tidiedAt: todo.tidiedAt, pretidy: todo.pretidy, dueDay: todo.dueDay }, { title: RULE_TITLE, notes: undefined, priority: "high", tidiedAt: undefined, pretidy: undefined, dueDay: "2026-10-18" });
  assert.equal((await server.call("POST", "/api/capture/tidy/revert", { body: { kind: "todo", id: body.id } })).status, 409, "nothing left to put back");

  // Tidied again, then the user rewrites the notes: 復原整理 would overwrite that, so it is gone.
  const again = (await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: body.id } })).json as CaptureTidyStart;
  await settle(services, again);
  await server.call("PATCH", `/api/todos/${body.id}`, { body: { notes: "主題：Windows Administrator Protection\n要 demo" } });
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).pretidy, undefined);
  const refused = await server.call("POST", "/api/capture/tidy/revert", { body: { kind: "todo", id: body.id } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "這一項沒有可以復原的整理。");
});

test("a title the user rewrote is what the manual 整理 reads, not the sentence first typed", async (t) => {
  const { services, modelCalls } = setup(t, { respond: () => claudeStream({ ...TIDY, title: "Deep Hacking 期末簡報", notes: ["內容：demo 錄影"] }) });
  const server = await serve(t, services);
  services.settings.update({ "ai.enabled": false });
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  assert.equal(((await server.call("GET", `/api/todos/${body.id}`)).json as Todo).originalText, REPORT);
  const renamed = (await server.call("PATCH", `/api/todos/${body.id}`, { body: { title: "Deep Hacking 期末簡報與 demo 錄影" } })).json as Todo;
  assert.equal(renamed.originalText, undefined, "the typed sentence is stale once the user rewrote the title");
  // A PATCH that repeats the same title (an older client) keeps it.
  const other = (await server.call("POST", "/api/capture", { body: { text: "明天 交報告，記得印出來" } })).json as CaptureResponse;
  const same = (await server.call("PATCH", `/api/todos/${other.id}`, { body: { title: "交報告，記得印出來", priority: "high" } })).json as Todo;
  assert.equal(same.originalText, "明天 交報告，記得印出來");

  services.settings.update({ "ai.enabled": true });
  const start = (await server.call("POST", "/api/capture/tidy", { body: { kind: "todo", id: body.id } })).json as CaptureTidyStart;
  const result = await settle(services, start);
  const input = modelCalls()[0].options.input!;
  assert.match(input, /"text":"Deep Hacking 期末簡報與 demo 錄影"/);
  assert.doesNotMatch(input, /要在周日前/, "the old sentence is not sent");
  assert.equal(result.applied, true);
  const todo = (await server.call("GET", `/api/todos/${body.id}`)).json as Todo;
  assert.deepEqual({ title: todo.title, notes: todo.notes }, { title: "Deep Hacking 期末簡報", notes: "內容：demo 錄影" });
});

test("the tidy goes ahead of queued mail triage for the agent slot", async (t) => {
  const order: string[] = [];
  const { services } = setup(t, { respond: (call) => { if (call.args.includes("-p")) order.push("tidy"); return slowCli(20, TIDY)(call); } });
  const server = await serve(t, services);
  const running = await services.slots.acquire();
  // Mail triage queued first, at background priority.
  const triage = services.slots.acquire(undefined, { priority: "background" }).then((release) => { order.push("triage"); release(); });
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(services.slots.waiting, 2, "the tidy waits for the slot");
  running();
  await services.jobs.settled(body.tidy!.jobId);
  await triage;
  assert.equal(resultOf(services, body.tidy!.jobId)!.status, "done");
  assert.deepEqual(order, ["tidy", "triage"]);
});

test("an AI 解析 the user is watching goes ahead of queued tidies", async (t) => {
  const order: string[] = [];
  const { services } = setup(t, { respond: (call) => { if (call.args.includes("-p")) order.push("tidy"); return slowCli(20, TIDY)(call); } });
  const server = await serve(t, services);
  const running = await services.slots.acquire();
  const body = (await server.call("POST", "/api/capture", { body: { text: REPORT } })).json as CaptureResponse;
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The palette's AI 解析 (parse-job.ts) asks for the slot after the tidy queued.
  const parse = services.slots.acquire(undefined, { priority: "interactive" }).then((release) => { order.push("parse"); release(); });
  assert.equal(services.slots.waiting, 2);
  running();
  await parse;
  await services.jobs.settled(body.tidy!.jobId);
  assert.deepEqual(order, ["parse", "tidy"]);
});

/* ------------------------------------------------------------------- events */

const EVENT_TEXT = "明天下午三點 跟林教授 meeting 討論期末專題提案，記得帶筆電 @工程三館";
const EVENT_TIDY: TidyAnswer = { title: "跟林教授討論期末專題提案", notes: ["記得帶筆電"], dueDay: "2026-10-16", dueTime: "15:00", location: "工程三館", confidence: "high" };

test("an event is tidied before its Google insert: the insert waits, then carries the tidied title", async (t) => {
  const network = fakeNetwork();
  const { services } = setup(t, { respond: slowCli(50, EVENT_TIDY), network });
  await connectGoogle(services);
  const server = await serve(t, services);
  const created = await server.call("POST", "/api/capture", { body: { text: EVENT_TEXT } });
  assert.equal(created.status, 201, created.text);
  const body = created.json as CaptureResponse;
  assert.equal(body.type, "event");
  assert.equal(body.tidy?.kind, "event");
  const service = calendarService(services);
  assert.equal(service.isPending(body.id), true, "the Google insert waits (postponed) while the model runs");
  const result = await settle(services, body.tidy);
  assert.equal(result.applied, true);
  assert.equal(result.message, "已整理成「跟林教授討論期末專題提案」· 明天 15:00");
  const event = service.get(body.id)!;
  assert.equal(event.title, "跟林教授討論期末專題提案");
  assert.equal(event.location, "工程三館");
  assert.equal(event.notes, "記得帶筆電\n來自 快速記下", "the moved detail first: the agenda shows the first line");
  assert.equal(event.originalText, EVENT_TEXT);
  assert.equal(service.isPending(body.id), true, "a fresh undo window after the tidy");
  assert.equal(network.google.inserted.length, 0);
  await service.flush();
  assert.equal(network.google.inserted.length, 1);
  assert.equal(network.google.inserted[0].summary, "跟林教授討論期末專題提案");
  assert.equal(network.google.inserted[0].location, "工程三館");
});

test("復原 of an event's tidy restores it before the insert; an event already in Google is not tidied", async (t) => {
  const network = fakeNetwork();
  const { services } = setup(t, { respond: () => claudeStream(EVENT_TIDY), network });
  await connectGoogle(services);
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: EVENT_TEXT } })).json as CaptureResponse;
  const result = await settle(services, body.tidy);
  const undone = await server.call("POST", "/api/capture/tidy/undo", { body: { token: result.undoToken } });
  assert.equal(undone.status, 200, undone.text);
  const service = calendarService(services);
  const restored = service.get(body.id) as ManualEvent;
  assert.equal(restored.title, "跟林教授 meeting 討論期末專題提案，記得帶筆電");
  assert.equal(restored.location, "工程三館");
  await service.flush();
  assert.equal(network.google.inserted[0].summary, "跟林教授 meeting 討論期末專題提案，記得帶筆電");
  // Now it is in Google: 整理 is refused (no Google update path), nothing is sent to the model.
  const refused = await server.call("POST", "/api/capture/tidy", { body: { kind: "event", id: body.id } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "這個行程已在 Google 行事曆，請到 Google 行事曆修改。");
});

test("a local-only event is tidied in place and its tidy is one job per event", async (t) => {
  const { services } = setup(t, { respond: slowCli(30, EVENT_TIDY) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: EVENT_TEXT } })).json as CaptureResponse;
  assert.equal(startTidy(services, "event", body.id, { auto: false }).jobId, body.tidy!.jobId);
  const result = await settle(services, body.tidy);
  assert.equal(result.applied, true);
  assert.equal(calendarService(services).isPending(body.id), false);
  assert.equal(calendarService(services).get(body.id)!.title, "跟林教授討論期末專題提案");
});

test("#/calendar: a tidied captured event's meta line shows the detail moved out of its title", async (t) => {
  const { services } = setup(t, { respond: () => claudeStream(EVENT_TIDY) });
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: EVENT_TEXT } })).json as CaptureResponse;
  await settle(services, body.tidy);
  const items = collectItems(services, taipei("2026-10-16T00:00").toISOString(), taipei("2026-10-17T00:00").toISOString());
  const item = items.find((entry) => entry.manualId === body.id)!;
  assert.equal(item.title, "跟林教授討論期末專題提案");
  assert.equal(item.meta, "工程三館 · 記得帶筆電");
  assert.equal(item.tidied, true, "復原整理 is offered on the row");
  // 復原整理 from the row, long after the toast.
  const reverted = await server.call("POST", "/api/capture/tidy/revert", { body: { kind: "event", id: body.id } });
  assert.equal(reverted.status, 200, reverted.text);
  const restored = calendarService(services).get(body.id)!;
  assert.deepEqual({ title: restored.title, notes: restored.notes, location: restored.location }, { title: "跟林教授 meeting 討論期末專題提案，記得帶筆電", notes: "來自 快速記下", location: "工程三館" });
  assert.equal(collectItems(services, taipei("2026-10-16T00:00").toISOString(), taipei("2026-10-17T00:00").toISOString()).find((entry) => entry.manualId === body.id)!.tidied, undefined);
});

/** fakeNetwork whose Google inserts wait for `release()`. */
function gatedGoogle() {
  const network = fakeNetwork();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const insertStarted = new Promise<void>((resolve) => { started = resolve; });
  const fetch: typeof network.fetch = async (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST" && /\/calendar\/v3\/calendars\/[^/]+\/events$/.test(new URL(String(input)).pathname)) {
      started();
      await gate;
    }
    return network.fetch(input, init);
  };
  return { network: { ...network, fetch }, release, insertStarted };
}

test("復原 while the event's Google insert is on its way is refused, so Google and BELL never differ", async (t) => {
  const { network, release, insertStarted } = gatedGoogle();
  const { services } = setup(t, { respond: () => claudeStream(EVENT_TIDY), network });
  await connectGoogle(services);
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: EVENT_TEXT } })).json as CaptureResponse;
  const result = await settle(services, body.tidy);
  assert.equal(result.applied, true);
  const service = calendarService(services);
  // The fresh undo window passes: the insert starts and waits on Google.
  const flushing = service.flush();
  await insertStarted;
  assert.equal(service.isPending(body.id), false);
  assert.equal(service.isInserting(body.id), true);
  const undone = await server.call("POST", "/api/capture/tidy/undo", { body: { token: result.undoToken } });
  assert.equal(undone.status, 409, undone.text);
  assert.equal((await server.call("POST", "/api/capture/tidy/revert", { body: { kind: "event", id: body.id } })).status, 409);
  assert.equal((await server.call("POST", "/api/capture/tidy", { body: { kind: "event", id: body.id } })).status, 409);
  release();
  await flushing;
  assert.equal(service.isInserting(body.id), false);
  const event = service.get(body.id)!;
  assert.ok(event.googleEventId);
  assert.equal(event.title, "跟林教授討論期末專題提案");
  assert.equal(network.google.inserted[0].summary, event.title, "Google has what BELL shows");
});

test("a tidy that lands while the event's Google insert is on its way writes nothing (reason google)", async (t) => {
  const { network, release, insertStarted } = gatedGoogle();
  let answer!: () => void;
  const model = new Promise<void>((resolve) => { answer = resolve; });
  const { services } = setup(t, { respond: async () => { await model; return claudeStream(EVENT_TIDY); }, network });
  await connectGoogle(services);
  const server = await serve(t, services);
  const body = (await server.call("POST", "/api/capture", { body: { text: EVENT_TEXT } })).json as CaptureResponse;
  const service = calendarService(services);
  // The 2-minute hold ran out while the tidy waited: the insert starts before the model answers.
  const flushing = service.flush();
  await insertStarted;
  answer();
  const result = await settle(services, body.tidy);
  assert.deepEqual({ applied: result.applied, reason: result.reason }, { applied: false, reason: "google" });
  release();
  await flushing;
  const event = service.get(body.id)!;
  assert.equal(event.title, "跟林教授 meeting 討論期末專題提案，記得帶筆電");
  assert.equal(network.google.inserted[0].summary, event.title);
});
