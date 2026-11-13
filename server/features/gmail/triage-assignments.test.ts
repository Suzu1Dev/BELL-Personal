import test from "node:test";
import assert from "node:assert/strict";
import type { Assignment } from "../../../shared/assignments.js";
import type { MailMessage } from "../../../shared/mail.js";
import type { AssignmentSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import type { StructuredRequest } from "../../ai/structured.js";
import { testServices } from "../../test-helpers.js";
import { assignmentRows } from "../lms/moodle.js";
import { localAssignments } from "../lms/native.js";
import { MailStore } from "./store.js";
import { applyAnswer, parseDay, runTriage, TRIAGE_JSON_SCHEMA, TRIAGE_PROMPT, triageAnswerSchema, type TriageAnswer } from "./triage.js";
import { RULE_PENDING_WAIT_MS, ruleAssignmentSuggestions, triageAssignmentPayload } from "./triage-assignments.js";

/** Monday 2026-10-12 08:42 in Taipei. */
const NOW = new Date("2026-10-12T00:42:00Z");
const TZ = "Asia/Taipei";
const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function mail(id: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id, threadId: `t-${id}`, from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: `主旨 ${id}`, snippet: "摘要", excerpt: "內文",
    receivedAt: at(1), unread: true, labels: ["INBOX", "UNREAD"], webUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`,
    triageQueue: { state: "pending", attempts: 0, updatedAt: at(1) }, ...extra,
  };
}

const item = (id: string): TriageAnswer["items"][number] => ({
  id, summary: "老師公告作業", category: "school", priority: "medium", action: "todo", context: "作業系統", bill: null,
});

function setup(t: test.TestContext, answer?: unknown) {
  const services = testServices(t, { seams: { now: () => NOW } });
  if (answer) {
    services.ai.runStructured = (async (request: StructuredRequest<TriageAnswer>) => {
      const value = request.schema.parse(answer);
      return { value, execution: { provider: "claude", model: "sonnet", source: "selected" }, ms: 5 };
    }) as typeof services.ai.runStructured;
  }
  return { services, store: new MailStore(services.sourceItems) };
}

const assignmentSuggestions = (services: ReturnType<typeof setup>["services"]) =>
  services.suggestions.list<AssignmentSuggestion>({ kind: "assignment" }).sort((a, b) => a.sourceRef!.externalId.localeCompare(b.sourceRef!.externalId));

test("the triage prompt and schema carry the strict assignments array", () => {
  assert.match(TRIAGE_PROMPT, /assignments：老師、助教或課程寄來/);
  assert.match(TRIAGE_PROMPT, /YYYY-MM-DDTHH:MM\+08:00/);
  const base = { items: [], todos: [], events: [] };
  assert.ok(triageAnswerSchema.safeParse({ ...base, assignments: [] }).success);
  assert.ok(!triageAnswerSchema.safeParse(base).success, "the array is required");
  assert.ok(!triageAnswerSchema.safeParse({ ...base, assignments: [{ sourceId: "a", title: "HW5", course: null, due: null, submit: null }] }).success, "every field is required");
  assert.ok(!triageAnswerSchema.safeParse({ ...base, assignments: [{ sourceId: "a", title: "HW5", course: null, due: null, submit: null, url: null, extra: 1 }] }).success, "strict");
});

test("the model's assignments become one suggestion per mail, and those mails get no todo", async (t) => {
  const { services, store } = setup(t, {
    items: [item("hw5"), item("lab3"), item("bill"), item("past"), item("blank")],
    todos: [
      { sourceId: "hw5", title: "交 HW5", due: "2026-10-16" },
      { sourceId: "bill", title: "繳電費", due: null },
    ],
    events: [],
    assignments: [
      { sourceId: "hw5", title: " HW5：系統呼叫實作 ", course: "作業系統", due: "2026-10-16T23:59", submit: "上傳到 E3", url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=1" },
      { sourceId: "hw5", title: "同一封信的第二份", course: null, due: null, submit: null, url: null },
      { sourceId: "lab3", title: "Lab 3", course: null, due: "2026-10-21", submit: null, url: "http://example.com/lab3" },
      { sourceId: "past", title: "HW1", course: null, due: "2026-10-01", submit: null, url: null },
      { sourceId: "blank", title: "   ", course: null, due: null, submit: null, url: null },
      { sourceId: "elsewhere", title: "不在這批的信", course: null, due: null, submit: null, url: null },
    ],
  });
  store.put([mail("hw5", { excerpt: "HW5 請上傳到 https://e3p.nycu.edu.tw/mod/assign/view.php?id=1 。" }), mail("lab3", { from: { name: "王助教", email: "ta-net@cs.nycu.edu.tw" } }), mail("bill"), mail("past"), mail("blank")]);
  const result = await runTriage(services, store, new AbortController().signal);
  assert.equal(result.processed, 5);

  const made = assignmentSuggestions(services);
  assert.deepEqual(made.map((suggestion) => suggestion.sourceRef?.externalId), ["hw5", "lab3"], "one per mail; past deadlines and blank titles are dropped");
  const [hw5, lab3] = made;
  assert.equal(hw5.title, "HW5：系統呼叫實作");
  assert.equal(hw5.origin, "林志明 教授 信件");
  assert.equal(hw5.modelExecution?.model, "sonnet");
  assert.deepEqual(hw5.payload, {
    title: "HW5：系統呼叫實作", dueAt: "2026-10-16T15:59:00.000Z", courseName: "作業系統", submitHint: "上傳到 E3",
    url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=1", detectedBy: "ai",
  }, "an offset-free time is Taipei wall-clock time");
  assert.deepEqual(lab3.payload, { title: "Lab 3", dueAt: "2026-10-21T15:59:00.000Z", dueDay: "2026-10-21", courseName: "作業系統", detectedBy: "ai" },
    "a date alone is 23:59 that day; the http link is dropped; the triage context fills the course");

  const todos = services.suggestions.list<TodoSuggestion>({ kind: "todo" });
  assert.deepEqual(todos.map((suggestion) => suggestion.sourceRef?.externalId), ["bill"], "the HW5 mail is offered as an assignment, not also as a todo");

  // A second answer about the same mail returns the existing suggestion (dedupe key per message).
  applyAnswer(services, store, [store.get("hw5")!], {
    items: [item("hw5")], todos: [], events: [],
    assignments: [{ sourceId: "hw5", title: "HW5 again", course: null, due: null, submit: null, url: null }],
  });
  assert.equal(assignmentSuggestions(services).length, 2);
});

test("a mail already turned into an assignment, or one E3 already lists, gets no suggestion and no todo", (t) => {
  const { services, store } = setup(t);
  store.put([mail("done"), mail("e3")]);
  localAssignments(services).create({ origin: "mail", title: "HW4", dueAt: null, mailRef: { messageId: "done", threadId: "t-done", url: "https://mail.google.com/" } });
  const e3: Assignment = {
    id: "moodle:1", origin: "moodle", externalId: "1", courseName: "作業系統", title: "HW5：System Calls", dueAt: "2026-10-16T15:59:00.000Z",
    submission: "not-submitted", updatedAt: NOW.toISOString(),
  };
  services.sourceItems.replace("moodle", "assignment", assignmentRows([e3]));
  const result = applyAnswer(services, store, [store.get("done")!, store.get("e3")!], {
    items: [item("done"), item("e3")],
    todos: [{ sourceId: "done", title: "交 HW4", due: null }, { sourceId: "e3", title: "交 HW5", due: null }],
    events: [],
    assignments: [
      { sourceId: "done", title: "HW4", course: null, due: null, submit: null, url: null },
      { sourceId: "e3", title: "HW5", course: "作業系統", due: "2026-10-16T23:59", submit: null, url: null },
    ],
  });
  assert.equal(result.suggestions, 2, "counted as assignments");
  assert.equal(services.suggestions.list().length, 0, "nothing new to decide");
});

test("triageAssignmentPayload: secret-looking links and malformed dates", () => {
  const input = { parseDue: (value: string | null) => parseDay(value, TZ) };
  const options = { timeZone: TZ, now: NOW };
  const base = { sourceId: "a", title: "HW5", course: null, due: null, submit: null, url: null };
  assert.equal(triageAssignmentPayload({ ...base, url: "https://e3p.nycu.edu.tw/?token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, input, options)?.url, undefined);
  assert.equal(triageAssignmentPayload({ ...base, url: "javascript:alert(1)" }, input, options)?.url, undefined);
  assert.equal(triageAssignmentPayload({ ...base, due: "下週三" }, input, options)?.dueAt, null, "an unreadable date is no deadline, not a dropped item");
  assert.equal(triageAssignmentPayload({ ...base, due: "2026-10-11T20:00+08:00" }, input, options)?.dueAt, "2026-10-11T12:00:00.000Z", "within a day past is kept");
  assert.equal(triageAssignmentPayload({ ...base, due: "2026-10-10" }, input, options), undefined);
});

test("rule fallback: with AI off, announcements in the inbox become rule-made suggestions once", (t) => {
  const { services, store } = setup(t);
  services.settings.update({ "ai.enabled": false });
  store.put([
    mail("hw5", { subject: "【作業系統】HW5 公告", excerpt: "HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。", receivedAt: "2026-10-12T00:10:00.000Z" }),
    mail("news", { from: { name: "iThome", email: "newsletter@ithome.com.tw" }, subject: "本週作業系統新聞", listUnsubscribe: true }),
    mail("old", { subject: "HW1 公告", excerpt: "HW1 請於 10/20 前上傳。", receivedAt: "2026-09-01T00:00:00.000Z" }),
    mail("archived", { subject: "HW2 公告", excerpt: "HW2 請於 10/20 前上傳。", labels: [] }),
  ]);
  assert.equal(ruleAssignmentSuggestions(services, store), 1);
  const [hw5] = assignmentSuggestions(services);
  assert.equal(hw5.sourceRef?.externalId, "hw5");
  assert.equal(hw5.origin, "林志明 教授 信件");
  assert.deepEqual(hw5.payload, { title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", submitHint: "上傳至 E3", detectedBy: "rule" });
  assert.equal(ruleAssignmentSuggestions(services, store), 0, "idempotent");
  services.suggestions.decide(hw5.id, "dismissed");
  assert.equal(ruleAssignmentSuggestions(services, store), 0, "略過 never comes back");
});

test("rule fallback leaves mail the model reads, and takes over mail that waited too long or failed", (t) => {
  const { services, store } = setup(t);
  const text = (code: string) => ({ subject: `${code} 公告`, excerpt: `${code} 請於 10/16 前上傳。` });
  store.put([
    mail("pending", { ...text("HW5"), triageQueue: { state: "pending", attempts: 0, updatedAt: at(0.1) } }),
    mail("ai", { ...text("HW6"), triage: { summary: "x", category: "school", priority: "low", action: "none", source: "ai", triagedAt: at(1), version: 2 }, triageQueue: { state: "done", attempts: 1, updatedAt: at(1) } }),
    mail("failed", { ...text("HW7"), triageQueue: { state: "failed", attempts: 3, updatedAt: at(1) } }),
    mail("stuck", { ...text("HW8"), triageQueue: { state: "pending", attempts: 0, updatedAt: new Date(NOW.getTime() - RULE_PENDING_WAIT_MS - 60_000).toISOString() } }),
    mail("backlog", { ...text("HW9"), triageQueue: undefined }),
  ]);
  assert.equal(ruleAssignmentSuggestions(services, store), 3);
  assert.deepEqual(assignmentSuggestions(services).map((suggestion) => suggestion.sourceRef?.externalId), ["backlog", "failed", "stuck"]);
});

test("mail the model triaged before it was asked about assignments gets the rules, once", (t) => {
  const { services, store } = setup(t);
  const triaged = (version?: number) => ({ summary: "x", category: "school" as const, priority: "low" as const, action: "none" as const, source: "ai" as const, triagedAt: at(30), ...(version ? { version } : {}) });
  store.put([
    mail("before", { subject: "【作業系統】HW5 公告", excerpt: "HW5 請於 10/16 前上傳。", triage: triaged(), triageQueue: { state: "done", attempts: 1, updatedAt: at(30) } }),
    mail("after", { subject: "【計算機網路】HW2 公告", excerpt: "HW2 請於 10/16 前上傳。", triage: triaged(2), triageQueue: { state: "done", attempts: 1, updatedAt: at(1) } }),
  ]);
  assert.equal(ruleAssignmentSuggestions(services, store), 1);
  assert.deepEqual(assignmentSuggestions(services).map((suggestion) => suggestion.sourceRef?.externalId), ["before"], "the model never read 「before」 for assignments; it did read 「after」");
  assert.equal(ruleAssignmentSuggestions(services, store), 0);
});

test("an announcement, a classmate's question, the TA's reply and a reminder are one HW5 suggestion", (t) => {
  const { services, store } = setup(t);
  services.settings.update({ "ai.enabled": false });
  const thread = "t-hw5-os";
  store.put([
    mail("announce", { threadId: thread, subject: "【作業系統】HW5 公告", excerpt: "HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。", receivedAt: "2026-10-12T00:10:00.000Z" }),
    mail("question", { threadId: thread, from: { name: "同學", email: "student@nycu.edu.tw" }, subject: "Re: 【作業系統】HW5 公告", excerpt: "請問 HW5 可以用 C++ 寫嗎？", receivedAt: "2026-10-12T00:20:00.000Z" }),
    mail("answer", { threadId: thread, from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "Re: 【作業系統】HW5 公告", excerpt: "可以，HW5 不限語言。", receivedAt: "2026-10-12T00:30:00.000Z" }),
    // A reminder in a conversation of its own, without the course tag.
    mail("reminder", { from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "提醒：HW5 週五截止", excerpt: "HW5 本週五 23:59 截止，請記得上傳。", receivedAt: "2026-10-12T00:40:00.000Z" }),
  ]);
  assert.equal(ruleAssignmentSuggestions(services, store), 1);
  assert.deepEqual(assignmentSuggestions(services).map((suggestion) => suggestion.sourceRef?.externalId), ["announce"]);

  // The model's answer about the reminder adds nothing either, nor about the TA's reply once the assignment exists.
  localAssignments(services).create({ origin: "mail", title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", mailRef: { messageId: "announce", threadId: thread, url: "https://mail.google.com/" } });
  services.suggestions.decide(assignmentSuggestions(services)[0].id, "accepted");
  applyAnswer(services, store, [store.get("reminder")!, store.get("answer")!], {
    items: [item("reminder"), item("answer")], todos: [], events: [],
    assignments: [
      { sourceId: "reminder", title: "HW5", course: "作業系統", due: "2026-10-16T23:59", submit: null, url: null },
      { sourceId: "answer", title: "HW5", course: null, due: null, submit: null, url: null },
    ],
  });
  assert.equal(assignmentSuggestions(services).length, 1, "no duplicate HW5");
});

test("the model's link is kept only when the cited mail carries it; a long link drops alone, never the batch", async (t) => {
  const longLink = `https://forms.gle/${"a".repeat(700)}`;
  const { services, store } = setup(t, {
    items: [item("own"), item("other"), item("long")], todos: [], events: [],
    assignments: [
      { sourceId: "own", title: "HW5", course: "作業系統", due: null, submit: null, url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=5" },
      { sourceId: "other", title: "HW6", course: "作業系統", due: null, submit: null, url: "https://e3-nycu-login.example/submit" },
      { sourceId: "long", title: "HW7", course: "作業系統", due: null, submit: "x".repeat(300), url: longLink },
    ],
  });
  store.put([
    mail("own", { excerpt: "請上傳到 https://e3p.nycu.edu.tw/mod/assign/view.php?id=5。" }),
    mail("other", { excerpt: "HW6 已公布。" }),
    mail("long", { excerpt: `表單 ${longLink}` }),
  ]);
  const result = await runTriage(services, store, new AbortController().signal);
  assert.equal(result.processed, 3, "a 700-character link does not fail the batch");
  const byMail = new Map(assignmentSuggestions(services).map((suggestion) => [suggestion.sourceRef!.externalId, suggestion.payload]));
  assert.equal(byMail.get("own")?.url, "https://e3p.nycu.edu.tw/mod/assign/view.php?id=5");
  assert.equal(byMail.get("other")?.url, undefined, "a link the mail does not carry is never kept");
  assert.equal(byMail.get("long")?.url, undefined);
  assert.equal(byMail.get("long")?.submitHint?.length, 120);
  // The model is still told the §5.3 limits.
  const schema = JSON.stringify(TRIAGE_JSON_SCHEMA);
  assert.match(schema, /"url":\{"anyOf":\[\{"type":"string","maxLength":500\}/);
});
