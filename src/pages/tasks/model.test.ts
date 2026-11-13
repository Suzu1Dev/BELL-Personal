import assert from "node:assert/strict";
import test from "node:test";
import type { Todo } from "../../../shared/todos";
import { dayKey, weekdayOf } from "../../../shared/time";
import { todoWhen } from "../../../shared/todo-format";
import {
  editorFields, editorPatch, endOfWeek, focusFromHash, groupFromHash, groupTodos, keepUnsettled, mergeTodos, resyncEditor, sameEditorFields, schedulePresets,
  scheduleWhen, taskGroup, taskMeta,
  type ClosingTodo, type ReopenedTodo, type ScheduledTodo,
} from "./model";

const TZ = "Asia/Taipei";
const NOW = new Date("2026-10-12T08:42:00+08:00"); // Monday
const TODAY = "2026-10-12";
let seq = 0;
const todo = (title: string, extra: Partial<Todo> = {}): Todo => ({
  id: `t${++seq}`, title, status: "open", priority: "normal", origin: "manual",
  createdAt: `2026-10-01T00:00:0${seq % 10}.000Z`, updatedAt: "2026-10-01T00:00:00.000Z", ...extra,
});

test("groups: 逾期 · 今天 · 明天 · 本週 · 之後 · 沒有期限", () => {
  assert.equal(endOfWeek("2026-10-12"), "2026-10-18");
  assert.equal(endOfWeek("2026-10-18"), "2026-10-18");
  assert.equal(taskGroup({ dueDay: "2026-10-10" }, TODAY, NOW, TZ), "overdue");
  assert.equal(taskGroup({ dueDay: "2026-10-12", dueTime: "08:00" }, TODAY, NOW, TZ), "overdue");
  assert.equal(taskGroup({ dueDay: "2026-10-12", dueTime: "14:00" }, TODAY, NOW, TZ), "today");
  assert.equal(taskGroup({ dueDay: "2026-10-12" }, TODAY, NOW, TZ), "today");
  assert.equal(taskGroup({ dueDay: "2026-10-13" }, TODAY, NOW, TZ), "tomorrow");
  assert.equal(taskGroup({ dueDay: "2026-10-18" }, TODAY, NOW, TZ), "week");
  assert.equal(taskGroup({ dueDay: "2026-10-19" }, TODAY, NOW, TZ), "later");
  assert.equal(taskGroup({}, TODAY, NOW, TZ), "someday");
  // On Saturday, Sunday is 明天 and 本週 is empty.
  assert.equal(taskGroup({ dueDay: "2026-10-18" }, "2026-10-17", new Date("2026-10-17T09:00:00+08:00"), TZ), "tomorrow");
});

test("groupTodos keeps SPEC order, sorts by due then creation, and skips done todos", () => {
  const list = [
    todo("someday"), todo("later", { dueDay: "2026-10-30" }), todo("today late", { dueDay: TODAY }), todo("today 14", { dueDay: TODAY, dueTime: "14:00" }),
    todo("done", { dueDay: TODAY, status: "done" }), todo("overdue", { dueDay: "2026-10-01" }),
  ];
  const groups = groupTodos(list, TODAY, NOW, TZ);
  assert.deepEqual(groups.map((group) => group.key), ["overdue", "today", "later", "someday"]);
  assert.deepEqual(groups[1].items.map((item) => item.title), ["today 14", "today late"]);
  assert.equal(groups[1].label, "今天");
});

test("taskMeta: 來源 · 期限 · context · estimate", () => {
  assert.deepEqual(taskMeta(todo("x", { origin: "mail", dueDay: "2026-10-16" }), TODAY, NOW, TZ), ["信件", "週五截止"]);
  assert.deepEqual(taskMeta(todo("x", { dueDay: TODAY, dueTime: "14:00", notes: "讀書會 14:00 前\n第二行", estimateMinutes: 40 }), TODAY, NOW, TZ), ["手動", "今天 14:00 截止", "讀書會 14:00 前", "預估 40 分鐘"]);
  assert.deepEqual(taskMeta(todo("x", { origin: "quick-capture", projectId: "os" }), TODAY, NOW, TZ, (id) => (id === "os" ? "OS 期末專題" : undefined)), ["快速記下", "OS 期末專題"]);
});

test("focusFromHash reads ?focus=", () => {
  assert.equal(focusFromHash("#/tasks?focus=abc"), "abc");
  assert.equal(focusFromHash("#/tasks"), undefined);
  assert.equal(focusFromHash("#/ideas?focus=a%20b"), "a b");
});

test("groupFromHash reads ?group= and only accepts a real group", () => {
  assert.equal(groupFromHash("#/tasks?group=someday"), "someday");
  assert.equal(groupFromHash("#/tasks?group=someday#keys"), "someday");
  assert.equal(groupFromHash("#/tasks?group=nope"), undefined, "only a real group counts");
  assert.equal(groupFromHash("#/tasks?focus=abc"), undefined);
  assert.equal(groupFromHash("#/tasks"), undefined);
});

test("schedule presets are local days counted from the server's today", () => {
  const days = (today: string) => schedulePresets(today).map((preset) => `${preset.label} ${preset.day}`);
  // Monday: the weekend is this Saturday, 下週一 is a week away.
  assert.equal(weekdayOf("2026-10-12"), 1);
  assert.deepEqual(days("2026-10-12"), ["今天 2026-10-12", "明天 2026-10-13", "這週末 2026-10-17", "下週一 2026-10-19"]);
  // Friday: 這週末 is tomorrow.
  assert.deepEqual(days("2026-10-16"), ["今天 2026-10-16", "明天 2026-10-17", "這週末 2026-10-17", "下週一 2026-10-19"]);
  // Saturday: this weekend is already here, so the Saturday offered is the next one (and says 下週末); Monday is in two days.
  assert.equal(weekdayOf("2026-10-17"), 6);
  assert.deepEqual(days("2026-10-17"), ["今天 2026-10-17", "明天 2026-10-18", "下週末 2026-10-24", "下週一 2026-10-19"]);
  // Sunday: next Saturday in six days; 下週一 is tomorrow.
  assert.equal(weekdayOf("2026-10-18"), 0);
  assert.deepEqual(days("2026-10-18"), ["今天 2026-10-18", "明天 2026-10-19", "下週末 2026-10-24", "下週一 2026-10-19"]);
  // Month and year boundaries (Thursday 12/31).
  assert.deepEqual(days("2026-12-31"), ["今天 2026-12-31", "明天 2027-01-01", "這週末 2027-01-02", "下週一 2027-01-04"]);
  // The day the toast names: 今天 · 明天 · 10/24（六）.
  assert.equal(scheduleWhen("2026-10-12", TODAY, TZ), "今天");
  assert.equal(scheduleWhen("2026-10-13", TODAY, TZ), "明天");
  assert.equal(scheduleWhen("2026-10-17", TODAY, TZ), "10/17（六）");
  assert.deepEqual(schedulePresets("2026-10-12", "en").map((preset) => `${preset.label} ${preset.day}`), ["Today 2026-10-12", "Tomorrow 2026-10-13", "This weekend 2026-10-17", "Next Monday 2026-10-19"]);
  assert.equal(scheduleWhen("2026-10-12", TODAY, TZ, "en"), "today");
  assert.equal(scheduleWhen("2026-10-13", TODAY, TZ, "en"), "tomorrow");
  assert.equal(scheduleWhen("2026-10-17", TODAY, TZ, "en"), "Sat, Oct 17");
});

test("a day picked on a todo moves it at once; taking it back (復原) returns it to 沒有期限, until a later list lands", () => {
  const usb = todo("買 USB-C 轉接頭");
  const list = { day: TODAY, open: [usb], completedToday: [] };
  const none = new Map();
  assert.equal(groupTodos(mergeTodos(list, none, none).open, TODAY, NOW, TZ)[0].key, "someday");

  let scheduled: ReadonlyMap<string, ScheduledTodo> = new Map([[usb.id, { dueDay: "2026-10-13" }]]);
  const dated = mergeTodos(list, none, none, scheduled).open;
  assert.deepEqual(groupTodos(dated, TODAY, NOW, TZ).map((group) => [group.key, group.items.map((item) => item.title)]), [["tomorrow", ["買 USB-C 轉接頭"]]]);

  // A poll that started before the PATCH still lists it undated; the pending day wins, and survives until a later fetch.
  scheduled = new Map([[usb.id, { dueDay: "2026-10-13", settledAt: 4_000 }]]);
  assert.equal(keepUnsettled(scheduled, 3_900).size, 1);
  assert.equal(keepUnsettled(scheduled, 4_100).size, 0);

  // 復原: the day is taken back locally before the server answers.
  const undone: ReadonlyMap<string, ScheduledTodo> = new Map([[usb.id, { dueDay: null }]]);
  const withDay = { ...list, open: [{ ...usb, dueDay: "2026-10-13" }] };
  const back = mergeTodos(withDay, none, none, undone).open[0];
  assert.equal(back.dueDay, undefined);
  assert.equal(groupTodos([back], TODAY, NOW, TZ)[0].key, "someday");
  // Nothing scheduled: the list is returned as the server sent it.
  assert.deepEqual(mergeTodos(withDay, none, none).open[0].dueDay, "2026-10-13");
});

test("a finished todo stays finished until a list fetched after its 完成 was acknowledged lands", () => {
  const slides = todo("準備讀書會簡報");
  const mail = todo("寄信給助教");
  // The 30 s poll started before the server applied 完成 on 「寄信給助教」: it still lists it as open.
  const stale = { day: TODAY, open: [mail], completedToday: [{ ...slides, status: "done" as const }] };
  let closing: ReadonlyMap<string, ClosingTodo> = new Map([[mail.id, { todo: { ...mail, status: "done" }, kind: "done" }]]);
  const none: ReadonlyMap<string, ReopenedTodo> = new Map();
  const pending = mergeTodos(stale, closing, none);
  assert.deepEqual(pending.open.map((item) => item.title), [], "the pending 完成 keeps the row out of the open list");
  assert.deepEqual(pending.done.map((item) => item.title), ["寄信給助教", "準備讀書會簡報"]);

  // Unsettled edits survive any fetch; a settled one only until a fetch that started after the ack.
  assert.equal(keepUnsettled(closing, 5_000), closing);
  closing = new Map([[mail.id, { ...closing.get(mail.id)!, settledAt: 4_000 }]]);
  assert.equal(keepUnsettled(closing, 3_900).size, 1, "a fetch that started before the ack does not drop it");
  assert.equal(keepUnsettled(closing, 4_100).size, 0);

  // The server's list and the local edit agree for a moment: still one row each.
  const fresh = { day: TODAY, open: [], completedToday: [{ ...mail, status: "done" as const }, { ...slides, status: "done" as const }] };
  assert.deepEqual(mergeTodos(fresh, closing, none).done.map((item) => item.title), ["寄信給助教", "準備讀書會簡報"]);
  // Deleted rows leave without joining 今天完成; reopened ones come back once.
  const deleted: ReadonlyMap<string, ClosingTodo> = new Map([[slides.id, { todo: slides, kind: "deleted" }]]);
  assert.deepEqual(mergeTodos({ day: TODAY, open: [slides], completedToday: [] }, deleted, none), { open: [], done: [] });
  const reopened: ReadonlyMap<string, ReopenedTodo> = new Map([[mail.id, {}]]);
  assert.deepEqual(mergeTodos(fresh, new Map(), reopened).open.map((item) => [item.title, item.status]), [["寄信給助教", "open"]]);
  assert.deepEqual(mergeTodos({ day: TODAY, open: [mail], completedToday: [{ ...mail, status: "done" }] }, new Map(), reopened).open.length, 1);
});

test("the open editor takes a tidy that lands under it, and 儲存 sends only what the user changed", () => {
  const rule = todo("Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection", { origin: "quick-capture", dueDay: "2026-10-18" });
  const base = editorFields(rule);
  // The user opened the row at once and switched 重要 on; then 自動整理 landed.
  const touched = { ...base, important: true };
  const tidied = editorFields({ ...rule, title: "Deep Hacking 簡報", notes: "主題：Windows Administrator Protection" });
  const fields = resyncEditor(base, touched, tidied);
  assert.deepEqual(fields, { title: "Deep Hacking 簡報", dueDay: "2026-10-18", dueTime: "", notes: "主題：Windows Administrator Protection", important: true });
  // 儲存: only 重要 goes out, so the tidied title and notes stay.
  assert.deepEqual(editorPatch(tidied, fields), { priority: "high" });
  assert.equal(sameEditorFields(tidied, editorFields({ ...rule, title: "Deep Hacking 簡報", notes: "主題：Windows Administrator Protection" })), true);
  // A field the user typed in keeps their text.
  const typing = resyncEditor(base, { ...base, title: "Deep Hacking 期末簡報" }, tidied);
  assert.equal(typing.title, "Deep Hacking 期末簡報");
  assert.equal(typing.notes, "主題：Windows Administrator Protection");
  assert.deepEqual(editorPatch(tidied, typing), { title: "Deep Hacking 期末簡報" });
});

test("editorPatch: nothing changed sends nothing; cleared fields send null", () => {
  const base = editorFields(todo("交報告", { dueDay: "2026-10-16", dueTime: "09:00", notes: "印兩份" }));
  assert.deepEqual(editorPatch(base, base), {});
  assert.deepEqual(editorPatch(base, { ...base, title: "  交報告 " }), {}, "spaces only are no change");
  assert.deepEqual(editorPatch(base, { ...base, notes: " " }), { notes: null });
  assert.deepEqual(editorPatch(base, { ...base, dueDay: "" }), { dueDay: null });
  assert.deepEqual(editorPatch(base, { ...base, dueTime: "" }), { dueTime: null });
  assert.deepEqual(editorPatch(base, { ...base, dueDay: "2026-10-17", dueTime: "10:00" }), { dueDay: "2026-10-17", dueTime: "10:00" });
});

test("todoWhen formats same-day and tomorrow dueTime from payload today across midnight skew", () => {
  const preMidnight = new Date("2026-10-12T23:59:30+08:00");
  assert.equal(dayKey(TZ, preMidnight), "2026-10-12");
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "02:00" }, "2026-10-13", preMidnight, TZ), { label: "02:00", tone: "warm", mono: true });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "02:00" }, "2026-10-13", preMidnight, TZ, "en"), { label: "02:00", tone: "warm", mono: true });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "09:00" }, "2026-10-13", preMidnight, TZ), { label: "09:00", mono: true });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "09:00" }, "2026-10-13", preMidnight, TZ, "en"), { label: "09:00", mono: true });

  const postMidnight = new Date("2026-10-13T00:05:00+08:00");
  assert.equal(dayKey(TZ, postMidnight), "2026-10-13");
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "09:00" }, "2026-10-12", postMidnight, TZ), { label: "明天 09:00", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "09:00" }, "2026-10-12", postMidnight, TZ, "en"), { label: "Tomorrow 09:00", mono: false });
});
