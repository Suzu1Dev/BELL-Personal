/**
 * Render tests for the BELL Suite parts (renderToStaticMarkup): the 今日複習
 * card in its ready, empty, stale, unavailable and unconfigured states, the
 * product switcher's markup, 來源詳情's rows, and the to-do draft's form and
 * notices. The pure views are rendered as they are, without providers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SuiteSourcesResponse, SuiteTodayFeed } from "../../shared/suite";
import { AppSwitcherMenu, AppSwitcherView, switcherRows } from "./AppSwitcher";
import { explainCardView, type ExplainCardInput } from "./explain-view";
import { ExplainTodayView } from "./ExplainTodayCard";
import { SourceDetailsBody, sourceRows } from "./SourceDetails";
import { TaskDraftFormView, TaskHandoffNotice } from "./TaskDraftPanel";
import type { TaskDraftForm } from "./useTaskDraftForm";

const EXPLAIN = "http://127.0.0.1:21101";
const NOW = new Date("2026-11-08T05:35:00.000Z");
const noop = () => {};
const render = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(component, props));
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

const FEED: SuiteTodayFeed = {
  schemaVersion: 1,
  appId: "explain",
  generatedAt: "2026-11-08T05:30:00.000Z",
  counts: { due: 12, newAvailable: 3, reviewedToday: 5 },
  items: [
    { sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "due", updatedAt: "2026-11-08T05:30:00.000Z" },
    { sourceApp: "explain", type: "lesson", id: "6f1c2a9e", title: "示範資料 · 傅立葉轉換的直覺", href: "#/note/6f1c2a9e", state: "waiting", updatedAt: "2026-11-07T14:02:11.000Z" },
    { sourceApp: "explain", type: "lesson", id: "x2", title: "<script>alert(1)</script>", href: "#/note/x2", state: "waiting", updatedAt: "2026-11-07T14:02:11.000Z" },
  ],
  truncated: false,
};

const sources = (explain: SuiteSourcesResponse["sources"][number]): SuiteSourcesResponse => ({
  schemaVersion: 1,
  sources: [explain, { appId: "pr", status: "unsupported" }],
});

const input = (extra: Partial<ExplainCardInput> = {}): ExplainCardInput => ({
  pollState: "ready",
  data: sources({ appId: "explain", status: "ready", lastSuccessAt: "2026-11-08T05:30:00.000Z", feed: FEED }),
  updatedAt: NOW.getTime() - 60_000,
  links: { explain: EXPLAIN },
  timeZone: "Asia/Taipei",
  now: NOW,
  ...extra,
});

const card = (extra: Partial<ExplainCardInput> = {}, props: { retrying?: boolean } = {}) =>
  render(ExplainTodayView, { view: explainCardView(input(extra)), onRetry: noop, onOpenDetails: noop, ...props });

test("ready: the headline, 開始複習 into Explain's review, the lessons as plain text links, and when", () => {
  const html = card();
  const plain = text(html);
  assert.match(html, /^<section class="card explain-today" aria-labelledby="[^"]+">/);
  assert.match(plain, /複習/);
  assert.match(plain, /Explain/);
  assert.match(plain, /15 張待複習 · 12 到期 · 3 新卡/);
  assert.match(html, new RegExp(`<a[^>]*href="${EXPLAIN}/#/review"[^>]*>.*?開始複習`));
  assert.match(html, new RegExp(`<a href="${EXPLAIN}/#/note/6f1c2a9e"><bdi>示範資料 · 傅立葉轉換的直覺</bdi></a>`));
  assert.ok(!html.includes("<script>"), "titles are text, never markup");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(plain, /更新於 13:30/);
  assert.match(plain, /來源詳情/);
  assert.ok(!plain.includes("—"), "every count is known");
  assert.ok(!plain.includes("線上"));
});

test("empty: 今天沒有到期的複習 and 開啟知識庫, but nothing to review", () => {
  const html = card({ data: sources({ appId: "explain", status: "ready", lastSuccessAt: "2026-11-08T05:30:00.000Z", feed: { ...FEED, counts: { due: 0, newAvailable: 0, reviewedToday: 0 }, items: [] } }) });
  assert.match(text(html), /今天沒有到期的複習/);
  assert.ok(!text(html).includes("開始複習"));
  assert.match(html, new RegExp(`href="${EXPLAIN}/#/library"[^>]*>.*?開啟知識庫`));
  assert.ok(!text(html).includes("0 張"));
});

test("stale: the last counts, age in minutes and 重試", () => {
  const data = sources({ appId: "explain", status: "stale", lastSuccessAt: "2026-11-08T05:10:00.000Z", feed: { ...FEED, counts: { due: 4, newAvailable: 0, reviewedToday: 2 } } });
  const plain = text(card({ data }));
  assert.match(plain, /4 張待複習 · 4 到期 · 0 新卡/);
  assert.match(plain, /25 分鐘前的資料/);
  assert.match(plain, /重試/);
  const retrying = card({ data }, { retrying: true });
  assert.match(text(retrying), /重試中…/);
  assert.match(retrying, /<button[^>]*disabled=""[^>]*>.*?重試中…/);
});

test("unavailable: 「—」 (never 0), 無法連線 Explain, 重試 and 來源詳情", () => {
  const html = card({ pollState: "error", data: undefined, updatedAt: undefined });
  const plain = text(html);
  assert.match(plain, /—/);
  assert.match(html, /<span class="sr-only">未知<\/span>/);
  assert.match(plain, /無法連線 Explain/);
  assert.match(plain, /重試/);
  assert.match(plain, /來源詳情/);
  assert.ok(!/\d/.test(plain.replace(/BELL/g, "")), `no number at all: ${plain}`);
  assert.ok(!plain.includes("開始複習"));
  assert.ok(!html.includes("href="), "nothing to open");
});

test("unconfigured: one quiet line, no counts, no link, no retry", () => {
  const html = card({ data: sources({ appId: "explain", status: "unconfigured" }), links: {} });
  const plain = text(html);
  assert.match(html, /class="card explain-today is-quiet"/);
  assert.match(plain, /尚未連結/);
  assert.ok(!plain.includes("—"));
  assert.ok(!plain.includes("張"));
  assert.ok(!plain.includes("重試"));
  assert.ok(!html.includes("href="));
  for (const leak of ["BELLPERSONAL", "EXPLAIN_", "_URL", "http://127", ".env", "/home", "127.0.0.1", "localhost"]) assert.ok(!html.includes(leak), leak);
});

test("loading: a busy card with a spoken status and no numbers", () => {
  const html = card({ pollState: "loading", data: undefined });
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status">載入 Explain 複習…/);
  assert.ok(!text(html).includes("—"));
});

test("Explain linked but its links missing: counts still show, nothing is a link", () => {
  const html = card({ links: {} });
  assert.match(text(html), /15 張待複習/);
  assert.ok(!html.includes("href="));
  assert.match(html, /<span><bdi>示範資料 · 傅立葉轉換的直覺<\/bdi><\/span>/);
});

// ── The switcher ──────────────────────────────────────────────────────────

test("the switcher button: 切換 BELL 產品, a dialog popup, collapsed", () => {
  const html = render(AppSwitcherView, { open: false, manifest: "ready", rows: switcherRows({ explain: EXPLAIN }), menuId: "m" });
  assert.match(html, /<button type="button" class="btn btn-icon suite-switcher-btn" aria-label="切換 BELL 產品" aria-haspopup="dialog" aria-expanded="false">/);
  assert.ok(!html.includes('role="menu"'));
  assert.ok(!html.includes("aria-controls"));
});

test("the open switcher: Personal current and not a link; Explain a same-tab link; PR, Web Reader and Campaign 尚未連結 with no helper line", () => {
  const html = render(AppSwitcherView, { open: true, manifest: "ready", rows: switcherRows({ explain: EXPLAIN }), menuId: "m" });
  assert.match(html, /aria-expanded="true" aria-controls="m"/);
  assert.match(html, /<div id="m" role="menu" aria-label="BELL 產品"/);
  assert.match(html, /<kbd>esc<\/kbd>/);
  assert.equal(count(html, /role="menuitem"/g), 5);
  assert.equal(count(html, /<kbd>⌃[12345]<\/kbd>/g), 5);
  assert.match(html, /lucide-audio-lines/);
  const order = ["BELL Personal", "BELL Explain", "BELL PR", "BELL Web Reader", "BELL Campaign"].map((name) => html.indexOf(name));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "fixed order");
  assert.match(html, /<div role="menuitem" tabindex="-1" aria-disabled="true" aria-current="true" class="suite-app-row is-current"[^>]*>.*?BELL Personal.*?目前/);
  assert.match(html, new RegExp(`<a role="menuitem" tabindex="-1" class="suite-app-row" href="${EXPLAIN}/"[^>]*>.*?BELL Explain`));
  assert.ok(!/target=/.test(html), "same tab");
  assert.match(html, /<div role="menuitem" tabindex="-1" aria-disabled="true" aria-current="true" class="suite-app-row is-current"[^>]*>/);
  assert.match(html, /<div role="menuitem" tabindex="-1" aria-disabled="true" class="suite-app-row is-unlinked"[^>]*>.*?BELL PR.*?尚未連結/);
  assert.match(html, /<div role="menuitem" tabindex="-1" aria-disabled="true" class="suite-app-row is-unlinked"[^>]*>.*?BELL Web Reader.*?尚未連結/);
  assert.match(html, /<div role="menuitem" tabindex="-1" aria-disabled="true" class="suite-app-row is-unlinked"[^>]*>.*?BELL Campaign.*?尚未連結/);
  assert.doesNotMatch(html, /aria-describedby|suite-app-hint|目前使用中/);
  assert.equal(count(html, /href=/g), 1, "only the linked sibling is a link");
  assert.ok(!text(html).includes("線上"));
});

test("nothing linked: all siblings 尚未連結, no links", () => {
  const html = render(AppSwitcherMenu, { manifest: "ready", rows: switcherRows({}) });
  assert.equal(count(html, /尚未連結<\/em>/g), 4);
  assert.ok(!html.includes("href="));
  assert.ok(!text(html).includes("線上"));
});

test("before the manifest answers, or after it failed, only Personal is shown — no guessed address", () => {
  const loading = render(AppSwitcherMenu, { manifest: "loading", rows: switcherRows({}) });
  assert.match(text(loading), /BELL Personal/);
  assert.ok(!loading.includes("BELL Explain"));
  assert.match(text(loading), /正在載入產品清單…/);
  const failed = render(AppSwitcherMenu, { manifest: "error", rows: switcherRows({}), onRetry: noop });
  assert.ok(!failed.includes("href="));
  assert.match(failed, /<button role="menuitem" tabindex="-1" type="button" class="suite-app-row is-status is-error"[^>]*>.*?無法載入產品清單.*?重試/);
});

test("rows: a link only for a linked sibling, always to its own start page", () => {
  assert.deepEqual(switcherRows({ explain: EXPLAIN, pr: "https://pr.example" }).map((row) => [row.id, row.kind, row.href]), [
    ["personal", "current", undefined],
    ["explain", "linked", `${EXPLAIN}/`],
    ["pr", "linked", "https://pr.example/"],
    ["reader", "unlinked", undefined],
    ["campaign", "unlinked", undefined],
  ]);
});

// ── 來源詳情 ──────────────────────────────────────────────────────────────

test("來源詳情: status, last read, what is shared, 重新整理 and 開啟 BELL Explain; PR has no summary yet", () => {
  const html = render(SourceDetailsBody, { rows: sourceRows(input()), onRefresh: noop, refreshing: false });
  const plain = text(html);
  assert.match(plain, /BELL Explain/);
  assert.match(plain, /已同步/);
  assert.match(plain, /上次成功讀取13:30/);
  assert.match(plain, /只讀取今日複習的數量、課程標題與連結/);
  assert.match(plain, /重新整理/);
  assert.match(html, new RegExp(`<a[^>]*href="${EXPLAIN}/"[^>]*>.*?開啟 BELL Explain`));
  assert.match(plain, /BELL PR尚未支援/);
  assert.equal(count(html, /重新整理/g), 1, "PR cannot be refreshed");
  for (const leak of ["BELLPERSONAL", "_URL", ".env", "/home"]) assert.ok(!html.includes(leak), leak);
});

const RTL = "\u200f\u05e9\u05dc\u05d5\u05dd \u200eabc";
const form = (extra: Partial<TaskDraftForm> = {}): TaskDraftForm => ({
  sourceName: "BELL Explain",
  backUrl: `${EXPLAIN}/#/note/abc`,
  truncated: false,
  title: RTL,
  notes: `${RTL}\n第二行`,
  pending: false,
  setTitle: noop,
  setNotes: noop,
  create: async () => {},
  discard: noop,
  ...extra,
});

test("the draft form: concise heading and source, the sender's text with its own direction, 建立待辦 and 捨棄", () => {
  const html = render(TaskDraftFormView, { form: form() });
  const plain = text(html);
  assert.match(html, /^<section class="suite-draft" aria-labelledby="([^"]+)">/);
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
  assert.ok(labelledBy && html.includes(`<h2 id="${labelledBy}">新增待辦</h2>`));
  assert.match(plain, /來自 BELL Explain · 筆記/);
  assert.doesNotMatch(plain, /之前不會寫入任何資料/);
  assert.equal(count(html, /<input[^>]*dir="auto"/g), 1, "the title keeps its own direction");
  assert.equal(count(html, /<textarea[^>]*dir="auto"/g), 1, "so do the notes");
  assert.ok(html.includes(`value="${RTL}"`), "the title is shown as the sender wrote it, marks included");
  assert.ok(html.includes(`>${RTL}\n第二行</textarea>`), "and so are the notes");
  assert.ok(html.includes(`<a class="suite-back" href="${EXPLAIN}/#/note/abc">`), "back to the sender's own page");
  assert.match(plain, /回到 BELL Explain/);
  assert.match(plain, /建立待辦/);
  assert.match(plain, /捨棄/);
  assert.equal(count(html, /disabled=""/g), 0);
  assert.doesNotMatch(plain, /內容過長/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("the draft form while 建立中, cut short, with a title error, a failed write, and no way back", () => {
  const busy = render(TaskDraftFormView, { form: form({ pending: true, backUrl: undefined }) });
  assert.match(text(busy), /建立中…/);
  assert.equal(count(busy, /<button[^>]*disabled=""/g), 2, "neither button can be pressed again while the write is out");
  assert.match(busy, /aria-busy="true"/);
  assert.doesNotMatch(busy, /suite-back/);

  const html = render(TaskDraftFormView, { form: form({ truncated: true, title: "", titleError: "請輸入待辦標題。", error: "無法建立待辦：離線" }) });
  const plain = text(html);
  assert.match(plain, /內容過長，已截斷為前 2,000 字/);
  assert.match(plain, /請輸入待辦標題。/);
  assert.match(html, /role="alert"[^>]*>.*無法建立待辦：離線/s);
});

test("the notices: rejected for an unlinked sender, a repeated parameter or no draft, checking, unverified", () => {
  const links = { explain: EXPLAIN };
  const duplicate = render(TaskHandoffNotice, { state: { kind: "rejected", reason: "duplicate" }, links, onRetry: noop, onDismiss: noop });
  assert.match(text(duplicate), /已忽略這份草稿：連結裡有重複的欄位，無法確定內容與來源/);
  assert.match(duplicate, /role="status"/);
  assert.doesNotMatch(text(duplicate), /未連結產品/);
  assert.doesNotMatch(duplicate, /<textarea|<input|suite-back/, "nothing of the refused draft is shown");

  const from = render(TaskHandoffNotice, { state: { kind: "rejected", reason: "from" }, links, onRetry: noop, onDismiss: noop });
  assert.match(text(from), /已忽略來自未連結產品的草稿/);
  assert.doesNotMatch(text(from), /重複的欄位/);

  // rev. d: an attempt with no draft, or nothing left after cleaning, is refused visibly too, with 關閉.
  for (const reason of ["missing", "empty"] as const) {
    const refused = render(TaskHandoffNotice, { state: { kind: "rejected", reason }, links, onRetry: noop, onDismiss: noop });
    assert.match(text(refused), /已忽略這個連結：裡面沒有可以建立的草稿內容/, reason);
    assert.match(text(refused), /關閉/, reason);
    assert.match(refused, /role="status"/, reason);
    assert.doesNotMatch(refused, /<textarea|<input|suite-back/, `${reason}: no form`);
  }

  assert.match(text(render(TaskHandoffNotice, { state: { kind: "checking" }, links, onRetry: noop, onDismiss: noop })), /正在確認草稿來源…/);
  const unverified = render(TaskHandoffNotice, { state: { kind: "unverified" }, links, onRetry: noop, onDismiss: noop });
  assert.match(unverified, /role="alert"/);
  assert.match(text(unverified), /重試/);
  assert.match(text(unverified), /捨棄/);
});

test("created: the title isolated in <bdi>, the sender named from Personal's own table, back only to a linked origin", () => {
  const state = { kind: "created", id: "t/1", title: `<b>x</b>${RTL}`, from: "explain", backUrl: `${EXPLAIN}/#/note/abc` } as const;
  const html = render(TaskHandoffNotice, { state, links: { explain: EXPLAIN }, onRetry: noop, onDismiss: noop });
  assert.ok(html.includes(`<bdi>&lt;b&gt;x&lt;/b&gt;${RTL}</bdi>`), "the title is text, isolated from the line around it");
  assert.ok(html.includes(`<a class="suite-back" href="${EXPLAIN}/#/note/abc">`));
  assert.match(text(html), /回到 BELL Explain/);
  assert.ok(html.includes('href="#/tasks/t%2F1"'), "查看待辦 to the new to-do");

  // Explain is linked elsewhere now: no back link to the old address.
  const moved = render(TaskHandoffNotice, { state, links: { explain: "http://127.0.0.1:21104" }, onRetry: noop, onDismiss: noop });
  assert.doesNotMatch(moved, /suite-back/);
  assert.match(text(moved), /已建立待辦/);
});
