import test from "node:test";
import assert from "node:assert/strict";
import type { InboxListResponse, InboxThreadResponse, MailMessage, MailSearchResponse } from "../../../shared/mail.js";
import type { TodayPayload } from "../../../shared/today.js";
import { seedDemo } from "../../../scripts/seed-demo.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { connectGoogle, FakeGmail } from "./fake-gmail.js";
import { gmailModule } from "./index.js";
import { liveMail } from "./live.js";

/**
 * 刪除 and 移回收件匣 (SPEC-mail-assignments §1.3, §2, ARCHITECTURE §10.10)
 * through POST /api/actions against the fake Gmail: the cache changes at
 * once, nothing reaches Gmail inside the 6.5 s undo window, the commit is
 * threads.trash (empty body) or threads.modify, and 復原 after the commit is
 * messages.untrash plus INBOX on exactly the messages 刪除 changed, or the
 * inverse modify. Conversations outside
 * the cache are resolved with one messages.get(format=minimal).
 */

const NOW = new Date("2026-10-12T08:42:00+08:00");
const LIN = "18c2f0a1b2c3d4e5";
const CHT = "18c2e9d0a1b2c3f6";
const NEWS = "demo-news-1";

async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), message);
}

async function setup(t: test.TestContext, options: { connect?: boolean } = {}) {
  const gmail = new FakeGmail(() => NOW);
  const services = testServices(t, { seams: { fetch: gmail.fetch, now: () => NOW } });
  seedDemo(services.db, { now: NOW, timeZone: "Asia/Taipei" });
  if (options.connect ?? true) await connectGoogle(services);
  for (const item of services.sourceItems.list<MailMessage>({ source: "gmail" }))
    gmail.add({ id: item.value.id, threadId: item.value.threadId, subject: item.value.subject, at: item.value.receivedAt, labels: item.value.labels, text: item.value.snippet }, false);
  // Mail only Gmail has: an old archived conversation and an old one still in the inbox.
  gmail.add({ id: "old-archived", threadId: "old-archived-thread", subject: "舊的封存信", at: "2026-09-02T02:00:00.000Z", labels: [], text: "很久以前" }, false);
  gmail.add({ id: "old-inbox", threadId: "old-inbox-thread", subject: "舊的收件匣信", at: "2026-09-01T02:00:00.000Z", labels: ["INBOX"], text: "還在收件匣" }, false);
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const today = async () => (await server.call("GET", "/api/today")).json as TodayPayload;
  const inbox = async () => (await server.call("GET", "/api/gmail/threads")).json as InboxListResponse;
  const act = (itemId: string, action: string) => server.call("POST", "/api/actions", { body: { itemId, action } });
  const undo = (actionId: string) => server.call("DELETE", `/api/actions/${actionId}`, { body: {} });
  const state = async (actionId: string, wanted: string) => {
    let current = "";
    for (const deadline = Date.now() + 5_000; current !== wanted && Date.now() < deadline;) {
      current = (await server.call("GET", `/api/actions/${actionId}`)).json.state;
      if (current !== wanted) await new Promise((resolve) => setImmediate(resolve));
    }
    return current;
  };
  const mail = (id: string) => services.sourceItems.get<MailMessage>("gmail", id)?.value;
  return { gmail, services, server, today, inbox, act, undo, state, mail };
}

const rows = (payload: TodayPayload) => payload.queue.flatMap((group) => group.items.map((item) => item.id));

test("刪除 a cached conversation: local at once, nothing reaches Gmail before the commit, 復原 cancels it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, today, inbox, act, undo, mail } = await setup(t);
  const before = await today();
  assert.deepEqual(before.queue.flatMap((group) => group.items).find((item) => item.id === `gmail:${CHT}`)?.actions.map((action) => action.id),
    ["todo", "archive", "snooze", "trash"], "mail rows offer 刪除 #");
  const trashed = await act(`gmail:${CHT}`, "trash");
  assert.equal(trashed.status, 202, trashed.text);
  assert.equal(trashed.json.label, "已移到垃圾桶");
  assert.deepEqual(mail(CHT)!.labels.filter((label) => label === "INBOX" || label === "TRASH"), ["TRASH"], "the cache drops INBOX and adds TRASH before the 202");
  assert.ok(!(await inbox()).threads.some((thread) => thread.messageId === CHT));
  const after = await today();
  assert.ok(!rows(after).includes(`gmail:${CHT}`));
  assert.equal(after.counts.inboxUnread, before.counts.inboxUnread - 1);
  assert.equal(after.counts.handled, before.counts.handled + 1, "刪除 closes the row like 封存");
  assert.equal(after.handled?.[0]?.action, "trash");

  t.mock.timers.tick(6_000);
  assert.equal(gmail.calls("POST", /^\/threads\//).length, 0, "nothing reached Gmail inside the undo window");
  assert.equal((await undo(trashed.json.actionId)).status, 200);
  assert.ok(mail(CHT)!.labels.includes("INBOX") && !mail(CHT)!.labels.includes("TRASH"), "undo restores the cache exactly");
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gmail.calls("POST", /^\/threads\//).length, 0, "the cancelled write never runs");
  assert.ok(rows(await today()).includes(`gmail:${CHT}`), "the row is back");
});

test("刪除 after the commit: threads.trash with an empty body; 復原 untrashes and puts INBOX back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, act, undo, state, mail } = await setup(t);
  const trashed = await act(`gmail:${LIN}`, "trash");
  assert.equal(trashed.status, 202);
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${LIN}/trash`).length === 1, "threads.trash after 6.5 s");
  assert.equal(gmail.calls("POST", `/threads/${LIN}/trash`)[0].body, undefined, "the reference asks for an empty body");
  assert.equal(gmail.calls("POST", /\/messages\/[^/]+\/(trash|delete)|\/threads\/[^/]+\/delete/).length, 0, "never a permanent delete");
  assert.equal(await state(trashed.json.actionId, "committed"), "committed");
  assert.ok(gmail.labels(LIN).includes("TRASH") && !gmail.labels(LIN).includes("INBOX"));

  const late = await undo(trashed.json.actionId);
  assert.equal(late.status, 200, late.text);
  assert.equal(gmail.calls("POST", `/threads/${LIN}/untrash`).length, 0, "never threads.untrash: it would also restore what was deleted before");
  assert.deepEqual(gmail.calls("POST", /^\/messages\/[^/]+\/untrash$/).map((call) => call.path), [`/messages/${LIN}/untrash`]);
  assert.equal(gmail.calls("GET", `/threads/${LIN}?format=minimal`).length, 1, "the commit looked at the conversation first");
  assert.deepEqual(gmail.calls("POST", "/messages/batchModify")[0].body, { ids: [LIN], addLabelIds: ["INBOX"], removeLabelIds: [] }, "INBOX comes back explicitly, where it was");
  assert.ok(gmail.labels(LIN).includes("INBOX") && !gmail.labels(LIN).includes("TRASH"));
  assert.ok(mail(LIN)!.labels.includes("INBOX") && !mail(LIN)!.labels.includes("TRASH"));
});

test("刪除 is refused with zh-TW reasons: no Gmail (503), already in the trash (409); a failed write puts the mail back", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const offline = await setup(t, { connect: false });
  const refused = await offline.act(`gmail:${LIN}`, "trash");
  assert.equal(refused.status, 503);
  assert.equal(refused.json.error, "Gmail 尚未連接，信件沒有變動。請到「連線與設定」連接 Google。");
  assert.ok(offline.mail(LIN)!.labels.includes("INBOX"));

  const { gmail, services, act, state, mail, today } = await setup(t);
  const stored = mail(NEWS)!;
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: NEWS, value: { ...stored, labels: ["TRASH"] }, updatedAt: stored.receivedAt }]);
  const twice = await act(`gmail:${NEWS}`, "trash");
  assert.deepEqual([twice.status, twice.json.error], [409, "這封信已經在垃圾桶了。"]);
  assert.equal((await act("gmail:digest", "trash")).status, 400, "the digest has no bulk 刪除");

  gmail.failModify = 500;
  const failing = await act(`gmail:${LIN}`, "trash");
  assert.equal(failing.status, 202);
  t.mock.timers.tick(6_500);
  assert.equal(await state(failing.json.actionId, "failed"), "failed");
  assert.ok(mail(LIN)!.labels.includes("INBOX") && !mail(LIN)!.labels.includes("TRASH"), "the local trash is undone");
  assert.ok(rows(await today()).includes(`gmail:${LIN}`), "the row is back");
});

test("移回收件匣 an archived cached conversation: INBOX locally at once, threads.modify after the commit, 復原 removes it again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, inbox, act, undo, state, mail } = await setup(t);
  const archived = (await server.call("GET", "/api/gmail/search?view=archive")).json as MailSearchResponse;
  const row = archived.threads.find((thread) => thread.threadId === "demo-archived-office")!;
  assert.deepEqual(row.actions.slice(0, 2).map((action) => [action.id, action.key]), [["unarchive", "E"], ["trash", "#"]]);

  const back = await act(row.itemId, "unarchive");
  assert.equal(back.status, 202, back.text);
  assert.equal(back.json.label, "已移回收件匣");
  assert.ok(mail("demo-archived-office")!.labels.includes("INBOX"));
  assert.ok((await inbox()).threads.some((thread) => thread.threadId === "demo-archived-office"), "it is in 收件匣 at the next list");
  const view = (await server.call("GET", "/api/gmail/search?view=archive")).json as MailSearchResponse;
  assert.ok(!view.threads.some((thread) => thread.threadId === "demo-archived-office"), "and no longer in 封存, although Gmail still lists it");
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", "/threads/demo-archived-office/modify").length === 1, "threads.modify after 6.5 s");
  assert.deepEqual(gmail.calls("POST", "/threads/demo-archived-office/modify")[0].body, { addLabelIds: ["INBOX"], removeLabelIds: [] });
  assert.equal(await state(back.json.actionId, "committed"), "committed");
  assert.equal((await undo(back.json.actionId)).status, 200);
  assert.deepEqual(gmail.calls("POST", "/threads/demo-archived-office/modify")[1].body, { addLabelIds: [], removeLabelIds: ["INBOX"] });
  assert.ok(!mail("demo-archived-office")!.labels.includes("INBOX"));

  const already = await act(`gmail:${NEWS}`, "unarchive");
  assert.deepEqual([already.status, already.json.error], [409, "這封信已經在收件匣了。"]);
});

test("a conversation outside the cache: one messages.get(minimal) finds its thread; trash, untrash and unarchive reach only Gmail", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, services, server, act, undo, state } = await setup(t);
  // Listing 封存 reads the row live and holds it in memory.
  await server.call("GET", "/api/gmail/search?view=archive");
  assert.ok(liveMail(services).listed("old-archived-thread"));

  const trashed = await act("gmail:old-archived", "trash");
  assert.equal(trashed.status, 202, trashed.text);
  assert.deepEqual(gmail.calls("GET", /^\/messages\/old-archived\?format=minimal/).length, 1, "the thread is resolved with one minimal read");
  assert.equal(liveMail(services).listed("old-archived-thread"), undefined, "the action drops what was read about the conversation");
  assert.equal(services.sourceItems.get("gmail", "old-archived"), undefined, "nothing is cached");
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", "/threads/old-archived-thread/trash").length === 1, "threads.trash on the resolved thread");
  assert.equal(await state(trashed.json.actionId, "committed"), "committed");
  assert.equal((await undo(trashed.json.actionId)).status, 200);
  assert.equal(gmail.calls("POST", "/messages/old-archived/untrash").length, 1);
  assert.equal(gmail.calls("POST", "/messages/batchModify").length, 0, "it was archived: INBOX is not added");
  assert.deepEqual(gmail.labels("old-archived"), []);

  const back = await act("gmail:old-archived", "unarchive");
  assert.equal(back.status, 202);
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", "/threads/old-archived-thread/modify").length === 1, "threads.modify add INBOX");
  assert.ok(gmail.labels("old-archived").includes("INBOX"));

  const old = await act("gmail:old-inbox", "trash");
  assert.equal(old.status, 202);
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", "/threads/old-inbox-thread/trash").length === 1, "trash");
  assert.equal(await state(old.json.actionId, "committed"), "committed");
  await undo(old.json.actionId);
  assert.ok(gmail.labels("old-inbox").includes("INBOX"), "an inbox conversation gets INBOX back after untrash");

  const missing = await act("gmail:does-not-exist", "trash");
  assert.deepEqual([missing.status, missing.json.error], [404, "找不到這封信，可能已經被刪除。請重新整理後再試。"]);
});

test("a trashed conversation opened by a link (an assignment's 開啟信件) says so, and 移回收件匣 takes it out of the trash", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, today, inbox, act, undo, state, mail } = await setup(t);
  const trashed = await act(`gmail:${LIN}`, "trash");
  t.mock.timers.tick(6_500);
  assert.equal(await state(trashed.json.actionId, "committed"), "committed");
  await today(); // the page refreshes Today after every action: the row is gone from the served queue

  const reader = await server.call("GET", `/api/gmail/threads/${LIN}`);
  assert.equal(reader.status, 200, reader.text);
  const thread = (reader.json as InboxThreadResponse).thread;
  assert.deepEqual([thread.location, thread.trashed], ["archive", true]);
  assert.deepEqual(thread.actions.map((action) => [action.id, action.key ?? null]), [["unarchive", "E"], ["todo", "T"], ["assignment", "A"], ["reply", null]], "no 刪除: it is already in the trash");

  const back = await act(`gmail:${LIN}`, "unarchive");
  assert.equal(back.status, 202, back.text);
  assert.ok(mail(LIN)!.labels.includes("INBOX") && !mail(LIN)!.labels.includes("TRASH"), "out of the trash and in the inbox at once");
  assert.ok((await inbox()).threads.some((item) => item.messageId === LIN));
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${LIN}/modify`).length === 1, "INBOX after untrash");
  assert.equal(gmail.calls("POST", `/threads/${LIN}/untrash`).length, 1);
  assert.ok(gmail.labels(LIN).includes("INBOX") && !gmail.labels(LIN).includes("TRASH"));
  assert.equal(await state(back.json.actionId, "committed"), "committed");
  assert.equal((await undo(back.json.actionId)).status, 200);
  assert.equal(gmail.calls("POST", `/threads/${LIN}/trash`).length, 2, "復原 puts it back in the trash");
  assert.ok(gmail.labels(LIN).includes("TRASH") && mail(LIN)!.labels.includes("TRASH") && !mail(LIN)!.labels.includes("INBOX"));
});

test("a conversation only Gmail had, deleted from BELL, still opens from a link and 移回收件匣 takes it out of the trash", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, act, state } = await setup(t);
  assert.equal((await server.call("GET", "/api/gmail/threads/old-archived-thread")).json.thread.location, "archive");
  const trashed = await act("gmail:old-archived", "trash");
  t.mock.timers.tick(6_500);
  assert.equal(await state(trashed.json.actionId, "committed"), "committed");
  assert.deepEqual(gmail.labels("old-archived"), ["TRASH"]);

  // An assignment's 開啟信件 opens it: the trashed reader, like a cached conversation's.
  const reader = await server.call("GET", "/api/gmail/threads/old-archived-thread");
  assert.equal(reader.status, 200, reader.text);
  const thread = (reader.json as InboxThreadResponse).thread;
  assert.deepEqual([thread.live, thread.location, thread.trashed, thread.itemId], [true, "archive", true, "gmail:old-archived"]);
  assert.deepEqual(thread.actions.map((action) => action.id), ["unarchive", "assignment", "reply"], "no 刪除: it is already in the trash");

  const back = await act(thread.itemId, "unarchive");
  assert.equal(back.status, 202, back.text);
  t.mock.timers.tick(6_500);
  await until(() => gmail.labels("old-archived").includes("INBOX"), "untrash, then INBOX");
  assert.ok(!gmail.labels("old-archived").includes("TRASH"));
});

test("復原 of 刪除 after the commit restores only what 刪除 moved: a message already deleted in Gmail stays in the trash", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, act, undo, state } = await setup(t);
  // Cached conversation: an older message of it the owner deleted in Gmail (not cached).
  gmail.add({ id: "lin-deleted", threadId: LIN, subject: "舊訊息", at: "2026-10-01T02:00:00.000Z", labels: ["TRASH"], text: "早就刪掉了" }, false);
  // A conversation only Gmail has: one message deleted on its own, one still in the inbox.
  gmail.add({ id: "pair-deleted", threadId: "pair", subject: "兩封", at: "2026-09-03T02:00:00.000Z", labels: ["TRASH"], text: "刪掉的那封" }, false);
  gmail.add({ id: "pair-kept", threadId: "pair", subject: "Re: 兩封", at: "2026-09-04T02:00:00.000Z", labels: ["INBOX"], text: "還在的那封" }, false);

  for (const itemId of [`gmail:${LIN}`, "gmail:pair-kept"]) {
    const trashed = await act(itemId, "trash");
    assert.equal(trashed.status, 202, trashed.text);
    t.mock.timers.tick(6_500);
    assert.equal(await state(trashed.json.actionId, "committed"), "committed");
    assert.equal((await undo(trashed.json.actionId)).status, 200);
  }
  assert.deepEqual(gmail.labels("lin-deleted"), ["TRASH"], "threads.untrash would have brought it back");
  assert.deepEqual(gmail.labels("pair-deleted"), ["TRASH"]);
  assert.ok(!gmail.labels(LIN).includes("TRASH") && gmail.labels(LIN).includes("INBOX"));
  assert.deepEqual(gmail.labels("pair-kept"), ["INBOX"]);
  assert.equal(gmail.calls("POST", "/messages/lin-deleted/untrash").length + gmail.calls("POST", "/messages/pair-deleted/untrash").length, 0);
});

test("復原 of 標為已讀 after the commit on a conversation only Gmail has makes every message unread again that was", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, act, undo, state } = await setup(t);
  gmail.add({ id: "unr-1", threadId: "unr", subject: "三封未讀", at: "2026-09-05T02:00:00.000Z", labels: ["INBOX", "UNREAD"], text: "一" }, false);
  gmail.add({ id: "unr-2", threadId: "unr", subject: "Re: 三封未讀", at: "2026-09-06T02:00:00.000Z", labels: ["INBOX"], text: "二（讀過）" }, false);
  gmail.add({ id: "unr-3", threadId: "unr", subject: "Re: 三封未讀", at: "2026-09-07T02:00:00.000Z", labels: ["INBOX", "UNREAD"], text: "三" }, false);
  gmail.add({ id: "unr-4", threadId: "unr", subject: "Re: 三封未讀", at: "2026-09-08T02:00:00.000Z", labels: ["INBOX", "UNREAD"], text: "四" }, false);
  const read = await act("gmail:unr-4", "read");
  assert.equal(read.status, 202, read.text);
  t.mock.timers.tick(6_500);
  assert.equal(await state(read.json.actionId, "committed"), "committed");
  assert.ok(["unr-1", "unr-3", "unr-4"].every((id) => !gmail.labels(id).includes("UNREAD")));
  assert.equal((await undo(read.json.actionId)).status, 200);
  assert.deepEqual(["unr-1", "unr-2", "unr-3", "unr-4"].map((id) => gmail.labels(id).includes("UNREAD")), [true, false, true, true]);
});
