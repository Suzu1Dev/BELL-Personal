import test from "node:test";
import assert from "node:assert/strict";
import type { InboxThreadResponse, MailMessage, MailSearchResponse } from "../../../shared/mail.js";
import { seedDemo } from "../../../scripts/seed-demo.js";
import { DEMO_HW5_MAIL } from "../../../scripts/seed-demo-assignments.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { connectGoogle, FakeGmail, type FakeMessageInput } from "./fake-gmail.js";
import { gmailModule } from "./index.js";
import { liveMail } from "./live.js";
import { findMailMessage } from "./lookup.js";

/**
 * GET /api/gmail/search and the live reader (SPEC-mail-assignments §3–§4)
 * against the fake Gmail: the exact `q` of each view, conversations grouped
 * per thread, cached ones from the cache and the rest with one
 * messages.get(format=metadata) each, paging, the cache-only fallback, the
 * zh-TW failures, and that nothing read live reaches the disk or the log.
 */

const NOW = new Date("2026-10-12T08:42:00+08:00");
const TA = "18c2a7b6c5d4e3f2";
const ARCHIVE_Q = "-in:inbox -in:snoozed -in:sent -in:drafts -in:spam -in:trash";
const day = (date: string, time = "10:00") => new Date(`${date}T${time}:00+08:00`).toISOString();

/** Mail only Gmail has: archived long ago, outside the 30-day cache. */
const GMAIL_ONLY: FakeMessageInput[] = [
  { id: "old-thread-a", threadId: "old-thread", from: "陳老師 <chen.t@cs.nycu.edu.tw>", subject: "專題分組", text: "第一封：請在週五前分好組。", labels: [], at: day("2026-09-26") },
  { id: "old-thread-b", threadId: "old-thread", from: "陳老師 <chen.t@cs.nycu.edu.tw>", subject: "Re: 專題分組", text: "第二封：分組名單已經公布。", labels: ["UNREAD"], at: day("2026-09-28") },
  { id: "html-only", from: "Notion <team@makenotion.com>", subject: "Your weekly digest", html: "<p>Hello <b>world</b><img src=\"https://tracker.example/p.gif\"></p><script>alert(1)</script>", labels: [], at: day("2026-09-22") },
  { id: "old-hw", from: "王助教 <ta-os@cs.nycu.edu.tw>", subject: "HW1 解答已公布", text: "HW1 的參考解答放在 E3 了。", labels: [], at: day("2026-09-20") },
  { id: "snoozed", from: "Friend <friend@gmail.com>", subject: "週末聚餐", text: "延後到週六再看", labels: ["SNOOZED"], at: day("2026-09-18") },
  { id: "sent-only", from: "Suzu <suzu1dev@gmail.com>", subject: "請假單 HW", text: "我寄出的信", labels: ["SENT"], at: day("2026-09-17") },
  { id: "draft", from: "Suzu <suzu1dev@gmail.com>", subject: "草稿 HW", text: "還沒寄", labels: ["DRAFT"], at: day("2026-09-16", "09:00") },
  { id: "trashed", from: "王助教 <ta-os@cs.nycu.edu.tw>", subject: "HW 垃圾", text: "已經丟掉的信", labels: ["TRASH"], at: day("2026-09-16") },
  { id: "spammy", from: "Prize <win@spam.example>", subject: "HW 中獎通知", text: "垃圾信", labels: ["SPAM"], at: day("2026-09-15") },
  { id: "old-inbox", from: "教務處 <aa@nycu.edu.tw>", subject: "選課確認 HW0", text: "請確認選課結果。", labels: ["INBOX", "UNREAD"], at: day("2026-09-01") },
];

async function setup(t: test.TestContext, options: { connect?: boolean; extra?: FakeMessageInput[] } = {}) {
  const gmail = new FakeGmail(() => NOW);
  const services = testServices(t, { seams: { fetch: gmail.fetch, now: () => NOW } });
  seedDemo(services.db, { now: NOW, timeZone: "Asia/Taipei" });
  if (options.connect ?? true) await connectGoogle(services);
  for (const item of services.sourceItems.list<MailMessage>({ source: "gmail" })) {
    const mail = item.value;
    gmail.add({
      id: mail.id, threadId: mail.threadId, from: mail.from.name ? `${mail.from.name} <${mail.from.email}>` : mail.from.email,
      subject: mail.subject, at: mail.receivedAt, labels: mail.labels, text: mail.excerpt ?? mail.snippet, snippet: mail.snippet,
    }, false);
  }
  for (const input of [...GMAIL_ONLY, ...(options.extra ?? [])]) gmail.add(input, false);
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const search = async (query: string) => server.call("GET", `/api/gmail/search?${query}`);
  return { gmail, services, server, search };
}

const ids = (body: MailSearchResponse) => body.threads.map((thread) => thread.threadId);
const listCalls = (gmail: FakeGmail) => gmail.calls("GET", /^\/messages\?/);
const metadataCalls = (gmail: FakeGmail) => gmail.calls("GET", /^\/threads\/[^/?]+\?format=metadata/);

test("封存 lists archived conversations from Gmail with the exact query: cached ones from the cache, the rest read whole once as metadata", async (t) => {
  const { gmail, services, search } = await setup(t);
  const before = services.sourceItems.count("gmail");
  const response = await search("view=archive");
  assert.equal(response.status, 200, response.text);
  const body = response.json as MailSearchResponse;
  const [list] = listCalls(gmail);
  const params = new URLSearchParams(list.path.split("?")[1]);
  assert.equal(params.get("q"), ARCHIVE_Q);
  assert.equal(params.get("maxResults"), "25");
  assert.equal(body.origin, "gmail");
  assert.equal(body.view, "archive");
  assert.equal(body.nextPageToken, undefined, "one page holds everything");
  // Newest first; one row per conversation; snoozed, sent-only, drafts, trash, spam and inbox mail are not archived mail.
  assert.deepEqual(ids(body), ["demo-archived-lin", "demo-archived-kktix", "demo-archived-office", "old-thread", "html-only", "old-hw"]);
  // The seeded conversations are cached: no Gmail read, the AI summary and 已回覆 come along.
  const lin = body.threads[0];
  assert.deepEqual([lin.location, lin.live ?? false, lin.replied, lin.summarySource], ["archive", false, true, "ai"]);
  assert.deepEqual(lin.actions.map((action) => [action.id, action.key ?? null]), [["unarchive", "E"], ["trash", "#"], ["todo", "T"], ["assignment", "A"], ["reply", null]]);
  // The rest were read with one threads.get(format=metadata) each: every message's labels and headers, never text.
  assert.deepEqual(metadataCalls(gmail).map((call) => call.path.split("?")[0]).sort(), ["/threads/html-only", "/threads/old-hw", "/threads/old-thread"]);
  assert.equal(gmail.calls("GET", /^\/messages\/[^/?]+\?/).length, 0, "no message is read on its own");
  assert.match(metadataCalls(gmail)[0].path, /metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=List-Unsubscribe/);
  const old = body.threads.find((thread) => thread.threadId === "old-thread")!;
  assert.deepEqual(
    { message: old.messageId, live: old.live, location: old.location, unread: old.unread, title: old.title, meta: old.meta, summarySource: old.summarySource },
    { message: "old-thread-b", live: true, location: "archive", unread: true, title: "Re: 專題分組", meta: ["陳老師", "第二封：分組名單已經公布。"], summarySource: "rule" },
  );
  assert.deepEqual(old.actions.map((action) => action.id), ["unarchive", "trash", "assignment", "reply"], "live rows have no 轉待辦 (the tasks module reads the cache)");
  assert.equal(services.sourceItems.count("gmail"), before, "nothing read live is written to source_items");
  assert.equal(services.sourceItems.get("gmail", "old-hw"), undefined);

  // A second look within five minutes reuses what was read.
  await search("view=archive");
  assert.equal(metadataCalls(gmail).length, 3);
});

test("全部 and searches: the user's words go between the view query and the spam/trash suffix; inbox rows keep their inbox actions", async (t) => {
  const { gmail, search } = await setup(t);
  const all = (await search(`view=all&q=${encodeURIComponent("  HW ")}`)).json as MailSearchResponse;
  assert.equal(new URLSearchParams(listCalls(gmail).at(-1)!.path.split("?")[1]).get("q"), "-in:drafts HW -in:spam -in:trash");
  assert.equal(all.q, "HW");
  // Spam, trash and drafts never; my own sent-only conversation is found by a search.
  // The newest is the seeded HW5 announcement in the inbox (the assignments seed).
  assert.deepEqual(ids(all), [DEMO_HW5_MAIL, TA, "old-hw", "sent-only", "old-inbox"]);
  const [, ta, hw, sent, oldInbox] = all.threads;
  assert.deepEqual([ta.location, ta.live ?? false, ta.actions[0].id], ["inbox", false, "reply"]);
  assert.deepEqual([hw.location, hw.live], ["archive", true]);
  assert.equal(sent.meta[0], "我", "the owner's own mail is labelled 我");
  assert.deepEqual([oldInbox.location, oldInbox.live, oldInbox.actions.map((action) => action.id)], ["inbox", true, ["read", "archive", "trash", "assignment", "reply"]]);

  const inbox = (await search("view=inbox&q=HW")).json as MailSearchResponse;
  assert.equal(new URLSearchParams(listCalls(gmail).at(-1)!.path.split("?")[1]).get("q"), "in:inbox HW -in:spam -in:trash");
  assert.deepEqual(ids(inbox), [DEMO_HW5_MAIL, TA, "old-inbox"]);

  const operators = (await search(`view=archive&q=${encodeURIComponent("from:chen.t (分組")}`)).json as MailSearchResponse;
  assert.equal(new URLSearchParams(listCalls(gmail).at(-1)!.path.split("?")[1]).get("q"), `${ARCHIVE_Q.replace(" -in:spam -in:trash", "")} from:chen.t 分組 -in:spam -in:trash`, "an unpaired parenthesis is dropped");
  assert.deepEqual(ids(operators), ["old-thread"]);
});

test("paging: 25 messages a page, Gmail's token for 載入更多, and an expired token is a 400 in zh-TW", async (t) => {
  const bulk: FakeMessageInput[] = Array.from({ length: 30 }, (_, index) => ({
    id: `bulk-${index}`, from: "通知 <notice@example.com>", subject: `通知 ${index}`, text: "封存的通知", labels: [], at: day(`2026-08-${String(index + 1).padStart(2, "0")}`),
  }));
  const { gmail, search } = await setup(t, { extra: bulk });
  const first = (await search("view=archive")).json as MailSearchResponse;
  assert.equal(first.nextPageToken, "25");
  assert.equal(first.threads.length, 6 + (25 - 7), "25 messages: the 7 archived above, then the newest bulk ones");
  const second = (await search("view=archive&pageToken=25")).json as MailSearchResponse;
  assert.equal(new URLSearchParams(listCalls(gmail).at(-1)!.path.split("?")[1]).get("pageToken"), "25");
  assert.equal(second.nextPageToken, undefined);
  assert.equal(second.threads.length, 12);
  assert.ok(!second.threads.some((thread) => first.threads.some((seen) => seen.threadId === thread.threadId)));

  const expired = await search("view=archive&pageToken=stale");
  assert.equal(expired.status, 400);
  assert.equal(expired.json.error, "搜尋結果已經過期，請重新搜尋。");
  assert.equal((await search(`view=archive&q=${encodeURIComponent("作".repeat(201))}`)).json.error, "搜尋文字太長了，請少於 200 個字。");
  assert.equal((await search(`view=archive&q=${encodeURIComponent("作".repeat(201))}`)).status, 400);
  assert.equal((await search("view=spam")).status, 400);
  assert.equal((await search("view=archive&pageToken=a%2Fb")).status, 400, "a page token is an opaque word");
});

test("without Gmail the views answer the cached mail (origin cache); a Gmail failure says why; 載入更多 failures are errors", async (t) => {
  const offline = await setup(t, { connect: false });
  const archived = (await offline.search("view=archive")).json as MailSearchResponse;
  assert.deepEqual([archived.origin, archived.error, archived.source.connected], ["cache", undefined, false]);
  assert.deepEqual(ids(archived), ["demo-archived-lin", "demo-archived-kktix", "demo-archived-office"]);
  assert.deepEqual(ids((await offline.search(`view=all&q=${encodeURIComponent("獎助學金")}`)).json), ["demo-archived-office"]);
  assert.deepEqual(ids((await offline.search(`view=inbox&q=${encodeURIComponent("from:cmlin 期末")}`)).json), ["18c2f0a1b2c3d4e5"], "operators are left to Gmail; words still filter");
  assert.equal(offline.gmail.requests.length, 0, "nothing reached Gmail");

  const { gmail, search } = await setup(t);
  gmail.failList = 429;
  const limited = await search("view=archive");
  assert.equal(limited.status, 200);
  assert.deepEqual([limited.json.origin, limited.json.error], ["cache", "Gmail 暫時限制讀取次數，請過一分鐘再試。"]);
  assert.equal(ids(limited.json).length, 3, "the cached archived mail still shows");
  const more = await search("view=archive&pageToken=25");
  assert.equal(more.status, 429);
  assert.equal(more.json.error, "Gmail 暫時限制讀取次數，請過一分鐘再試。");
  gmail.failList = 500;
  assert.equal((await search("view=all&q=HW")).json.error, "Gmail 回應 HTTP 500，請稍後再試。");
  assert.equal((await search("view=all&pageToken=25")).status, 502);
});

test("search text never reaches the log; the log line has the view, the time and the row count", async (t) => {
  const { search } = await setup(t);
  const lines: string[] = [];
  const previous = process.env.BELLPERSONAL_LOG;
  process.env.BELLPERSONAL_LOG = "on";
  t.after(() => { process.env.BELLPERSONAL_LOG = previous; });
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  await search(`view=all&q=${encodeURIComponent("專題分組")}`);
  t.mock.restoreAll();
  process.env.BELLPERSONAL_LOG = previous;
  assert.ok(!lines.some((line) => line.includes("專題分組") || line.includes("%E5%B0%88")), "no line carries the query");
  const entry = lines.map((line) => JSON.parse(line)).find((line) => line.event === "gmail.search");
  assert.deepEqual(Object.keys(entry).sort(), ["event", "hasQuery", "ms", "origin", "page", "rows", "time", "view"]);
  assert.deepEqual([entry.view, entry.hasQuery, entry.rows], ["all", true, 1]);
});

test("the reader reads a conversation outside the cache live: plain text only, held for minutes, 404 when Gmail has nothing", async (t) => {
  const { gmail, server, services } = await setup(t);
  const response = await server.call("GET", "/api/gmail/threads/html-only");
  assert.equal(response.status, 200, response.text);
  const body = response.json as InboxThreadResponse;
  assert.deepEqual([body.thread.live, body.thread.location], [true, "archive"]);
  assert.equal(body.messages[0].excerpt, "Hello world");
  assert.doesNotMatch(JSON.stringify(body), /<|tracker\.example|alert\(/, "no markup, no remote image, no script survives");
  assert.equal(gmail.calls("GET", /^\/threads\/html-only\?format=full/).length, 1);

  const thread = (await server.call("GET", "/api/gmail/threads/old-thread")).json as InboxThreadResponse;
  assert.deepEqual(thread.messages.map((message) => message.excerpt), ["第一封：請在週五前分好組。", "第二封：分組名單已經公布。"]);
  assert.deepEqual(thread.thread.actions.map((action) => action.id), ["unarchive", "trash", "assignment", "reply"]);
  await server.call("GET", "/api/gmail/threads/old-thread");
  assert.equal(gmail.calls("GET", /^\/threads\/old-thread/).length, 1, "the second read comes from memory");
  assert.equal(services.sourceItems.get("gmail", "old-thread-a"), undefined, "never written to the cache");

  // A cached archived conversation is read from the cache.
  const lin = (await server.call("GET", "/api/gmail/threads/demo-archived-lin")).json as InboxThreadResponse;
  assert.deepEqual([lin.thread.location, lin.thread.live ?? false], ["archive", false]);
  assert.equal(gmail.calls("GET", /^\/threads\/demo-archived-lin/).length, 0);

  const gone = await server.call("GET", "/api/gmail/threads/nothing-here");
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error, "這封信已經不在 Gmail，可能已被永久刪除。");
  // A conversation in the trash opens like a cached one does (an assignment's 開啟信件): 移回收件匣, no 刪除.
  const trashed = await server.call("GET", "/api/gmail/threads/trashed");
  assert.equal(trashed.status, 200, trashed.text);
  assert.deepEqual([trashed.json.thread.location, trashed.json.thread.trashed, trashed.json.thread.actions.map((action: { id: string }) => action.id)],
    ["archive", true, ["unarchive", "assignment", "reply"]]);
  const spam = await server.call("GET", "/api/gmail/threads/spammy");
  assert.deepEqual([spam.status, spam.json.error], [404, "這封信在垃圾郵件裡，請到 Gmail 查看。"]);

  // Purging the cache forgets live reads too.
  assert.ok(liveMail(services).size > 0);
  await server.call("POST", "/api/gmail/purge", { body: {} });
  assert.equal(liveMail(services).size, 0);
});

test("findMailMessage: the cache first, else one live read with the plain-text excerpt; nothing without Gmail", async (t) => {
  const { gmail, services } = await setup(t);
  assert.equal((await findMailMessage(services, "demo-archived-office"))?.subject, "[公告] 研究生獎助學金審查結果");
  assert.equal(gmail.requests.length, 0, "cached: no Gmail call");
  const live = await findMailMessage(services, "old-hw");
  assert.deepEqual([live?.subject, live?.excerpt, live?.threadId], ["HW1 解答已公布", "HW1 的參考解答放在 E3 了。", "old-hw"]);
  assert.equal(gmail.calls("GET", /^\/messages\/old-hw\?format=full/).length, 1);
  assert.equal(services.sourceItems.get("gmail", "old-hw"), undefined);
  await findMailMessage(services, "old-hw");
  assert.equal(gmail.calls("GET", /^\/messages\/old-hw/).length, 1, "held in memory");
  assert.equal(await findMailMessage(services, "missing-id"), undefined);
  gmail.failGet = 500;
  await assert.rejects(findMailMessage(services, "html-only"), /Gmail 回應 HTTP 500，請稍後再試。/);

  const offline = await setup(t, { connect: false });
  assert.equal(await findMailMessage(offline.services, "old-hw"), undefined);
  assert.equal(offline.gmail.requests.length, 0);
});

test("a live row says where its whole conversation is, with the reader's message: my newest reply, or an inbox reply to an archived thread", async (t) => {
  const extra: FakeMessageInput[] = [
    // Still in the inbox, older than the cache; my reply (SENT only) is the newest message.
    { id: "oldin-a", threadId: "oldin", from: "陳老師 <chen.t@cs.nycu.edu.tw>", subject: "期中專題回饋", text: "回饋在附件。", labels: ["INBOX"], at: day("2026-08-20") },
    { id: "oldin-b", threadId: "oldin", from: "Suzu <suzu1dev@gmail.com>", subject: "Re: 期中專題回饋", text: "好的", labels: ["SENT"], at: day("2026-08-21") },
    // Archived, then the TA's reply put it back in the inbox.
    { id: "arch-a", threadId: "arch", from: "王助教 <ta-os@cs.nycu.edu.tw>", subject: "Lab 環境設定", text: "請先裝好 QEMU。", labels: [], at: day("2026-08-10") },
    { id: "arch-b", threadId: "arch", from: "王助教 <ta-os@cs.nycu.edu.tw>", subject: "Re: Lab 環境設定", text: "補充：版本 8.2。", labels: ["INBOX", "UNREAD"], at: day("2026-08-12") },
  ];
  const { server, search } = await setup(t, { extra });
  const all = (await search(`view=all&q=${encodeURIComponent("期中專題回饋")}`)).json as MailSearchResponse;
  const oldin = all.threads.find((thread) => thread.threadId === "oldin")!;
  assert.deepEqual([oldin.location, oldin.itemId, oldin.meta[0], oldin.actions[0].id], ["inbox", "gmail:oldin-a", "陳老師", "archive"]);
  assert.ok(!oldin.actions.some((action) => action.id === "unarchive"), "an inbox conversation offers 封存, not 移回收件匣");
  const arch = ((await search(`view=all&q=${encodeURIComponent("環境設定")}`)).json as MailSearchResponse).threads.find((thread) => thread.threadId === "arch")!;
  assert.deepEqual([arch.location, arch.itemId], ["inbox", "gmail:arch-b"]);

  // The reader of the same conversation names the same message, so actions and 轉成作業 agree.
  const reader = (await server.call("GET", "/api/gmail/threads/oldin")).json as InboxThreadResponse;
  assert.deepEqual([reader.thread.location, reader.thread.itemId], ["inbox", "gmail:oldin-a"]);

  // 封存 matched arch-a (no INBOX), but the conversation is in the inbox: it is not archived mail.
  assert.deepEqual(ids((await search(`view=archive&q=${encodeURIComponent("環境設定")}`)).json), []);
  assert.deepEqual(ids((await search(`view=archive&q=${encodeURIComponent("期中專題回饋")}`)).json), [], "my own reply (SENT) is never archived mail either");
  const found = (await search(`view=all&q=${encodeURIComponent("好的")}`)).json as MailSearchResponse;
  assert.deepEqual(found.threads.map((thread) => [thread.threadId, thread.location, thread.itemId]), [["oldin", "inbox", "gmail:oldin-a"]], "a search that matched only my reply");
});

test("a conversation too big for one answer still opens: its newest messages one by one, a message too big alone as headers only", async (t) => {
  const extra: FakeMessageInput[] = [
    { id: "big-a", threadId: "big", from: "List <list@lists.example>", subject: "Long thread", text: `開頭的回覆。${"x".repeat(100_000)}`, labels: [], at: day("2026-09-10") },
    { id: "big-b", threadId: "big", from: "List <list@lists.example>", subject: "Re: Long thread", text: `最新的回覆。${"y".repeat(4_500_000)}`, labels: [], at: day("2026-09-11") },
  ];
  const { gmail, server } = await setup(t, { extra });
  const response = await server.call("GET", "/api/gmail/threads/big");
  assert.equal(response.status, 200, response.text);
  const body = response.json as InboxThreadResponse;
  assert.equal(gmail.calls("GET", /^\/threads\/big\?format=minimal/).length, 1, "the whole thread was over the cap: it is listed first");
  assert.deepEqual(body.messages.map((message) => [message.id, (message.excerpt ?? "").slice(0, 6)]), [["big-a", "開頭的回覆。"], ["big-b", ""]]);
  assert.equal(gmail.calls("GET", /^\/messages\/big-b\?format=metadata/).length, 1, "the message too big alone falls back to its headers");
  assert.deepEqual([body.thread.itemId, body.thread.subject], ["gmail:big-b", "Re: Long thread"]);
});

test("findMailMessage reads a message over the response cap as its headers, so 轉成作業 still has its subject", async (t) => {
  const { gmail, services } = await setup(t, { extra: [
    { id: "huge", from: "王助教 <ta-os@cs.nycu.edu.tw>", subject: "HW7 公告", text: `HW7 請於 10/30 前上傳。${"z".repeat(4_500_000)}`, labels: [], at: day("2026-10-05") },
  ] });
  const message = await findMailMessage(services, "huge");
  assert.deepEqual([message?.subject, message?.excerpt], ["HW7 公告", undefined]);
  assert.equal(gmail.calls("GET", /^\/messages\/huge\?format=metadata/).length, 1);
});
