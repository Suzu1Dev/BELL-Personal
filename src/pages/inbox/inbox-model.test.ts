import test from "node:test";
import assert from "node:assert/strict";
import type { InboxListResponse, InboxThread } from "../../../shared/mail";
import type { QueueAction } from "../../../shared/today";
import { queueAction } from "../../../shared/today-format";
import { INBOX } from "../../copy/inbox";
import {
  applyEdits, applyThreadEdits, assignmentToast, displayOrder, enterOpens, filterThreads, focusFor, gmailBlocked, groupThreads, highlightRanges, mailHoverActions, matchesSearch, moveCursor,
  MAIL_EXPLAIN_LIMIT, mailExplainText, nextAfter, NO_FOCUS_REQUEST, offlineMessage, requestFocus, rowStays, searchAnnouncement, searchTerms, threadVersion, toastFor, withoutShown, type InboxEdit,
} from "./inbox-model";

const TZ = "Asia/Taipei";

test("the inbox head only carries a positive unread count", () => {
  assert.equal(INBOX.sub(3), "3 封未讀");
  assert.equal(INBOX.sub(0), "");
});

function thread(threadId: string, category: InboxThread["category"], extra: Partial<InboxThread> = {}): InboxThread {
  return {
    threadId, messageId: threadId, itemId: `gmail:${threadId}`, from: { email: `${threadId}@example.com` }, subject: `主旨 ${threadId}`, title: `主旨 ${threadId}`,
    meta: ["寄件者"], summarySource: "rule", category, inQueue: false, receivedAt: "2026-10-12T00:00:00Z", when: { label: "08:00", mono: true },
    unread: true, count: 1, actions: [{ id: "read", label: "標為已讀", touchLabel: "已讀", key: "E" }], replied: false, webUrl: "https://mail.google.com/mail/u/0/#inbox/x",
    ...extra,
  };
}

const list = (threads: InboxThread[]): InboxListResponse => ({
  source: { connected: true, state: "ok" },
  threads,
  counts: { "needs-reply": 0, bill: 0, school: 0, invitation: 0, newsletter: 0, notification: 0, other: 0, ...Object.fromEntries(["needs-reply", "bill", "school", "invitation", "newsletter", "notification", "other"].map((category) => [category, threads.filter((item) => item.category === category).length])) },
  unread: threads.filter((item) => item.unread).length,
  snoozed: 0,
});

test("groups follow the chip order; a filter keeps one group; the cursor walks the display order", () => {
  const threads = [thread("n1", "newsletter"), thread("r1", "needs-reply"), thread("b1", "bill", { unread: false }), thread("r2", "needs-reply")];
  const groups = groupThreads(threads, "all");
  assert.deepEqual(groups.map((group) => [group.category, group.label, group.threads.length, group.unread]), [
    ["needs-reply", "需要回覆", 2, 2], ["bill", "帳單", 1, 0], ["newsletter", "電子報", 1, 1],
  ]);
  assert.deepEqual(displayOrder(groups), ["r1", "r2", "b1", "n1"]);
  assert.deepEqual(groupThreads(threads, "bill").map((group) => group.category), ["bill"]);
  assert.deepEqual(groupThreads(threads, "school"), []);

  const order = displayOrder(groups);
  assert.equal(nextAfter(order, "r2"), "b1");
  assert.equal(nextAfter(order, "n1"), "b1", "the last row hands the cursor back");
  assert.equal(nextAfter(["only"], "only"), undefined);
  assert.equal(moveCursor(order, "r1", 1), "r2");
  assert.equal(moveCursor(order, "n1", 1), "n1", "clamped at the end");
  assert.equal(moveCursor(order, undefined, 1), "r1");
  assert.equal(moveCursor(order, undefined, -1), "n1");
  assert.equal(moveCursor([], undefined, 1), undefined);
});

test("optimistic edits hide, mark read and mark state; counts and unread follow", () => {
  const base = list([thread("a", "needs-reply"), thread("b", "newsletter"), thread("c", "newsletter", { unread: false })]);
  const edited = applyEdits(base, [
    { kind: "hide", threadIds: ["a"], snoozed: true },
    { kind: "read", threadIds: ["b"] },
    { kind: "state", threadId: "c", state: { kind: "handled", action: "todo" } },
  ]);
  assert.deepEqual(edited.threads.map((item) => [item.threadId, item.unread, item.state?.kind ?? null]), [["b", false, null], ["c", false, "handled"]]);
  assert.equal(edited.counts["needs-reply"], 0);
  assert.equal(edited.counts.newsletter, 2);
  assert.equal(edited.unread, 0);
  assert.equal(edited.snoozed, 1);
  assert.deepEqual(edited.threads[0].actions, [], "標為已讀 leaves a read conversation");
  const withArchive = applyEdits(list([thread("d", "newsletter", { actions: [
    { id: "read", label: "標為已讀", touchLabel: "已讀", key: "E" }, { id: "todo", label: "轉待辦", touchLabel: "轉待辦", key: "T" },
    { id: "archive", label: "封存", touchLabel: "封存" },
  ] })]), [{ kind: "read", threadIds: ["d"] }]);
  assert.deepEqual(withArchive.threads[0].actions.map((action) => [action.id, action.key ?? null]), [["archive", "E"], ["todo", "T"]]);
  assert.equal(applyEdits(base, []), base);
});

test("toast text quotes the subject (SPEC-ux §10)", () => {
  assert.equal(toastFor("archive", "Re: OS 期末專題題目討論"), "已封存「Re: OS 期末專題題目討論」");
  assert.equal(toastFor("read", "電子報"), "已標為已讀「電子報」");
  assert.equal(toastFor("snooze", "x", { label: "明天 08:00" }), "已延後到明天 08:00");
  assert.equal(toastFor("todo", "繳電費"), "已加入待辦「繳電費」");
  assert.equal(toastFor("calendar", "SITCON 秋季交流會"), "已加入行事曆「SITCON 秋季交流會」");
});

test("the reading pane refetches when its own row changes, not on every list refresh", () => {
  const row = thread("a", "needs-reply");
  assert.equal(threadVersion({ ...row }), threadVersion(row), "a refreshed list with the same row keeps the version");
  assert.equal(threadVersion(undefined), undefined);
  for (const change of [{ unread: false }, { count: 2, messageId: "a2" }, { summary: "AI 摘要", summarySource: "ai" as const }, { state: { kind: "replying" as const } }, { replied: true }, { location: "archive" as const }]) {
    assert.notEqual(threadVersion({ ...row, ...change }), threadVersion(row), JSON.stringify(change));
  }
});

const act = (id: QueueAction["id"], label: string, key?: QueueAction["key"]): QueueAction => ({ id, label, touchLabel: label, ...(key ? { key } : {}) });

test("hover without opening: the primary, the first 封存 or 移回收件匣, then 刪除 (SPEC-mail-assignments §2.2)", () => {
  const labels = (actions: QueueAction[]) => mailHoverActions(actions).map((action) => action.label);
  assert.deepEqual(labels([act("reply", "回覆", "Enter"), act("todo", "轉待辦", "T"), act("snooze", "延後", "S"), act("archive", "封存", "E"), act("trash", "刪除", "#")]), ["回覆", "封存", "刪除"]);
  assert.deepEqual(labels([act("read", "標為已讀", "E"), act("todo", "轉待辦", "T"), act("archive", "封存"), act("trash", "刪除", "#"), act("reply", "回覆")]), ["標為已讀", "封存", "刪除"]);
  assert.deepEqual(labels([act("archive", "封存", "E"), act("todo", "轉待辦", "T"), act("trash", "刪除", "#")]), ["封存", "刪除"], "duplicates dropped");
  assert.deepEqual(labels([act("unarchive", "移回收件匣", "E"), act("trash", "刪除", "#"), act("todo", "轉待辦", "T")]), ["移回收件匣", "刪除"]);
});

test("the local search: NFKC and case folded, every term must match, Gmail operators are left to Gmail", () => {
  assert.deepEqual(searchTerms("  ＨＷ５  作業 from:cmlin -spam OR \"Lab\" "), ["hw5", "作業", "lab"]);
  assert.deepEqual(searchTerms("subject:報告"), [], "operators only: nothing to filter locally");
  const hw = thread("hw", "school", { subject: "【作業系統】HW5 公告", title: "【作業系統】HW5 公告", from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, snippet: "請於 10/16 前上傳至 E3", receivedAt: "2026-10-12T01:00:00Z" });
  const bill = thread("bill", "bill", { subject: "中華電信 9 月電子帳單", title: "中華電信 9 月帳單 NT$599", summary: "9 月電信費", receivedAt: "2026-10-12T02:00:00Z" });
  assert.ok(matchesSearch(hw, searchTerms("hw5 上傳")), "subject and snippet");
  assert.ok(matchesSearch(hw, searchTerms("CMLIN")), "the sender's address");
  assert.ok(matchesSearch(hw, searchTerms("林志明")), "the sender's name");
  assert.ok(!matchesSearch(hw, searchTerms("hw5 帳單")), "all terms must match");
  assert.deepEqual(filterThreads([hw, bill], searchTerms("9 月")).map((item) => item.threadId), ["bill"]);
  assert.deepEqual(filterThreads([hw, bill], searchTerms("")), [], "no terms, no local group");
  assert.deepEqual(filterThreads([hw, bill], searchTerms("e")).map((item) => item.threadId), ["bill", "hw"], "newest first");
});

test("highlights mark the literal terms in the original text, full-width forms included, merged", () => {
  assert.deepEqual(highlightRanges("【作業系統】ＨＷ５ 公告", ["hw5"]), [[6, 9]]);
  assert.deepEqual(highlightRanges("HW5 hw5", ["hw5"]), [[0, 3], [4, 7]]);
  assert.deepEqual(highlightRanges("作業系統作業", ["作業", "業系"]), [[0, 3], [4, 6]], "overlapping matches merge");
  assert.deepEqual(highlightRanges("abc", []), []);
  assert.deepEqual(highlightRanges("😀 HW", ["hw"]), [[3, 5]], "offsets count UTF-16 units of the original");
});

test("Gmail's results are appended without repeating a conversation already shown", () => {
  const a = thread("a", "school");
  const b = thread("b", "school");
  const c = thread("c", "school");
  assert.deepEqual(withoutShown([a], [a, b, b, c]).map((item) => item.threadId), ["b", "c"]);
  assert.equal(searchAnnouncement(3), "找到 3 封符合的信");
  assert.equal(searchAnnouncement(0), "沒有找到符合的信");
});

test("刪除 and 移回收件匣 edits: rows leave a page at once; in 全部 a row changes sides and E follows", () => {
  const archived = thread("x", "school", { location: "archive", actions: [act("unarchive", "移回收件匣", "E"), act("trash", "刪除", "#"), act("todo", "轉待辦", "T")] });
  const inInbox = thread("y", "school", { location: "inbox", unread: true, actions: [act("read", "標為已讀", "E"), act("archive", "封存"), act("trash", "刪除", "#")] });
  assert.deepEqual(applyThreadEdits([archived, inInbox], [{ kind: "hide", threadIds: ["x"] }]).map((item) => item.threadId), ["y"]);
  const [back] = applyThreadEdits([archived], [{ kind: "moved", threadIds: ["x"], location: "inbox" }]);
  assert.equal(back.location, "inbox");
  assert.deepEqual(back.actions.map((action) => [action.id, action.key ?? null]), [["archive", "E"], ["trash", "#"], ["todo", "T"]]);
  const [away] = applyThreadEdits([inInbox], [{ kind: "moved", threadIds: ["y"], location: "archive" }]);
  assert.deepEqual(away.actions.map((action) => [action.id, action.key ?? null]), [["read", null], ["unarchive", "E"], ["trash", "#"]]);
  // The cached inbox list drops a conversation moved to the archive.
  assert.deepEqual(applyEdits(list([inInbox]), [{ kind: "moved", threadIds: ["y"], location: "archive" }]).threads, []);
  // One edit, every view: 移回收件匣 made in 封存 leaves 封存 but the row still shows in 全部; 封存 leaves a 收件匣 search.
  const back2: InboxEdit[] = [{ kind: "moved", threadIds: ["x"], location: "inbox" }];
  assert.deepEqual(applyThreadEdits([archived, inInbox], back2, "archive").map((item) => item.threadId), []);
  assert.deepEqual(applyThreadEdits([archived, inInbox], back2, "all").map((item) => [item.threadId, item.location]), [["x", "inbox"], ["y", "inbox"]]);
  assert.deepEqual(applyThreadEdits([archived, inInbox], [{ kind: "moved", threadIds: ["y"], location: "archive" }], "inbox").map((item) => item.threadId), []);
});

test("toasts for 刪除, 移回收件匣 and 轉成作業 quote the conversation (SPEC-mail-assignments §7.2)", () => {
  assert.equal(toastFor("trash", "Re: OS 期末專題題目討論"), "已移到垃圾桶「Re: OS 期末專題題目討論」");
  assert.equal(toastFor("unarchive", "Re: 期中考範圍"), "已移回收件匣「Re: 期中考範圍」");
  assert.equal(toastFor("assignment", "HW5", { when: "週五 23:59 截止" }), "已加入作業「HW5」· 週五 23:59 截止");
  const hw = thread("hw", "school", { subject: "Re: 【作業系統】HW5 公告", receivedAt: "2026-10-12T01:00:00Z" });
  assert.match(assignmentToast(hw, { now: new Date("2026-10-12T01:00:00Z"), timeZone: TZ }), /^已加入作業「HW5」/, "the rules' title: the subject without Re:, the course tag and the trailing 公告");
});

test("轉成作業's optimistic edit marks the row converted and takes 轉成作業 off it", () => {
  const target = thread("a", "school", { actions: [queueAction("archive"), queueAction("trash"), queueAction("assignment")] });
  const [edited] = applyThreadEdits([target], [{ kind: "state", threadId: "a", state: { kind: "handled", action: "assignment" } }]);
  assert.equal(edited.converted, true);
  assert.deepEqual(edited.actions.map((action) => action.id), ["archive", "trash"]);
});

test("focus requests are one-shot: asking again for the cursor row is a new request, and no request moves focus", () => {
  const focused: string[] = [];
  const titles = new Map(["a", "b"].map((id) => [id, { focus: () => { focused.push(id); } }] as const));
  assert.equal(focusFor(NO_FOCUS_REQUEST, titles, true), undefined, "renders without a request (typing in the search field) never move focus");
  const first = requestFocus(NO_FOCUS_REQUEST, "a");
  const again = requestFocus(first, "a");
  assert.notEqual(again.n, first.n, "↓ onto the first result when it already is the cursor, or 刪除 on the row above it, still asks");
  (focusFor(again, titles, false) as { focus(): void }).focus();
  assert.deepEqual(focused, ["a"]);
  assert.equal(focusFor(requestFocus(again, undefined), titles, true), "main", "the list emptied: <main>, never <body>");
  assert.equal(focusFor(requestFocus(again, "gone"), titles, false), undefined, "focus the user put elsewhere stays there");
});

test("↵ on a title opens the conversation in 封存, 全部 and search results; actions that keep the row hand focus back to its title", () => {
  assert.equal(enterOpens("inbox", false), false, "the plain 收件匣 list: ↵ is the row's primary action");
  assert.equal(enterOpens("archive", false), true, "移回收件匣 is first there");
  assert.equal(enterOpens("all", false), true);
  assert.equal(enterOpens("inbox", true), true, "a search result's first action may be 封存");
  assert.deepEqual(["read", "todo", "assignment", "archive", "trash", "snooze"].map((action) => rowStays(action as never, "all")), [true, true, true, true, false, false]);
  assert.equal(rowStays("archive", "inbox"), false, "封存 in 收件匣 leaves the list");
});

test("without Gmail, 封存 · 標為已讀 · 刪除 · 移回收件匣 cannot run and say why; the other actions still can", () => {
  for (const action of ["archive", "read", "trash", "unarchive"] as const) {
    assert.equal(gmailBlocked(action, false), true, action);
    assert.equal(gmailBlocked(action, true), false, `${action} once connected`);
  }
  for (const action of ["reply", "todo", "snooze", "assignment", "open"] as const) assert.equal(gmailBlocked(action, false), false, action);
  assert.equal(offlineMessage(["archive"]), "Gmail 尚未連線，無法封存；請先到設定連線 Gmail。");
  assert.equal(offlineMessage(["unarchive"]), "Gmail 尚未連線，無法移回收件匣；請先到設定連線 Gmail。");
  assert.equal(offlineMessage(["reply", "archive", "todo", "read", "trash", "archive"]), "Gmail 尚未連線，無法封存、標為已讀或刪除；請先到設定連線 Gmail。");
  assert.equal(offlineMessage(["reply", "todo"]), undefined);
  assert.doesNotMatch(offlineMessage(["trash"])!, /[,;:]|GOOGLE_|\//, "full-width punctuation, no env names or paths");
});

test("解釋這個 sends the subject and the newest message's plain text, at most 2000 characters in all", () => {
  const messages = [{ snippet: "舊的那封", excerpt: "舊的內文" }, { snippet: "片段", excerpt: "  第一段  \r\n\r\n\r\n\r\n第二段\n" }];
  assert.equal(mailExplainText("【作業系統】HW5 公告", messages), "【作業系統】HW5 公告\n\n第一段\n\n第二段");
  assert.equal(mailExplainText("主旨", [{ snippet: "只有片段" }]), "主旨\n\n只有片段", "no excerpt: the snippet");
  assert.equal(mailExplainText("主旨", [], "一行摘要"), "主旨\n\n一行摘要", "not loaded yet: the summary");
  assert.equal(mailExplainText("主旨", []), "主旨");
  const long = mailExplainText("主旨", [{ snippet: "", excerpt: "長".repeat(5000) }]);
  assert.equal([...long].length, MAIL_EXPLAIN_LIMIT);
  assert.ok(long.startsWith("主旨\n\n長") && long.endsWith("長…"));
  const emoji = mailExplainText("", [{ snippet: "", excerpt: "😀".repeat(3000) }]);
  assert.equal([...emoji].length, MAIL_EXPLAIN_LIMIT, "counted in code points, never a split surrogate pair");
});
