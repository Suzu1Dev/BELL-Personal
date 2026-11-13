import assert from "node:assert/strict";
import test from "node:test";
import { parseCapture, retypeCapture } from "../../../shared/capture-parse";
import { captureRequest, captureToast, chipLabel, inputMarks, optionMeta, searchMeta, shortWhen, whenLabel } from "./describe";

const TZ = "Asia/Taipei";
const NOW = new Date("2026-10-12T08:42:00+08:00");
const parse = (text: string, context?: "idea" | "todo") => parseCapture(text, { now: NOW, timeZone: TZ, context });

test("previews read like the spec: 明天 10/13（二）09:00", () => {
  const todo = parse("明天 9:00 交報告");
  assert.equal(whenLabel(todo, TZ, NOW), "明天 10/13（二）09:00");
  assert.equal(chipLabel(todo, TZ), "10/13（二）09:00");
  assert.equal(optionMeta(todo, TZ, NOW), "待辦 · 明天 10/13（二）09:00 到期");
  const event = retypeCapture(todo, "event", { now: NOW, timeZone: TZ, text: "明天 9:00 交報告" });
  assert.equal(shortWhen(event, TZ, NOW), "明天 09:00–10:00");
  assert.equal(chipLabel(event, TZ), "10/13（二）09:00–10:00");
  assert.equal(optionMeta(parse("10/25 13:30 SITCON 秋季交流會 @中研院"), TZ, NOW), "行程 · 10/25（日）13:30–14:30 · 中研院");
  assert.equal(optionMeta(parse("週五前 繳電費"), TZ, NOW), "待辦 · 10/16（五） 到期");
  assert.equal(optionMeta(parse("買牛奶"), TZ, NOW), "待辦 · 沒有期限");
  assert.equal(optionMeta(parse("靈感：CTF 平台 #CTF"), TZ, NOW), "靈感 · #CTF");
});

test("capture toasts quote the title and the time", () => {
  assert.equal(captureToast(parse("明天 9:00 交報告"), TZ, NOW), "已加入待辦「交報告」· 明天 09:00");
  assert.equal(captureToast(parse("週五前 繳電費"), TZ, NOW), "已加入待辦「繳電費」· 10/16（五）");
  assert.equal(captureToast(parse("買牛奶"), TZ, NOW), "已加入待辦「買牛奶」");
  assert.equal(captureToast(parse("10/25 13:30 SITCON 秋季交流會 @中研院"), TZ, NOW), "已加入行事曆「SITCON 秋季交流會」· 10/25（日）13:30");
  assert.equal(captureToast(parse("下午三點 開會"), TZ, NOW), "已加入行事曆「開會」· 今天 15:00");
  assert.equal(captureToast(parse("用 eBPF 量 CFS", "idea"), TZ, NOW), "已記下靈感");
});

test("captureRequest sends exactly what the preview showed", () => {
  const todo = parse("讀 Ch.5 40分鐘 明天");
  assert.deepEqual(captureRequest("讀 Ch.5 40分鐘 明天", todo), {
    text: "讀 Ch.5 40分鐘 明天", type: "todo", title: "讀 Ch.5", allDay: true, due: "2026-10-13T15:59:00.000Z", estimateMinutes: 40,
  });
  const option = { type: "event" as const, title: "跟林教授討論", start: "2026-10-14T02:00:00.000Z", end: "2026-10-14T03:00:00.000Z", allDay: false, location: "工程三館" };
  assert.deepEqual(captureRequest("週三 meeting", option, "s1"), { text: "週三 meeting", type: "event", title: "跟林教授討論", allDay: false, start: option.start, end: option.end, location: "工程三館", suggestionId: "s1" });
});

test("input marks join the date and time and skip tags", () => {
  const text = "明天 9:00 交報告 #OS";
  assert.deepEqual(inputMarks(parse(text), text).map((mark) => text.slice(mark.start, mark.end)), ["明天 9:00"]);
  const place = "10/25 13:30 SITCON @中研院";
  assert.deepEqual(inputMarks(parse(place), place).map((mark) => place.slice(mark.start, mark.end)), ["10/25 13:30", "@中研院"]);
  const deadline = "週三前 回信";
  assert.deepEqual(inputMarks(parse(deadline), deadline).map((mark) => deadline.slice(mark.start, mark.end)), ["週三前"]);
  // The deadline words removed with the date are marked with it; 找時間 is not a date.
  const report = "Deep Hacking 簡報 要在周日前生出來";
  assert.deepEqual(inputMarks(parse(report), report).map((mark) => report.slice(mark.start, mark.end)), ["要在周日前"]);
  const english = "Finish slides before Friday";
  assert.deepEqual(inputMarks(parse(english), english).map((mark) => english.slice(mark.start, mark.end)), ["before Friday"]);
  const vague = "下週找時間跟教授聊提案";
  assert.deepEqual(inputMarks(parse(vague), vague).map((mark) => vague.slice(mark.start, mark.end)), ["下週"]);
  assert.deepEqual(inputMarks(parse("靈感：明天再想", "idea"), "靈感：明天再想"), []);
});

test("search meta lines", () => {
  assert.equal(searchMeta({ kind: "todo", id: "1", title: "x", href: "", dueDay: "2026-10-13", dueTime: "09:00" }, TZ, NOW), "待辦 · 明天 09:00");
  assert.equal(searchMeta({ kind: "todo", id: "1", title: "x", href: "", dueDay: "2026-10-20" }, TZ, NOW), "待辦 · 10/20（二）");
  assert.equal(searchMeta({ kind: "todo", id: "1", title: "x", href: "", done: true }, TZ, NOW), "已完成的待辦");
  assert.equal(searchMeta({ kind: "idea", id: "2", title: "x", href: "", at: "2026-10-11T15:10:00.000Z" }, TZ, NOW), "靈感 · 昨天");
  assert.equal(searchMeta({ kind: "idea", id: "2", title: "x", href: "", at: "2026-10-09T13:00:00.000Z" }, TZ, NOW), "靈感 · 10/9（五）");
  assert.equal(searchMeta({ kind: "project", id: "3", title: "x", href: "", pct: 20 }, TZ, NOW), "專案 · 20%");
});

test("a weekly 行程 previews as 每週一重複, toasts as a weekly one, and only an event sends its repeat", () => {
  const text = "每週一 10:10 作業系統 @EC115";
  const weekly = parse(text);
  assert.equal(whenLabel(weekly, TZ, NOW), "今天 10/12（一）10:10–11:10 · 每週一重複");
  assert.equal(shortWhen(weekly, TZ, NOW), "今天 10:10–11:10 · 每週一重複");
  assert.equal(optionMeta(weekly, TZ, NOW), "行程 · 今天 10/12（一）10:10–11:10 · 每週一重複 · EC115");
  assert.equal(captureToast(weekly, TZ, NOW), "已加入每週行程「作業系統」· 每週一 10:10");
  assert.equal(captureToast(weekly, TZ, NOW, { localOnly: true }), "已加入每週行程「作業系統」· 每週一 10:10 · 只存在 BELL", "with Google on, say it stays in BELL");
  assert.equal(captureRequest(text, weekly).repeat?.freq, "weekly");
  // 重複 on a day (all-day) reads without a time.
  assert.equal(captureToast(parse("每週三 社團"), TZ, NOW), "已加入每週行程「社團」· 每週三");
  // A todo keeps no repeat in its preview or its request (Tab to 行程 brings it back).
  const todo = parse("每週五 交週報");
  assert.equal(whenLabel(todo, TZ, NOW), "10/16（五）");
  assert.equal("repeat" in captureRequest("每週五 交週報", todo), false);
  assert.equal(captureRequest("每週五 交週報", retypeCapture(todo, "event", { now: NOW, timeZone: TZ, text: "每週五 交週報" })).repeat?.freq, "weekly");
  // A one-off event says nothing about repeating.
  assert.equal(whenLabel(parse("週三 14:00 跟教授 meeting"), TZ, NOW), "後天 10/14（三）14:00–15:00");
});
