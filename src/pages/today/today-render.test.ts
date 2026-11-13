/**
 * Component tests for the Today widgets (renderToStaticMarkup on the
 * server fixtures): queue grouping, the cursor row, every widget state, and
 * the one-store rule — the H1, progress and queue footer all show `counts`,
 * before and after an action.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TodayPayload } from "../../../shared/today";
import { applyActionToPayload } from "../../../shared/today-logic";
import { AgendaCard } from "./AgendaCard";
import { CaptureCard } from "./CaptureCard";
import { DigestStrip } from "./DigestStrip";
import { EndMark } from "./EndMark";
import { FocusQueue, type FocusQueueProps } from "./FocusQueue";
import { HabitsCard } from "./HabitsCard";
import { QueueRow } from "./QueueRow";
import { LaterCard } from "./LaterCard";
import { TodayHero, TodayProgress } from "./TodayHero";
import { singleKeyStore } from "../../lib/preferences";

const fixture = (name: string): TodayPayload =>
  JSON.parse(readFileSync(new URL(`../../../server/fixtures/today-${name}.json`, import.meta.url), "utf8")) as TodayPayload;

const noop = () => {};
const agendaProps = { onAdd: noop, onSchedule: noop, onToggleHabit: noop, onSyncSources: noop };
const render = <P extends object>(component: ComponentType<P>, props: P) => renderToStaticMarkup(createElement(component, props));
const queueProps = (payload: TodayPayload | undefined, extra: Partial<FocusQueueProps> = {}): FocusQueueProps => ({
  payload, pollState: "ready", onAct: noop, onRetry: noop, onSyncSources: noop, onCapture: noop, onUndoHandled: noop, onToggleHabit: noop, ...extra,
});
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;
const text = (html: string) => html.replace(/<[^>]+>/g, "");

test("the queue renders the three groups with counts and only the later group's seven-day scope", () => {
  const html = render(FocusQueue, queueProps(fixture("2026-10-12")));
  const groups = [...html.matchAll(/<h3 id="qg-(\w+)">([^<]+)<\/h3><span class="count"[^>]*>(\d+)<\/span>(?:<span class="hint">([^<]+)<\/span>)?<\/div>/g)]
    .map((match) => [match[1], match[2], Number(match[3]), match[4]]);
  assert.deepEqual(groups, [
    ["now", "最重要", 3, undefined],
    ["today", "今天內", 3, undefined],
    ["later", "可以等", 2, "待辦與作業：未來 7 天內"],
  ]);
  assert.equal(count(html, /class="hint"/g), 1);
  assert.doesNotMatch(text(html), /先做這些，今天就輕鬆了|找個空檔處理|這週內處理就好/);
  assert.equal(count(html, /<li class="q-row/g), 8);
  assert.match(html, /<h2 id="q-title">專注佇列<\/h2><span class="count" aria-label="8 件待處理">8<\/span>/);
  assert.match(text(html), /全部8信件2作業2GitHub1活動2待辦1/);
});

test("exactly one cursor row: aria-current, a roving tabindex, opened in place with every action", () => {
  const html = render(FocusQueue, queueProps(fixture("2026-10-12")));
  assert.equal(count(html, /aria-current="true"/g), 1);
  assert.equal(count(html, /class="q-title" type="button" tabindex="0"/g), 1);
  assert.equal(count(html, /class="q-title" type="button" tabindex="-1"/g), 7);
  const cursor = html.slice(html.indexOf('aria-current="true"'), html.indexOf("</li>", html.indexOf('aria-current="true"')));
  assert.match(cursor, /aria-expanded="true"/);
  assert.match(cursor, /class="q-sum"/);
  assert.deepEqual([...cursor.matchAll(/class="btn btn-(\w+) btn-sm"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?([^<]+)/g)].map((match) => [match[1], match[2]]), [
    ["primary", "回覆"], ["secondary", "轉待辦"], ["secondary", "延後"], ["ghost", "封存"], ["ghost", "刪除"],
  ]);
  assert.match(cursor, /<kbd>↵<\/kbd>/);
  assert.match(cursor, /class="link ext" target="_blank" rel="noopener noreferrer" href="https:\/\/mail.google.com[^"]*">在 Gmail 開啟/);
});

test("other rows keep .when visible next to the hover actions and the touch primary; suggestions show both buttons", () => {
  const html = render(FocusQueue, queueProps(fixture("2026-10-12")));
  const hw3 = html.slice(html.indexOf('data-row-id="moodle:assign-30512"'), html.indexOf("</li>", html.indexOf('data-row-id="moodle:assign-30512"')));
  assert.match(hw3, /class="q-acts".*開啟 E3.*標為已交.*延後/);
  assert.match(hw3, /<span class="when zh hot">剩 15 小時<\/span>/);
  assert.match(hw3, /q-primary[^>]*>.*已交<\/button>/);
  assert.match(html, /<li class="q-row is-ai can-swipe" data-row-id="ai:sg-sitcon-autumn">/);
  // Swipeable rows declare touch-action (FocusQueue.css .can-swipe), or touch drags end in pointercancel.
  assert.equal(count(html, /<li class="q-row[^"]*can-swipe/g), 8);
  const ai = html.slice(html.indexOf('data-row-id="ai:sg-sitcon-autumn"'), html.indexOf("</li>", html.indexOf('data-row-id="ai:sg-sitcon-autumn"')));
  assert.match(ai, /加入行事曆<kbd>C<\/kbd>/);
  assert.match(ai, /aria-label="略過這個建議"/);
  assert.doesNotMatch(ai, /aria-expanded/, "suggestions never expand");
  assert.match(html, /<span class="add mono">\+142<\/span> <span class="del mono">−38<\/span>/);
});

test("the footer shows today's handled count without an explanatory legend", () => {
  const html = render(FocusQueue, queueProps(fixture("2026-10-12")));
  assert.match(text(html), /今天已處理 3 件顯示/);
  assert.doesNotMatch(html, /class="legend"/);
});

test("counts are one store: progress and footer follow counts after an action; the heading stays a date", () => {
  for (const payload of [fixture("2026-10-12"), applyActionToPayload(fixture("2026-10-12"), "gmail:18c2f0a1b2c3d4e5", "archive")]) {
    const { open, handled, total } = payload.counts;
    const hero = text(render(TodayHero, { payload }));
    const progressHtml = render(TodayProgress, { payload });
    assert.match(hero, /10月12日 星期一/);
    assert.doesNotMatch(hero, /今日進度/, "progress strip moved below Personal Bot");
    assert.match(text(progressHtml), new RegExp(`今日進度${handled} / ${total}`));
    assert.match(progressHtml, new RegExp(`aria-valuenow="${handled}" aria-valuetext="已處理 ${handled} 件，共 ${total} 件"`));
    const queue = render(FocusQueue, queueProps(payload));
    assert.match(text(queue), new RegExp(`今天已處理 ${handled} 件`));
    assert.match(queue, new RegExp(`aria-label="${open} 件待處理">${open}<`));
  }
});

test("the hero and progress strip: concise date, weather pill, AI brief, segmented pace and next-up", () => {
  const html = render(TodayHero, { payload: fixture("2026-10-12") });
  const prog = render(TodayProgress, { payload: fixture("2026-10-12") });
  assert.match(text(html), /新竹 24° 多雲21:00 後降雨 60%/);
  assert.doesNotMatch(text(html), /MON · 10\/12/);
  assert.match(html, /<h1 id="hero-title" class="hero-title kp">10月12日 星期一<\/h1>/);
  assert.doesNotMatch(html, /class="uline"/);
  assert.match(html, /class="ai-tag" title="AI 整理於 06:30"/);
  assert.match(text(prog), /照這個節奏，約 35 分鐘 清空/);
  assert.match(text(prog), /10:10作業系統1 小時 28 分後/);
  const segments = prog.slice(prog.indexOf('class="segs"'), prog.indexOf("</div>", prog.indexOf('class="segs"')));
  assert.equal(count(segments, /<i class="on"/g), 3);
  assert.equal(count(segments, /<i[ >]/g), 11, "one segment per item");
});

test("AI failed → the rule brief with the reason and 重試; signed out or AI off → the rule brief alone", () => {
  const degraded = render(TodayHero, { payload: { ...fixture("degraded"), brief: { ...fixture("degraded").brief, reason: "產生逾時" } }, onRefreshBrief: noop });
  assert.match(degraded, /class="ai-tag rule"/);
  assert.match(text(degraded), /1 封信待回覆，1 項作業今晚 23:59 截止。/);
  assert.match(text(degraded), /AI 摘要暫時無法使用：產生逾時。重試·每日摘要設定/);
  const signedOut = render(TodayHero, { payload: fixture("degraded"), onRefreshBrief: noop });
  assert.match(signedOut, /class="ai-tag rule"/);
  assert.doesNotMatch(signedOut, /fallback-note/, "a model that is not signed in is not announced on every open");
  const off = render(TodayHero, { payload: fixture("empty"), onRefreshBrief: noop });
  assert.match(off, /class="ai-tag rule"/);
  assert.doesNotMatch(off, /fallback-note|brief-refresh/);
  assert.match(text(off), /10月17日 星期六/);
  const generating = render(TodayHero, { payload: { ...fixture("2026-10-12"), brief: { state: "generating", text: "…", source: "rule" } } });
  assert.match(text(generating), /正在整理今日摘要…/);
  assert.equal(count(generating, /class="skel"/g), 2);
});

test("state 01: the empty queue offers 記下一件事 and the end mark says AI briefs are off", () => {
  const payload = fixture("empty");
  const html = render(FocusQueue, queueProps(payload));
  assert.match(text(html), /今天沒有要處理的事。信件、作業與活動會自動加入。記下一件事N/);
  assert.doesNotMatch(text(html), /新的信件、作業和活動會自動出現在這裡/);
  assert.match(text(render(EndMark, { brief: payload.brief })), /今天的版面到這裡。AI 摘要已關閉。/);
  assert.match(text(render(EndMark, { brief: fixture("2026-10-12").brief })), /下一份摘要明天 06:30 送到。/);
});

test("state 02: the cleared queue celebrates, counts how, and offers the habits still left", () => {
  const html = render(FocusQueue, queueProps(fixture("cleared")));
  assert.match(html, /class="empty-state solid" role="status"/);
  assert.equal(count(html, /<i style=/g), 5, "five confetti squares");
  assert.match(text(html), /今天的 11 件事都處理完了。/);
  assert.deepEqual([...html.matchAll(/<dd><b>(\d+)<\/b><span aria-hidden="true">([^<]+)</g)].map((match) => `${match[2]} ${match[1]}`), ["回覆 3", "完成 4", "延後 2", "行事曆 2"]);
  assert.match(text(html), /還差 2 個習慣/);
  assert.equal(count(html, /class="hchip"/g), 2);
  assert.match(text(render(TodayHero, { payload: fixture("cleared") })), /10月12日 星期一/);
});

test("state 03: a disconnected source is a dashed chip and a notice that says the count may be short", () => {
  const payload = fixture("2026-10-12");
  const broken: TodayPayload = { ...payload, sources: payload.sources.map((source) => (source.id === "gmail" ? { ...source, state: "reconnect", lastSyncedAt: "2026-10-11T14:10:00.000Z" } : source)) };
  const html = render(FocusQueue, queueProps(broken));
  assert.match(html, /class="chip is-error" aria-pressed="false" title="Gmail 需要重新連線"/);
  assert.match(html, /class="notice notice-warn" role="alert"/);
  assert.match(text(html), /Gmail 需要重新連線Google 撤銷了授權，新信件沒有列入佇列，所以「8 件」可能少算。上次同步 昨天 22:10。重新連線/);
  assert.equal(render(DigestStrip, { payload: broken, onAct: noop }), "", "the digest hides while Gmail is broken");
});

test("the queue keeps its rows when a refresh fails, with the error notice on top; loading shows three skeleton rows", () => {
  const html = render(FocusQueue, queueProps(fixture("2026-10-12"), { pollState: "stale", updatedAt: Date.parse("2026-10-12T00:12:00.000Z") }));
  assert.match(text(html), /佇列暫時無法更新顯示 08:12 的內容。重試/);
  assert.equal(count(html, /<li class="q-row/g), 8);
  const loading = render(FocusQueue, queueProps(undefined));
  assert.equal(count(loading, /class="skel-row"/g), 3);
  assert.match(loading, /aria-busy="true"/);
});

test("stale sources add a note under the queue head", () => {
  const payload = fixture("2026-10-12");
  const stale: TodayPayload = { ...payload, sources: payload.sources.map((source) => (source.id === "moodle" ? { ...source, state: "stale", lastSyncedAt: "2026-10-12T00:12:00.000Z" } : source)) };
  assert.match(text(render(FocusQueue, queueProps(stale))), /顯示 08:12 的資料 · 重新整理/);
});

test("caps: rows beyond five become 「還有 N 件 · 顯示全部」", () => {
  const payload = fixture("2026-10-12");
  const now = payload.queue[0];
  const crowded: TodayPayload = {
    ...payload,
    queue: [{ ...now, items: Array.from({ length: 7 }, (_, index) => ({ ...now.items[1], id: `moodle:a${index}`, title: `作業 ${index}` })), hidden: 2 }, ...payload.queue.slice(1)],
  };
  const html = render(FocusQueue, queueProps(crowded));
  assert.match(text(html), /還有 2 件 · 顯示全部/);
  assert.equal(count(html, /data-row-id="moodle:a\d"/g), 5);
});

test("habits: weekday header, round checks with their keys, today's dot, streak units; extra habits become +N", () => {
  const payload = fixture("2026-10-12");
  const html = render(HabitsCard, { payload, onToggle: noop });
  assert.match(text(html), /習慣打卡1\/3按 1–3 打卡/);
  assert.match(html, /aria-pressed="true" aria-label="閱讀 20 分鐘，今天已完成。按 1 切換"/);
  assert.match(html, /aria-label="寫日記，今天尚未完成。按 3 切換"/);
  assert.match(html, /aria-label="連續 4 週"/);
  assert.match(html, /<span class="today">一<\/span>/);
  assert.equal(count(html, / t"><\/i>|"t"><\/i>/g), 3);
  const more = { ...payload, habits: [...payload.habits, { ...payload.habits[0], id: "h4", name: "冥想" }, { ...payload.habits[0], id: "h5", name: "喝水" }] };
  const crowded = render(HabitsCard, { payload: more, onToggle: noop });
  assert.equal(count(crowded, /is-extra/g), 2);
  assert.match(crowded, /class="habit habit-more" href="#\/habits" aria-label="還有 2 個習慣，前往習慣頁">\+2</);
  const empty = render(HabitsCard, { payload: { ...payload, habits: [] }, onToggle: noop });
  assert.match(text(empty), /還沒有習慣，從一個小的開始吧。新增習慣＋ 新增習慣/);
});

test("agenda: the 現在 line, the free slot with 排進, the habit hint, the deadline row", () => {
  const html = render(AgendaCard, { ...agendaProps, payload: fixture("2026-10-12") });
  assert.match(html, /<div class="tl-now" role="note" aria-label="現在 08:42">/);
  assert.match(text(html), /4 小時空檔適合寫 HW3排進/);
  assert.match(text(html), /光復校區 體育館 · 結束後一鍵打卡「運動」/);
  assert.match(html, /class="tl-row is-due"/);
  assert.match(html, /aria-label="3 個行程">3</);
});

test("agenda state 04: the calendar notice, faded last data and its stale note; not set up asks to connect", () => {
  const html = render(AgendaCard, { ...agendaProps, payload: fixture("degraded") });
  assert.match(text(html), /無法讀取 Google 行事曆授權已過期。重新連線後會自動補上今天的行程。重新連線/);
  assert.match(html, /class="tl is-stale"/);
  assert.match(text(html), /顯示 昨天 22:10 的資料 · 重新整理/);
  const bare = { ...fixture("empty"), sources: [] };
  const setup = render(AgendaCard, { ...agendaProps, payload: bare });
  assert.match(text(setup), /今天沒有行程。新增一個，或連接行事曆，行程就會自動出現。新增行程連接 Google/);
  assert.match(setup, /class="btn btn-primary btn-sm"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?新增行程<\/button>/, "新增行程 is the primary action");
  assert.match(setup, /<a class="link" href="#\/settings\/sources">連接 Google/, "連接 Google stays as a text link to the sources");
  assert.doesNotMatch(setup, /class="btn btn-secondary/);
  assert.match(text(render(AgendaCard, { ...agendaProps, payload: fixture("empty") })), /今天沒有行程，留點時間給自己。/);
  const cleared = render(AgendaCard, { ...agendaProps, payload: fixture("cleared") });
  assert.match(text(cleared), /打卡「運動」/, "the ended workout offers the one-tap check-in");
  assert.match(text(cleared), /已結束 3 個 · 顯示/);
});

test("digest, later and capture render their copy", () => {
  const payload = fixture("2026-10-12");
  const digest = text(render(DigestStrip, { payload, onAct: noop }));
  assert.match(digest, /另外 9 封信已自動分類，不用處理電子報 3 · 學校公告 2 · GitHub 通知 4 · 信都還在你的 Gmail全部標為已讀逐類看/);
  const later = render(LaterCard, { payload, onRetry: noop, onSyncSources: noop });
  assert.match(text(later), /明天 09:00 計算機網路 · 本週還有 3 個活動 · 3 個專案進行中/);
  assert.match(text(later), /10\/13明天09:00 計算機網路工程三館 EC122 · Google 行事曆/);
  assert.match(text(later), /下一步：10\/19 題目提案 · 等林教授回覆/);
  assert.match(later, /class="pj-row" href="https:\/\/github.com\/vitejs\/vite\/pull\/18234" target="_blank" rel="noopener noreferrer"/);
  const none = render(LaterCard, { payload: { ...payload, later: { events: [], projects: [] } }, onRetry: noop, onSyncSources: noop });
  assert.equal(none, "", "nothing ahead: no card and no nudge to add sources");
  const capture = render(CaptureCard, { payload, field: createElement("label", { className: "cap-field" }) });
  assert.match(capture, /<section class="card capture" aria-label="快速記下"><label class="cap-field"><\/label>/);
  assert.match(text(capture), /用 eBPF 量 CFS 排程延遲，當期末專題昨天CTF writeup 改寫成部落格系列10\/9/);
});

test("before the first payload every widget shows its own loading state and nothing blanks", () => {
  const hero = render(TodayHero, { payload: undefined });
  assert.match(hero, /class="today-hero is-loading" aria-busy="true"/);
  assert.match(hero, /<h1 id="hero-title" class="sr-only">正在載入今天的資料…<\/h1>/);
  assert.equal(count(render(HabitsCard, { payload: undefined, onToggle: noop }), /class="habit habit-skel"/g), 3);
  assert.equal(count(render(AgendaCard, { ...agendaProps, payload: undefined }), /class="tl-row"/g), 4);
  assert.equal(count(render(LaterCard, { payload: undefined, onRetry: noop, onSyncSources: noop }), /class="later-skel"/g), 2);
  assert.equal(render(DigestStrip, { payload: undefined, onAct: noop }), "", "the digest stays hidden until loaded");
  assert.match(render(CaptureCard, { payload: undefined, field: createElement("input", { placeholder: "記下任何事…" }) }), /placeholder="記下任何事…"/, "capture never waits");
  assert.match(text(render(EndMark, { brief: undefined })), /今天的版面到這裡。/);
});

test("when the first load failed, widgets show a still line instead of skeletons that announce loading forever", () => {
  const widgets = [
    render(TodayHero, { payload: undefined, failed: true }),
    render(FocusQueue, queueProps(undefined, { pollState: "error" })),
    render(HabitsCard, { payload: undefined, onToggle: noop, failed: true }),
    render(AgendaCard, { ...agendaProps, payload: undefined, failed: true }),
    render(LaterCard, { payload: undefined, onRetry: noop, onSyncSources: noop, failed: true }),
  ];
  for (const html of widgets) {
    assert.doesNotMatch(html, /aria-busy|skel|正在載入/, html.slice(0, 80));
  }
  for (const html of widgets.slice(1)) assert.match(html, /暫時無法載入。/);
  assert.match(widgets[0], /<h1 id="hero-title" class="sr-only">今天<\/h1>/);
  assert.match(render(FocusQueue, queueProps(undefined, { pollState: "loading" })), /aria-busy="true"/, "still loading: the skeleton");
});

test("with 單鍵快捷鍵 off the queue shows no single-key hints, only ↵", (t) => {
  singleKeyStore.set(false);
  t.after(() => singleKeyStore.set(true));
  const html = render(FocusQueue, queueProps(fixture("2026-10-12")));
  assert.deepEqual([...new Set([...html.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((match) => match[1]))], ["↵"]);
  assert.doesNotMatch(html, /class="legend"/);
  singleKeyStore.set(true);
  assert.match(render(FocusQueue, queueProps(fixture("2026-10-12"))), /<kbd>E<\/kbd>/);
});

test("a mail row's swipe tray never covers the expanded cursor row, whose detail already shows 封存 and 刪除", () => {
  const mail = fixture("2026-10-12").queue.flatMap((group) => group.items).find((item) => item.kind === "mail.reply")!;
  const row = (cursor: boolean) => render(QueueRow, {
    item: { ...mail, actions: [...mail.actions.filter((action) => action.id !== "trash"), { id: "trash", label: "刪除", touchLabel: "刪除", key: "#" }] },
    cursor, expanded: cursor, trayOpen: true, onSelect: noop, onAction: noop, onSwipe: noop, onTray: noop,
  });
  assert.match(row(false), /class="q-tray"/, "a collapsed row's tray opens");
  assert.doesNotMatch(row(true), /class="q-tray"/);
  assert.match(row(true), /class="q-detail"/);
});
