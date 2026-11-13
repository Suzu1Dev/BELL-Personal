/**
 * The whole product on the demo day: every feature module registered as in
 * production (server/features/index.ts), the SPEC §13 mockup seeded, no
 * fixture override. Covers the contracts between teams — each module's
 * today() contribution, the action handlers behind the queue buttons, the
 * suggestion acceptors, capture → todos/calendar, habits ↔ GitHub — over
 * HTTP. Network and CLIs are fakes: nothing reaches Google, GitHub or a model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_HW5_MAIL, DEMO_HW5_SUGGESTION } from "../scripts/seed-demo-assignments.js";
import { seedKit } from "../scripts/seed-demo-kit.js";
import { seedDemo } from "../scripts/seed-demo.js";
import type { AssignmentsResponse } from "../shared/assignments.js";
import type { InboxListResponse, InboxThreadResponse, MailMessage, MailSearchResponse } from "../shared/mail.js";
import type { TodayPayload } from "../shared/today.js";
import type { FetchLike } from "./sync.js";
import { featureModules } from "./features/index.js";
import { connectGoogle, FakeGmail } from "./features/gmail/fake-gmail.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices } from "./test-helpers.js";

const NOW = new Date("2026-10-12T08:42:00+08:00");
const TZ = "Asia/Taipei";

async function setup(t: test.TestContext, options: { google?: boolean } = {}) {
  const gmail = new FakeGmail(() => NOW);
  const outbound: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    outbound.push(String(input));
    return gmail.fetch(input, init);
  };
  const services = testServices(t, { seams: { fetch, now: () => NOW } });
  seedDemo(services.db, { now: NOW, timeZone: TZ });
  if (options.google) await connectGoogle(services);
  for (const item of services.sourceItems.list<MailMessage>({ source: "gmail" }))
    gmail.add({ id: item.value.id, threadId: item.value.threadId, subject: item.value.subject, at: item.value.receivedAt, labels: item.value.labels, text: item.value.snippet }, false);
  const server = await startTestServer(t, services, { modules: featureModules });
  const today = async () => {
    const response = await server.call("GET", "/api/today");
    assert.equal(response.status, 200, response.text);
    return response.json as TodayPayload;
  };
  const act = async (itemId: string, action: string, params?: Record<string, unknown>) => {
    const response = await server.call("POST", "/api/actions", { body: { itemId, action, ...(params ? { params } : {}) } });
    assert.equal(response.status, 202, response.text);
    return response.json as { actionId: string; label: string };
  };
  const undo = async (actionId: string) => {
    const response = await server.call("DELETE", `/api/actions/${actionId}`, { body: {} });
    assert.equal(response.status, 200, response.text);
  };
  return { gmail, outbound, services, server, today, act, undo };
}

const rows = (payload: TodayPayload) => payload.queue.map((group) => [group.group, group.items.map((item) => item.id)]);

test("Today from the real modules: the mockup's queue, digest, agenda gap, habits, ideas, later, weather and brief", async (t) => {
  const { today } = await setup(t);
  const payload = await today();
  assert.deepEqual(rows(payload), [
    ["now", ["moodle:30512", "gmail:18c2f0a1b2c3d4e5", "github:PR_kwDOSitcon127"]],
    ["today", ["native:todo-study-slides", "gmail:18c2e9d0a1b2c3f6", "ai:sg-sitcon-autumn", "ai:sg-hw5-os"]],
    ["later", ["moodle:30744", "assignment:5d0c9a3e-1f2b-4c6d-8e7f-0a1b2c3d4e5f", "ctftime:2846"]],
  ]);
  assert.deepEqual({ open: payload.counts.open, handled: payload.counts.handled, total: payload.counts.total, inboxUnread: payload.counts.inboxUnread, habitsLeft: payload.counts.habitsLeft },
    { open: 10, handled: 3, total: 13, inboxUnread: 12, habitsLeft: 2 });
  assert.deepEqual(payload.counts.nav, { tasks: 4, work: 4, events: 1 });
  assert.deepEqual(payload.digest?.categories.map((category) => `${category.label} ${category.count}`), ["電子報 3", "學校公告 2", "GitHub 通知 4"]);
  assert.deepEqual(payload.agenda.items.map((item) => item.title), ["作業系統", "OS 讀書會 · Ch.5", "健身", "HW3 截止"]);
  assert.equal(payload.agenda.items[2].habitLink, "運動");
  assert.deepEqual({ hours: payload.agenda.gap?.hours, forItemId: payload.agenda.gap?.forItemId, label: payload.agenda.gap?.label }, { hours: 4, forItemId: "moodle:30512", label: "適合寫 HW3" });
  assert.deepEqual(payload.habits.map((habit) => [habit.name, habit.doneToday, habit.streak, habit.streakUnit]), [["閱讀 20 分鐘", true, 12, "天"], ["運動", false, 4, "週"], ["寫日記", false, 27, "天"]]);
  assert.deepEqual(payload.ideas.map((idea) => idea.text), ["用 eBPF 量 CFS 排程延遲，當期末專題", "CTF writeup 改寫成部落格系列"]);
  assert.equal(payload.later.events[0].title, "09:00 計算機網路");
  assert.deepEqual(payload.later.projects.map((project) => project.name), ["ctf-notes", "OS 期末專題", "vitejs/vite #18234"], "ordered by next milestone");
  assert.equal(payload.weather?.city, "新竹");
  assert.equal(payload.brief.state, "ready");
  assert.equal(payload.nextUp?.title, "作業系統");
  assert.equal(payload.sidebar?.streakDays, 12);
});

test("queue actions across modules: 完成 and undo, 延後, 加入行事曆 from mail, 要參加, 轉待辦 and 排進", async (t) => {
  const { services, server, today, act, undo, outbound } = await setup(t);

  const done = await act("native:todo-study-slides", "done");
  assert.equal((await today()).counts.open, 9);
  await undo(done.actionId);
  assert.equal((await today()).counts.open, 10);

  await act("github:PR_kwDOSitcon127", "snooze", { until: "2026-10-13T00:00:00.000Z" });
  const refused = await server.call("POST", "/api/actions", { body: { itemId: "moodle:30512", action: "snooze", params: { until: "2026-10-13T00:00:00.000Z" } } });
  assert.equal(refused.status, 400, "a hard deadline never snoozes past deadline − 2 h");

  // The SITCON suggestion from the KKTIX mail becomes a local event (Google is not connected).
  const accepted = await act("ai:sg-sitcon-autumn", "calendar");
  const week = (await server.call("GET", "/api/calendar?view=day&day=2026-10-25")).json;
  assert.deepEqual(week.days[0].items.map((item: { title: string }) => item.title), ["SITCON 秋季交流會"]);
  const handled = (await today()).handled ?? [];
  assert.equal(handled.find((entry) => entry.itemId === "ai:sg-sitcon-autumn")?.title, "SITCON 秋季交流會", "the handled list names the suggestion, not the question");
  await undo(accepted.actionId);
  assert.deepEqual((await server.call("GET", "/api/calendar?view=day&day=2026-10-25")).json.days[0].items, []);

  await act("ctftime:2846", "going");
  assert.ok((await server.call("GET", "/api/events")).json.events.some((event: { title: string; going?: boolean }) => event.title === "Balsn CTF 2026" && event.going));

  // 轉待辦 on a mail #/inbox lists but Today does not serve (a school notice).
  await act("gmail:demo-school-1", "todo");
  const todos = (await server.call("GET", "/api/todos")).json;
  const notice = todos.open.find((todo: { title: string }) => todo.title === "[公告] 本學期停修申請期間");
  assert.ok(notice, "the cached subject became the todo");
  assert.equal(notice.sourceRef?.url, "https://mail.google.com/mail/u/0/#inbox/demo-school-1");

  const gap = (await today()).agenda.gap!;
  await act(gap.forItemId, "schedule", { start: gap.start, end: gap.end });
  const day = (await server.call("GET", "/api/calendar?view=day&day=2026-10-12")).json;
  assert.ok(day.days[0].items.some((item: { title: string; start: string }) => item.start === gap.start), "排進 made a block in the free slot");
  assert.equal(outbound.length, 0, "nothing left the machine");
  void services;
});

test("mail 標為已讀 is local and undoable inside the 6.5 s window, so nothing reaches Gmail", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, today, act, undo } = await setup(t, { google: true });
  const before = await today();
  const read = await act("gmail:digest", "read");
  const after = await today();
  assert.equal(after.digest, undefined, "the digest strip goes away");
  assert.equal(after.counts.inboxUnread, before.counts.inboxUnread - 9);
  t.mock.timers.tick(6_000);
  await undo(read.actionId);
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gmail.calls("POST", "/messages/batchModify").length, 0, "the cancelled write never ran");
  assert.equal((await today()).counts.inboxUnread, before.counts.inboxUnread);
});

test("without Gmail, 封存 and 標為已讀 are refused before anything changes", async (t) => {
  const { server, today } = await setup(t);
  const response = await server.call("POST", "/api/actions", { body: { itemId: "gmail:digest", action: "read" } });
  assert.equal(response.status, 503);
  assert.match(response.json.error, /Gmail 尚未連接/);
  assert.equal((await today()).counts.inboxUnread, 12);
});

test("capture → todos and calendar, habit check-ins and the GitHub habit, settings, feeds and export", async (t) => {
  const { server, today } = await setup(t);
  const todo = await server.call("POST", "/api/capture", { body: { text: "明天 9:00 交報告" } });
  assert.equal(todo.status, 201, todo.text);
  assert.equal(todo.json.message, "已加入待辦「交報告」· 明天 09:00");
  assert.ok((await today()).queue.some((group) => group.items.some((item) => item.id === `native:${todo.json.id}`)));
  assert.equal((await server.call("DELETE", todo.json.undoPath, { body: {} })).status, 200);

  const event = await server.call("POST", "/api/capture", { body: { text: "明天下午三點 跟教授 meeting" } });
  assert.equal(event.status, 201, event.text);
  assert.equal(event.json.type, "event");
  const tomorrow = (await server.call("GET", "/api/calendar?view=day&day=2026-10-13")).json;
  assert.ok(tomorrow.days[0].items.some((item: { title: string }) => item.title === "跟教授 meeting"));
  assert.equal((await server.call("DELETE", event.json.undoPath, { body: {} })).status, 200);

  const check = await server.call("POST", "/api/habits/habit-diary/check", { body: {} });
  assert.equal(check.status, 200, check.text);
  assert.equal((await today()).counts.habitsLeft, 1);
  assert.equal((await server.call("DELETE", "/api/habits/habit-diary/check", { body: {} })).status, 200);

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "habits.githubAuto": true } })).status, 200);
  const habits = (await server.call("GET", "/api/habits")).json;
  const auto = habits.habits.find((habit: { auto?: boolean }) => habit.auto);
  assert.equal(auto?.name, "GitHub 有貢獻");
  assert.ok(auto.streak > 0, "the streak comes from the GitHub contribution calendar");

  const invalid = await server.call("PUT", "/api/settings/app", { body: { "mail.retentionDays": 0 } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /^mail\.retentionDays: 數值過小/);
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "ai.enabled": false } })).status, 200);
  const brief = (await today()).brief;
  assert.equal(brief.state, "off");
  assert.match(brief.text, /^1 封信待回覆，1 項作業今晚 23:59 截止。/);

  const http = await server.call("POST", "/api/events/feeds", { body: { url: "http://example.com/feed.xml", label: "測試" } });
  assert.equal(http.status, 400);
  assert.equal((await server.call("GET", "/api/events/feeds")).json.feeds.length, 2);

  const exported = await server.call("GET", "/api/export");
  assert.equal(exported.status, 200);
  assert.match(String(exported.headers["content-disposition"]), /attachment/);
  assert.ok(exported.json.personal.todos.length >= 6);
  assert.doesNotMatch(exported.text, /refreshToken|1\/\/test-refresh/);
});

/* ------------------------------------- mail row actions, archive, search and assignments from mail (SPEC-mail-assignments) */

const CHT = "18c2e9d0a1b2c3f6";
const LIN = "18c2f0a1b2c3d4e5";
const DAY_MS = 86_400_000;

/** Lets queued deferred writes run (the fake Gmail answers on the next turns). */
async function until(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), message);
}

const queueIds = (payload: TodayPayload) => payload.queue.flatMap((group) => group.items.map((item) => item.id));
const queueRow = (payload: TodayPayload, id: string) => payload.queue.flatMap((group) => group.items.map((item) => ({ ...item, group: group.group }))).find((item) => item.id === id);

test("mail rows across Today and 收件匣: 封存 and 刪除 with 復原 inside the window send nothing; after it, 復原 untrashes; 封存 view, reader, 移回收件匣 and search scopes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, server, today, act, undo } = await setup(t, { google: true });
  const inbox = async () => (await server.call("GET", "/api/gmail/threads")).json as InboxListResponse;
  const search = async (query: string) => (await server.call("GET", `/api/gmail/search?${query}`)).json as MailSearchResponse;
  const writes = () => gmail.requests.filter((request) => request.method === "POST");
  const before = await today();

  // Without opening: 刪除 on Today's bill row and 封存 on a newsletter only #/inbox lists, then 復原 on both inside the window.
  const bill = queueRow(before, `gmail:${CHT}`)!;
  assert.deepEqual(bill.actions.map((action) => action.id), ["todo", "archive", "snooze", "trash"]);
  const trashed = await act(`gmail:${CHT}`, "trash");
  const archived = await act("gmail:demo-news-2", "archive");
  const during = await today();
  assert.ok(!queueIds(during).includes(`gmail:${CHT}`));
  assert.deepEqual([during.counts.inboxUnread, during.counts.handled], [before.counts.inboxUnread - 2, before.counts.handled + 1], "the bill closes; both were unread");
  assert.ok(!(await inbox()).threads.some((thread) => thread.messageId === CHT || thread.messageId === "demo-news-2"));
  t.mock.timers.tick(6_000);
  await undo(trashed.actionId);
  await undo(archived.actionId);
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes(), [], "nothing reached Gmail");
  const restored = await today();
  assert.ok(queueIds(restored).includes(`gmail:${CHT}`));
  assert.deepEqual([restored.counts.inboxUnread, restored.counts.handled], [before.counts.inboxUnread, before.counts.handled]);
  assert.ok((await inbox()).threads.some((thread) => thread.messageId === "demo-news-2"));

  // After the window: threads.trash; 復原 from Today's handled list untrashes and puts INBOX back.
  const late = await act(`gmail:${LIN}`, "trash");
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${LIN}/trash`).length === 1, "threads.trash after the window");
  assert.equal(gmail.calls("POST", /\/delete$/).length, 0, "never a permanent delete");
  assert.ok((await today()).handled?.some((entry) => entry.itemId === `gmail:${LIN}` && entry.action === "trash" && entry.undoable));
  await undo(late.actionId);
  assert.deepEqual(gmail.calls("POST", /^\/messages\/[^/]+\/untrash$/).map((call) => call.path), [`/messages/${LIN}/untrash`]);
  assert.deepEqual(gmail.calls("POST", "/messages/batchModify").map((call) => call.body), [{ ids: [LIN], addLabelIds: ["INBOX"], removeLabelIds: [] }]);
  assert.ok(queueIds(await today()).includes(`gmail:${LIN}`), "the reply row is back");

  // 封存 the bill for good: it is in the 封存 view (from Gmail) and its reader; a search finds it per scope.
  await act(`gmail:${CHT}`, "archive");
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${CHT}/modify`).length === 1, "threads.modify after the window");
  const archive = await search("view=archive");
  assert.equal(archive.origin, "gmail");
  const row = archive.threads.find((thread) => thread.messageId === CHT)!;
  assert.deepEqual([row.location, row.live ?? false, row.actions[0].id, row.actions[1].id], ["archive", false, "unarchive", "trash"]);
  const reader = (await server.call("GET", `/api/gmail/threads/${CHT}`)).json as InboxThreadResponse;
  assert.equal(reader.thread.location, "archive");
  assert.match(reader.messages.at(-1)!.excerpt ?? reader.messages.at(-1)!.snippet, /NT\$599/);
  assert.deepEqual((await search(`view=inbox&q=${encodeURIComponent("中華電信")}`)).threads.map((thread) => thread.messageId), [], "收件匣 scope: archived mail is not there");
  assert.deepEqual((await search(`view=archive&q=${encodeURIComponent("中華電信")}`)).threads.map((thread) => thread.messageId), [CHT]);
  assert.deepEqual((await search(`view=all&q=${encodeURIComponent("中華電信")}`)).threads.map((thread) => [thread.messageId, thread.location]), [[CHT, "archive"]]);
  const lastList = new URLSearchParams(gmail.calls("GET", /^\/messages\?/).at(-1)!.path.split("?")[1]);
  assert.equal(lastList.get("q"), "-in:drafts 中華電信 -in:spam -in:trash");

  // 移回收件匣: back in 收件匣 at once, Gmail after the window; the Today row handled today stays closed.
  await act(`gmail:${CHT}`, "unarchive");
  assert.ok((await inbox()).threads.some((thread) => thread.messageId === CHT));
  assert.ok(!(await search("view=archive")).threads.some((thread) => thread.messageId === CHT));
  assert.ok(!queueIds(await today()).includes(`gmail:${CHT}`), "移回收件匣 does not reopen a row handled today");
  t.mock.timers.tick(6_500);
  await until(() => gmail.calls("POST", `/threads/${CHT}/modify`).length === 2, "threads.modify add INBOX");
  assert.deepEqual(gmail.calls("POST", `/threads/${CHT}/modify`)[1].body, { addLabelIds: ["INBOX"], removeLabelIds: [] });
});

test("assignments from mail across 收件匣, Today and #/work: 轉成作業 on a Today row and on a live archived mail, 加入作業, agenda and nav counts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { gmail, services, server, today, act, undo } = await setup(t, { google: true });
  const work = async () => (await server.call("GET", "/api/lms/assignments")).json as AssignmentsResponse;
  const kit = seedKit({ now: NOW, timeZone: TZ });
  // A professor's mail that needs a reply and announces HW6: a Today mail row whose rules add 轉成作業 A.
  const hw6 = kit.mail("demo-hw6", { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, "【作業系統】HW6 分組與繳交", kit.at(0, "07:30"), {
    snippet: "HW6：Page Replacement 模擬，請於 10/16（五）23:59 前上傳至 E3…",
    excerpt: "同學好，\n\nHW6：Page Replacement 模擬，請於 10/16（五）23:59 前上傳至 E3。組員名單請直接回信給我。\n\n林志明",
    triage: kit.triage("needs-reply", "HW6 要回信告知組員名單，10/16 23:59 前上傳 E3。", { priority: "high", action: "reply", context: "作業系統" }),
  });
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: hw6.id, value: hw6, updatedAt: hw6.receivedAt }]);
  gmail.add({ id: hw6.id, subject: hw6.subject, at: hw6.receivedAt, labels: hw6.labels, text: hw6.excerpt }, false);
  // A TA's reminder archived long ago: only Gmail has it.
  gmail.add({ id: "live-lab4", threadId: "live-lab4-thread", from: "王助教 <ta-os@cs.nycu.edu.tw>", subject: "【作業系統】Lab 4 繳交提醒",
    text: "Lab 4：排程器實作，請於 10/12 23:59 前上傳至 E3。", labels: [], at: "2026-09-30T06:00:00.000Z" }, false);

  const before = await today();
  const navBefore = before.counts.nav!.work!;
  const row = queueRow(before, `gmail:${hw6.id}`)!;
  assert.deepEqual(row.actions.map((action) => `${action.label} ${action.key ?? ""}`.trim()), ["回覆 Enter", "轉待辦 T", "延後 S", "封存 E", "刪除 #", "轉成作業 A"]);

  // 轉成作業 on the Today row: the row closes, the rules' draft is on #/work and back on Today as an assignment; 復原 undoes it.
  const first = await act(row.id, "assignment");
  assert.equal(first.label, "已轉成作業");
  let made = (await work()).assignments.find((item) => item.mailRef?.messageId === hw6.id)!;
  assert.deepEqual([made.origin, made.title, made.courseName, made.dueAt, made.submitHint, made.site?.label, made.mailSender],
    ["mail", "HW6：Page Replacement 模擬", "作業系統", "2026-10-16T15:59:00.000Z", "上傳至 E3", "信件", "林志明 教授"]);
  let payload = await today();
  assert.equal(queueRow(payload, row.id), undefined);
  assert.deepEqual(payload.handled?.[0] && [payload.handled[0].itemId, payload.handled[0].action], [row.id, "assignment"]);
  const native = queueRow(payload, made.id)!;
  assert.deepEqual([native.source, native.meta[0], native.actions[0].label, native.url], ["assignment", "信件", "開啟信件", `#/inbox/${hw6.threadId}`]);
  assert.equal(payload.counts.nav?.work, navBefore + 1);
  const listed = ((await server.call("GET", "/api/gmail/threads")).json as InboxListResponse).threads.find((thread) => thread.messageId === hw6.id)!;
  assert.deepEqual(listed.state, { kind: "handled", action: "assignment" }, "the inbox row says 已轉成作業");
  await undo(first.actionId);
  assert.ok(!(await work()).assignments.some((item) => item.id === made.id));
  assert.ok(queueIds(await today()).includes(row.id), "the mail row is back");
  await act(row.id, "assignment");
  made = (await work()).assignments.find((item) => item.mailRef?.messageId === hw6.id)!;

  // 轉成作業 on a conversation only Gmail has, found in the 封存 view with a search: read live, never cached.
  const found = (await server.call("GET", `/api/gmail/search?view=archive&q=${encodeURIComponent("Lab 4")}`)).json as MailSearchResponse;
  const live = found.threads.find((thread) => thread.messageId === "live-lab4")!;
  assert.deepEqual([live.live, live.location, live.actions.map((action) => action.id)], [true, "archive", ["unarchive", "trash", "assignment", "reply"]]);
  await act(live.itemId, "assignment");
  assert.equal(services.sourceItems.get("gmail", "live-lab4"), undefined, "the live mail is still not cached");
  const lab4 = (await work()).assignments.find((item) => item.mailRef?.messageId === "live-lab4")!;
  assert.deepEqual([lab4.title, lab4.courseName, lab4.dueAt, lab4.mailRef?.threadId], ["Lab 4：排程器實作", "作業系統", "2026-10-12T15:59:00.000Z", "live-lab4-thread"]);
  payload = await today();
  const tonight = queueRow(payload, lab4.id)!;
  assert.deepEqual([tonight.group, tonight.url, tonight.meta], ["now", "#/inbox/live-lab4-thread", ["信件", "作業系統", "今晚 23:59 截止", "尚未繳交"]]);
  assert.ok(payload.agenda.items.some((item) => item.kind === "due" && item.title === "Lab 4 截止"), "the agenda lists the deadline");
  const opened = (await server.call("GET", "/api/gmail/threads/live-lab4-thread")).json as InboxThreadResponse;
  assert.deepEqual([opened.thread.live, opened.thread.subject], [true, "【作業系統】Lab 4 繳交提醒"], "開啟信件 reads it live");
  // A second 轉成作業 on the same mail is refused (the core's wording inside the undo window, the lms one after it).
  const again = await server.call("POST", "/api/actions", { body: { itemId: live.itemId, action: "assignment" } });
  assert.equal(again.status, 409);
  assert.equal((await work()).assignments.filter((item) => item.mailRef?.messageId === "live-lab4").length, 1);

  // 加入作業 on the AI suggestion made from the HW5 mail.
  await act(`ai:${DEMO_HW5_SUGGESTION}`, "assignment");
  const list = await work();
  assert.deepEqual(list.suggestions, []);
  const hw5 = list.assignments.find((item) => item.mailRef?.messageId === DEMO_HW5_MAIL)!;
  assert.deepEqual([hw5.title, hw5.status], ["HW5：系統呼叫實作", "open"]);

  // The nav badge, Today and #/work agree: deadlines within 7 days not marked 已交, plus the PR review.
  payload = await today();
  const dueSoon = list.assignments.filter((item) => item.status === "open" && item.dueAt && Date.parse(item.dueAt) - NOW.getTime() <= 7 * DAY_MS);
  assert.equal(payload.counts.nav?.work, dueSoon.length + 1);
  assert.equal(payload.counts.nav?.work, navBefore + 3);
  for (const item of [made, lab4, hw5]) assert.ok(queueIds(payload).includes(item.id), `${item.title} is a Today row`);
  assert.deepEqual(gmail.requests.filter((request) => request.method === "POST"), [], "Gmail is untouched by 轉成作業 and 加入作業");
});

test("自動整理 on the demo day: the capture saves at once, the tidied title reaches Today, 復原 puts the rule title back", async (t) => {
  const answer = { title: "Deep Hacking 簡報", notes: ["主題：Windows Administrator Protection"], dueDay: "2026-10-18", dueTime: null, location: null, confidence: "high" };
  const stream = claudeFixtureEvents().map((event) => {
    if (event.type === "result") { event.structured_output = answer; event.result = JSON.stringify(answer); }
    if (event.type === "assistant") event.message.content[0].input = answer;
    return JSON.stringify(event);
  }).join("\n");
  const fake = fakeCommand((call) => (call.args.join(" ") === "auth status" ? "{}" : call.executable === "claude" ? stream : undefined));
  const services = testServices(t, { seams: { now: () => NOW, command: fake.runner, sleep: async () => {} } });
  seedDemo(services.db, { now: NOW, timeZone: TZ });
  const server = await startTestServer(t, services, { modules: featureModules });
  const titleOnToday = async (id: string) => {
    const payload = (await server.call("GET", "/api/today")).json as TodayPayload;
    return payload.queue.flatMap((group) => group.items).find((item) => item.id === `native:${id}`)?.title;
  };

  const created = await server.call("POST", "/api/capture", { body: { text: "Deep Hacking 簡報 要在周日前生出來，主題是 Windows Administrator Protection" } });
  assert.equal(created.status, 201, created.text);
  const { id, tidy } = created.json as { id: string; tidy?: { jobId: string } };
  assert.ok(tidy, "自動整理 started behind the save");
  await services.jobs.settled(tidy.jobId);
  const events: Array<{ type: string; result?: { applied: boolean; message: string; undoToken: string } }> = [];
  services.jobs.follow(tidy.jobId, 0, (event) => events.push(event as (typeof events)[number]), () => {});
  const result = events.at(-1)!.result!;
  assert.equal(result.applied, true);
  assert.equal(result.message, "已整理成「Deep Hacking 簡報」· 10/18（日）");
  assert.equal(await titleOnToday(id), "Deep Hacking 簡報");
  const todo = (await server.call("GET", `/api/todos/${id}`)).json;
  assert.equal(todo.notes, "主題：Windows Administrator Protection");
  assert.equal(todo.dueDay, "2026-10-18");

  assert.equal((await server.call("POST", "/api/capture/tidy/undo", { body: { token: result.undoToken } })).status, 200);
  assert.equal(await titleOnToday(id), "Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection");
});
