import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { InboxListResponse, InboxThreadResponse, MailMessage } from "../../../shared/mail.js";
import type { TodayPayload } from "../../../shared/today.js";
import { seedDemo } from "../../../scripts/seed-demo.js";
import { DEMO_HW5_MAIL, DEMO_HW5_SUGGESTION } from "../../../scripts/seed-demo-assignments.js";
import { appContext } from "../../app.js";
import { repairActionsAfterRestart } from "../../today/actions.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { connectGoogle, FakeGmail } from "./fake-gmail.js";
import { gmailModule } from "./index.js";
import { mailContribution } from "./rows.js";

const NOW = new Date("2026-10-12T08:42:00+08:00");
const LIN = "18c2f0a1b2c3d4e5";
const CHT = "18c2e9d0a1b2c3f6";
const KKTIX = "18c2d1c0b9a8f7e6";
const TA = "18c2a7b6c5d4e3f2";

/**
 * Waits (real setImmediate, not the mocked setTimeout) until `check` holds.
 * Bounded by wall time, not a turn count: the commit reads the vault from
 * disk, which takes longer while the whole suite runs in parallel.
 */
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), message);
}

async function setup(t: test.TestContext, options: { connect?: boolean } = {}) {
  const gmail = new FakeGmail(() => NOW);
  const services = testServices(t, { seams: { fetch: gmail.fetch, now: () => NOW } });
  seedDemo(services.db, { now: NOW, timeZone: "Asia/Taipei" });
  if (options.connect) await connectGoogle(services);
  // Mirror the seeded mail in the fake Gmail so remote writes have something to change.
  for (const item of services.sourceItems.list<MailMessage>({ source: "gmail" }))
    gmail.add({ id: item.value.id, threadId: item.value.threadId, subject: item.value.subject, at: item.value.receivedAt, labels: item.value.labels, text: item.value.snippet }, false);
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const today = async () => (await server.call("GET", "/api/today")).json as TodayPayload;
  const inbox = async () => (await server.call("GET", "/api/gmail/threads")).json as InboxListResponse;
  const mail = (id: string) => services.sourceItems.get<MailMessage>("gmail", id)?.value;
  return { gmail, services, server, today, inbox, mail };
}

const rows = (payload: TodayPayload) => payload.queue.flatMap((group) => group.items.map((item) => `${group.group}:${item.id}`));

test("today(): the mockup's mail rows, digest and unread badge from the seeded inbox", async (t) => {
  const { today } = await setup(t);
  const payload = await today();
  // The rule order (deadline first, ARCHITECTURE §10.8) puts the bill before the undated suggestion.
  assert.deepEqual(rows(payload), [`now:gmail:${LIN}`, `today:gmail:${CHT}`, "today:ai:sg-sitcon-autumn", "today:ai:sg-hw5-os"]);
  assert.deepEqual(payload.digest, { total: 9, categories: [
    { key: "newsletter", label: "電子報", count: 3, action: "read" },
    { key: "school", label: "學校公告", count: 2, action: "open", url: "https://mail.google.com/mail/u/0/#inbox" },
    { key: "github", label: "GitHub 通知", count: 4, action: "read" },
  ] });
  assert.equal(payload.counts.inboxUnread, 12);
  assert.ok(!payload.sources.some((source) => source.state === "error"), "today() passed the contribution schema");
  // Row for row, what the mockup fixture shows for the professor's mail and the bill.
  const fixture = JSON.parse(readFileSync(new URL("../../fixtures/today-2026-10-12.json", import.meta.url), "utf8")) as TodayPayload;
  const expected = (id: string) => fixture.queue.flatMap((group) => group.items).find((item) => item.id === `gmail:${id}`);
  const actual = (id: string) => payload.queue.flatMap((group) => group.items).find((item) => item.id === `gmail:${id}`);
  assert.deepEqual(actual(LIN), expected(LIN));
  assert.deepEqual(actual(CHT), expected(CHT));
});

test("rule fallback: no AI triage still groups mail (IMPORTANT person → 最重要, bill with amount and due day, digest)", () => {
  const now = new Date("2026-10-12T00:42:00Z");
  const base = { threadId: "", snippet: "", unread: true, webUrl: "https://mail.google.com/mail/u/0/#inbox/x" };
  const messages: MailMessage[] = [
    { ...base, id: "p", threadId: "p", from: { name: "陳教授", email: "chen@cs.nycu.edu.tw" }, subject: "專題討論", receivedAt: "2026-10-12T00:10:00Z", labels: ["INBOX", "UNREAD", "IMPORTANT"] },
    { ...base, id: "q", threadId: "q", from: { name: "同學", email: "friend@gmail.com" }, subject: "週末要不要一起讀書", receivedAt: "2026-10-11T12:00:00Z", labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"] },
    { ...base, id: "b", threadId: "b", from: { name: "台灣電力公司", email: "service@taipower.com.tw" }, subject: "10 月電費通知", snippet: "本期電費 NT$1,234，繳費期限 10/25，已設定自動扣繳。", receivedAt: "2026-10-11T02:00:00Z", labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"] },
    { ...base, id: "n", threadId: "n", from: { name: "Weekly", email: "hi@weekly.dev" }, subject: "Weekly #42", receivedAt: "2026-10-11T03:00:00Z", labels: ["INBOX", "UNREAD"], listUnsubscribe: true },
    { ...base, id: "g", threadId: "g", from: { name: "GitHub", email: "notifications@github.com" }, subject: "[repo] CI failed", receivedAt: "2026-10-11T04:00:00Z", labels: ["INBOX", "UNREAD"] },
    { ...base, id: "s", threadId: "s", from: { name: "教務處", email: "aa@nycu.edu.tw" }, subject: "[公告] 選課", receivedAt: "2026-10-11T05:00:00Z", labels: ["INBOX", "UNREAD"] },
    { ...base, id: "o", threadId: "o", from: { name: "Shop", email: "deals@shop.example" }, subject: "Sale", receivedAt: "2026-10-11T06:00:00Z", labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] },
    { ...base, id: "read", threadId: "read", from: { name: "Weekly", email: "hi@weekly.dev" }, subject: "Weekly #41", receivedAt: "2026-10-10T03:00:00Z", labels: ["INBOX"], unread: false, listUnsubscribe: true },
    { ...base, id: "archived", threadId: "archived", from: { name: "陳教授", email: "chen@cs.nycu.edu.tw" }, subject: "舊信", receivedAt: "2026-10-10T03:00:00Z", labels: ["IMPORTANT"] },
  ];
  const contribution = mailContribution({ messages, now, timeZone: "Asia/Taipei", schoolDomains: ["nycu.edu.tw"], suggested: new Set() });
  const snoozedOut = mailContribution({ messages, now, timeZone: "Asia/Taipei", schoolDomains: ["nycu.edu.tw"], suggested: new Set(), aside: new Set(["gmail:o"]) });
  assert.ok(!snoozedOut.digest?.some((category) => category.key === "promo"), "a snoozed or handled conversation leaves the digest");
  const queue = contribution.queue!;
  assert.deepEqual(queue.map((row) => [row.id, row.kind, row.hints.important ?? null]), [
    ["gmail:p", "mail.reply", true], ["gmail:q", "mail.reply", false], ["gmail:b", "mail.bill", null],
  ]);
  const bill = queue.find((row) => row.id === "gmail:b")!;
  assert.equal(bill.title, "台灣電力公司 10 月帳單 NT$1,234");
  assert.deepEqual(bill.meta, ["帳單", "10/25 截止", "已設定自動扣繳"]);
  assert.equal(bill.hints.dueAt, "2026-10-25T15:59:00.000Z");
  assert.equal(bill.summarySource, "rule");
  assert.deepEqual(contribution.digest, [
    { key: "newsletter", label: "電子報", count: 1, action: "read" },
    { key: "school", label: "學校公告", count: 1, action: "open", url: "https://mail.google.com/mail/u/0/#inbox" },
    { key: "github", label: "GitHub 通知", count: 1, action: "read" },
    { key: "promo", label: "促銷", count: 1, action: "archive" },
  ]);
  assert.equal(contribution.inboxUnread, 7);
});

test("封存: local at once, nothing reaches Gmail before the commit, undo cancels; after the commit undo re-adds INBOX", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, today, inbox, mail } = await setup(t, { connect: true });
  await today();
  const archived = await server.call("POST", "/api/actions", { body: { itemId: `gmail:${CHT}`, action: "archive" } });
  assert.equal(archived.status, 202, archived.text);
  assert.equal(archived.json.label, "已封存");
  assert.ok(!mail(CHT)!.labels.includes("INBOX"), "the cache changes before the 202");
  assert.ok(!(await inbox()).threads.some((thread) => thread.messageId === CHT));
  const after = await today();
  assert.deepEqual(rows(after), [`now:gmail:${LIN}`, "today:ai:sg-sitcon-autumn", "today:ai:sg-hw5-os"]);
  assert.equal(after.counts.inboxUnread, 11);
  t.mock.timers.tick(6_000);
  assert.equal(gmail.calls("POST", "/threads/").length, 0, "nothing reached Gmail inside the undo window");
  assert.equal((await server.call("DELETE", `/api/actions/${archived.json.actionId}`, { body: {} })).status, 200);
  assert.ok(mail(CHT)!.labels.includes("INBOX"), "undo restores the cache");
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gmail.calls("POST", "/threads/").length, 0, "the cancelled write never runs");

  const again = await server.call("POST", "/api/actions", { body: { itemId: `gmail:${CHT}`, action: "archive" } });
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${CHT}/modify`).length === 1, "threads.modify after 6.5 s");
  assert.deepEqual(gmail.calls("POST", `/threads/${CHT}/modify`)[0].body, { addLabelIds: [], removeLabelIds: ["INBOX"] });
  await until(() => !gmail.labels(CHT).includes("INBOX"), "Gmail archived it");
  // The commit settles asynchronously; poll the action's state through the API.
  let state = "";
  for (let index = 0; index < 50 && state !== "committed"; index++) {
    state = (await server.call("GET", `/api/actions/${again.json.actionId}`)).json.state;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(state, "committed");
  const late = await server.call("DELETE", `/api/actions/${again.json.actionId}`, { body: {} });
  assert.equal(late.status, 200, late.text);
  assert.deepEqual(gmail.calls("POST", `/threads/${CHT}/modify`)[1].body, { addLabelIds: ["INBOX"], removeLabelIds: [] });
  assert.ok(gmail.labels(CHT).includes("INBOX"));
  assert.ok(mail(CHT)!.labels.includes("INBOX"));
});

test("a failed Gmail write puts the mail back and the action reports failed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, today, mail } = await setup(t, { connect: true });
  await today();
  gmail.failModify = 500;
  const archived = await server.call("POST", "/api/actions", { body: { itemId: `gmail:${LIN}`, action: "archive" } });
  assert.equal(archived.status, 202);
  t.mock.timers.tick(6_500);
  let status: { state?: string; error?: string } = {};
  for (let index = 0; index < 200 && status.state !== "failed"; index++) {
    await new Promise((resolve) => setImmediate(resolve));
    status = (await server.call("GET", `/api/actions/${archived.json.actionId}`)).json;
  }
  assert.equal(status.state, "failed");
  assert.match(status.error ?? "", /Gmail 回應 HTTP 500/);
  assert.ok(mail(LIN)!.labels.includes("INBOX"), "the local archive is undone");
  assert.ok(rows(await today()).includes(`now:gmail:${LIN}`), "the row is back");
});

test("digest bulk 全部標為已讀 and per-category actions use batchModify; the inbox header marks one category", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, today, inbox, mail } = await setup(t, { connect: true });
  const before = await today();
  assert.equal(before.digest?.total, 9);

  const all = await server.call("POST", "/api/actions", { body: { itemId: "gmail:digest", action: "read" } });
  assert.equal(all.status, 202, all.text);
  assert.equal(all.json.label, "已將 9 封標為已讀");
  const after = await today();
  assert.equal(after.digest, undefined);
  assert.equal(after.counts.inboxUnread, 3);
  assert.equal(after.counts.handled, before.counts.handled, "a bulk read is not a queue item");
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", "/messages/batchModify").length === 1, "one batchModify");
  const call = gmail.calls("POST", "/messages/batchModify")[0].body as { ids: string[]; removeLabelIds: string[] };
  assert.equal(call.ids.length, 9);
  assert.deepEqual(call.removeLabelIds, ["UNREAD"]);
  assert.ok(!call.ids.includes(LIN) && !call.ids.includes(CHT) && !call.ids.includes(KKTIX), "queue rows and suggestion mail are left alone");

  const empty = await server.call("POST", "/api/actions", { body: { itemId: "gmail:digest:promo", action: "archive" } });
  assert.equal(empty.status, 409);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "gmail:digest:newsletter", action: "archive" } })).status, 400);

  // #/inbox: the 需要回覆 header's 全部標為已讀 marks only that category.
  const list = await inbox();
  assert.equal(list.unread, 3);
  const header = await server.call("POST", "/api/actions", { body: { itemId: "gmail:category:needs-reply", action: "read" } });
  assert.equal(header.status, 202, header.text);
  assert.equal(header.json.label, "已將 1 封標為已讀");
  assert.equal(mail(LIN)!.unread, false);
  assert.equal(mail(CHT)!.unread, true);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "gmail:category:nope", action: "read" } })).status, 400);
});

test("#/inbox: threads by category with Today's actions, the reading pane with excerpts and suggestions, purge", async (t) => {
  const { server, services, inbox } = await setup(t);
  const list = await inbox();
  assert.deepEqual(list.counts, { "needs-reply": 2, bill: 1, school: 4, invitation: 1, newsletter: 3, notification: 4, other: 0 });
  assert.equal(list.unread, 12);
  assert.equal(list.threads.length, 15);
  assert.deepEqual(list.source, { connected: false, state: "off", lastSyncedAt: list.source.lastSyncedAt });
  const lin = list.threads.find((thread) => thread.messageId === LIN)!;
  assert.deepEqual(
    { title: lin.title, meta: lin.meta, avatar: lin.avatar, kind: lin.kind, inQueue: lin.inQueue, actions: lin.actions.map((action) => action.id), when: lin.when },
    { title: "Re: OS 期末專題題目討論", meta: ["林志明 教授", "教授同意用 eBPF 觀察排程延遲當期末專題，請你在週三 10:00 meeting 前回信，附上一頁提案並確認時間。"], avatar: { initial: "林" },
      kind: "mail.reply", inQueue: true, actions: ["reply", "todo", "snooze", "archive", "trash", "assignment"], when: { label: "08:05", mono: true } },
  );
  const ta = list.threads.find((thread) => thread.messageId === TA)!;
  assert.deepEqual({ replied: ta.replied, inQueue: ta.inQueue, state: ta.state }, { replied: true, inQueue: false, state: { kind: "handled", action: "reply" } });
  const news = list.threads.find((thread) => thread.category === "newsletter")!;
  assert.equal(news.avatar, undefined, "automated senders get a tile, not an initial");
  assert.deepEqual(news.actions.map((action) => [action.id, action.key ?? null]), [["read", "E"], ["todo", "T"], ["snooze", "S"], ["archive", null], ["trash", "#"], ["assignment", "A"], ["reply", null]]);
  assert.equal(list.threads.find((thread) => thread.category === "school")?.avatar, undefined, "an office sends announcements, not personal mail");
  assert.deepEqual(ta.actions.map((action) => action.id), ["reply", "todo", "snooze", "archive", "trash", "assignment"], "mail to answer leads with 回覆 even outside the queue");
  assert.ok(list.threads.every((thread, index, all) => index === 0 || all[index - 1].receivedAt >= thread.receivedAt), "newest first");

  // Snoozed conversations are hidden until they wake.
  services.itemState.record({ itemId: `gmail:${CHT}`, kind: "mail.bill", action: "snooze", title: "帳單", closes: true, state: { state: "snoozed", until: "2026-10-13T00:00:00.000Z" } });
  const snoozed = await inbox();
  assert.equal(snoozed.snoozed, 1);
  assert.equal(snoozed.counts.bill, 0);

  const detail = await server.call("GET", `/api/gmail/threads/${KKTIX}`);
  assert.equal(detail.status, 200);
  const body = detail.json as InboxThreadResponse;
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].mine, false);
  assert.deepEqual(body.suggestions, [{
    itemId: "ai:sg-sitcon-autumn", kind: "suggestion.event", title: "從信件找到 1 個活動，要加入行事曆嗎？",
    meta: ["SITCON 秋季交流會", "10/25（日）13:30", "中研院人文館"],
    actions: [{ id: "calendar", label: "加入行事曆", touchLabel: "加入行事曆", key: "C" }, { id: "dismiss", label: "略過", touchLabel: "略過", key: "E" }],
  }]);
  const linDetail = (await server.call("GET", `/api/gmail/threads/${LIN}`)).json as InboxThreadResponse;
  assert.match(linDetail.messages[0].excerpt ?? "", /^同學好，/);
  assert.equal((await server.call("GET", "/api/gmail/threads/unknown-thread")).status, 404);
  assert.equal((await server.call("GET", "/api/gmail/threads/bad%20id")).status, 404);

  // Without a Google connection 封存 is refused at once instead of failing after the undo window.
  const refused = await server.call("POST", "/api/actions", { body: { itemId: `gmail:${LIN}`, action: "archive" } });
  assert.equal(refused.status, 503);
  assert.match(refused.json.error, /Gmail 尚未連接/);
  assert.ok(services.sourceItems.get<MailMessage>("gmail", LIN)?.value.labels.includes("INBOX"));

  const mailSuggestions = () => services.suggestions.list({ status: "pending" }).filter((suggestion) => suggestion.sourceRef?.source === "gmail");
  assert.ok(mailSuggestions().length > 0, "the seeded SITCON suggestion came from mail");
  const cached = services.sourceItems.count("gmail", "mail");
  assert.ok(cached > list.threads.length, "archived mail is cached too");
  const purge = await server.call("POST", "/api/gmail/purge", { body: {} });
  assert.deepEqual(purge.json, { removed: cached }, "every cached message, archived ones included");
  assert.equal((await inbox()).threads.length, 0);
  assert.deepEqual(mailSuggestions(), [], "清除快取的信件 also deletes suggestions made from the mail");
  assert.equal(services.db.personal.db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE item_id LIKE 'gmail:%' AND title <> '（已清除的信件）'").get()!.n, 0, "and the subjects in the handled list");
  assert.equal(services.syncState.get("gmail")?.cursor, null, "the next sync starts with a full sync");
  assert.equal((await server.call("POST", "/api/gmail/purge", { body: { all: true } })).status, 400);
});

test("a crash inside the undo window: boot repair brings the row back and the next sync rereads the mail's real labels", async (t) => {
  const { services, server, today, mail } = await setup(t, { connect: true });
  services.syncState.save("gmail", { state: "ok", cursor: "5000" });
  await today();
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: `gmail:${CHT}`, action: "archive" } })).status, 202);
  assert.ok(!mail(CHT)!.labels.includes("INBOX"));
  // The process dies before the commit: the timer and the in-memory label overlay are gone.
  appContext(server.app).today.actions.close();
  assert.equal(repairActionsAfterRestart(services), 1);
  assert.equal(services.itemState.get(`gmail:${CHT}`), undefined);
  assert.equal(services.syncState.get("gmail")?.cursor, null, "the next Gmail sync is a full one");
  const restarted = await startTestServer(t, services, { modules: [gmailModule] });
  const gmailSource = appContext(restarted.app).modules.sources.find((source) => source.id === "gmail")!;
  assert.equal((await gmailSource.sync()).state, "ok");
  assert.ok(mail(CHT)!.labels.includes("INBOX"), "Gmail never archived it: the cache says so again");
});

test("profile.roles without student: no 轉成作業 in #/inbox, Today or the reader, and no assignment proposal there", async (t) => {
  const { server, today, inbox, mail } = await setup(t);
  const hw5Thread = mail(DEMO_HW5_MAIL)!.threadId;
  const assignmentActions = (list: InboxListResponse) => list.threads.filter((thread) => thread.actions.some((action) => action.id === "assignment")).length;
  const todayAssignments = (payload: TodayPayload) => payload.queue.flatMap((group) => group.items).filter((item) => item.id === `ai:${DEMO_HW5_SUGGESTION}` || item.actions.some((action) => action.id === "assignment")).length;
  const readerSuggestions = async () => ((await server.call("GET", `/api/gmail/threads/${hw5Thread}`)).json as InboxThreadResponse).suggestions.map((suggestion) => suggestion.kind);
  assert.ok(assignmentActions(await inbox()) > 0, "null: every row offers 轉成作業");
  assert.ok(todayAssignments(await today()) > 0);
  assert.deepEqual(await readerSuggestions(), ["suggestion.assignment"]);

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["developer", "ctf"] } })).status, 200);
  assert.equal(assignmentActions(await inbox()), 0, "the lms module is hidden: no row offers 轉成作業");
  assert.equal(todayAssignments(await today()), 0, "nor a Today row or the HW5 proposal");
  assert.deepEqual(await readerSuggestions(), [], "the reader drops the assignment proposal");
  const search = await server.call("GET", "/api/gmail/search?q=HW5");
  assert.equal(search.status, 200, search.text);
  assert.ok(search.json.threads.length > 0, "the cached search finds the HW5 mail");
  assert.equal(assignmentActions(search.json), 0, "search rows neither");

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["student"] } })).status, 200);
  assert.ok(assignmentActions(await inbox()) > 0, "back for a student");
  assert.deepEqual(await readerSuggestions(), ["suggestion.assignment"]);
});
