import test from "node:test";
import assert from "node:assert/strict";
import type { MailMessage } from "../../../shared/mail.js";
import type { EventSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import { AppError } from "../../errors.js";
import type { StructuredRequest } from "../../ai/structured.js";
import { claudeFixtureEvents, fakeCommand, testServices, type RecordedCall } from "../../test-helpers.js";
import { MailStore } from "./store.js";
import { applyAnswer, MailTriageQueue, offsetText, parseDay, runTriage, TRIAGE_BATCH, TRIAGE_MAX_ATTEMPTS, triagePrompt, type TriageAnswer } from "./triage.js";

const NOW = new Date("2026-10-12T00:42:00Z");
const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function mail(id: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id, threadId: id, from: { name: "寄件者", email: `${id}@example.com` }, subject: `主旨 ${id}`, snippet: "摘要", excerpt: "內文",
    receivedAt: at(1), unread: true, labels: ["INBOX", "UNREAD"], webUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    triageQueue: { state: "pending", attempts: 0, updatedAt: at(1) }, ...extra,
  };
}

const item = (id: string, extra: Partial<TriageAnswer["items"][number]> = {}): TriageAnswer["items"][number] => ({
  id, summary: "請在週三前回信", category: "action", priority: "high", action: "reply", context: null, bill: null, ...extra,
});

/** Services whose ai.runStructured is replaced by `answer` (the zod schema still validates it, like the real runner). */
function stubbed(t: test.TestContext, answer: (request: StructuredRequest<TriageAnswer>) => unknown) {
  const services = testServices(t, { seams: { now: () => NOW } });
  const requests: StructuredRequest<TriageAnswer>[] = [];
  services.ai.runStructured = (async (request: StructuredRequest<TriageAnswer>) => {
    requests.push(request);
    const value = request.schema.parse(await answer(request));
    return { value, execution: { provider: "claude", model: "sonnet", source: "selected" }, ms: 5 };
  }) as typeof services.ai.runStructured;
  const store = new MailStore(services.sourceItems);
  return { services, store, requests };
}

test("a batch stores AI triage, and its todos and events become deduplicated suggestions", async (t) => {
  const { services, store, requests } = stubbed(t, () => ({
    items: [
      item("lin", { context: "作業系統" }),
      item("cht", { category: "finance", action: "todo", priority: "medium", summary: "9 月電信費 NT$599", bill: { payee: "中華電信", amount: 599, currency: "TWD", dueDate: "2026-10-20", period: "9 月", autopay: false } }),
      item("kktix", { category: "event", action: "calendar", priority: "low", summary: "SITCON 報名成功" }),
      item("aa", { category: "school", action: "todo", priority: "low", summary: "停修申請 10/30 截止" }),
    ],
    todos: [
      { sourceId: "aa", title: "提出停修申請", due: "2026-10-30" },
      { sourceId: "aa", title: "第二件同一封信的待辦", due: null },
      { sourceId: "cht", title: "繳電信費", due: "2026-10-20" },
      { sourceId: "unknown", title: "不在這批的信", due: null },
    ],
    events: [
      { sourceId: "kktix", title: "SITCON 秋季交流會", start: "2026-10-25T13:30+08:00", end: "2026-10-25T17:30+08:00", location: "中研院人文館" },
      { sourceId: "kktix", title: "過去的活動", start: "2026-01-01T10:00+08:00", end: null, location: null },
    ],
    assignments: [],
  }));
  store.put([
    mail("lin", { from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" } }),
    mail("cht"),
    mail("kktix", { from: { name: "KKTIX", email: "no-reply@kktix.com" }, subject: "報名成功：SITCON 秋季交流會" }),
    mail("aa"),
  ]);

  const result = await runTriage(services, store, new AbortController().signal);
  assert.deepEqual(result, { processed: 4, failed: 0, suggestions: 2 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].role, "信件分類");
  const data = requests[0].data as { today: string; messages: Array<{ id: string; body: string }> };
  assert.equal(data.today, "2026-10-12");
  assert.match(data.messages[0].body, /^<email>\n內文\n<\/email>$/, "bodies are wrapped as untrusted data");

  const lin = store.get("lin")!;
  assert.deepEqual({ ...lin.triage, triagedAt: undefined }, { summary: "請在週三前回信", category: "needs-reply", priority: "high", action: "reply", source: "ai", triagedAt: undefined, version: 2, context: "作業系統" });
  assert.equal(lin.triageQueue?.state, "done");
  assert.deepEqual(store.get("cht")?.triage?.bill, { payee: "中華電信", amount: 599, currency: "TWD", dueDay: "2026-10-20", period: "9 月", autopay: false });
  assert.equal(store.get("kktix")?.triage?.category, "invitation");

  const suggestions = services.suggestions.list();
  const event = suggestions.find((suggestion) => suggestion.kind === "event")!;
  assert.deepEqual(event.payload as EventSuggestion, { title: "SITCON 秋季交流會", start: "2026-10-25T05:30:00.000Z", end: "2026-10-25T09:30:00.000Z", allDay: false, location: "中研院人文館" });
  assert.equal(event.origin, "KKTIX 報名成功信");
  assert.deepEqual(event.sourceRef, { source: "gmail", externalId: "kktix", url: "https://mail.google.com/mail/u/0/#inbox/kktix" });
  const todos = suggestions.filter((suggestion) => suggestion.kind === "todo");
  assert.equal(todos.length, 1, "one todo per message; bills keep their own 轉待辦");
  assert.deepEqual(todos[0].payload as TodoSuggestion, { title: "提出停修申請", dueDay: "2026-10-30" });

  // The same message again never makes a second suggestion (dedupeKey per message).
  store.put([{ ...store.get("kktix")!, triageQueue: { state: "pending", attempts: 0, updatedAt: at(0) } }]);
  await runTriage(services, store, new AbortController().signal);
  assert.equal(services.suggestions.list({ kind: "event" }).length, 1);
});

test("the real runner: strict schema, secrets never leave, one batch of at most 15", async (t) => {
  let answer: unknown = { items: [], todos: [], events: [], assignments: [] };
  const stream = () => claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = answer; copy.result = JSON.stringify(answer); }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
  const fake = fakeCommand((call: RecordedCall) => (call.args.join(" ") === "auth status" ? "{}" : stream()));
  const services = testServices(t, { seams: { command: fake.runner, now: () => NOW } });
  const store = new MailStore(services.sourceItems);
  const secret = `ghp_${"a".repeat(30)}`;
  store.put([
    mail("leak", { excerpt: `你的權杖是 ${secret}` }),
    ...Array.from({ length: TRIAGE_BATCH + 2 }, (_, index) => mail(`m${String(index).padStart(2, "0")}`, { receivedAt: at(index + 1) })),
  ]);
  answer = { items: [{ ...item("m00"), extra: true }], todos: [], events: [], assignments: [] };
  const rejected = await runTriage(services, store, new AbortController().signal, 1);
  assert.equal(rejected.stopped, "failed", "an extra field fails the strict schema");
  assert.equal(rejected.failedBatch, TRIAGE_BATCH);
  assert.equal(store.get("m00")?.triageQueue?.attempts, 0, "a failed batch of several messages charges nobody");
  const alone = await runTriage(services, store, new AbortController().signal, 1, 1);
  assert.equal(alone.failedBatch, 1);
  assert.equal(store.get("m00")?.triageQueue?.attempts, 1, "a message that fails alone is charged");
  assert.equal(store.get("m00")?.triageQueue?.state, "pending");
  assert.match(store.get("m00")?.triageQueue?.error ?? "", /不符合格式/);

  answer = { items: Array.from({ length: TRIAGE_BATCH }, (_, index) => item(`m${String(index).padStart(2, "0")}`, { action: "read", category: "newsletter", priority: "low" })), todos: [], events: [], assignments: [] };
  const ok = await runTriage(services, store, new AbortController().signal, 1);
  assert.equal(ok.processed, TRIAGE_BATCH);
  const run = fake.calls.filter((call) => call.executable === "claude" && call.args[0] === "-p").at(-1)!;
  const input = run.options.input!;
  assert.doesNotMatch(input, /ghp_|你的權杖是|"leak"/, "a message that looks like it carries a secret is never sent");
  assert.equal((input.match(/\\u003cemail\\u003e/g) ?? []).length, TRIAGE_BATCH, "each body is wrapped (and escaped inside the JSON)");
  assert.equal(store.get("leak")?.triageQueue?.state, "done", "it is settled with the rules instead");
  assert.equal(store.get("leak")?.triage, undefined);
  assert.equal(store.get("m15")?.triageQueue?.state, "pending", "the rest waits for the next batch");
});

test("failures: three attempts, then failed with the rules; an unavailable CLI or AI off counts nothing", async (t) => {
  let mode: "schema" | "login" = "login";
  const { services, store } = stubbed(t, () => {
    if (mode === "login") throw new AppError(503, "無法使用 Claude Code：請在伺服器的終端機執行 claude auth login。");
    throw new AppError(502, "信件分類的模型回覆不符合格式，結果未儲存。");
  });
  store.put([mail("a")]);
  assert.equal((await runTriage(services, store, new AbortController().signal)).stopped, "unavailable");
  assert.equal(store.get("a")?.triageQueue?.attempts, 0);

  mode = "schema";
  for (let attempt = 1; attempt <= 3; attempt++) await runTriage(services, store, new AbortController().signal);
  assert.equal(store.get("a")?.triageQueue?.state, "failed");
  assert.equal(store.get("a")?.triageQueue?.attempts, 3);
  assert.equal((await runTriage(services, store, new AbortController().signal)).processed, 0, "failed mail is not retried");

  store.put([mail("b")]);
  services.settings.update({ "ai.mailTriage": false });
  assert.equal((await runTriage(services, store, new AbortController().signal)).stopped, "disabled");
  assert.equal(store.get("b")?.triageQueue?.state, "pending", "kept for when triage is turned back on");
});

test("the queue runs as a single mail-triage job and skips work when nothing is pending", async (t) => {
  let calls = 0;
  const { services, store } = stubbed(t, (request) => {
    calls++;
    const ids = (request.data as { messages: Array<{ id: string }> }).messages.map((message) => message.id);
    return { items: ids.map((id) => item(id, { action: "none", category: "other", priority: "low" })), todos: [], events: [], assignments: [] };
  });
  const queue = new MailTriageQueue(services, store);
  t.after(() => queue.close());
  queue.kick();
  assert.equal(queue.active, false, "nothing pending, no job");
  store.put([mail("x"), mail("y", { labels: ["UNREAD"] })]);
  queue.kick();
  queue.kick();
  await queue.idle();
  assert.equal(calls, 1);
  assert.equal(services.jobs.list().filter((job) => job.kind === "mail-triage").length, 1);
  assert.equal(store.get("x")?.triage?.source, "ai");
  assert.equal(store.get("y")?.triageQueue?.state, "done", "mail that left the inbox is settled without a model call");
  assert.deepEqual(queue.pending(), { pending: 0, failed: 0 });
});

/** stubbed() with a clock the test moves. */
function clocked(t: test.TestContext, answer: (request: StructuredRequest<TriageAnswer>) => unknown) {
  let now = NOW;
  const services = testServices(t, { seams: { now: () => now } });
  let calls = 0;
  services.ai.runStructured = (async (request: StructuredRequest<TriageAnswer>) => {
    calls++;
    const value = request.schema.parse(await answer(request));
    return { value, execution: { provider: "claude", model: "sonnet", source: "selected" }, ms: 5 };
  }) as typeof services.ai.runStructured;
  const store = new MailStore(services.sourceItems);
  const queue = new MailTriageQueue(services, store);
  t.after(() => queue.close());
  const kick = async (options?: { now?: boolean }) => { queue.kick(options); await queue.idle(); };
  return { services, store, queue, kick, calls: () => calls, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const ids = (request: StructuredRequest<TriageAnswer>) => (request.data as { messages: Array<{ id: string }> }).messages.map((message) => message.id);
const answerAll = (request: StructuredRequest<TriageAnswer>) => ({ items: ids(request).map((id) => item(id, { action: "none", category: "other", priority: "low" })), todos: [], events: [], assignments: [] });

test("mail a sync deletes while the model runs is not written back, and gets no suggestion", async (t) => {
  let store!: MailStore;
  const stub = stubbed(t, () => {
    store.remove(["gone"]); // GmailSync.forget() during the call (messagesDeleted, a purge, a disconnect)
    return { items: [item("gone"), item("kept")], todos: [{ sourceId: "gone", title: "回覆", due: null }], events: [{ sourceId: "gone", title: "說明會", start: "2026-10-20T10:00+08:00", end: null, location: null }], assignments: [] };
  });
  store = stub.store;
  store.put([mail("gone"), mail("kept")]);
  await runTriage(stub.services, store, new AbortController().signal);
  assert.equal(store.get("gone"), undefined);
  assert.equal(store.get("kept")?.triage?.source, "ai");
  assert.deepEqual(stub.services.suggestions.list().map((suggestion) => suggestion.sourceRef?.externalId), []);
  // The same for a failed answer that leaves the message out.
  store.put([mail("again")]);
  const result = applyAnswer(stub.services, store, [mail("again"), mail("vanished")], { items: [], todos: [], events: [], assignments: [] });
  assert.equal(result.failed, 0);
  assert.equal(store.get("vanished"), undefined);
  assert.equal(store.get("again")?.triageQueue?.attempts, 1);
});

test("a failing batch is split instead of charged: only the message that fails alone is marked failed", async (t) => {
  const { store, kick, advance, queue, calls } = clocked(t, (request) => {
    if (ids(request).includes("poison")) throw new AppError(502, "信件分類未完成：模型沒有完成回覆，請稍後再試。");
    return answerAll(request);
  });
  store.put([mail("a", { receivedAt: at(1) }), mail("poison", { receivedAt: at(2) }), mail("b", { receivedAt: at(3) }), mail("c", { receivedAt: at(4) }), mail("d", { receivedAt: at(5) })]);
  await kick();
  assert.equal(store.all().filter((message) => message.triageQueue?.attempts).length, 0, "nobody is charged for a failed batch of five");
  assert.equal(queue.backoff.batchSize, 3);
  const before = calls();
  await kick();
  assert.equal(calls(), before, "the next kick waits for the backoff");
  for (let round = 0; round < 20 && store.all().some((message) => message.triageQueue?.state === "pending"); round++) {
    advance(61 * 60_000);
    await kick({ now: true });
  }
  assert.equal(store.get("poison")?.triageQueue?.state, "failed");
  assert.equal(store.get("poison")?.triageQueue?.attempts, TRIAGE_MAX_ATTEMPTS);
  for (const id of ["a", "b", "c", "d"]) assert.equal(store.get(id)?.triage?.source, "ai", `${id} is triaged`);
});

test("an upstream outage within minutes fails no message; a signed-out CLI is retried after 15 minutes, not every sync", async (t) => {
  let mode: "outage" | "login" | "ok" = "outage";
  const { store, kick, advance, calls } = clocked(t, (request) => {
    if (mode === "outage") throw new AppError(502, "信件分類未完成：模型沒有完成回覆，請稍後再試。");
    if (mode === "login") throw new AppError(503, "無法使用 Claude Code：請在伺服器的終端機執行 claude auth login。");
    return answerAll(request);
  });
  store.put(Array.from({ length: 6 }, (_, index) => mail(`m${index}`, { receivedAt: at(index + 1) })));
  for (let minute = 0; minute < 6; minute += 2) { await kick(); advance(2 * 60_000); }
  assert.equal(store.all().filter((message) => message.triageQueue?.state === "failed").length, 0);

  mode = "login";
  advance(61 * 60_000);
  await kick();
  const afterLogin = calls();
  for (let minute = 0; minute < 14; minute += 2) { advance(2 * 60_000); await kick(); }
  assert.equal(calls(), afterLogin, "no model call while the CLI is signed out");
  mode = "ok";
  advance(2 * 60_000);
  await kick();
  assert.ok(store.all().some((message) => message.triage?.source === "ai"), "it resumes after the wait");
});

test("runs are coalesced: a lone fresh mail waits for more mail, ten minutes, or someone opening the inbox", async (t) => {
  const { store, kick, advance, calls } = clocked(t, answerAll);
  store.put([mail("fresh", { triageQueue: { state: "pending", attempts: 0, updatedAt: NOW.toISOString() } })]);
  await kick();
  assert.equal(calls(), 0);
  await kick({ now: true });
  assert.equal(calls(), 1, "the inbox being read triages at once");
  store.put([mail("later", { triageQueue: { state: "pending", attempts: 0, updatedAt: NOW.toISOString() } })]);
  await kick();
  assert.equal(calls(), 1);
  advance(10 * 60_000);
  await kick();
  assert.equal(calls(), 2, "the oldest waited ten minutes");
  store.put(Array.from({ length: 5 }, (_, index) => mail(`n${index}`, { triageQueue: { state: "pending", attempts: 0, updatedAt: new Date(NOW.getTime() + 10 * 60_000).toISOString() } })));
  await kick();
  assert.equal(calls(), 3, "five waiting is enough");
});

test("model date-times without an offset are wall-clock time in the user's zone; the prompt names that zone's offset", () => {
  assert.deepEqual(parseDay("2026-10-20T23:00", "Asia/Taipei"), { day: "2026-10-20", time: "23:00" });
  assert.deepEqual(parseDay("2026-10-20T23:59:00", "Asia/Taipei"), { day: "2026-10-20", time: "23:59" });
  assert.deepEqual(parseDay("2026-10-20T14:00+08:00", "Asia/Taipei"), { day: "2026-10-20", time: "14:00" });
  assert.deepEqual(parseDay("2026-10-20T06:00Z", "Asia/Taipei"), { day: "2026-10-20", time: "14:00" }, "an explicit offset is taken as written");
  assert.equal(parseDay("2026-10-20T25:00", "Asia/Taipei"), undefined);
  assert.equal(offsetText("Asia/Taipei", NOW), "+08:00");
  assert.equal(offsetText("America/Los_Angeles", NOW), "-07:00");
  assert.match(triagePrompt("-07:00"), /YYYY-MM-DDTHH:MM-07:00/);
  assert.doesNotMatch(triagePrompt("-07:00"), /\+08:00/);
});

test("an event the model writes without an offset becomes a suggestion at that local time", async (t) => {
  const { services, store } = stubbed(t, () => ({
    items: [item("kktix", { category: "event", action: "calendar", priority: "low" })], todos: [],
    events: [{ sourceId: "kktix", title: "SITCON", start: "2026-10-24T14:00", end: "2026-10-24T17:00", location: null }],
    assignments: [],
  }));
  store.put([mail("kktix")]);
  await runTriage(services, store, new AbortController().signal);
  const [suggestion] = services.suggestions.list({ kind: "event" }) as Array<{ payload: EventSuggestion }>;
  assert.equal(suggestion.payload.start, "2026-10-24T06:00:00.000Z");
  assert.equal(suggestion.payload.end, "2026-10-24T09:00:00.000Z");
});
