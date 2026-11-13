/**
 * Component tests for the inbox list (renderToStaticMarkup): the hover set
 * without opening (labelled, or two icon buttons beside the reading pane),
 * archived rows in 全部, highlights, the tray closed by default, the legend,
 * and the search field's hint (SPEC-mail-assignments §2–§4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxThread } from "../../../shared/mail";
import type { QueueAction } from "../../../shared/today";
import { InboxList, PagesFooter, compactTitle, type InboxListProps } from "./InboxList";
import { SearchField } from "./SearchField";

const act = (id: QueueAction["id"], label: string, key?: QueueAction["key"]): QueueAction => ({ id, label, touchLabel: label, ...(key ? { key } : {}) });

function thread(threadId: string, extra: Partial<InboxThread> = {}): InboxThread {
  return {
    threadId, messageId: threadId, itemId: `gmail:${threadId}`, from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" },
    subject: "【作業系統】HW5 公告", title: "【作業系統】HW5 公告", meta: ["林志明 教授", "請於 10/16 前上傳 HW5"], summarySource: "rule",
    category: "school", inQueue: false, receivedAt: "2026-10-12T01:00:00Z", when: { label: "09:00", mono: true }, unread: false, count: 1,
    actions: [act("archive", "封存", "E"), act("todo", "轉待辦", "T"), act("snooze", "延後", "S"), act("trash", "刪除", "#"), act("assignment", "轉成作業", "A")],
    replied: false, webUrl: "https://mail.google.com/mail/u/0/#all/x", location: "inbox", ...extra,
  };
}

const noop = () => {};
const props = (extra: Partial<InboxListProps> = {}): InboxListProps => ({
  count: 2, rows: 2, tools: null, sections: [], view: "inbox", terms: [], cursor: undefined, split: false,
  onSelect: noop, onRun: noop, onMarkCategory: noop, titleRef: noop, snoozed: 0, trayFor: undefined, onTray: noop, ...extra,
});
const render = (extra: Partial<InboxListProps>) => renderToStaticMarkup(createElement(InboxList, props(extra)));
const rowOf = (html: string, id: string) => html.slice(html.indexOf(`data-row-id="${id}"`), html.indexOf("</li>", html.indexOf(`data-row-id="${id}"`)));

test("a row offers its primary, 封存 and 刪除 without opening; beside the reading pane two named icon buttons", () => {
  const sections = [{ key: "school", title: "學校", threads: [thread("a"), thread("b", { location: "archive", actions: [act("unarchive", "移回收件匣", "E"), act("trash", "刪除", "#"), act("assignment", "轉成作業", "A")] })] }];
  const list = render({ sections });
  assert.deepEqual([...rowOf(list, "a").matchAll(/class="q-acts">(.*?)<\/div>/g)].flatMap((match) => [...match[1].matchAll(/<\/svg>([^<]+)<kbd>([^<]+)<\/kbd>/g)].map((hit) => `${hit[1]} ${hit[2]}`)),
    ["封存 E", "刪除 #"], "封存 is the primary here, so the set is 封存 · 刪除");
  assert.match(rowOf(list, "b"), /移回收件匣<kbd>E<\/kbd>.*刪除<kbd>#<\/kbd>/);
  assert.doesNotMatch(list, /class="q-tray"/, "the swipe tray only exists while swiping or open");

  const split = render({ sections, split: true });
  assert.match(rowOf(split, "a"), /class="q-acts is-compact"/);
  assert.match(rowOf(split, "a"), /aria-label="封存「【作業系統】HW5 公告」" title="封存（E）"/);
  assert.match(rowOf(split, "a"), /aria-label="刪除「【作業系統】HW5 公告」" title="刪除（#）"/);
  assert.match(rowOf(split, "b"), /aria-label="移回收件匣「【作業系統】HW5 公告」" title="移回收件匣（E）"/);
});

test("全部 marks archived rows, searches highlight the literal terms, and an open tray names the conversation", () => {
  const sections = [{ key: "all", title: "所有信件", hint: "依收到時間排列", threads: [thread("b", { location: "archive" })] }];
  const html = render({ sections, view: "all", terms: ["hw5"], trayFor: "b" });
  assert.match(html, /<h3 id="inbox-group-all">所有信件<\/h3><span class="hint">依收到時間排列<\/span>/);
  assert.match(rowOf(html, "b"), /<span class="q-note">已封存 · <\/span>/);
  assert.match(rowOf(html, "b"), /【作業系統】<mark class="hit">HW5<\/mark> 公告/);
  assert.match(rowOf(html, "b"), /請於 10\/16 前上傳 <mark class="hit">HW5<\/mark>/);
  assert.match(rowOf(html, "b"), /class="q-tray" role="group" aria-label="「【作業系統】HW5 公告」的動作"/);
  assert.match(rowOf(html, "b"), /aria-label="刪除「【作業系統】HW5 公告」"/);
  assert.doesNotMatch(rowOf(html, "b"), /class="q-tray"[^>]*inert/, "an open tray is reachable");
  assert.match(html, /移動.*封存.*刪除.*搜尋.*復原.*全部/, "the inbox legend");
  assert.match(render({ sections, view: "archive" }), /<kbd>E<\/kbd>移回收件匣/, "in 封存, E is 移回收件匣");
});

test("the search field: a / hint while empty, a named clear button once there is text", () => {
  const field = (value: string) => renderToStaticMarkup(createElement(SearchField, {
    value, inputRef: createRef<HTMLInputElement>(), onInput: noop, onSubmit: noop, onFirstResult: noop, onLeave: noop,
  }));
  const empty = field("");
  assert.match(empty, /role="search" aria-label="搜尋信件"/);
  assert.match(empty, /type="search"[^>]*placeholder="搜尋信件"[^>]*aria-label="搜尋信件"[^>]*enterkeyhint="search"[^>]*autoComplete="off"/i);
  assert.match(empty, /maxLength="200"/i);
  assert.match(empty, /<kbd aria-hidden="true">\/<\/kbd>/);
  assert.match(field("hw5"), /aria-label="清除搜尋"/);
  assert.doesNotMatch(field("hw5"), /<kbd/);
});

test("載入更多 shows whenever Gmail has another page, even with no row left on screen, and stays focusable while loading", () => {
  const footer = (extra: Partial<Parameters<typeof PagesFooter>[0]>) => renderToStaticMarkup(createElement(PagesFooter, {
    ready: true, nextPageToken: "25", loadingMore: false, origin: "gmail", rows: 0, onLoadMore: noop, ...extra,
  }));
  assert.match(footer({}), /<button[^>]*data-load-more=""[^>]*>載入更多<\/button>/, "every row of page one was deleted: the next page is still reachable");
  const loading = footer({ loadingMore: true });
  assert.match(loading, /aria-disabled="true"/);
  assert.match(loading, /aria-busy="true"/);
  assert.doesNotMatch(loading, / disabled=""/, "a disabled button would drop keyboard focus to <body>");
  assert.match(loading, />載入中…</);
  assert.equal(footer({ nextPageToken: undefined }), "", "no rows and no more pages: the empty state speaks");
  assert.match(footer({ nextPageToken: undefined, rows: 3 }), /沒有更多信了。/);
  assert.equal(footer({ ready: false }), "");
});

test("the compact 封存 tooltip names E only when E is 封存 on that row", () => {
  assert.equal(compactTitle(act("archive", "封存", "E")), "封存（E）");
  assert.equal(compactTitle(act("archive", "封存")), "封存", "an unread notice: E is 標為已讀");
  assert.equal(compactTitle(act("unarchive", "移回收件匣", "E")), "移回收件匣（E）");
  const html = render({ split: true, sections: [{ key: "n", title: "通知", threads: [thread("n", { unread: true, actions: [act("read", "標為已讀", "E"), act("archive", "封存"), act("trash", "刪除", "#")] })] }] });
  assert.match(rowOf(html, "n"), /aria-label="封存「【作業系統】HW5 公告」" title="封存"/);
});

test("without Gmail, 封存 · 標為已讀 · 刪除 · 移回收件匣 stay focusable but dimmed and point at the notice line", () => {
  const unread = thread("n", { unread: true, category: "notification", actions: [act("read", "標為已讀", "E"), act("archive", "封存"), act("trash", "刪除", "#"), act("todo", "轉待辦", "T")] });
  const sections = [{ key: "notification", title: "通知", count: 1, category: "notification" as const, unread: 1, threads: [unread, thread("a")] }];
  for (const split of [false, true]) {
    const html = render({ sections, split, offline: true });
    const row = rowOf(html, "a");
    assert.doesNotMatch(row, / disabled=""/, "a disabled button would drop keyboard focus to <body>");
    if (split) {
      assert.match(row, /aria-label="封存「【作業系統】HW5 公告」"[^>]*aria-disabled="true"[^>]*aria-describedby="inbox-offline"/);
      assert.match(row, /aria-label="刪除「【作業系統】HW5 公告」"[^>]*aria-disabled="true"/);
    } else {
      assert.match(row, /aria-disabled="true" aria-describedby="inbox-offline"[^>]*>(?:<svg.*?<\/svg>)?封存<kbd>E<\/kbd>/);
    }
    assert.match(row, /class="btn btn-secondary btn-sm q-primary" aria-disabled="true"/, "the touch primary is 封存 here");
    assert.match(html, /aria-label="把「通知」全部標為已讀"[^>]*aria-disabled="true"/);
  }
  const online = render({ sections });
  assert.doesNotMatch(online, /aria-disabled/, "connected: nothing is dimmed");
  const todo = rowOf(render({ sections: [{ key: "s", title: "學校", threads: [thread("t", { actions: [act("todo", "轉待辦", "T"), act("archive", "封存", "E"), act("trash", "刪除", "#")] })] }], offline: true }), "t");
  assert.match(todo, /class="btn btn-secondary btn-sm q-primary">/, "轉待辦 does not need Gmail");
});
