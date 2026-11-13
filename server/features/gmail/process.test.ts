import test from "node:test";
import assert from "node:assert/strict";
import type { InboxThreadResponse, MailMessage, MailModuleStatus, MailProcessResult, MailProcessStart } from "../../../shared/mail.js";
import type { AssignmentSuggestion, EventSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import type { StructuredRequest } from "../../ai/structured.js";
import type { CoreServices } from "../../services.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices, type RecordedCall } from "../../test-helpers.js";
import { gmailModule } from "./index.js";
import { processPrompt, type ProcessAnswer } from "./process.js";
import { MailStore } from "./store.js";

/** Monday 2026-10-12 08:42 in Taipei. */
const NOW = new Date("2026-10-12T00:42:00Z");
const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function mail(id: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id, threadId: "t-sitcon", from: { name: "SITCON", email: "contact@sitcon.org" }, subject: "SITCON 秋季交流會報名成功", snippet: "摘要", excerpt: "內文",
    receivedAt: at(1), unread: true, labels: ["INBOX", "UNREAD"], webUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`, ...extra,
  };
}

/** A conversation of five: a secret, the announcement, my reply, a reminder and the newest notice (the row's message). */
const CONVERSATION = [
  mail("m0", { receivedAt: at(50), excerpt: `你的驗證碼是 ghp_${"a".repeat(30)}` }),
  mail("m1", { receivedAt: at(40), excerpt: "10/25 13:30 在中研院人文館舉行，請在 10/20 前繳交報名費。" }),
  mail("m2", { receivedAt: at(30), from: { name: "我", email: "me@example.com" }, labels: ["SENT"], excerpt: "我會參加，謝謝。" }),
  mail("m3", { receivedAt: at(20), excerpt: "提醒：活動當天請帶學生證。" }),
  mail("m4", { receivedAt: at(10), excerpt: "另外 HW5 請在 10/30 前上傳到 E3。" }),
];

const ANSWER: ProcessAnswer = {
  events: [
    { title: "SITCON 秋季交流會", start: "2026-10-25T13:30+08:00", end: "2026-10-25T17:30+08:00", location: "中研院人文館" },
    { title: "SITCON 交流會", start: "2026-10-25T13:30+08:00", end: null, location: null },
    { title: "已經結束的活動", start: "2026-01-01T10:00+08:00", end: null, location: null },
  ],
  todos: [
    { title: "繳交報名費", due: "2026-10-20" },
    { title: "HW5：系統呼叫實作", due: "2026-10-30" },
  ],
  assignments: [
    { title: "HW5：系統呼叫實作", course: "作業系統", due: "2026-10-30T23:59", submit: "上傳到 E3", url: null },
  ],
};

/** Services whose ai.runStructured answers `answer` (the zod schema still validates it, like the real runner). */
function stubbed(t: test.TestContext, answer: () => unknown = () => ANSWER) {
  const services = testServices(t, { seams: { now: () => NOW } });
  const requests: StructuredRequest<ProcessAnswer>[] = [];
  services.ai.runStructured = (async (request: StructuredRequest<ProcessAnswer>) => {
    requests.push(request);
    return { value: request.schema.parse(answer()), execution: { provider: "claude", model: "sonnet", source: "selected" }, ms: 5 };
  }) as typeof services.ai.runStructured;
  const store = new MailStore(services.sourceItems);
  store.put([...CONVERSATION, mail("other", { threadId: "t-other" })]);
  return { services, store, requests };
}

async function finish(services: CoreServices, start: MailProcessStart): Promise<MailProcessResult> {
  await services.jobs.settled(start.jobId);
  const events: unknown[] = [];
  services.jobs.follow(start.jobId, 0, (event) => events.push(event), () => {});
  const end = events.at(-1) as { type: string; result?: MailProcessResult; message?: string };
  assert.equal(end.type, "done", end.message);
  return end.result!;
}

test("AI 處理 turns one conversation into pending suggestions on its row message, never records", async (t) => {
  const { services, requests } = stubbed(t);
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const process = async () => {
    const started = await server.call("POST", "/api/gmail/threads/t-sitcon/process", { body: {} });
    assert.equal(started.status, 202, started.text);
    return finish(services, started.json as MailProcessStart);
  };

  // Two events at the same time are one; the past one is dropped; the assignment is not also a todo.
  assert.deepEqual(await process(), { threadId: "t-sitcon", found: 4, added: 3, pending: 3 });

  const request = requests[0];
  assert.equal(request.role, "信件處理");
  assert.equal(request.priority, "interactive", "someone is watching: ahead of the triage");
  assert.equal(request.prompt, processPrompt("+08:00"));
  const data = request.data as { today: string; weekday: string; messages: Array<{ mine: boolean; receivedAt: string; body: string }> };
  assert.equal(data.today, "2026-10-12");
  assert.equal(data.weekday, "週一");
  assert.equal(data.messages.length, 4, "the newest four; the message with a secret never leaves");
  assert.ok(!data.messages.some((message) => message.body.includes("ghp_")));
  assert.deepEqual(data.messages.map((message) => message.mine), [false, true, false, false]);
  assert.match(data.messages[0].body, /^<email>\n10\/25 13:30 在中研院人文館舉行/, "bodies are wrapped as untrusted data");
  assert.equal(data.messages[3].receivedAt, "2026-10-11 22:42", "local time in BELLPERSONAL_TZ");

  const made = services.suggestions.list({ status: "pending" });
  assert.equal(made.length, 3);
  for (const suggestion of made) {
    assert.deepEqual(suggestion.sourceRef, { source: "gmail", externalId: "m4", url: "https://mail.google.com/mail/u/0/#inbox/m4" });
    assert.equal(suggestion.origin, "SITCON 報名成功信");
  }
  assert.deepEqual(made.find((suggestion) => suggestion.kind === "event")?.payload as EventSuggestion, {
    title: "SITCON 秋季交流會", start: "2026-10-25T05:30:00.000Z", end: "2026-10-25T09:30:00.000Z", allDay: false, location: "中研院人文館",
  });
  assert.deepEqual(made.find((suggestion) => suggestion.kind === "todo")?.payload as TodoSuggestion, { title: "繳交報名費", dueDay: "2026-10-20" });
  const assignment = made.find((suggestion) => suggestion.kind === "assignment")?.payload as AssignmentSuggestion;
  assert.equal(assignment.title, "HW5：系統呼叫實作");
  assert.equal(assignment.courseName, "作業系統");

  // The reader lists them under 從這封信找到, with one-tap buttons; Today has them as ai: rows.
  const reader = (await server.call("GET", "/api/gmail/threads/t-sitcon")).json as InboxThreadResponse;
  assert.deepEqual(reader.suggestions.map((suggestion) => suggestion.kind).sort(), ["suggestion.assignment", "suggestion.event", "suggestion.todo"]);
  assert.deepEqual(reader.suggestions.find((suggestion) => suggestion.kind === "suggestion.event")?.actions.map((action) => action.id), ["calendar", "dismiss"]);

  // A second run proposes nothing new; what the owner dismissed stays dismissed.
  assert.deepEqual(await process(), { threadId: "t-sitcon", found: 4, added: 0, pending: 3 });
  services.suggestions.decide(made.find((suggestion) => suggestion.kind === "todo")!.id, "dismissed");
  assert.deepEqual(await process(), { threadId: "t-sitcon", found: 4, added: 0, pending: 2 });
  assert.equal(services.suggestions.list().length, 3);
});

test("an earlier triage suggestion for the same event or todo is not offered twice", async (t) => {
  const { services, store } = stubbed(t, () => ({
    events: [{ title: "SITCON 交流會（下午場）", start: "2026-10-25T13:30+08:00", end: null, location: null }],
    todos: [{ title: "繳交 報名費。", due: null }, { title: "帶學生證", due: "2026-10-25" }],
    assignments: [],
  }));
  // The triage already proposed the event and the todo, on an older message of the conversation.
  services.suggestions.create<EventSuggestion>({
    kind: "event", title: "SITCON 秋季交流會", payload: { title: "SITCON 秋季交流會", start: "2026-10-25T05:30:00.000Z", allDay: false },
    sourceRef: { source: "gmail", externalId: "m1" }, dedupeKey: "mail-event:m1",
  });
  services.suggestions.create<TodoSuggestion>({ kind: "todo", title: "繳交報名費", payload: { title: "繳交報名費" }, sourceRef: { source: "gmail", externalId: "m1" }, dedupeKey: "mail-todo:m1" });
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const started = await server.call("POST", "/api/gmail/threads/t-sitcon/process", { body: {} });
  assert.deepEqual(await finish(services, started.json as MailProcessStart), { threadId: "t-sitcon", found: 3, added: 1, pending: 3 });
  assert.deepEqual(services.suggestions.list({ kind: "todo" }).map((suggestion) => (suggestion.payload as TodoSuggestion).title).sort(), ["帶學生證", "繳交報名費"]);

  // The mail left the cache while the model ran (清除快取的信件): nothing is made from it.
  services.ai.runStructured = (async (request: StructuredRequest<ProcessAnswer>) => {
    store.clear();
    return { value: request.schema.parse({ events: [], todos: [{ title: "新的待辦", due: null }], assignments: [] }), execution: { provider: "claude", source: "selected" }, ms: 5 };
  }) as typeof services.ai.runStructured;
  const again = (await server.call("POST", "/api/gmail/threads/t-sitcon/process", { body: {} })).json as MailProcessStart;
  await services.jobs.settled(again.jobId);
  assert.equal(services.jobs.get(again.jobId)?.status, "failed");
  assert.match(services.jobs.get(again.jobId)?.error ?? "", /找不到這封信/);
  assert.equal(services.suggestions.list({ kind: "todo" }).length, 2);
});

test("AI 處理 refuses when AI is off, outside the cache, for secrets and bad input; one job per conversation", async (t) => {
  let release: () => void = () => {};
  const { services, store, requests } = stubbed(t, () => ({ events: [], todos: [], assignments: [] }));
  const answer = services.ai.runStructured;
  services.ai.runStructured = (async (request: StructuredRequest<ProcessAnswer>) => {
    await new Promise<void>((resolve) => { release = resolve; });
    return answer(request);
  }) as typeof services.ai.runStructured;
  store.put([mail("secret", { threadId: "t-secret", excerpt: `token ghp_${"b".repeat(30)}` })]);
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const post = (threadId: string, body: unknown = {}) => server.call("POST", `/api/gmail/threads/${threadId}/process`, { body });

  assert.equal((await post("t-unknown")).status, 404);
  assert.match((await post("t-unknown")).json.error, /找不到這封信/);
  assert.equal((await post("bad.id")).status, 404);
  assert.equal((await post("t-sitcon", { extra: true })).status, 400);
  const secret = await post("t-secret");
  assert.equal(secret.status, 422);
  assert.equal(secret.json.error, "這封信看起來含有密碼或驗證碼，不會交給 AI 處理。");

  const first = (await post("t-sitcon")).json as MailProcessStart;
  const second = (await post("t-sitcon")).json as MailProcessStart;
  assert.equal(second.jobId, first.jobId, "pressing again joins the running job");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await finish(services, first), { threadId: "t-sitcon", found: 0, added: 0, pending: 0 });
  assert.equal(requests.length, 1);

  services.settings.update({ "ai.enabled": false });
  const off = await post("t-sitcon");
  assert.equal(off.status, 503);
  assert.equal(off.json.error, "AI 已關閉，無法處理這封信。請到「連線與設定」開啟 AI。");
  // The reader hides the button when it cannot run: here AI is off and no CLI is signed in.
  const status = (await server.call("GET", "/api/status")).json as { modules: { gmail: MailModuleStatus } };
  assert.equal(status.modules.gmail.aiProcess, false);
});

test("the real runner: the answer must pass the strict schema", async (t) => {
  let answer: unknown = ANSWER;
  const stream = () => claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = answer; copy.result = JSON.stringify(answer); }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
  const fake = fakeCommand((call: RecordedCall) => (call.args.join(" ") === "auth status" ? "{}" : call.args.includes("-p") ? stream() : undefined));
  const services = testServices(t, { seams: { command: fake.runner, now: () => NOW } });
  new MailStore(services.sourceItems).put(CONVERSATION);
  const server = await startTestServer(t, services, { modules: [gmailModule] });

  const ok = (await server.call("POST", "/api/gmail/threads/t-sitcon/process", { body: {} })).json as MailProcessStart;
  assert.equal((await finish(services, ok)).added, 3);
  const call = fake.calls.find((item) => item.args.includes("-p"))!;
  const schema = JSON.parse(call.args[call.args.indexOf("--json-schema") + 1]) as { required: string[]; properties: Record<string, { maxItems: number }> };
  assert.deepEqual(schema.required, ["events", "todos", "assignments"]);
  assert.equal(schema.properties.events.maxItems, 8);

  answer = { ...ANSWER, todos: [{ title: "繳費", due: null, extra: true }] };
  const rejected = (await server.call("POST", "/api/gmail/threads/t-sitcon/process", { body: {} })).json as MailProcessStart;
  await services.jobs.settled(rejected.jobId);
  assert.equal(services.jobs.get(rejected.jobId)?.status, "failed", "an extra field fails the strict schema");
});
