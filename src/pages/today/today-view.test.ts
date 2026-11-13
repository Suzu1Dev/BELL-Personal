import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { QueueItem, TodayPayload } from "../../../shared/today";
import {
  actionForKey, arrivals, buildTimeline, mailAssignmentToast, customSnooze, cursorAfterRemoval, detailVariant, filterOfKind, heroTitle, hoverActions, isFirstRun, laterSummary,
  moveCursor, queueChips, queueView, rainTime, rowOrder, scheduleWindow, sincePhrase, snoozeOptions, touchPrimary, weekHeader,
} from "./today-view";

const fixture = (name: string): TodayPayload =>
  JSON.parse(readFileSync(new URL(`../../../server/fixtures/today-${name}.json`, import.meta.url), "utf8")) as TodayPayload;

const find = (payload: TodayPayload, id: string): QueueItem => payload.queue.flatMap((group) => group.items).find((item) => item.id === id)!;

test("chips count the rows by 信件 · 作業 · GitHub · 活動 · 待辦 and hide empty filters", () => {
  const payload = fixture("2026-10-12");
  assert.deepEqual(queueChips(payload).map((chip) => [chip.value, chip.count]), [
    ["all", 8], ["mail", 2], ["work", 2], ["github", 1], ["events", 2], ["tasks", 1],
  ]);
  assert.equal(filterOfKind("suggestion.event"), "events", "an event found in mail is an 活動");
  assert.equal(filterOfKind("suggestion.todo"), "tasks");
  const held = queueChips(payload, new Set(["gmail:18c2f0a1b2c3d4e5"]));
  assert.deepEqual(held.slice(0, 2).map((chip) => chip.count), [7, 1], "held-back new rows are not counted yet");
});

test("a broken source turns its chip into the dashed error chip, even with no rows left", () => {
  const payload = fixture("2026-10-12");
  const broken: TodayPayload = {
    ...payload,
    sources: payload.sources.map((source) => (source.id === "gmail" ? { ...source, state: "reconnect" } : source)),
    queue: payload.queue.map((group) => ({ ...group, items: group.items.filter((item) => item.source !== "gmail") })),
  };
  const mail = queueChips(broken).find((chip) => chip.value === "mail");
  assert.equal(mail?.broken?.id, "gmail");
  assert.equal(mail?.count, undefined);
});

test("filters keep the group order; caps hide rows until 顯示全部 and expanding shows them all", () => {
  const payload = fixture("2026-10-12");
  assert.deepEqual(queueView(payload, "work").map((group) => [group.group, group.items.map((item) => item.id)]), [
    ["now", ["moodle:assign-30512"]], ["later", ["moodle:assign-30744"]],
  ]);
  const crowded: TodayPayload = {
    ...payload,
    queue: payload.queue.map((group) => (group.group === "later"
      ? { ...group, items: Array.from({ length: 5 }, (_, index) => ({ ...group.items[0], id: `moodle:x${index}` })), hidden: 2 }
      : group)),
  };
  const later = queueView(crowded, "all").find((group) => group.group === "later")!;
  assert.deepEqual([later.shown.length, later.hidden, later.overflow], [3, 2, 2]);
  const open = queueView(crowded, "all", new Set(), new Set(["later"])).find((group) => group.group === "later")!;
  assert.deepEqual([open.shown.length, open.hidden, open.overflow], [5, 0, 2]);
});

test("the cursor moves in DOM order and lands on the next row after an action, or the previous one at the end", () => {
  const order = rowOrder(queueView(fixture("2026-10-12"), "all"));
  assert.equal(order.length, 8);
  assert.equal(moveCursor(order, undefined, 1), order[0], "the first J enters the queue");
  assert.equal(moveCursor(order, order[0], 1), order[1]);
  assert.equal(moveCursor(order, order[0], -1), order[0], "K stops at the top");
  assert.equal(moveCursor(order, order[7], 1), order[7], "J stops at the bottom");
  assert.equal(cursorAfterRemoval(order, order[2]), order[3]);
  assert.equal(cursorAfterRemoval(order, order[7]), order[6]);
  assert.equal(cursorAfterRemoval([order[0]], order[0]), undefined);
});

test("new rows above the cursor wait behind the pill; rows below arrive silently", () => {
  const known = new Set(["a", "b", "c"]);
  assert.deepEqual(arrivals(["new1", "a", "b", "new2", "c"], known, "b"), { silent: ["new2"], held: ["new1"] });
  assert.deepEqual(arrivals(["new1", "a"], known, undefined), { silent: ["new1"], held: [] });
  assert.deepEqual(arrivals(["a", "b"], known, "a"), { silent: [], held: [] });
});

test("keys and touch pick the row's action: ↵ default, E/S/T/C by key, 已交 on touch for assignments", () => {
  const payload = fixture("2026-10-12");
  const mail = find(payload, "gmail:18c2f0a1b2c3d4e5");
  assert.equal(actionForKey(mail, "Enter")?.id, "reply");
  assert.equal(actionForKey(mail, "E")?.id, "archive");
  assert.equal(actionForKey(mail, "T")?.id, "todo");
  assert.equal(actionForKey(mail, "C"), undefined, "no calendar action on this mail");
  const todo = find(payload, "native:todo-study-slides");
  assert.equal(actionForKey(todo, "Enter")?.id, "open", "↵ is the row's Enter action (開啟), E is 完成");
  assert.equal(actionForKey(todo, "E")?.id, "done");
  const bill = find(payload, "gmail:18c2e9d0a1b2c3f6");
  assert.equal(actionForKey(bill, "Enter")?.id, "todo", "without an Enter action ↵ runs the primary");
  const hw3 = find(payload, "moodle:assign-30512");
  assert.equal(touchPrimary(hw3)?.touchLabel, "已交");
  assert.equal(touchPrimary(find(payload, "github:PR_kwDOSitcon127"))?.touchLabel, "審查");
  assert.deepEqual(mail.actions.map((action, index) => detailVariant(action, index)), ["primary", "secondary", "secondary", "ghost", "ghost"]);
  assert.equal(actionForKey(mail, "#")?.id, "trash", "# is 刪除 on mail rows");
  assert.deepEqual(hoverActions(mail).map((action) => action.label), ["回覆", "封存", "刪除"], "mail hover: primary, 封存, 刪除");
  assert.deepEqual(hoverActions(bill).map((action) => action.label), ["轉成待辦", "封存", "刪除"]);
  assert.deepEqual(hoverActions(hw3).map((action) => action.id), hw3.actions.slice(0, 3).map((action) => action.id), "other rows keep their first three");
});

test("the H1 follows the counts: open, cleared, or nothing scheduled", () => {
  assert.deepEqual(heroTitle(fixture("2026-10-12")), { kind: "open", greeting: "早安", count: 8 });
  assert.deepEqual(heroTitle(fixture("cleared")), { kind: "cleared" });
  assert.deepEqual(heroTitle(fixture("empty")), { kind: "empty", greeting: "早安" });
  assert.deepEqual(rainTime(fixture("2026-10-12").weather), { time: "21:00", pct: 60 });
  assert.equal(rainTime({ city: "新竹", tempC: 24, text: "多雲", rain: { from: "2026-10-12T13:00:00.000Z", pct: 40 } }), undefined, "under 50 % is not shown");
});

test("snooze options are Taipei times and respect the row's limit (deadline − 2 h)", () => {
  const now = "2026-10-12T00:42:00.000Z"; // Monday 08:42 in Taipei
  const options = snoozeOptions(now);
  assert.deepEqual(options.map((option) => [option.id, option.until, option.disabled]), [
    ["tonight", "2026-10-12T12:00:00.000Z", undefined],
    ["tomorrow", "2026-10-13T00:00:00.000Z", undefined],
    ["saturday", "2026-10-17T01:00:00.000Z", undefined],
    ["nextMonday", "2026-10-19T00:00:00.000Z", undefined],
  ]);
  const limited = snoozeOptions(now, "2026-10-12T13:59:00.000Z");
  assert.deepEqual(limited.map((option) => option.disabled), [undefined, "limit", "limit", "limit"]);
  const late = snoozeOptions("2026-10-12T13:30:00.000Z");
  assert.equal(late[0].disabled, "past", "今晚 20:00 is gone at 21:30");
  const sunday = snoozeOptions("2026-10-18T02:00:00.000Z");
  assert.equal(sunday.find((option) => option.id === "nextMonday")?.until, "2026-10-19T00:00:00.000Z", "下週一 from a Sunday is tomorrow");
  assert.equal(sunday.find((option) => option.id === "saturday")?.until, "2026-10-24T01:00:00.000Z");
});

test("選擇時間… reads the local field in Taipei and refuses the past and the deadline", () => {
  const now = "2026-10-12T00:42:00.000Z";
  assert.deepEqual(customSnooze("2026-10-13T09:30", now), { until: "2026-10-13T01:30:00.000Z", label: "明天 09:30" });
  assert.deepEqual(customSnooze("2026-10-12T21:15", now), { until: "2026-10-12T13:15:00.000Z", label: "今天 21:15" });
  assert.deepEqual(customSnooze("2026-10-15T09:00", now), { until: "2026-10-15T01:00:00.000Z", label: "10/15 09:00" });
  assert.deepEqual(customSnooze("2026-10-12T08:00", now), { error: "past" });
  assert.deepEqual(customSnooze("2026-10-13T09:30", now, "2026-10-12T13:59:00.000Z"), { error: "limit" });
  assert.deepEqual(customSnooze("tomorrow", now), { error: "invalid" });
});

test("the agenda: 現在 before the first future row, the free slot at its time, 1 小時 28 分後 on the next event", () => {
  const payload = fixture("2026-10-12");
  const rows = buildTimeline(payload.agenda, payload.now, false);
  assert.deepEqual(rows.map((row) => (row.type === "item" ? row.item.title : row.type)), ["now", "作業系統", "OS 讀書會 · Ch.5", "gap", "健身", "HW3 截止"]);
  const next = rows.find((row) => row.type === "item" && row.soon);
  assert.equal(next?.type === "item" ? next.soon : undefined, "1 小時 28 分後");
  assert.deepEqual(scheduleWindow(payload.agenda.gap!), { start: "2026-10-12T07:30:00.000Z", end: "2026-10-12T10:30:00.000Z" }, "the 3 h estimate is shorter than the 4 h slot");
});

test("more than two past rows fold, except a habit check-in still waiting for its tap", () => {
  const cleared = fixture("cleared");
  const folded = buildTimeline(cleared.agenda, cleared.now, false);
  assert.deepEqual(folded.map((row) => row.type), ["fold", "now"]);
  assert.equal(folded[0].type === "fold" ? folded[0].count : 0, 4);
  const kept = buildTimeline(cleared.agenda, cleared.now, false, undefined, (item) => item.habitLink === "運動");
  assert.deepEqual(kept.map((row) => (row.type === "item" ? row.item.title : row.type)), ["fold", "健身", "now"]);
  assert.equal(kept[0].type === "fold" ? kept[0].count : 0, 3);
  assert.equal(buildTimeline(cleared.agenda, cleared.now, true).filter((row) => row.type === "item").length, 4, "顯示 unfolds them");
  assert.deepEqual(buildTimeline({ items: [] }, cleared.now, false), []);
});

test("small phrases: weekday header, stale times, later summary, first run", () => {
  assert.deepEqual(weekHeader("2026-10-12").map((day) => day.label).join(""), "二三四五六日一");
  assert.equal(weekHeader("2026-10-12")[6].today, true);
  const now = "2026-10-12T00:42:00.000Z";
  assert.equal(sincePhrase("2026-10-12T00:12:00.000Z", now), "08:12");
  assert.equal(sincePhrase("2026-10-11T14:10:00.000Z", now), "昨天 22:10");
  assert.equal(sincePhrase("2026-10-09T14:10:00.000Z", now), "10/9 22:10");
  assert.deepEqual(laterSummary(fixture("2026-10-12")), { lead: "明天 09:00 計算機網路", rest: ["本週還有 3 個活動", "3 個專案進行中"] });
  assert.equal(isFirstRun(fixture("2026-10-12")), false);
  const blank = fixture("empty");
  const fresh: TodayPayload = {
    ...blank, habits: [], ideas: [], later: { events: [], projects: [] }, sidebar: undefined,
    counts: { ...blank.counts, nav: { tasks: 0, work: 0, events: 0 } },
    sources: [{ id: "weather", label: "天氣", state: "ok" }, { id: "gmail", label: "Gmail", state: "off" }],
  };
  assert.equal(isFirstRun(fresh), true, "weather alone is not a connected source");
  assert.equal(isFirstRun({ ...fresh, ideas: [{ id: "i", text: "x", at: now }] }), false, "native data counts");

  // A first run with CTFtime on (the CTF 選手 switch in 初次設定): it syncs at boot, so two 要參加嗎 rows are already there.
  const ctf = (id: string, title: string): QueueItem => ({
    id: `ctftime:${id}`, kind: "event.decide", group: "later", source: "ctftime", title: `${title}，要參加嗎？`, subject: title, meta: ["CTFtime"],
    actions: [{ id: "going", label: "要參加", touchLabel: "要參加", key: "C" }, { id: "dismiss", label: "略過", touchLabel: "略過", key: "E" }],
  });
  const withCtfs: TodayPayload = {
    ...fresh,
    sources: [...fresh.sources, { id: "ctftime", label: "CTFtime", state: "ok" }, { id: "github", label: "GitHub", state: "ok" }],
    queue: fresh.queue.map((group) => (group.group === "later" ? { ...group, items: [ctf("1", "DEADFACE CTF"), ctf("2", "Securinets CTF")] } : group)),
    counts: { ...fresh.counts, open: 2, total: 2 },
  };
  assert.equal(isFirstRun(withCtfs), true, "rows from setup-free sources (CTFtime, a detected gh login) do not end the first run");
  const skipped = { ...withCtfs, counts: { ...withCtfs.counts, open: 1, handled: 1 }, handled: [{ itemId: "ctftime:2", kind: "event.decide" as const, title: "Securinets CTF", action: "dismiss" as const, at: now, actionId: "a", undoable: true }] };
  assert.equal(isFirstRun(skipped), true, "略過 on a CTF is not the user's own data either");
  const mail: QueueItem = { ...ctf("x", "x"), id: "gmail:1", kind: "mail.reply", source: "gmail", title: "Re: 期末專題" };
  assert.equal(isFirstRun({ ...withCtfs, queue: withCtfs.queue.map((group) => ({ ...group, items: [...group.items, mail] })) }), false, "a mail row means a source is set up");
  assert.equal(isFirstRun({ ...skipped, handled: [{ ...skipped.handled[0], itemId: "native:todo-1", kind: "todo" }] }), false, "a finished todo is native data");
});

test("Today's 轉成作業 toast names the rules' title and no guessed deadline until the server answers", () => {
  const row = {
    id: "gmail:m", kind: "mail.reply", group: "today", source: "gmail", title: "Re: 【作業系統】HW2 公告", meta: ["王助教", "HW2 明天截止"],
    summary: "HW2 明天 23:59 前上傳", actions: [],
  } as unknown as QueueItem;
  assert.equal(mailAssignmentToast(row), "已加入作業「HW2」", "「明天」 in the summary is relative to a day the row does not know");
});
