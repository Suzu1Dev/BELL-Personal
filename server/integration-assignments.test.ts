/**
 * Assignments from mail on the demo day (SPEC-mail-assignments §5, §13),
 * every feature module registered as in production: the seeded HW5
 * suggestion from 林志明 教授's mail, the Lab 3 assignment already added from
 * 王助教's mail, and the manual 專題提案書 — across Today, #/work, the
 * calendar and the actions (加入作業, 轉成作業, 標為已交, 復原). Nothing
 * reaches Google or a model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_HW5_MAIL, DEMO_HW5_SUGGESTION, DEMO_LAB3_ASSIGNMENT, DEMO_LAB3_MAIL, DEMO_PROPOSAL_ASSIGNMENT } from "../scripts/seed-demo-assignments.js";
import { seedDemo } from "../scripts/seed-demo.js";
import type { AssignmentsResponse } from "../shared/assignments.js";
import type { CalendarResponse } from "../shared/calendar.js";
import type { MailMessage } from "../shared/mail.js";
import type { TodayPayload } from "../shared/today.js";
import type { FetchLike } from "./sync.js";
import { featureModules } from "./features/index.js";
import { ruleAssignmentSuggestions } from "./features/gmail/triage-assignments.js";
import { MailStore } from "./features/gmail/store.js";
import { startTestServer, testServices } from "./test-helpers.js";

const NOW = new Date("2026-10-12T08:42:00+08:00");
const TZ = "Asia/Taipei";

async function setup(t: test.TestContext) {
  const outbound: string[] = [];
  const fetch: FetchLike = async (input) => {
    outbound.push(String(input));
    return new Response("{}", { status: 404 });
  };
  const services = testServices(t, { seams: { fetch, now: () => NOW } });
  seedDemo(services.db, { now: NOW, timeZone: TZ });
  const server = await startTestServer(t, services, { modules: featureModules });
  const today = async () => {
    const response = await server.call("GET", "/api/today");
    assert.equal(response.status, 200, response.text);
    return response.json as TodayPayload;
  };
  const work = async () => (await server.call("GET", "/api/lms/assignments")).json as AssignmentsResponse;
  const act = async (itemId: string, action: string) => {
    const response = await server.call("POST", "/api/actions", { body: { itemId, action } });
    assert.equal(response.status, 202, response.text);
    return response.json as { actionId: string; label: string };
  };
  const undo = async (actionId: string) => assert.equal((await server.call("DELETE", `/api/actions/${actionId}`, { body: {} })).status, 200);
  return { services, server, outbound, today, work, act, undo };
}

const rowOf = (payload: TodayPayload, id: string) => payload.queue.flatMap((group) => group.items.map((item) => ({ ...item, group: group.group }))).find((item) => item.id === id);

test("the seeded day: the HW5 suggestion, Lab 3 from mail and the manual proposal on Today, #/work and the calendar", async (t) => {
  const { server, today, work, outbound, services } = await setup(t);
  const payload = await today();
  const hw5 = rowOf(payload, `ai:${DEMO_HW5_SUGGESTION}`)!;
  assert.deepEqual({ group: hw5.group, kind: hw5.kind, title: hw5.title, meta: hw5.meta, actions: hw5.actions.map((action) => [action.label, action.key]) }, {
    group: "today", kind: "suggestion.assignment", title: "從信件找到 1 份作業，要加入嗎？",
    meta: ["HW5：系統呼叫實作", "作業系統", "週五 23:59 截止", "來自 林志明 教授 信件"], actions: [["加入作業", "A"], ["略過", "E"]],
  });
  const lab3 = rowOf(payload, DEMO_LAB3_ASSIGNMENT)!;
  assert.deepEqual({ group: lab3.group, source: lab3.source, title: lab3.title, meta: lab3.meta, url: lab3.url, primary: lab3.actions[0].label }, {
    group: "later", source: "assignment", title: "計算機網路 Lab 3：封包分析報告", meta: ["信件", "計算機網路", "週日 12:00 截止", "尚未繳交"],
    url: `#/inbox/${DEMO_LAB3_MAIL}`, primary: "開啟信件",
  });
  assert.equal(rowOf(payload, DEMO_PROPOSAL_ASSIGNMENT), undefined, "due in 10 days: #/work only");
  assert.equal(rowOf(payload, `gmail:${DEMO_HW5_MAIL}`), undefined, "the suggestion stands for its mail");
  assert.equal(payload.counts.nav?.work, 4, "HW3, Lab 2, Lab 3 and the PR review");

  const list = await work();
  const lab3Row = list.assignments.find((row) => row.id === DEMO_LAB3_ASSIGNMENT)!;
  assert.deepEqual([lab3Row.status, lab3Row.mailSender, lab3Row.site?.label], ["open", "王助教", "信件"]);
  const proposal = list.assignments.find((row) => row.id === DEMO_PROPOSAL_ASSIGNMENT)!;
  assert.deepEqual([proposal.origin, proposal.courseName, proposal.dueDateOnly, proposal.site?.label], ["manual", "未分類", true, "手動"]);
  assert.deepEqual(list.suggestions?.map((row) => row.itemId), [`ai:${DEMO_HW5_SUGGESTION}`]);
  assert.deepEqual(list.assignments.map((row) => row.origin), ["moodle", "moodle", "mail", "manual", "moodle"], "due soonest first across origins");

  const day = (await server.call("GET", "/api/calendar?view=day&day=2026-10-18")).json as CalendarResponse;
  assert.deepEqual(day.days[0].items.filter((item) => item.kind === "due").map((item) => [item.title, item.meta, item.url]),
    [["Lab 3 截止", "計算機網路 · 信件", `https://mail.google.com/mail/u/0/#inbox/${DEMO_LAB3_MAIL}`]]);

  // The rule fallback finds nothing new: the HW5 mail has its suggestion, the Lab 3 mail its assignment.
  services.settings.update({ "ai.enabled": false });
  assert.equal(ruleAssignmentSuggestions(services, new MailStore(services.sourceItems)), 0);
  assert.equal(outbound.length, 0, "nothing left the machine");
});

test("加入作業 on the HW5 suggestion: the row becomes an assignment on Today and #/work; 復原 puts the suggestion back", async (t) => {
  const { today, work, act, undo } = await setup(t);
  const added = await act(`ai:${DEMO_HW5_SUGGESTION}`, "assignment");
  assert.equal(added.label, "已加入作業");
  const after = await today();
  assert.equal(rowOf(after, `ai:${DEMO_HW5_SUGGESTION}`), undefined);
  const created = (await work()).assignments.find((row) => row.origin === "mail" && row.title === "HW5：系統呼叫實作")!;
  assert.deepEqual([created.courseName, created.dueAt, created.submitHint, created.mailRef?.threadId], ["作業系統", "2026-10-16T15:59:00.000Z", "上傳到 E3", DEMO_HW5_MAIL]);
  const row = rowOf(after, created.id)!;
  assert.deepEqual([row.group, row.title, row.url], ["later", "作業系統 HW5：系統呼叫實作", `#/inbox/${DEMO_HW5_MAIL}`]);
  assert.equal(after.counts.nav?.work, 5);
  assert.equal(after.handled?.[0]?.title, "HW5：系統呼叫實作", "the handled list names the assignment, not the question");
  assert.deepEqual((await work()).suggestions, []);

  await undo(added.actionId);
  assert.ok(rowOf(await today(), `ai:${DEMO_HW5_SUGGESTION}`));
  assert.ok(!(await work()).assignments.some((item) => item.id === created.id));
});

test("轉成作業 on a mail #/inbox lists, 標為已交 on the new row, and 略過 on the suggestion", async (t) => {
  const { today, work, act, undo, services } = await setup(t);
  // The school notice is not an assignment, but the owner decides: the rules make a draft at once.
  const converted = await act("gmail:demo-school-1", "assignment");
  const notice = (await work()).assignments.find((row) => row.mailRef?.messageId === "demo-school-1")!;
  const mail = services.sourceItems.get<MailMessage>("gmail", "demo-school-1")!.value;
  assert.deepEqual([notice.title, notice.courseName, notice.dueAt, notice.dueDateOnly, notice.mailSender], ["本學期停修申請期間", "未分類", "2026-10-30T15:59:00.000Z", true, mail.from.name]);
  assert.ok(mail.labels.includes("INBOX"), "Gmail is untouched");

  const marked = await act(notice.itemId, "submitted");
  assert.equal((await work()).assignments.find((row) => row.id === notice.id)?.status, "submitted");
  await undo(marked.actionId);
  assert.equal((await work()).assignments.find((row) => row.id === notice.id)?.status, "open");
  await undo(converted.actionId);
  assert.ok(!(await work()).assignments.some((row) => row.id === notice.id));

  await act(`ai:${DEMO_HW5_SUGGESTION}`, "dismiss");
  assert.deepEqual((await work()).suggestions, []);
  assert.equal(rowOf(await today(), `ai:${DEMO_HW5_SUGGESTION}`), undefined);
});

test("after 加入作業 on the HW5 suggestion, its mail's inbox row and reader say 已轉成作業 and offer no 轉成作業", async (t) => {
  const { server, act } = await setup(t);
  const before = (await server.call("GET", `/api/gmail/threads/${DEMO_HW5_MAIL}`)).json;
  assert.ok(before.thread.actions.some((action: { id: string }) => action.id === "assignment"));
  await act(`ai:${DEMO_HW5_SUGGESTION}`, "assignment");
  const inbox = (await server.call("GET", "/api/gmail/threads")).json as { threads: Array<{ messageId: string; converted?: boolean; actions: Array<{ id: string }> }> };
  const row = inbox.threads.find((thread) => thread.messageId === DEMO_HW5_MAIL)!;
  assert.equal(row.converted, true);
  assert.ok(!row.actions.some((action) => action.id === "assignment"), "A would only answer 「這封信已經轉成作業了。」");
  const reader = (await server.call("GET", `/api/gmail/threads/${DEMO_HW5_MAIL}`)).json;
  assert.deepEqual([reader.thread.converted, reader.thread.actions.some((action: { id: string }) => action.id === "assignment")], [true, false]);
});
