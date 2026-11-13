import assert from "node:assert/strict";
import test from "node:test";
import type { AiSuggestion, TodoSuggestion } from "../../../shared/suggestions.js";
import type { Todo, TodoListResponse } from "../../../shared/todos.js";
import type { QueueCandidate, TodayPayload } from "../../../shared/today.js";
import { queueAction } from "../../../shared/today-format.js";
import type { FeatureModule } from "../../modules.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { dueFromInstant } from "./actions.js";
import { todosModule } from "./index.js";
import { todoStore } from "./store.js";
import { gapLabel, todosToday } from "./today.js";

const taipei = (local: string) => new Date(`${local}:00+08:00`);
/** Monday 2026-10-12 08:42 in Taipei (SPEC §13). */
const NOW = taipei("2026-10-12T08:42");

function services(t: test.TestContext, now = NOW) {
  let current = now;
  const value = testServices(t, { seams: { now: () => current } });
  return { services: value, setNow: (next: Date) => { current = next; } };
}

/** A gmail-like stub with one bill row offering 轉待辦. */
const billModule: FeatureModule = {
  name: "mail-stub",
  setup() {
    const bill: QueueCandidate = {
      id: "gmail:bill-1", kind: "mail.bill", source: "gmail", title: "中華電信 9 月帳單 NT$599", meta: ["帳單"],
      summary: "9 月電信費 NT$599，10/20 前繳。", url: "https://mail.google.com/mail/u/0/#inbox/bill-1",
      actions: [queueAction("todo", { label: "轉成待辦" }), queueAction("archive"), queueAction("snooze")],
      hints: { dueAt: taipei("2026-10-20T23:59").toISOString(), hardDeadline: true },
    };
    return { today: () => ({ queue: [bill] }) };
  },
};

test("todos CRUD: create, list with today's finished, patch, validation", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const created = await server.call("POST", "/api/todos", { body: { title: "  交 HW3  ", dueDay: "2026-10-12", dueTime: "23:59", priority: "high" } });
  assert.equal(created.status, 201);
  const todo = created.json as Todo;
  assert.equal(todo.title, "交 HW3");
  assert.equal(todo.origin, "manual");
  assert.equal(todo.status, "open");
  await server.call("POST", "/api/todos", { body: { title: "買 USB-C 轉接頭" } });
  await server.call("POST", "/api/todos", { body: { title: "週五 繳電費", dueDay: "2026-10-16" } });

  const list = (await server.call("GET", "/api/todos")).json as TodoListResponse;
  assert.equal(list.day, "2026-10-12");
  assert.deepEqual(list.open.map((item) => item.title), ["交 HW3", "週五 繳電費", "買 USB-C 轉接頭"]);
  assert.deepEqual(list.completedToday, []);

  const patched = await server.call("PATCH", `/api/todos/${todo.id}`, { body: { title: "交 OS HW3", dueTime: null, notes: "E3 上傳 PDF" } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.title, "交 OS HW3");
  assert.equal(patched.json.dueTime, undefined);
  assert.equal(patched.json.notes, "E3 上傳 PDF");
  const cleared = await server.call("PATCH", `/api/todos/${todo.id}`, { body: { dueDay: null } });
  assert.equal(cleared.json.dueDay, undefined);

  assert.equal((await server.call("POST", "/api/todos", { body: { title: "" } })).status, 400);
  assert.equal((await server.call("POST", "/api/todos", { body: { title: "x", dueDay: "2026-02-30" } })).status, 400);
  assert.equal((await server.call("POST", "/api/todos", { body: { title: "x", dueTime: "09:00" } })).status, 400);
  assert.equal((await server.call("POST", "/api/todos", { body: { title: "x", extra: true } })).status, 400);
  assert.equal((await server.call("PATCH", "/api/todos/missing", { body: { title: "x" } })).status, 404);
  const search = (await server.call("GET", "/api/todos?q=usb")).json as TodoListResponse;
  assert.deepEqual(search.open.map((item) => item.title), ["買 USB-C 轉接頭"]);
});

test("delete goes through the trash and 復原 restores the todo", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const todo = (await server.call("POST", "/api/todos", { body: { title: "寄出獎學金申請文件" } })).json as Todo;
  const deleted = await server.call("DELETE", `/api/todos/${todo.id}`, { body: {} });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.deleted, true);
  assert.equal((await server.call("GET", `/api/todos/${todo.id}`)).status, 404);
  const restored = await server.call("POST", "/api/trash/restore", { body: { token: deleted.json.undoToken } });
  assert.equal(restored.status, 200);
  assert.equal((await server.call("GET", `/api/todos/${todo.id}`)).json.title, "寄出獎學金申請文件");
  assert.equal((await server.call("DELETE", "/api/todos/missing", { body: {} })).status, 404);
});

test("完成 through POST /api/actions counts as handled on Today; 復原 reopens it", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const todo = (await server.call("POST", "/api/todos", { body: { title: "準備讀書會簡報：Ch.5 Deadlocks", dueDay: "2026-10-12", dueTime: "14:00", estimateMinutes: 40, notes: "讀書會 14:00 前" } })).json as Todo;
  const before = (await server.call("GET", "/api/today")).json as TodayPayload;
  const row = before.queue.flatMap((group) => group.items).find((item) => item.id === `native:${todo.id}`)!;
  assert.equal(row.kind, "todo");
  assert.deepEqual(row.meta, ["待辦", "讀書會 14:00 前", "預估 40 分鐘"]);
  assert.deepEqual(row.when, { label: "14:00", tone: "warm", mono: true });
  assert.deepEqual(row.actions.map((action) => action.id), ["done", "snooze"]);
  assert.equal(before.counts.open, 1);
  assert.equal(before.counts.nav?.tasks, 1);

  const accepted = await server.call("POST", "/api/actions", { body: { itemId: `native:${todo.id}`, action: "done" } });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json.label, "已完成");
  const done = (await server.call("GET", "/api/todos")).json as TodoListResponse;
  assert.equal(done.open.length, 0);
  assert.equal(done.completedToday[0].id, todo.id);
  assert.equal(done.completedToday[0].completedAt, NOW.toISOString());
  const after = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(after.counts.open, 0);
  assert.equal(after.counts.handled, 1);
  assert.equal(after.counts.handledBy.done, 1);
  assert.equal(after.counts.nav?.tasks, 0);

  // Done twice is refused; undo reopens.
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: `native:${todo.id}`, action: "done" } })).status, 409);
  const undone = await server.call("DELETE", `/api/actions/${accepted.json.actionId}`, { body: {} });
  assert.equal(undone.status, 200);
  assert.equal(((await server.call("GET", `/api/todos/${todo.id}`)).json as Todo).status, "open");
  assert.equal(((await server.call("GET", "/api/today")).json as TodayPayload).counts.open, 1);
});

test("a todo finished in #/tasks and reopened later comes back to the queue", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const todo = (await server.call("POST", "/api/todos", { body: { title: "繳宿舍網路費", dueDay: "2026-10-12" } })).json as Todo;
  await server.call("GET", "/api/today");
  await server.call("POST", "/api/actions", { body: { itemId: `native:${todo.id}`, action: "done" } });
  const reopened = await server.call("POST", `/api/todos/${todo.id}/uncomplete`, { body: {} });
  assert.equal(reopened.json.status, "open");
  assert.equal(reopened.json.completedAt, undefined);
  assert.equal(ctx.itemState.get(`native:${todo.id}`), undefined);
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.ok(today.queue.flatMap((group) => group.items).some((item) => item.id === `native:${todo.id}`));
  // The plain endpoints also complete and are idempotent.
  assert.equal((await server.call("POST", `/api/todos/${todo.id}/complete`, { body: {} })).json.status, "done");
  assert.equal((await server.call("POST", `/api/todos/${todo.id}/complete`, { body: {} })).json.status, "done");
});

test("today(): groups by due, hard deadlines, agenda due rows, free-slot candidates, nav count", async (t) => {
  const { services: ctx } = services(t);
  const store = todoStore(ctx);
  const make = (title: string, extra: Partial<Todo> = {}) => store.create({ title, origin: "manual", ...extra });
  const overdue = make("回覆社團器材借用表單", { dueDay: "2026-10-10" });
  const hard = make("交 OS HW3", { dueDay: "2026-10-12", dueTime: "23:59", priority: "high" });
  const timed = make("準備讀書會簡報：Ch.5 Deadlocks", { dueDay: "2026-10-12", dueTime: "14:00", estimateMinutes: 40 });
  const tomorrow = make("寄履歷", { dueDay: "2026-10-13" });
  const week = make("繳電費", { dueDay: "2026-10-16" });
  make("十天後的事", { dueDay: "2026-10-22" });
  make("買 USB-C 轉接頭");
  const projectRow = make("整理 OS 期末專題提案", { dueDay: "2026-10-14", projectId: "os-final" });

  const contribution = todosToday(store, () => new Map([["os-final", "OS 期末專題"]]), { day: "2026-10-12", now: NOW, timeZone: "Asia/Taipei" });
  const byId = new Map(contribution.queue!.map((row) => [row.id.slice("native:".length), row]));
  assert.equal(contribution.queue!.length, 6);
  assert.equal(byId.get(overdue.id)!.when!.label, "逾期 1 天");
  assert.equal(byId.get(overdue.id)!.when!.tone, "hot");
  assert.equal(byId.get(hard.id)!.hints.hardDeadline, true);
  assert.equal(byId.get(hard.id)!.snoozeLimit, taipei("2026-10-12T21:59").toISOString());
  assert.equal(byId.get(timed.id)!.hints.dueAt, taipei("2026-10-12T14:00").toISOString());
  assert.equal(byId.get(tomorrow.id)!.when!.label, "明天到期");
  assert.equal(byId.get(tomorrow.id)!.hints.dueAt, taipei("2026-10-13T23:59").toISOString());
  assert.deepEqual(byId.get(week.id)!.when, { label: "還有 4 天", tone: "muted", mono: false });
  assert.deepEqual(byId.get(projectRow.id)!.meta, ["待辦", "OS 期末專題"]);
  assert.equal(contribution.nav!.tasks, 8);
  assert.deepEqual(contribution.agenda, [{ start: taipei("2026-10-12T23:59").toISOString(), title: "交 OS HW3", meta: "待辦", kind: "due", itemId: `native:${hard.id}` }]);
  assert.deepEqual(contribution.gapCandidates!.map((gap) => gap.label), ["適合準備讀書會簡報", "適合交 OS HW3", "適合寄履歷"]);
  assert.equal(contribution.gapCandidates![0].estimateMinutes, 40);
  assert.equal(gapLabel("SITCON 籌備"), "適合處理 SITCON 籌備");

  // Through the core: overdue and the hard deadline are 最重要, today's timed todo 今天內, the rest 可以等.
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const payload = (await server.call("GET", "/api/today")).json as TodayPayload;
  const groupOf = (id: string) => payload.queue.find((group) => group.items.some((item) => item.id === `native:${id}`))?.group;
  assert.equal(groupOf(overdue.id), "now");
  assert.equal(groupOf(hard.id), "now");
  assert.equal(groupOf(timed.id), "today");
  assert.equal(groupOf(tomorrow.id), "today");
  assert.equal(groupOf(week.id), "later");
  assert.equal(payload.agenda.items.find((item) => item.kind === "due")?.title, "交 OS HW3");
});

test("轉待辦 creates one todo with a link back, due from the row; undo deletes it", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [billModule, todosModule] });
  await server.call("GET", "/api/today");
  const first = await server.call("POST", "/api/actions", { body: { itemId: "gmail:bill-1", action: "todo", params: { label: "10/20" } } });
  assert.equal(first.status, 202);
  assert.equal(first.json.label, "已轉成待辦");
  const [todo] = ((await server.call("GET", "/api/todos")).json as TodoListResponse).open;
  assert.equal(todo.title, "中華電信 9 月帳單 NT$599");
  assert.equal(todo.origin, "mail");
  assert.equal(todo.dueDay, "2026-10-20");
  assert.equal(todo.dueTime, undefined);
  assert.equal(todo.notes, "9 月電信費 NT$599，10/20 前繳。");
  assert.deepEqual(todo.sourceRef, { source: "gmail", externalId: "bill-1", url: "https://mail.google.com/mail/u/0/#inbox/bill-1" });

  await server.call("DELETE", `/api/actions/${first.json.actionId}`, { body: {} });
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 0);

  // Converting the same row twice (after the first was kept) reuses the todo.
  await server.call("POST", "/api/actions", { body: { itemId: "gmail:bill-1", action: "todo" } });
  ctx.itemState.clear("gmail:bill-1");
  await server.call("GET", "/api/today");
  const again = await server.call("POST", "/api/actions", { body: { itemId: "gmail:bill-1", action: "todo", params: { title: "繳電信費" } } });
  assert.equal(again.status, 202);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 1);
  // Undo of the second one must not delete the todo the first one made.
  await server.call("DELETE", `/api/actions/${again.json.actionId}`, { body: {} });
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 1);
});

test("轉待辦 on a native row is refused", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const todo = (await server.call("POST", "/api/todos", { body: { title: "x", dueDay: "2026-10-12" } })).json as Todo;
  await server.call("GET", "/api/today");
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: `native:${todo.id}`, action: "todo" } })).status, 400);
});

test("AI todo suggestions: 加入待辦 from the queue (undo reopens it) and POST /api/suggestions/:id/accept", async (t) => {
  const { services: ctx } = services(t);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const suggestion = ctx.suggestions.create<TodoSuggestion>({
    kind: "todo", title: "加入待辦：繳電費", payload: { title: "繳電費", dueDay: "2026-10-20" },
    sourceRef: { source: "gmail", externalId: "m1" }, origin: "中華電信帳單信",
  });
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.ok(today.queue.flatMap((group) => group.items).some((item) => item.id === `ai:${suggestion.id}`));
  const accepted = await server.call("POST", "/api/actions", { body: { itemId: `ai:${suggestion.id}`, action: "todo" } });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json.label, "已加入待辦");
  const [todo] = ((await server.call("GET", "/api/todos")).json as TodoListResponse).open;
  assert.equal(todo.title, "繳電費");
  assert.equal(todo.origin, "suggestion");
  assert.equal(todo.dueDay, "2026-10-20");
  assert.deepEqual(todo.sourceRef, { source: "gmail", externalId: "m1" });
  const decided = ctx.suggestions.get(suggestion.id) as AiSuggestion;
  assert.equal(decided.status, "accepted");
  assert.equal(decided.resultId, todo.id);

  await server.call("DELETE", `/api/actions/${accepted.json.actionId}`, { body: {} });
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 0);
  assert.equal(ctx.suggestions.get(suggestion.id)!.status, "pending");

  const viaAccept = await server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: { title: "繳中華電信帳單" } });
  assert.equal(viaAccept.status, 200);
  assert.equal(viaAccept.json.result.title, "繳中華電信帳單");
  assert.equal(viaAccept.json.suggestion.resultId, viaAccept.json.result.id);

  const broken = ctx.suggestions.create({ kind: "todo", title: "壞掉的建議", payload: { nope: true } });
  assert.equal((await server.call("POST", `/api/suggestions/${broken.id}/accept`, { body: {} })).status, 422);
});

test("backlog: only open undated todos created before today's local day, absent at 0, never part of the counts", async (t) => {
  const { services: ctx, setNow } = services(t, new Date("2026-10-20T04:00:00Z"));
  const store = todoStore(ctx);
  const server = await startTestServer(t, ctx, { modules: [todosModule] });
  const create = (at: string, title: string, extra: Partial<Todo> = {}) => {
    setNow(new Date(at));
    return store.create({ title, origin: "manual", ...extra });
  };
  const old = create("2026-10-20T04:00:00Z", "很久以前記的");
  const lastMinute = create("2026-10-22T15:59:00Z", "昨天 23:59 記的"); // 10/22 in Taipei, 10/22 in UTC
  create("2026-10-22T16:00:00Z", "今天 00:00 記的"); // 10/23 in Taipei, still 10/22 in UTC
  create("2026-10-20T04:00:00Z", "有日期的舊待辦", { dueDay: "2026-10-26" });
  const finished = create("2026-10-20T04:00:00Z", "已經做完的舊待辦");
  store.complete(finished.id);

  setNow(taipei("2026-10-23T08:42"));
  const payload = async () => (await server.call("GET", "/api/today")).json as TodayPayload;
  const first = await payload();
  assert.deepEqual(first.backlog, { undatedTodos: 2 }, "a UTC-date comparison would also count the 00:00 todo");
  assert.equal(first.counts.nav!.tasks, 4, "the 待辦 badge still counts every open todo");
  assert.equal(first.counts.open, 1, "the dated todo is the only queue row; the backlog adds none");

  // The day rolls over in Taipei (16:00 UTC): the todo captured at 00:00 is now yesterday's.
  setNow(new Date("2026-10-23T16:00:00Z"));
  assert.deepEqual((await payload()).backlog, { undatedTodos: 3 });

  setNow(taipei("2026-10-23T08:42"));
  await server.call("POST", `/api/todos/${old.id}/complete`, { body: {} });
  await server.call("PATCH", `/api/todos/${lastMinute.id}`, { body: { dueDay: "2026-10-24" } });
  const none = await payload();
  assert.equal(none.backlog, undefined, "the todo captured today is not counted, so there is no backlog at all");
});

test("dueFromInstant: 23:59 and midnight mean the day alone", () => {
  assert.deepEqual(dueFromInstant(taipei("2026-10-20T23:59").toISOString(), "Asia/Taipei"), { dueDay: "2026-10-20" });
  assert.deepEqual(dueFromInstant(taipei("2026-10-21T00:00").toISOString(), "Asia/Taipei"), { dueDay: "2026-10-20" });
  assert.deepEqual(dueFromInstant(taipei("2026-10-20T09:30").toISOString(), "Asia/Taipei"), { dueDay: "2026-10-20", dueTime: "09:30" });
});
