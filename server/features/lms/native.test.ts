import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Assignment, AssignmentView, AssignmentsResponse } from "../../../shared/assignments.js";
import type { MailMessage } from "../../../shared/mail.js";
import type { AssignmentSuggestion } from "../../../shared/suggestions.js";
import type { TodayPayload } from "../../../shared/today.js";
import { createServices, type CoreServices } from "../../services.js";
import { allFeatures, fakeCommand, startTestServer, tempDir, testConfig } from "../../test-helpers.js";
import { lmsModule } from "./index.js";
import { assignmentRows } from "./moodle.js";
import { localAssignments, mergeAssignments } from "./native.js";
import { MOODLE_NOW as NOW } from "./test-support.js";
import { lmsToday } from "./today.js";

/** Monday 2026-10-12 08:42 in Taipei. */
const TZ = "Asia/Taipei";

function moodle(externalId: string, title: string, dueAt: string, extra: Partial<Assignment> = {}): Assignment {
  return {
    id: `moodle:${externalId}`, origin: "moodle", externalId, courseName: "作業系統", title, dueAt,
    url: `https://e3p.nycu.edu.tw/mod/assign/view.php?id=${externalId}`, submission: "not-submitted", updatedAt: NOW.toISOString(), ...extra,
  };
}

function mail(id: string, extra: Partial<MailMessage> = {}): MailMessage {
  return {
    id, threadId: `t-${id}`, from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "【作業系統】HW5 公告",
    snippet: "HW5：系統呼叫實作…", excerpt: "HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。",
    receivedAt: "2026-10-12T00:10:00.000Z", unread: false, labels: ["INBOX"], webUrl: `https://mail.google.com/mail/u/0/#inbox/t-${id}`, ...extra,
  };
}

async function setup(t: test.TestContext, options: { v1?: boolean } = {}) {
  const dir = tempDir(t);
  if (options.v1) {
    // A database written by the first release, upgraded at boot through every later step (v4: local_assignments).
    mkdirSync(join(dir, "data"), { recursive: true, mode: 0o700 });
    const raw = new DatabaseSync(join(dir, "data", "personal.sqlite"));
    raw.exec(readFileSync(new URL("../../fixtures/personal.v1.sql", import.meta.url), "utf8"));
    raw.close();
  }
  const services = createServices(testConfig(dir), { command: fakeCommand(() => undefined).runner, now: () => NOW });
  t.after(() => services.close());
  allFeatures(services);
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const list = async () => (await server.call("GET", "/api/lms/assignments")).json as AssignmentsResponse;
  const act = (itemId: string, action: string) => server.call("POST", "/api/actions", { body: { itemId, action } });
  const today = async () => (await server.call("GET", "/api/today")).json as TodayPayload;
  return { services, server, list, act, today };
}

const uuidOf = (row: Pick<AssignmentView, "id">) => row.id.slice("assignment:".length);
const queueIds = (payload: TodayPayload) => payload.queue.flatMap((group) => group.items.map((item) => item.id));

test("新增作業, 編輯 and 刪除作業 with 復原, on a database upgraded from v1", async (t) => {
  const { server, list } = await setup(t, { v1: true });
  const created = await server.call("POST", "/api/lms/assignments", { body: { title: " 專題提案書 ", dueAt: "2026-10-22T15:59:00.000Z", dueDateOnly: true, notes: "一頁 A4" } });
  assert.equal(created.status, 201, created.text);
  const row = created.json as AssignmentView;
  assert.match(row.id, /^assignment:[0-9a-f-]{36}$/);
  assert.equal(row.itemId, row.id, "the Today item id is the record id");
  assert.equal(row.externalId, uuidOf(row));
  assert.deepEqual({ origin: row.origin, title: row.title, courseName: row.courseName, site: row.site, status: row.status, dueDateOnly: row.dueDateOnly, submission: row.submission },
    { origin: "manual", title: "專題提案書", courseName: "未分類", site: { label: "手動", short: "手動" }, status: "open", dueDateOnly: true, submission: "not-submitted" });

  const blank = await server.call("POST", "/api/lms/assignments", { body: { title: "  " } });
  assert.deepEqual([blank.status, blank.json.error], [400, "作業名稱不能是空白。"]);
  const http = await server.call("POST", "/api/lms/assignments", { body: { title: "HW", url: "http://example.com" } });
  assert.equal(http.status, 400);
  assert.match(http.json.error, /連結必須是 https:\/\/ 開頭的網址/);
  assert.equal((await server.call("POST", "/api/lms/assignments", { body: { title: "HW", origin: "mail" } })).status, 400, "strict bodies");

  const edited = await server.call("PATCH", `/api/lms/assignments/${encodeURIComponent(row.id)}`, {
    body: { courseName: "作業系統", dueAt: "2026-10-22T10:00:00.000Z", dueDateOnly: false, url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=9", submitHint: "紙本交到系辦" },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual([edited.json.courseName, edited.json.dueAt, edited.json.dueDateOnly, edited.json.url], ["作業系統", "2026-10-22T10:00:00.000Z", undefined, "https://e3p.nycu.edu.tw/mod/assign/view.php?id=9"]);
  const cleared = await server.call("PATCH", `/api/lms/assignments/${uuidOf(row)}`, { body: { submitHint: null, courseName: "", dueAt: null } });
  assert.deepEqual([cleared.json.submitHint, cleared.json.courseName, cleared.json.dueAt, cleared.json.notes], [undefined, "未分類", null, "一頁 A4"]);
  assert.equal((await server.call("PATCH", `/api/lms/assignments/${uuidOf(row)}`, { body: { title: "" } })).json.error, "作業名稱不能是空白。");
  const lms = await server.call("PATCH", "/api/lms/assignments/moodle:30512", { body: { title: "x" } });
  assert.deepEqual([lms.status, lms.json.error], [409, "學校系統的作業不能在這裡修改。"]);
  const missing = await server.call("PATCH", "/api/lms/assignments/00000000-0000-4000-8000-000000000000", { body: { title: "x" } });
  assert.deepEqual([missing.status, missing.json.error], [404, "找不到這份作業。"]);

  const deleted = await server.call("DELETE", `/api/lms/assignments/${uuidOf(row)}`, { body: {} });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(deleted.json.deleted, true);
  assert.equal((await list()).assignments.length, 0);
  const restored = await server.call("POST", "/api/trash/restore", { body: { token: deleted.json.undoToken } });
  assert.equal(restored.status, 200, restored.text);
  assert.deepEqual((await list()).assignments.map((item) => [item.id, item.title]), [[row.id, "專題提案書"]], "復原 brings it back as it was");
});

test("GET /api/lms/assignments: E3 and native rows together; a mail assignment E3 also lists shows once", async (t) => {
  const { services, list } = await setup(t);
  services.sourceItems.replace("moodle", "assignment", assignmentRows([
    moodle("30512", "HW3：CPU Scheduling 模擬", "2026-10-12T15:59:00.000Z"),
    moodle("30950", "HW5：System Calls", "2026-10-16T15:59:00.000Z"),
  ]));
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "lab3", value: mail("lab3", { from: { name: "王助教", email: "ta-net@cs.nycu.edu.tw" } }) }]);
  const store = localAssignments(services);
  const ref = (id: string) => ({ messageId: id, threadId: `t-${id}`, url: `https://mail.google.com/mail/u/0/#inbox/t-${id}` });
  store.create({ origin: "mail", title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", mailRef: ref("hw5") });
  const lab3 = store.create({ origin: "mail", title: "Lab 3", courseName: "計算機網路", dueAt: "2026-10-18T04:00:00.000Z", mailRef: ref("lab3") });
  const later = store.create({ origin: "manual", title: "讀書心得", dueAt: null });
  services.suggestions.create<AssignmentSuggestion>({
    kind: "assignment", title: "期末報告", payload: { title: "期末報告", dueAt: "2026-12-20T15:59:00.000Z", dueDay: "2026-12-20", detectedBy: "rule" },
    sourceRef: { source: "gmail", externalId: "final", url: "https://mail.google.com/mail/u/0/#inbox/final" }, dedupeKey: "mail-assignment:final", origin: "陳老師 信件",
  });

  const body = await list();
  assert.deepEqual(body.assignments.map((row) => row.id), ["moodle:30512", "moodle:30950", lab3.id, later.id], "the HW5 mail is the E3 row; undated last");
  const e3HW5 = body.assignments[1];
  assert.equal(e3HW5.mailRef?.messageId, "hw5", "the E3 row keeps the mail that announced it");
  assert.equal(body.assignments[2].mailSender, "王助教", "read from the mail cache, never stored");
  assert.equal(body.assignments[2].site?.label, "信件");
  assert.equal(body.assignments[3].mailSender, undefined);
  assert.equal(body.suggestions?.length, 1);
  const [suggestion] = body.suggestions!;
  assert.match(suggestion.itemId, /^ai:/);
  assert.equal(suggestion.title, "從信件找到 1 份作業，要加入嗎？");
  assert.deepEqual(suggestion.meta, ["期末報告", "12/20 截止", "來自 陳老師 信件", "規則判斷"]);
  assert.deepEqual(suggestion.actions.map((action) => [action.id, action.label]), [["assignment", "加入作業"], ["dismiss", "略過"]]);
});

test("mergeAssignments keeps manual ones and mail ones another course announced", () => {
  const e3 = moodle("1", "HW5", "2026-10-16T15:59:00.000Z");
  const native = (title: string, courseName: string, origin: "mail" | "manual" = "mail"): Assignment => ({
    id: `assignment:${title}-${courseName}`, origin, externalId: title, courseName, title, dueAt: "2026-10-16T15:59:00.000Z", submission: "not-submitted", updatedAt: NOW.toISOString(),
  });
  const merged = mergeAssignments([e3], [native("HW5", "作業系統", "manual"), native("HW5", "計算機網路"), native("HW5：Syscalls", "作業系統")]);
  assert.deepEqual(merged.native.map((row) => row.id), ["assignment:HW5-作業系統", "assignment:HW5-計算機網路"]);
  assert.equal(merged.duplicates.get("moodle:1")?.title, "HW5：Syscalls");
});

test("today(): native rows behave like E3 ones, open their mail in the app, and a duplicate shows once", (t) => {
  const services = createServices(testConfig(tempDir(t)), { command: fakeCommand(() => undefined).runner, now: () => NOW });
  t.after(() => services.close());
  services.sourceItems.replace("moodle", "assignment", assignmentRows([moodle("30950", "HW5：System Calls", "2026-10-16T15:59:00.000Z")]));
  const store = localAssignments(services);
  store.create({ origin: "mail", title: "HW5", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", mailRef: { messageId: "hw5", threadId: "t-hw5", url: "https://mail.google.com/" } });
  const lab3 = store.create({ origin: "mail", title: "Lab 3：封包分析", courseName: "計算機網路", dueAt: "2026-10-13T04:00:00.000Z", mailRef: { messageId: "lab3", threadId: "t-lab3", url: "https://mail.google.com/" } });
  const proposal = store.create({ origin: "manual", title: "專題提案書", dueAt: "2026-10-12T15:59:00.000Z", dueDateOnly: true });
  store.create({ origin: "manual", title: "沒有期限", dueAt: null });

  const today = lmsToday(services, { now: NOW, timeZone: TZ, day: "2026-10-12" });
  assert.deepEqual(today.queue!.map((row) => row.id).sort(), ["moodle:30950", lab3.id, proposal.id].sort(), "no deadline: #/work only; the HW5 mail is E3's row");
  const row = (id: string) => today.queue!.find((entry) => entry.id === id)!;
  const lab3Row = row(lab3.id);
  assert.deepEqual({ source: lab3Row.source, kind: lab3Row.kind, title: lab3Row.title, meta: lab3Row.meta, url: lab3Row.url },
    { source: "assignment", kind: "assignment", title: "計算機網路 Lab 3：封包分析", meta: ["信件", "計算機網路", "明天 12:00 截止", "尚未繳交"], url: "#/inbox/t-lab3" });
  assert.deepEqual(lab3Row.actions.map((action) => [action.id, action.label, action.touchLabel]), [["open", "開啟信件", "開啟"], ["submitted", "標為已交", "已交"], ["snooze", "延後", "延後"]]);
  assert.deepEqual(lab3Row.hints, { dueAt: "2026-10-13T04:00:00.000Z", hardDeadline: true, fingerprint: "2026-10-13T04:00:00.000Z|not-submitted" });
  const proposalRow = row(proposal.id);
  assert.deepEqual({ title: proposalRow.title, meta: proposalRow.meta, url: proposalRow.url, open: proposalRow.actions[0].label },
    { title: "專題提案書", meta: ["手動", "今晚 23:59 截止", "尚未繳交"], url: "#/work", open: "開啟" });
  assert.deepEqual(today.agenda, [{ start: "2026-10-12T15:59:00.000Z", title: "專題提案書 截止", meta: "手動", kind: "due", itemId: proposal.id }]);
  assert.deepEqual(today.gapCandidates?.map((gap) => gap.label).sort(), ["適合寫 Lab 3", "適合寫 專題提案書"]);
  assert.deepEqual(today.later?.events?.map((event) => [event.title, event.meta]), [["HW5 截止", "作業系統 · NYCU E3"], ["Lab 3 截止", "計算機網路 · 信件"]]);
  assert.equal(today.nav?.work, 3);
});

test("標為已交 on a native row reads 已繳交, and editing the deadline brings it back", async (t) => {
  const { server, list, act, today } = await setup(t);
  const created = (await server.call("POST", "/api/lms/assignments", { body: { title: "HW1", courseName: "演算法", dueAt: "2026-10-14T15:59:00.000Z" } })).json as AssignmentView;
  assert.ok(queueIds(await today()).includes(created.id));
  const marked = await act(created.id, "submitted");
  assert.equal(marked.status, 202, marked.text);
  const after = (await list()).assignments[0];
  assert.deepEqual([after.status, typeof after.localSubmittedAt], ["submitted", "string"], "D7: no LMS will ever agree, so it is 已繳交");
  assert.ok(!queueIds(await today()).includes(created.id));
  assert.equal((await today()).counts.nav?.work, 0);
  await server.call("PATCH", `/api/lms/assignments/${uuidOf(created)}`, { body: { dueAt: "2026-10-15T15:59:00.000Z" } });
  assert.equal((await list()).assignments[0].status, "open", "a new deadline is a new assignment to hand in");
  assert.ok(queueIds(await today()).includes(created.id));

  // A row Today did not serve (due in 20 days): the handler describes it so the fingerprint is kept.
  const far = (await server.call("POST", "/api/lms/assignments", { body: { title: "期末報告", dueAt: "2026-11-01T15:59:00.000Z" } })).json as AssignmentView;
  assert.equal((await act(far.id, "submitted")).status, 202);
  assert.equal((await list()).assignments.find((row) => row.id === far.id)?.status, "submitted");
  const other = (await server.call("POST", "/api/lms/assignments", { body: { title: "Lab 1", dueAt: "2026-10-13T15:59:00.000Z" } })).json as AssignmentView;
  assert.equal((await act(other.id, "archive")).status, 400, "an assignment is never archived");
  assert.equal((await act("assignment:00000000-0000-4000-8000-000000000000", "submitted")).status, 404);
});

test("轉成作業 on a cached mail: created at once from the rules, one per mail, 復原 deletes it", async (t) => {
  const { services, server, list, act } = await setup(t);
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "hw5", value: mail("hw5") }]);
  const converted = await act("gmail:hw5", "assignment");
  assert.equal(converted.status, 202, converted.text);
  assert.equal(converted.json.label, "已轉成作業");
  const [row] = (await list()).assignments;
  assert.deepEqual({ origin: row.origin, title: row.title, courseName: row.courseName, dueAt: row.dueAt, submitHint: row.submitHint, mailRef: row.mailRef, mailSender: row.mailSender }, {
    origin: "mail", title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", submitHint: "上傳至 E3",
    mailRef: { messageId: "hw5", threadId: "t-hw5", url: "https://mail.google.com/mail/u/0/#inbox/t-hw5" }, mailSender: "林志明 教授",
  });
  assert.equal((await act("gmail:hw5", "assignment")).status, 409, "a double press inside the undo window");
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "lab3", value: mail("lab3") }]);
  localAssignments(services).create({ origin: "mail", title: "Lab 3", dueAt: null, mailRef: { messageId: "lab3", threadId: "t-lab3", url: "https://mail.google.com/" } });
  const again = await act("gmail:lab3", "assignment");
  assert.deepEqual([again.status, again.json.error], [409, "這封信已經轉成作業了。"]);
  const handled = services.itemState.get("gmail:hw5");
  assert.equal(handled?.state, "handled", "the mail's Today row closes like 轉待辦");
  assert.equal(services.db.personal.db.prepare("SELECT title FROM action_log WHERE item_id = 'gmail:hw5'").get()?.title, "HW5：系統呼叫實作", "the handled list names the assignment");

  assert.equal((await server.call("DELETE", `/api/actions/${converted.json.actionId}`, { body: {} })).status, 200);
  assert.deepEqual((await list()).assignments.map((item) => item.mailRef?.messageId), ["lab3"], "復原 deletes it");
  assert.equal(services.itemState.get("gmail:hw5"), undefined);
  assert.equal((await act("gmail:hw5", "assignment")).status, 202, "and it can be converted again");

  const notMail = await act("moodle:30512", "assignment");
  assert.deepEqual([notMail.status, notMail.json.error], [400, "這個項目不能轉成作業。"]);
  assert.equal((await act("gmail:digest", "assignment")).status, 400);
  const gone = await act("gmail:missing", "assignment");
  assert.deepEqual([gone.status, gone.json.error], [404, "找不到這封信，沒有建立作業。"]);
});

test("轉成作業 on a mail with a pending suggestion takes the suggestion's fields and accepts it; 復原 reopens it", async (t) => {
  const { services, list, act, server } = await setup(t);
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "hw5", value: mail("hw5") }]);
  const suggestion = services.suggestions.create<AssignmentSuggestion>({
    kind: "assignment", title: "HW5：系統呼叫實作", payload: { title: "HW5：xv6 trace", courseName: "OS", dueAt: "2026-10-16T15:59:00.000Z", url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=7", detectedBy: "ai" },
    sourceRef: { source: "gmail", externalId: "hw5", url: "https://mail.google.com/" }, dedupeKey: "mail-assignment:hw5",
  });
  const converted = await act("gmail:hw5", "assignment");
  const [row] = (await list()).assignments;
  assert.deepEqual([row.title, row.courseName, row.url], ["HW5：xv6 trace", "OS", "https://e3p.nycu.edu.tw/mod/assign/view.php?id=7"]);
  assert.deepEqual([services.suggestions.get(suggestion.id)?.status, services.suggestions.get(suggestion.id)?.resultId], ["accepted", row.id]);
  await server.call("DELETE", `/api/actions/${converted.json.actionId}`, { body: {} });
  assert.equal(services.suggestions.get(suggestion.id)?.status, "pending");
  assert.equal((await list()).assignments.length, 0);
});

test("加入作業 from Today and from the accept endpoint: one assignment per mail, undo reopens the suggestion", async (t) => {
  const { services, server, list, act } = await setup(t);
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "lab3", value: mail("lab3", { threadId: "thread-lab3" }) }]);
  const payload: AssignmentSuggestion = { title: "Lab 3", courseName: "計算機網路", dueAt: "2026-10-21T04:00:00.000Z", submitHint: "寄給助教", detectedBy: "rule" };
  const suggestion = services.suggestions.create({ kind: "assignment", title: "Lab 3", payload, sourceRef: { source: "gmail", externalId: "lab3", url: "https://mail.google.com/lab3" }, dedupeKey: "mail-assignment:lab3" });

  const added = await act(`ai:${suggestion.id}`, "assignment");
  assert.equal(added.status, 202, added.text);
  const [row] = (await list()).assignments;
  assert.deepEqual([row.origin, row.title, row.submitHint, row.mailRef?.threadId], ["mail", "Lab 3", "寄給助教", "thread-lab3"]);
  assert.deepEqual([services.suggestions.get(suggestion.id)?.status, services.suggestions.get(suggestion.id)?.resultId], ["accepted", row.id]);
  assert.equal((await list()).suggestions?.length, 0, "the 「從信件找到」 card empties");
  await server.call("DELETE", `/api/actions/${added.json.actionId}`, { body: {} });
  assert.equal(services.suggestions.get(suggestion.id)?.status, "pending");
  assert.equal((await list()).assignments.length, 0);

  const accepted = await server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: {} });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.json.suggestion.resultId, accepted.json.result.id);
  assert.equal((await list()).assignments.length, 1);

  // Another suggestion about the same mail (made before the first was accepted) reuses the record.
  services.db.sources.db.prepare("UPDATE ai_suggestions SET dedupe_key = NULL").run();
  const twin = services.suggestions.create({ kind: "assignment", title: "Lab 3", payload, sourceRef: { source: "gmail", externalId: "lab3" }, dedupeKey: "mail-assignment:lab3" });
  const again = await server.call("POST", `/api/suggestions/${twin.id}/accept`, { body: {} });
  assert.equal(again.json.suggestion.resultId, accepted.json.result.id);
  assert.equal((await list()).assignments.length, 1, "idempotent per mail");

  const todo = services.suggestions.create({ kind: "todo", title: "交報告", payload: { title: "交報告" } });
  assert.equal((await act(`ai:${todo.id}`, "assignment")).status, 400, "加入作業 only on assignment suggestions");
});

test("native assignments survive a mail purge: they keep only ids and the Gmail link", (t) => {
  const services: CoreServices = createServices(testConfig(tempDir(t)), { command: fakeCommand(() => undefined).runner, now: () => NOW });
  t.after(() => services.close());
  const store = localAssignments(services);
  const record = store.create({ origin: "mail", title: "HW5", dueAt: null, mailRef: { messageId: "hw5", threadId: "t-hw5", url: "https://mail.google.com/" } });
  services.sourceItems.clear("gmail");
  assert.deepEqual(Object.keys(store.get(record.id)!).sort(), ["courseName", "createdAt", "dueAt", "externalId", "id", "mailRef", "origin", "site", "submission", "title", "updatedAt"]);
  assert.equal(store.byMessage("hw5")?.id, record.id);
});

test("轉成作業 on the TA's reply answers the announcement's pending suggestion; 加入作業 on a reminder reuses the assignment; the answer names what was saved", async (t) => {
  const { services, list, act, server } = await setup(t);
  services.sourceItems.upsert("gmail", [
    { kind: "mail", externalId: "announce", value: mail("announce", { threadId: "hw5-thread" }) },
    { kind: "mail", externalId: "answer", value: mail("answer", { threadId: "hw5-thread", from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "Re: 【作業系統】HW5 公告", excerpt: "可以，HW5 不限語言。" }) },
    { kind: "mail", externalId: "reminder", value: mail("reminder", { subject: "提醒：HW5 週五截止", excerpt: "HW5 本週五 23:59 截止。" }) },
  ]);
  const announced = services.suggestions.create<AssignmentSuggestion>({
    kind: "assignment", title: "HW5：系統呼叫實作", payload: { title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: "2026-10-16T15:59:00.000Z", submitHint: "上傳至 E3", detectedBy: "ai" },
    sourceRef: { source: "gmail", externalId: "announce", url: "https://mail.google.com/" }, dedupeKey: "mail-assignment:announce",
  });
  const converted = await act("gmail:answer", "assignment");
  assert.equal(converted.status, 202, converted.text);
  assert.deepEqual(converted.json.created, { title: "HW5：系統呼叫實作", dueAt: "2026-10-16T15:59:00.000Z" }, "the toast names the saved record, not the page's guess");
  const [row] = (await list()).assignments;
  assert.deepEqual([row.title, row.submitHint, row.mailRef?.messageId], ["HW5：系統呼叫實作", "上傳至 E3", "answer"]);
  assert.equal(services.suggestions.get(announced.id)?.status, "accepted", "the announcement's suggestion is answered too");

  const reminder = services.suggestions.create<AssignmentSuggestion>({
    kind: "assignment", title: "HW5", payload: { title: "HW5", dueAt: "2026-10-16T15:59:00.000Z", dueDay: "2026-10-16", detectedBy: "rule" },
    sourceRef: { source: "gmail", externalId: "reminder", url: "https://mail.google.com/" }, dedupeKey: "mail-assignment:reminder",
  });
  const added = await act(`ai:${reminder.id}`, "assignment");
  assert.equal(added.status, 202, added.text);
  assert.equal(added.json.created.title, "HW5：系統呼叫實作");
  assert.equal((await list()).assignments.length, 1, "HW5 once, not twice");
  await server.call("DELETE", `/api/actions/${added.json.actionId}`, { body: {} });
  assert.equal((await list()).assignments.length, 1, "復原 of the reuse deletes nothing");
  await server.call("DELETE", `/api/actions/${converted.json.actionId}`, { body: {} });
  assert.equal((await list()).assignments.length, 0);
  assert.equal(services.suggestions.get(announced.id)?.status, "pending", "and reopens what it answered");
});
