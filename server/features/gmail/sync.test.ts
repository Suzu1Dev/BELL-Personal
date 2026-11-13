import test from "node:test";
import assert from "node:assert/strict";
import type { MailMessage } from "../../../shared/mail.js";
import { testServices } from "../../test-helpers.js";
import { connectGoogle, FakeGmail } from "./fake-gmail.js";
import { MailStore } from "./store.js";
import { GmailSync } from "./sync.js";

const NOW = new Date("2026-10-12T00:42:00Z"); // 08:42 in Taipei
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

async function setup(t: test.TestContext, options: { connect?: boolean; email?: string } = {}) {
  let now = NOW;
  const gmail = new FakeGmail(() => now);
  const services = testServices(t, { seams: { fetch: gmail.fetch, now: () => now } });
  if (options.connect !== false) await connectGoogle(services, undefined, options.email);
  const store = new MailStore(services.sourceItems);
  let synced = 0;
  const sync = new GmailSync(services, store, { onSynced: () => { synced++; } });
  t.after(() => sync.close());
  return { gmail, services, store, sync, synced: () => synced, setNow: (next: Date) => { now = next; } };
}

test("not configured without a Google token: 尚未設定, no request", async (t) => {
  const { sync, gmail } = await setup(t, { connect: false });
  const status = await sync.sync();
  assert.equal(status.state, "not_configured");
  assert.equal(gmail.requests.length, 0);
});

test("full sync: inbox of the last 14 days, metadata and a plain-text excerpt only, historyId as the cursor", async (t) => {
  const { gmail, services, store, sync, synced } = await setup(t);
  gmail.add({ id: "lin", from: "\"林志明 教授\" <cmlin@cs.nycu.edu.tw>", subject: "Re: OS 期末專題題目討論", at: ago(0.6), labels: ["INBOX", "UNREAD", "IMPORTANT"],
    html: "<html><head><style>p{}</style></head><body><p>請在週三 10:00 前回信。</p><img src=\"https://t.example/x.gif\"><script>evil()</script></body></html>" });
  gmail.add({ id: "news", from: "iThome <newsletter@ithome.com.tw>", subject: "本週資安焦點", at: ago(5), text: "電子報內容", headers: { "List-Unsubscribe": "<mailto:u@ithome.com.tw>" } });
  gmail.add({ id: "old", subject: "上個月的信", at: ago(24 * 20), text: "old" });
  gmail.add({ id: "backlog", subject: "十天前的信", at: ago(24 * 10), text: "older than the triage window" });
  gmail.add({ id: "archived", subject: "已封存", at: ago(2), labels: ["UNREAD"], text: "not in inbox" });

  const status = await sync.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.equal(status.items, 3);
  assert.equal(synced(), 1, "the triage queue is kicked after a sync");
  assert.equal(services.syncState.get("gmail")?.cursor, "5005");
  assert.ok(gmail.calls("GET", "/messages?q=in%3Ainbox+newer_than%3A14d").length === 1);

  const lin = store.get("lin")!;
  assert.deepEqual(
    { from: lin.from, subject: lin.subject, excerpt: lin.excerpt, unread: lin.unread, webUrl: lin.webUrl },
    { from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "Re: OS 期末專題題目討論", excerpt: "請在週三 10:00 前回信。", unread: true,
      webUrl: "https://mail.google.com/mail/u/0/#all/lin" },
  );
  const stored = JSON.stringify(store.all());
  assert.doesNotMatch(stored, /<p>|<img|<script|evil|t\.example/, "no HTML, scripts or remote images are stored");
  assert.equal(lin.triageQueue?.state, "pending", "new mail is queued for AI triage");
  assert.equal(store.get("news")?.listUnsubscribe, true);
  assert.equal(store.get("backlog")?.triageQueue, undefined, "older backlog keeps the rules");
  assert.equal(store.get("old"), undefined);
  assert.equal(store.get("archived"), undefined);
});

test("incremental sync: new mail, label changes, deletions and a reply sent from Gmail", async (t) => {
  const { gmail, services, store, sync, setNow } = await setup(t);
  gmail.add({ id: "lin", threadId: "t-lin", from: "林志明 <cmlin@cs.nycu.edu.tw>", subject: "Re: 專題", at: ago(0.6), labels: ["INBOX", "UNREAD", "IMPORTANT"], text: "請回信" });
  gmail.add({ id: "cht", from: "中華電信 <ebill@cht.com.tw>", subject: "9 月電子帳單", at: ago(2), text: "金額 NT$599" });
  gmail.add({ id: "spam", subject: "促銷", at: ago(3), labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], text: "sale" });
  await sync.sync();
  const fullCalls = gmail.requests.length;
  store.put([{ ...store.get("lin")!, triageQueue: { state: "done", attempts: 1, updatedAt: NOW.toISOString() }, triage: { summary: "AI 摘要", category: "needs-reply", priority: "high", action: "reply", source: "ai", triagedAt: NOW.toISOString() } }]);

  setNow(new Date(NOW.getTime() + 10 * 60_000));
  gmail.add({ id: "new", from: "王助教 <ta@cs.nycu.edu.tw>", subject: "HW2", at: new Date(NOW.getTime() + 5 * 60_000).toISOString(), text: "請確認" });
  gmail.relabel("cht", { remove: ["UNREAD"] });
  gmail.relabel("lin", { add: ["STARRED"] });
  gmail.remove("spam");
  services.itemState.record({ itemId: "gmail:spam", kind: "mail.action", action: "snooze", title: "促銷", closes: true, state: { state: "snoozed", until: ago(-5) } });
  gmail.add({ id: "my-reply", threadId: "t-lin", from: "Suzu <suzu1dev@gmail.com>", subject: "Re: 專題", at: new Date(NOW.getTime() + 8 * 60_000).toISOString(), labels: ["SENT"], text: "好的" });

  const status = await sync.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  const incremental = gmail.requests.slice(fullCalls);
  assert.ok(incremental.some((request) => request.path.startsWith("/history?startHistoryId=")), "history.list, not a full listing");
  assert.ok(!incremental.some((request) => request.path.startsWith("/messages?q=")));
  assert.ok(store.get("new"), "a new inbox message is fetched");
  assert.equal(store.get("cht")?.unread, false);
  assert.ok(store.get("lin")?.labels.includes("STARRED"));
  assert.equal(store.get("lin")?.triage?.source, "ai", "a label change keeps the AI triage");
  assert.equal(store.get("spam"), undefined, "a deleted message is gone");
  assert.equal(services.itemState.get("gmail:spam"), undefined, "and its queue state is forgotten");
  assert.equal(store.get("my-reply"), undefined, "sent mail is not cached");
  assert.equal(store.get("lin")?.repliedAt, new Date(NOW.getTime() + 8 * 60_000).toISOString());
  const handled = services.itemState.get("gmail:lin");
  assert.equal(handled?.state, "handled", "the reply row closes as handled (回覆)");
  assert.equal(handled?.action, "reply");
  assert.equal(services.itemState.log(handled!.actionId!)?.actor, "sync");
});

test("history messages without labelIds: current labels are looked up instead of dropping the change", async (t) => {
  const { gmail, store, sync, setNow } = await setup(t);
  gmail.add({ id: "cht", from: "中華電信 <ebill@cht.com.tw>", subject: "9 月電子帳單", at: ago(2), text: "金額 NT$599" });
  gmail.add({ id: "spam", subject: "促銷", at: ago(3), labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], text: "sale" });
  await sync.sync();
  gmail.historyWithoutLabels = true;

  setNow(new Date(NOW.getTime() + 10 * 60_000));
  gmail.add({ id: "new", from: "王助教 <ta@cs.nycu.edu.tw>", subject: "HW2", at: new Date(NOW.getTime() + 5 * 60_000).toISOString(), text: "請確認" });
  gmail.relabel("cht", { remove: ["UNREAD", "INBOX"] });
  gmail.add({ id: "gone", subject: "已刪除", at: new Date(NOW.getTime() + 6 * 60_000).toISOString(), text: "x" });
  gmail.remove("gone");

  const status = await sync.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.ok(store.get("new"), "a new inbox message is still fetched");
  assert.equal(store.get("cht")?.unread, false);
  assert.ok(!store.get("cht")?.labels.includes("INBOX"), "an archive made in Gmail still reaches the cache");
  assert.equal(store.get("gone"), undefined);
  assert.ok(store.get("spam"), "untouched mail stays");
});

test("history 404 falls back to a full sync", async (t) => {
  const { gmail, services, store, sync } = await setup(t);
  gmail.add({ id: "a", subject: "A", at: ago(1), text: "a" });
  await sync.sync();
  gmail.historyExpired = true;
  gmail.add({ id: "b", subject: "B", at: ago(0.5), text: "b" });
  const before = gmail.requests.length;
  const status = await sync.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  const after = gmail.requests.slice(before).map((request) => request.path);
  assert.ok(after[0].startsWith("/history?"));
  assert.ok(after.some((path) => path.startsWith("/messages?q=in%3Ainbox")), "listed again");
  assert.ok(store.get("b"));
  assert.equal(services.syncState.get("gmail")?.cursor, "5002");
});

test("retention: mail older than mail.retentionDays is deleted and the full sync window shrinks", async (t) => {
  const { gmail, services, store, sync } = await setup(t);
  services.settings.update({ "mail.retentionDays": 7 });
  gmail.add({ id: "recent", subject: "recent", at: ago(24), text: "x" });
  gmail.add({ id: "nine-days", subject: "nine days", at: ago(24 * 9), text: "x" });
  await sync.sync();
  assert.ok(gmail.calls("GET", "/messages?q=in%3Ainbox+newer_than%3A7d").length === 1);
  assert.ok(store.get("recent"));
  assert.equal(store.get("nine-days"), undefined);
  // A message cached earlier that is now past the window is pruned on the next run.
  const stale: MailMessage = { ...store.get("recent")!, id: "stale", threadId: "stale", receivedAt: ago(24 * 8) };
  store.put([stale]);
  services.itemState.record({ itemId: "gmail:stale", kind: "mail.reply", action: "snooze", title: "x", closes: true, state: { state: "snoozed", until: ago(-1) } });
  const fromStale = services.suggestions.create({ kind: "todo", title: "回覆舊信", payload: { title: "回覆舊信" }, sourceRef: { source: "gmail", externalId: "stale" } });
  const fromRecent = services.suggestions.create({ kind: "todo", title: "回覆新信", payload: { title: "回覆新信" }, sourceRef: { source: "gmail", externalId: "recent" } });
  await sync.sync();
  assert.equal(store.get("stale"), undefined);
  assert.equal(services.itemState.get("gmail:stale"), undefined);
  assert.equal(services.suggestions.get(fromStale.id), undefined, "a suggestion made from pruned mail goes with it");
  assert.ok(services.suggestions.get(fromRecent.id), "one made from mail still cached stays");
  assert.equal(services.db.personal.db.prepare("SELECT title FROM action_log WHERE item_id = 'gmail:stale'").get()?.title, "（已清除的信件）");
});

test("a stale access token is refreshed once instead of asking to reconnect", async (t) => {
  const { gmail, sync } = await setup(t);
  gmail.add({ id: "a", subject: "A", at: ago(1), text: "a" });
  gmail.rejectToken = "test-access-token";
  const status = await sync.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.equal(gmail.refreshes, 1, "one refresh, then the new token is reused");
});

test("a 401 from Gmail means 需要重新連線 and background retries stop", async (t) => {
  const { gmail, services, sync } = await setup(t);
  gmail.failWith = 401;
  const status = await sync.sync();
  assert.equal(status.state, "needs_reconnect");
  assert.match(status.lastError ?? "", /需要重新連線/);
  const count = gmail.requests.length;
  sync.schedule();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gmail.requests.length, count, "skipped while waiting for the user");
  assert.equal(services.syncState.get("gmail")?.state, "needs_reconnect");
});

test("a message over the response cap is stored from its headers and the rest of the mailbox keeps syncing", async (t) => {
  const { gmail, store, sync, services } = await setup(t, { email: "suzu1dev@gmail.com" });
  gmail.add({ id: "huge", subject: "九月報表", at: ago(1), html: `<p>${"x".repeat(5_200_000)}</p>` });
  gmail.add({ id: "small", subject: "Hello", at: ago(2), text: "內容" });
  const status = await sync.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.equal(store.get("huge")?.subject, "九月報表");
  assert.equal(store.get("huge")?.excerpt, undefined);
  assert.equal(store.get("small")?.excerpt, "內容");
  assert.equal(gmail.calls("GET", /^\/messages\/huge\?format=metadata/).length, 1);
  assert.ok(services.syncState.get("gmail")?.cursor, "the cursor advances past the large message");
  assert.equal(store.get("small")?.webUrl, "https://mail.google.com/mail/u/suzu1dev%40gmail.com/#all/small", "links open the connected account");
});

test("links cached before the account was known are pointed at it on the next sync", async (t) => {
  const { store, sync, services } = await setup(t, { email: "suzu1dev@gmail.com" });
  store.put([{ id: "old", threadId: "old", from: { email: "a@example.com" }, subject: "舊信", snippet: "", receivedAt: ago(3), unread: false, labels: ["INBOX"], webUrl: "https://mail.google.com/mail/u/0/#inbox/old" } satisfies MailMessage]);
  services.syncState.save("gmail", { cursor: "5000" });
  assert.equal((await sync.sync()).state, "ok");
  assert.equal(store.get("old")?.webUrl, "https://mail.google.com/mail/u/suzu1dev%40gmail.com/#all/old");
});

test("a follow-up reply on a later day in a thread already answered closes nothing new", async (t) => {
  const { gmail, services, store, sync, setNow } = await setup(t);
  const day1 = new Date(NOW.getTime() + 60_000);
  gmail.add({ id: "prof", threadId: "t-prof", from: "林志明 <cmlin@cs.nycu.edu.tw>", subject: "Re: 專題", at: ago(0.5), labels: ["INBOX", "IMPORTANT"], text: "請回信" });
  await sync.sync();
  store.put([{ ...store.get("prof")!, triage: { summary: "請回信", category: "needs-reply", priority: "high", action: "reply", source: "ai", triagedAt: NOW.toISOString() } }]);
  setNow(new Date(day1.getTime() + 60_000));
  gmail.add({ id: "reply-1", threadId: "t-prof", from: "Suzu <suzu1dev@gmail.com>", subject: "Re: 專題", at: day1.toISOString(), labels: ["SENT"], text: "好的" });
  await sync.sync();
  const first = services.itemState.get("gmail:prof");
  assert.equal(first?.state, "handled");
  const closedDay1 = services.itemState.closedOn(services.today()).length;
  assert.equal(closedDay1, 1);

  // The next day, a follow-up in the same thread (the professor's mail stays the newest inbox message).
  const day2 = new Date(NOW.getTime() + 86_400_000);
  setNow(new Date(day2.getTime() + 60_000));
  gmail.add({ id: "reply-2", threadId: "t-prof", from: "Suzu <suzu1dev@gmail.com>", subject: "Re: 專題", at: day2.toISOString(), labels: ["SENT"], text: "補充一下" });
  await sync.sync();
  assert.equal(store.get("prof")?.repliedAt, day2.toISOString());
  assert.equal(services.itemState.closedOn(services.today()).length, 0, "nothing was open today, so nothing counts as handled today");
  assert.equal(services.itemState.get("gmail:prof")?.actionId, first?.actionId);
});
