/**
 * Mail row actions, archive and search (SPEC-mail-assignments §2–§4) with
 * every feature module registered as in production, on the seeded demo day.
 * Covers what crosses module lines: 刪除 on a Today row moves the counts and
 * the handled list like 封存; 轉待辦 works on an archived conversation from the
 * 封存 view (tasks module); 移回收件匣 brings a conversation back to 收件匣
 * without reopening Today rows; and nothing reaches Gmail inside the undo
 * window. The network is the fake Gmail; nothing reaches Google or a model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { seedDemo } from "../scripts/seed-demo.js";
import type { InboxListResponse, MailMessage, MailSearchResponse } from "../shared/mail.js";
import type { TodayPayload } from "../shared/today.js";
import { featureModules } from "./features/index.js";
import { connectGoogle, FakeGmail } from "./features/gmail/fake-gmail.js";
import { startTestServer, testServices } from "./test-helpers.js";

const NOW = new Date("2026-10-12T08:42:00+08:00");
const LIN = "18c2f0a1b2c3d4e5";

async function setup(t: test.TestContext, options: { google?: boolean } = {}) {
  const gmail = new FakeGmail(() => NOW);
  const services = testServices(t, { seams: { fetch: gmail.fetch, now: () => NOW } });
  seedDemo(services.db, { now: NOW, timeZone: "Asia/Taipei" });
  if (options.google) await connectGoogle(services);
  for (const item of services.sourceItems.list<MailMessage>({ source: "gmail" })) {
    const mail = item.value;
    gmail.add({ id: mail.id, threadId: mail.threadId, from: `${mail.from.name ?? ""} <${mail.from.email}>`, subject: mail.subject, at: mail.receivedAt, labels: mail.labels, text: mail.excerpt ?? mail.snippet }, false);
  }
  const server = await startTestServer(t, services, { modules: featureModules });
  const today = async () => (await server.call("GET", "/api/today")).json as TodayPayload;
  const act = async (itemId: string, action: string) => {
    const response = await server.call("POST", "/api/actions", { body: { itemId, action } });
    assert.equal(response.status, 202, response.text);
    return response.json as { actionId: string; label: string };
  };
  const undo = async (actionId: string) => assert.equal((await server.call("DELETE", `/api/actions/${actionId}`, { body: {} })).status, 200);
  return { gmail, services, server, today, act, undo };
}

/** Waits (real time, at most 5 s) for a deferred write: a Gmail sync may be running beside it. */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
}

const ids = (payload: TodayPayload) => payload.queue.flatMap((group) => group.items.map((item) => item.id));

test("刪除 on Today's mail row closes it like 封存 (counts, unread badge, handled list) and 復原 inside the window sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, today, act, undo } = await setup(t, { google: true });
  const before = await today();
  const row = before.queue.flatMap((group) => group.items).find((item) => item.id === `gmail:${LIN}`)!;
  assert.deepEqual(row.actions.map((action) => `${action.label}${action.key ? ` ${action.key}` : ""}`), ["回覆 Enter", "轉待辦 T", "延後 S", "封存 E", "刪除 #"]);

  const trashed = await act(`gmail:${LIN}`, "trash");
  const after = await today();
  assert.ok(!ids(after).includes(`gmail:${LIN}`));
  assert.deepEqual([after.counts.open, after.counts.handled, after.counts.inboxUnread], [before.counts.open - 1, before.counts.handled + 1, before.counts.inboxUnread - 1]);
  const [entry] = after.handled ?? [];
  assert.deepEqual([entry?.itemId, entry?.action, entry?.title, entry?.undoable], [`gmail:${LIN}`, "trash", "Re: OS 期末專題題目討論", true]);
  assert.equal(after.counts.handledBy.done, before.counts.handledBy.done + 1);

  t.mock.timers.tick(6_000);
  await undo(trashed.actionId);
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gmail.calls("POST", /^\/threads\//).length, 0, "nothing reached Gmail");
  const back = await today();
  assert.ok(ids(back).includes(`gmail:${LIN}`));
  assert.equal(back.counts.inboxUnread, before.counts.inboxUnread);
});

test("the 封存 view without Google shows the cached archived mail, and 轉待辦 works on it through the tasks module", async (t) => {
  const { server, act } = await setup(t);
  const response = await server.call("GET", "/api/gmail/search?view=archive");
  assert.equal(response.status, 200, response.text);
  const body = response.json as MailSearchResponse;
  assert.deepEqual([body.origin, body.source.connected], ["cache", false]);
  assert.deepEqual(body.threads.map((thread) => [thread.threadId, thread.location]), [
    ["demo-archived-lin", "archive"], ["demo-archived-kktix", "archive"], ["demo-archived-office", "archive"],
  ]);
  const office = body.threads[2];
  assert.ok(office.actions.some((action) => action.id === "todo"), "a cached archived conversation offers 轉待辦");
  await act(office.itemId, "todo");
  const todos = (await server.call("GET", "/api/todos")).json;
  assert.ok(todos.open.some((todo: { title: string }) => todo.title === "[公告] 研究生獎助學金審查結果"));
  const after = (await server.call("GET", "/api/gmail/search?view=archive")).json as MailSearchResponse;
  assert.deepEqual(after.threads.find((thread) => thread.threadId === "demo-archived-office")?.state, { kind: "handled", action: "todo" }, "the row says 已轉成待辦");

  // The reader works offline from the cache, archived or not.
  const reader = await server.call("GET", "/api/gmail/threads/demo-archived-kktix");
  assert.equal(reader.status, 200);
  assert.equal(reader.json.thread.location, "archive");
  const gone = await server.call("GET", "/api/gmail/threads/not-cached");
  assert.deepEqual([gone.status, gone.json.error], [404, "找不到這封信，可能已經封存或超過保留天數。"]);
});

test("移回收件匣 puts an archived conversation back in 收件匣 without reopening a Today row; a search finds both kinds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, today, act } = await setup(t, { google: true });
  const queueBefore = ids(await today());
  await act("gmail:demo-archived-lin", "unarchive");
  const inbox = (await server.call("GET", "/api/gmail/threads")).json as InboxListResponse;
  const lin = inbox.threads.find((thread) => thread.threadId === "demo-archived-lin");
  assert.equal(lin?.location, "inbox");
  assert.equal(lin?.replied, true, "the professor's answer was already replied to: no reply row");
  assert.deepEqual(ids(await today()), queueBefore);
  t.mock.timers.tick(6_500);
  await until(() => gmail.labels("demo-archived-lin").includes("INBOX"));
  assert.ok(gmail.labels("demo-archived-lin").includes("INBOX"));

  const found = (await server.call("GET", "/api/gmail/search?view=all&q=Synchronization")).json as MailSearchResponse;
  assert.equal(found.origin, "gmail");
  assert.deepEqual(found.threads.map((thread) => [thread.threadId, thread.location]), [["demo-archived-lin", "inbox"]]);
});

test("刪除 or 封存 right after 轉成作業 or 標為已讀 on the same mail goes ahead; only a repeat of the same action is a duplicate", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, services, server, today, act, undo } = await setup(t, { google: true });
  const post = (itemId: string, action: string) => server.call("POST", "/api/actions", { body: { itemId, action } });
  await today();

  // 轉成作業 (A) keeps the inbox row on screen; 刪除 (#) on it is the natural next key.
  const converted = await act(`gmail:${LIN}`, "assignment");
  const repeat = await post(`gmail:${LIN}`, "assignment");
  assert.equal(repeat.status, 409, "the same action again is still refused");
  const trashed = await post(`gmail:${LIN}`, "trash");
  assert.equal(trashed.status, 202, trashed.text);
  assert.equal(services.itemState.get(`gmail:${LIN}`)?.action, "trash", "刪除 takes over the item state");
  // Its 復原 puts 轉成作業's state back (the assignment stays).
  await undo(trashed.json.actionId);
  assert.deepEqual([services.itemState.get(`gmail:${LIN}`)?.action, services.itemState.get(`gmail:${LIN}`)?.actionId], ["assignment", converted.actionId]);
  const archived = await post(`gmail:${LIN}`, "archive");
  assert.equal(archived.status, 202, archived.text);

  // 標為已讀 on an unread notice in 全部 or the inbox, then 刪除.
  const inbox = (await server.call("GET", "/api/gmail/threads")).json as InboxListResponse;
  const unread = inbox.threads.find((thread) => thread.actions[0]?.id === "read" && thread.threadId !== LIN)!;
  assert.equal((await post(unread.itemId, "read")).status, 202);
  const after = await post(unread.itemId, "trash");
  assert.equal(after.status, 202, after.text);

  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${unread.threadId}/trash`).length > 0);
  assert.equal(gmail.calls("POST", `/threads/${unread.threadId}/trash`).length, 1, "the delete reached Gmail");
  assert.equal(gmail.calls("POST", `/threads/${LIN}/trash`).length, 0, "the undone delete never did");
});
