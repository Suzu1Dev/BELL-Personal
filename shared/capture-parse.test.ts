import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPTURE_TYPE_ORDER, captureMoment, ideaBody, nextCaptureType, parseCapture, parseNumber, retypeCapture, setCaptureMoment, startsWithTodoVerb, withRepeat,
  type CaptureContext, type CaptureParse,
} from "./capture-parse.js";

const TZ = "Asia/Taipei";
/** SPEC-ux §6.6: Monday 2026-10-12 08:42 in Taipei (the host clock is UTC: 00:42Z). */
const NOW = new Date("2026-10-12T08:42:00+08:00");

interface Golden {
  text: string;
  context?: CaptureContext;
  now?: string;
  type: CaptureParse["type"];
  title: string;
  /** "+08:00" ISO for readability; compared as instants. */
  due?: string | null;
  start?: string | null;
  end?: string | null;
  allDay?: boolean;
  confidence: "high" | "low";
  location?: string;
  tags?: string[];
  duration?: number;
  /** Whether the parse repeats weekly (checked when given). */
  repeat?: boolean;
}

const GOLDEN: Golden[] = [
  // SPEC-ux §6.6 golden examples
  { text: "明天 9:00 交報告", type: "todo", title: "交報告", due: "2026-10-13T09:00+08:00", allDay: false, confidence: "high" },
  { text: "明天下午三點 跟教授 meeting", type: "event", title: "跟教授 meeting", start: "2026-10-13T15:00+08:00", end: "2026-10-13T16:00+08:00", confidence: "high" },
  { text: "週三前 回林教授信", type: "todo", title: "回林教授信", due: "2026-10-14T23:59+08:00", allDay: true, confidence: "high" },
  { text: "10/25 13:30 SITCON 秋季交流會 @中研院", type: "event", title: "SITCON 秋季交流會", start: "2026-10-25T13:30+08:00", end: "2026-10-25T14:30+08:00", location: "中研院", confidence: "high" },
  { text: "用 eBPF 量 CFS 排程延遲，當期末專題", context: "idea", type: "idea", title: "用 eBPF 量 CFS 排程延遲，當期末專題", confidence: "high" },
  { text: "下週找時間跟教授聊提案", type: "todo", title: "跟教授聊提案", due: null, confidence: "low" },
  // The task's phrases
  { text: "下週三 14:00 跟教授 meeting", type: "event", title: "跟教授 meeting", start: "2026-10-21T14:00+08:00", end: "2026-10-21T15:00+08:00", confidence: "high" },
  { text: "週五前 繳電費", type: "todo", title: "繳電費", due: "2026-10-16T23:59+08:00", allDay: true, confidence: "high" },
  { text: "靈感：做一個 CTF 練習平台", type: "idea", title: "做一個 CTF 練習平台", confidence: "high" },
  { text: "10/25 SITCON", type: "todo", title: "SITCON", due: "2026-10-25T23:59+08:00", allDay: true, confidence: "low" },
  { text: "下午三點 開會", type: "event", title: "開會", start: "2026-10-12T15:00+08:00", confidence: "high" },
  { text: "晚上7點半 跑步", type: "todo", title: "跑步", due: "2026-10-12T19:30+08:00", confidence: "low" },
  { text: "今天晚上7點半 跟學長吃飯", type: "event", title: "跟學長吃飯", start: "2026-10-12T19:30+08:00", end: "2026-10-12T20:30+08:00", confidence: "high" },
  // Relative days
  { text: "今天 繳宿舍網路費", type: "todo", title: "繳宿舍網路費", due: "2026-10-12T23:59+08:00", allDay: true, confidence: "high" },
  { text: "後天 10:00 面試", type: "event", title: "面試", start: "2026-10-14T10:00+08:00", confidence: "high" },
  { text: "大後天 交 HW3", type: "todo", title: "交 HW3", due: "2026-10-15T23:59+08:00", allDay: true, confidence: "high" },
  { text: "這週五 繳報名費", type: "todo", title: "繳報名費", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "下週一 交作業", type: "todo", title: "交作業", due: "2026-10-19T23:59+08:00", confidence: "high" },
  { text: "下下週一 交期中報告", type: "todo", title: "交期中報告", due: "2026-10-26T23:59+08:00", confidence: "high" },
  { text: "週日 洗衣服", type: "todo", title: "洗衣服", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "星期六 早上10點 整理房間", type: "todo", title: "整理房間", due: "2026-10-17T10:00+08:00", confidence: "high" },
  { text: "禮拜二 寄履歷", type: "todo", title: "寄履歷", due: "2026-10-13T23:59+08:00", confidence: "high" },
  { text: "月底 繳房租", type: "todo", title: "繳房租", due: "2026-10-31T23:59+08:00", confidence: "high" },
  // Absolute dates
  { text: "10月25日 g0v 大松", type: "todo", title: "g0v 大松", due: "2026-10-25T23:59+08:00", confidence: "low" },
  { text: "2026-11-03 09:10 期中考", type: "todo", title: "期中考", due: "2026-11-03T09:10+08:00", confidence: "low" },
  { text: "1/5 報稅", type: "todo", title: "報稅", due: "2027-01-05T23:59+08:00", confidence: "low" },
  { text: "10/20 前 繳中華電信帳單", type: "todo", title: "繳中華電信帳單", due: "2026-10-20T23:59+08:00", confidence: "high" },
  { text: "１０／２５　１３：３０ 交流會 @中研院", type: "event", title: "交流會", start: "2026-10-25T13:30+08:00", location: "中研院", confidence: "high" },
  // Times
  { text: "十點半 開會", type: "event", title: "開會", start: "2026-10-12T10:30+08:00", confidence: "high" },
  { text: "下午兩點十五分 看診", type: "event", title: "看診", start: "2026-10-12T14:15+08:00", confidence: "high" },
  { text: "中午12點 午餐 跟學長", type: "event", title: "午餐 跟學長", start: "2026-10-12T12:00+08:00", confidence: "high" },
  { text: "3:30pm 跟同學 討論 專題", type: "event", title: "跟同學 討論 專題", start: "2026-10-12T15:30+08:00", confidence: "high" },
  { text: "明天 1430 開會", type: "event", title: "開會", start: "2026-10-13T14:30+08:00", confidence: "high" },
  { text: "明天 3點 開會", type: "event", title: "開會", start: "2026-10-13T15:00+08:00", confidence: "low" },
  { text: "明天 03:00 看流星", type: "todo", title: "看流星", due: "2026-10-13T03:00+08:00", confidence: "low" },
  { text: "明早 9點 晨跑", type: "todo", title: "晨跑", due: "2026-10-13T09:00+08:00", confidence: "low" },
  { text: "明天下午 開會", type: "event", title: "開會", start: "2026-10-13T14:00+08:00", confidence: "low" },
  { text: "晚上12點 交 Lab 2", type: "todo", title: "交 Lab 2", due: "2026-10-13T00:00+08:00", confidence: "high" },
  { text: "HW3 23:59 截止", type: "todo", title: "HW3", due: "2026-10-12T23:59+08:00", confidence: "high" },
  // 24:00 / 24點 is the end of the named day, never its start
  { text: "今天24點前繳費", type: "todo", title: "繳費", due: "2026-10-12T23:59+08:00", confidence: "high" },
  { text: "週五 24:00 前交報告", type: "todo", title: "交報告", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "明天 24:00 前 交報告", type: "todo", title: "交報告", due: "2026-10-13T23:59+08:00", confidence: "high" },
  { text: "明天 22點到24點 夜唱", type: "event", title: "夜唱", start: "2026-10-13T22:00+08:00", end: "2026-10-14T00:00+08:00", confidence: "high" },
  // An evening range that ends after midnight ends in the early morning
  { text: "晚上11點到1點 聚餐", type: "event", title: "聚餐", start: "2026-10-12T23:00+08:00", end: "2026-10-13T01:00+08:00", confidence: "high" },
  { text: "晚上11點-1點 跟朋友吃飯", type: "event", title: "跟朋友吃飯", start: "2026-10-12T23:00+08:00", end: "2026-10-13T01:00+08:00", confidence: "high" },
  { text: "晚上10點到12點 夜唱", type: "event", title: "夜唱", start: "2026-10-12T22:00+08:00", end: "2026-10-13T00:00+08:00", confidence: "high" },
  // 早/晚 inside a word is not a period; after a date or on its own it is
  { text: "提早3點開會", type: "event", title: "提早開會", start: "2026-10-12T15:00+08:00", confidence: "low" },
  { text: "週三晚8點 吃飯", type: "event", title: "吃飯", start: "2026-10-14T20:00+08:00", confidence: "high" },
  { text: "晚8點 跟朋友吃飯", type: "event", title: "跟朋友吃飯", start: "2026-10-12T20:00+08:00", confidence: "high" },
  { text: "明天 9:00 前 交 HW3", type: "todo", title: "交 HW3", due: "2026-10-13T09:00+08:00", confidence: "high" },
  // A time alone: today, or tomorrow once it has passed
  { text: "9:00 交報告", type: "todo", title: "交報告", due: "2026-10-12T09:00+08:00", confidence: "high" },
  { text: "8:00 晨會", type: "event", title: "晨會", start: "2026-10-13T08:00+08:00", confidence: "high" },
  // Ranges and durations
  { text: "14:00-15:30 讀書會", type: "event", title: "讀書會", start: "2026-10-12T14:00+08:00", end: "2026-10-12T15:30+08:00", confidence: "high" },
  { text: "明天 下午2點到4點 討論", type: "event", title: "討論", start: "2026-10-13T14:00+08:00", end: "2026-10-13T16:00+08:00", confidence: "high" },
  { text: "明天 10:00 開會 2小時", type: "event", title: "開會", start: "2026-10-13T10:00+08:00", end: "2026-10-13T12:00+08:00", duration: 120, confidence: "high" },
  { text: "讀 Ch.5 40分鐘", type: "todo", title: "讀 Ch.5", due: null, duration: 40, confidence: "high" },
  { text: "一個半小時 讀書", type: "todo", title: "讀書", duration: 90, confidence: "high" },
  // Signals, tags, contexts
  { text: "想到 用 Rust 重寫爬蟲", type: "idea", title: "用 Rust 重寫爬蟲", confidence: "high" },
  { text: "idea: habit heatmap", type: "idea", title: "habit heatmap", confidence: "high" },
  { text: "#靈感 習慣頁加熱度圖", type: "idea", title: "習慣頁加熱度圖", confidence: "high" },
  { text: "#OS 讀 Ch.5", type: "todo", title: "讀 Ch.5", tags: ["OS"], confidence: "high" },
  { text: "審查 #127 新增議程頁", type: "todo", title: "審查 #127 新增議程頁", tags: [], confidence: "high" },
  { text: "買 USB-C 轉接頭", context: "idea", type: "todo", title: "買 USB-C 轉接頭", due: null, confidence: "high" },
  { text: "USB-C 轉接頭", context: "todo", type: "todo", title: "USB-C 轉接頭", confidence: "high" },
  { text: "USB-C 轉接頭", type: "todo", title: "USB-C 轉接頭", confidence: "low" },
  { text: "明天 準備讀書會簡報 14:00", type: "todo", title: "準備讀書會簡報", due: "2026-10-13T14:00+08:00", confidence: "high" },
  { text: "週末 跟朋友 吃飯", type: "event", title: "跟朋友 吃飯", start: "2026-10-17", end: "2026-10-18", allDay: true, confidence: "low" },
  {
    text: "這是一段很長很長的想法，關於如何把每天的工作流程整理得更好，讓自己不用一直切換工具，也不會漏掉任何事情",
    type: "idea", title: "這是一段很長很長的想法，關於如何把每天的工作流程整理得更好，讓自己不用一直切換工具，也不會漏掉任何事情", confidence: "high",
  },
  // Day boundaries in Asia/Taipei (no DST): 00:10 local is still the previous UTC date
  { text: "今天 交報告", now: "2026-10-12T00:10:00+08:00", type: "todo", title: "交報告", due: "2026-10-12T23:59+08:00", confidence: "high" },
  { text: "明天 9:00 交報告", now: "2026-10-12T23:50:00+08:00", type: "todo", title: "交報告", due: "2026-10-13T09:00+08:00", confidence: "high" },
  { text: "明天 交報告", now: "2026-12-31T22:00:00+08:00", type: "todo", title: "交報告", due: "2027-01-01T23:59+08:00", confidence: "high" },
  { text: "1/3 繳學費", now: "2026-12-30T10:00:00+08:00", type: "todo", title: "繳學費", due: "2027-01-03T23:59+08:00", confidence: "high" },
  { text: "週日 洗衣服", now: "2026-10-18T09:00:00+08:00", type: "todo", title: "洗衣服", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "下週一 交作業", now: "2026-10-18T09:00:00+08:00", type: "todo", title: "交作業", due: "2026-10-19T23:59+08:00", confidence: "high" },
  { text: "9:00 交報告", now: "2026-10-12T10:00:00+08:00", type: "todo", title: "交報告", due: "2026-10-13T09:00+08:00", confidence: "high" },
];

/** Thursday 2026-10-15 10:00 in Taipei: the day the 「周日前」 report came in. */
const THU = "2026-10-15T10:00:00+08:00";

/**
 * Deadline scaffolding (要在 … 前, 最晚, 為止, before/by/due) goes with its date or
 * time, and the title keeps no hole: no leftover connective, no double space,
 * no dangling punctuation or 的; proper nouns and English stay as written.
 */
const SCAFFOLDING: Golden[] = [
  // The user's report: 「要在」 stayed and left a hole.
  {
    text: "Deep Hacking 簡報 要在周日前生出來，主題是 Windows Administrator Protection", now: THU,
    type: "todo", title: "Deep Hacking 簡報 生出來，主題是 Windows Administrator Protection", due: "2026-10-18T23:59+08:00", allDay: true, confidence: "high",
  },
  { text: "要在週五前交報告", now: THU, type: "todo", title: "交報告", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "報告得在下週一前寄出", now: THU, type: "todo", title: "報告寄出", due: "2026-10-19T23:59+08:00", confidence: "high" },
  { text: "必須在 10/20 前繳學費", now: THU, type: "todo", title: "繳學費", due: "2026-10-20T23:59+08:00", confidence: "high" },
  { text: "最晚週三 交期中報告", now: THU, type: "todo", title: "交期中報告", due: "2026-10-21T23:59+08:00", confidence: "high" },
  { text: "週五之前要 填好報名表", now: THU, type: "todo", title: "填好報名表", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "下週二以前 寄履歷", now: THU, type: "todo", title: "寄履歷", due: "2026-10-20T23:59+08:00", confidence: "high" },
  { text: "週日前要把 Deep Hacking 簡報做完", now: THU, type: "todo", title: "把 Deep Hacking 簡報做完", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "報名到週五為止", now: THU, type: "todo", title: "報名", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "交週五的作業", now: THU, type: "todo", title: "交作業", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "報告週五前完成", now: THU, type: "todo", title: "報告完成", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "交報告，週五前，記得帶隨身碟", now: THU, type: "todo", title: "交報告，記得帶隨身碟", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "報告的週五前", now: THU, type: "todo", title: "報告", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "確認旅行目的週五前", now: THU, type: "todo", title: "確認旅行目的", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "在明天下午三點 跟教授 meeting", now: THU, type: "event", title: "跟教授 meeting", start: "2026-10-16T15:00+08:00", confidence: "high" },
  { text: "於 10/25 13:30 參加 SITCON @中研院", now: THU, type: "event", title: "參加 SITCON", start: "2026-10-25T13:30+08:00", location: "中研院", confidence: "high" },
  { text: "開會在週五", now: THU, type: "event", title: "開會", start: "2026-10-16", allDay: true, confidence: "low" },
  { text: "只要在週五前交就好", now: THU, type: "todo", title: "只要交就好", due: "2026-10-16T23:59+08:00", confidence: "high" },
  // 週/周/星期/禮拜 variants
  { text: "周六前 繳電費", now: THU, type: "todo", title: "繳電費", due: "2026-10-17T23:59+08:00", confidence: "high" },
  { text: "這周日 洗車", now: THU, type: "todo", title: "洗車", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "本周五 交 Lab 3", now: THU, type: "todo", title: "交 Lab 3", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "下周三 14:00 跟教授 meeting", now: THU, type: "event", title: "跟教授 meeting", start: "2026-10-21T14:00+08:00", confidence: "high" },
  { text: "禮拜天前 整理房間", now: THU, type: "todo", title: "整理房間", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "星期天 晚上8點 跟家人吃飯", now: THU, type: "event", title: "跟家人吃飯", start: "2026-10-18T20:00+08:00", confidence: "high" },
  { text: "月底前 繳房租", now: THU, type: "todo", title: "繳房租", due: "2026-10-31T23:59+08:00", confidence: "high" },
  // M/D and times with 點 / 點半 / :
  { text: "10/18 前 Deep Hacking 簡報", now: THU, type: "todo", title: "Deep Hacking 簡報", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "10/20 18:00 前上傳 HW2", now: THU, type: "todo", title: "上傳 HW2", due: "2026-10-20T18:00+08:00", confidence: "high" },
  { text: "今晚 9 點前 交作業", now: THU, type: "todo", title: "交作業", due: "2026-10-15T21:00+08:00", confidence: "high" },
  { text: "明早 9 點前 回信給助教", now: THU, type: "todo", title: "回信給助教", due: "2026-10-16T09:00+08:00", confidence: "high" },
  { text: "明天 9點半 開會", now: THU, type: "event", title: "開會", start: "2026-10-16T09:30+08:00", confidence: "high" },
  { text: "下午3點半前 交 lab", now: THU, type: "todo", title: "交 lab", due: "2026-10-15T15:30+08:00", confidence: "high" },
  { text: "明天 15:00 前要回覆 PR", now: THU, type: "todo", title: "回覆 PR", due: "2026-10-16T15:00+08:00", confidence: "high" },
  { text: "下週一 10:00 前 寄 email 給教授", now: THU, type: "todo", title: "寄 email 給教授", due: "2026-10-19T10:00+08:00", confidence: "high" },
  { text: "今晚 跑步", now: THU, type: "todo", title: "跑步", due: "2026-10-15T19:00+08:00", confidence: "low" },
  // English and mixed
  { text: "Finish slides before Friday", now: THU, type: "todo", title: "Finish slides", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "Submit report by Fri 5pm", now: THU, type: "todo", title: "Submit report", due: "2026-10-16T17:00+08:00", confidence: "high" },
  { text: "Call mom tomorrow at 9:00", now: THU, type: "todo", title: "Call mom", due: "2026-10-16T09:00+08:00", confidence: "low" },
  { text: "Team meeting next Wednesday 14:00", now: THU, type: "event", title: "Team meeting", start: "2026-10-21T14:00+08:00", confidence: "high" },
  { text: "OS 作業 due Sunday", now: THU, type: "todo", title: "OS 作業", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "Pay rent tonight", now: THU, type: "todo", title: "Pay rent", due: "2026-10-15T19:00+08:00", confidence: "low" },
  { text: "buy sun cream", now: THU, type: "todo", title: "buy sun cream", due: null, confidence: "low" },
  { text: "整理 CTF writeup before Sunday 前", now: THU, type: "todo", title: "整理 CTF writeup", due: "2026-10-18T23:59+08:00", confidence: "high" },
  // Full-width punctuation or brackets next to the removed date leave no hole either
  { text: "Deep Hacking 簡報，要在周日前生出來，主題是 Windows Administrator Protection", now: THU, type: "todo", title: "Deep Hacking 簡報，生出來，主題是 Windows Administrator Protection", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "Deep Hacking 簡報，要在周日前生出來", now: THU, type: "todo", title: "Deep Hacking 簡報，生出來", due: "2026-10-18T23:59+08:00", confidence: "high" },
  { text: "報告，週五前交", now: THU, type: "todo", title: "報告，交", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "買牛奶、明天交報告", now: THU, type: "todo", title: "買牛奶、交報告", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "報告（週五前）交", now: THU, type: "todo", title: "報告交", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "簡報：週五前生出來", now: THU, type: "todo", title: "簡報：生出來", due: "2026-10-16T23:59+08:00", confidence: "high" },
];

/**
 * Words that only look like a date or a lead-in keep their letters: an
 * all-caps or proper-noun English word is not a weekday (SAT, Sun Moon Lake),
 * and 在/會/得/於 that end another word (還在, 總會, 免得, 關於) stay. After
 * 關於/對於/由於… the date is the topic: it stays in the title and gives the
 * day only at low confidence (another date wins).
 */
const WORDS: Golden[] = [
  { text: "讀 SAT 論文", now: THU, type: "todo", title: "讀 SAT 論文", due: null, confidence: "high" },
  { text: "SAT solver 作業週五前交", now: THU, type: "todo", title: "SAT solver 作業交", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "Sun Moon Lake 一日遊", now: THU, type: "todo", title: "Sun Moon Lake 一日遊", due: null, confidence: "low" },
  { text: "中山大學 Sun Yat-sen 面試 明天 10:00", now: THU, type: "event", title: "中山大學 Sun Yat-sen 面試", start: "2026-10-16T10:00+08:00", confidence: "high" },
  { text: "WED 2026 投稿", now: THU, type: "todo", title: "WED 2026 投稿", due: null, confidence: "low" },
  { text: "Sat 10:00 爬山", now: THU, type: "todo", title: "爬山", due: "2026-10-17T10:00+08:00", confidence: "low" },
  { text: "next WED 交 lab", now: THU, type: "todo", title: "交 lab", due: "2026-10-21T23:59+08:00", confidence: "high" },
  { text: "寫關於週五的報告", now: THU, type: "todo", title: "寫關於週五的報告", due: "2026-10-16T23:59+08:00", confidence: "low" },
  { text: "關於明天的報告", now: THU, type: "todo", title: "關於明天的報告", due: "2026-10-16T23:59+08:00", confidence: "low" },
  { text: "對於週五的考試做準備", now: THU, type: "todo", title: "對於週五的考試做準備", due: "2026-10-16T23:59+08:00", confidence: "low" },
  { text: "由於明天下雨取消", now: THU, type: "todo", title: "由於明天下雨取消", due: "2026-10-16T23:59+08:00", confidence: "low" },
  { text: "至於週五的作業", now: THU, type: "todo", title: "至於週五的作業", due: "2026-10-16T23:59+08:00", confidence: "low" },
  { text: "關於明天的報告 下週一交", now: THU, type: "todo", title: "關於明天的報告 交", due: "2026-10-19T23:59+08:00", confidence: "low" },
  { text: "還在明天", now: THU, type: "todo", title: "還在", due: "2026-10-16T23:59+08:00", confidence: "high" },
  { text: "總會在明天", now: THU, type: "todo", title: "總會", due: "2026-10-16T23:59+08:00", confidence: "low" },
  { text: "免得在明天遲到", now: THU, type: "todo", title: "免得遲到", due: "2026-10-16T23:59+08:00", confidence: "low" },
];

/**
 * 每週X: a weekly event that starts on the next such weekday, today when its time has not passed yet
 * (NOW is Monday 08:42: a Monday 10:10 class starts today, a Monday 08:00 one next week). Only a weekday
 * names a repeat: 「每週報告」, 「每次開會」, 「每週一次」, 「每週一、三」 and 「每天」 are plain words.
 */
const MONDAY_LATE = "2026-10-12T11:00:00+08:00";
const REPEATS: Golden[] = [
  { text: "每週一 10:10 作業系統 @EC115", type: "event", title: "作業系統", start: "2026-10-12T10:10+08:00", end: "2026-10-12T11:10+08:00", location: "EC115", repeat: true, confidence: "high" },
  { text: "每週一 10:10 作業系統 @EC115", now: MONDAY_LATE, type: "event", title: "作業系統", start: "2026-10-19T10:10+08:00", end: "2026-10-19T11:10+08:00", location: "EC115", repeat: true, confidence: "high" },
  { text: "每週一 08:00 晨會", type: "event", title: "晨會", start: "2026-10-19T08:00+08:00", repeat: true, confidence: "high" },
  { text: "每週一 10:10 作業系統", now: "2026-10-12T10:10:30+08:00", type: "event", title: "作業系統", start: "2026-10-12T10:10+08:00", repeat: true, confidence: "high" },
  { text: "每週三 14:00-16:00 計算機網路", type: "event", title: "計算機網路", start: "2026-10-14T14:00+08:00", end: "2026-10-14T16:00+08:00", repeat: true, confidence: "high" },
  { text: "每星期五 下午三點 專題會議", type: "event", title: "專題會議", start: "2026-10-16T15:00+08:00", repeat: true, confidence: "high" },
  { text: "每個禮拜二 晚上7點 社團", type: "event", title: "社團", start: "2026-10-13T19:00+08:00", repeat: true, confidence: "high" },
  { text: "每週日 19:00 家教", type: "event", title: "家教", start: "2026-10-18T19:00+08:00", repeat: true, confidence: "high" },
  { text: "每週三 19:00 讀書會", type: "event", title: "讀書會", start: "2026-10-14T19:00+08:00", repeat: true, confidence: "high" },
  { text: "計算機網路 每週三 14:00", type: "event", title: "計算機網路", start: "2026-10-14T14:00+08:00", repeat: true, confidence: "high" },
  { text: "每週一 10:10 作業系統 2小時", type: "event", title: "作業系統", start: "2026-10-12T10:10+08:00", end: "2026-10-12T12:10+08:00", duration: 120, repeat: true, confidence: "high" },
  { text: "10/20 每週一 10:00 OS", type: "event", title: "OS", start: "2026-10-26T10:00+08:00", repeat: true, confidence: "high" },
  { text: "每週三 社團", type: "event", title: "社團", start: "2026-10-14", end: "2026-10-15", allDay: true, repeat: true, confidence: "low" },
  // A todo does not repeat: 每週五 交週報 is a todo due Friday, the rules are unsure (Tab to 行程 repeats it).
  { text: "每週五 交週報", type: "todo", title: "交週報", due: "2026-10-16T23:59+08:00", repeat: true, confidence: "low" },
  // Not repeats: no weekday, a count, a list of weekdays, every day, or just a weekday
  { text: "每週報告", type: "todo", title: "每週報告", repeat: false, confidence: "low" },
  { text: "每次開會", type: "todo", title: "每次開會", repeat: false, confidence: "low" },
  { text: "每週一次 讀書", type: "todo", title: "每週一次 讀書", due: null, repeat: false, confidence: "low" },
  { text: "每週三次 讀書會", type: "todo", title: "每週三次 讀書會", due: null, repeat: false, confidence: "low" },
  { text: "每週一、三 10:00 上課", type: "event", title: "每週一、三 上課", start: "2026-10-12T10:00+08:00", repeat: false, confidence: "high" },
  { text: "每天 9:00 背單字", type: "todo", title: "每天 背單字", repeat: false, confidence: "low" },
  { text: "週三 14:00 計算機網路", type: "todo", title: "計算機網路", due: "2026-10-14T14:00+08:00", repeat: false, confidence: "low" },
];

const instant = (value: string) => (value.length === 10 ? value : new Date(value).toISOString());

for (const golden of [...GOLDEN, ...SCAFFOLDING, ...WORDS, ...REPEATS]) {
  test(`capture golden: ${golden.text}${golden.context ? ` (${golden.context})` : ""}${golden.now ? ` @ ${golden.now}` : ""}`, () => {
    const parse = parseCapture(golden.text, { now: golden.now ? new Date(golden.now) : NOW, timeZone: TZ, context: golden.context });
    assert.equal(parse.type, golden.type);
    assert.equal(parse.title, golden.title);
    assert.equal(parse.confidence, golden.confidence);
    if (golden.due === null) assert.equal(parse.due, undefined);
    else if (golden.due) assert.equal(parse.due, instant(golden.due));
    if (golden.start) assert.equal(parse.start, instant(golden.start));
    if (golden.end) assert.equal(parse.end, instant(golden.end));
    if (golden.allDay !== undefined) assert.equal(parse.allDay, golden.allDay);
    if (golden.location !== undefined) assert.equal(parse.location, golden.location);
    if (golden.tags !== undefined) assert.deepEqual(parse.tags, golden.tags);
    if (golden.duration !== undefined) assert.equal(parse.durationMinutes, golden.duration);
    if (golden.repeat !== undefined) assert.deepEqual(parse.repeat, golden.repeat ? { freq: "weekly" } : undefined);
    if (golden.type === "event" && !golden.end && parse.start && !parse.allDay) assert.equal(Date.parse(parse.end!) - Date.parse(parse.start), (golden.duration ?? 60) * 60_000);
    if (golden.type === "idea") { assert.equal(parse.due, undefined); assert.equal(parse.start, undefined); }
  });
}

test("the golden table covers at least 40 phrases, and 25 more for deadline scaffolding", () => {
  assert.ok(GOLDEN.length >= 40, `${GOLDEN.length} cases`);
  assert.ok(SCAFFOLDING.length >= 25, `${SCAFFOLDING.length} scaffolding cases`);
});

test("a title never keeps a hole: no double space, no leftover connective, no dangling punctuation or 的", () => {
  for (const golden of [...GOLDEN, ...SCAFFOLDING, ...WORDS, ...REPEATS]) {
    const { title } = parseCapture(golden.text, { now: golden.now ? new Date(golden.now) : NOW, timeZone: TZ, context: golden.context });
    assert.doesNotMatch(title, /\s{2}/, golden.text);
    assert.doesNotMatch(title, /^[，,、；;的\s]|[，,、；;\s]$/, golden.text);
    assert.doesNotMatch(title, /(?:要在|得在|必須在|最晚|為止|之前|以前)/, golden.text);
    assert.doesNotMatch(title, /[，,]\s*[，,]/, golden.text);
    assert.doesNotMatch(title, /[，。、；：！？（「『]\s/, `${golden.text}: a space after full-width punctuation`);
    assert.doesNotMatch(title, /（\s*）|「\s*」|\(\s*\)/, `${golden.text}: empty brackets`);
    assert.doesNotMatch(title, /\p{Script=Han}:/u, `${golden.text}: 「：」 stays full-width`);
    // Every Latin word that was typed (other than a date or lead-in) is still there, as written.
    const latin = (golden.text.replace(/[#＃@＠]\S+/g, " ").match(/[A-Za-z][A-Za-z-]+/g) ?? []).filter((word) => !/^(?:next|this|before|by|on|at|until|due|tomorrow|tonight|today|pm|am|Friday|Fri|Sunday|Wednesday|Wed|Sat|idea)$/i.test(word));
    if (golden.type !== "idea") for (const word of latin) assert.ok(title.includes(word), `${golden.text}: keeps ${word}`);
  }
});

test("the scaffolding is a marker span, so the palette highlights it with the date", () => {
  const text = "Deep Hacking 簡報 要在周日前生出來";
  const parse = parseCapture(text, { now: new Date(THU), timeZone: TZ });
  assert.deepEqual(parse.spans.map((span) => [span.kind, text.slice(span.start, span.end)]), [["marker", "要在"], ["date", "周日"], ["marker", "前"]]);
  assert.equal(parse.signals.deadline, true);
});

test("spans point at the recognised tokens in the original text", () => {
  const text = "明天 9:00 交報告 #OS @圖書館";
  const parse = parseCapture(text, { now: NOW, timeZone: TZ });
  const pieces = parse.spans.map((span) => [span.kind, text.slice(span.start, span.end)]);
  assert.deepEqual(pieces, [["date", "明天"], ["time", "9:00"], ["tag", "#OS"], ["location", "@圖書館"]]);
  // Full-width input keeps its offsets.
  const wide = "１０／２５　１３：３０ 交流會";
  const marks = parseCapture(wide, { now: NOW, timeZone: TZ }).spans.map((span) => wide.slice(span.start, span.end));
  assert.deepEqual(marks, ["１０／２５", "１３：３０"]);
});

test("a 前 after the date is part of the deadline token", () => {
  const text = "週三前 回林教授信";
  const parse = parseCapture(text, { now: NOW, timeZone: TZ });
  assert.equal(parse.signals.deadline, true);
  assert.deepEqual(parse.spans.map((span) => text.slice(span.start, span.end)), ["週三", "前"]);
});

test("a vague 下週 or an hour without 上午/下午 asks for AI (low confidence)", () => {
  assert.equal(parseCapture("下週 交報告", { now: NOW, timeZone: TZ }).vague, true);
  assert.equal(parseCapture("下週 交報告", { now: NOW, timeZone: TZ }).due, undefined);
  const ambiguous = parseCapture("明天 3點 交報告", { now: NOW, timeZone: TZ });
  assert.equal(ambiguous.time, "15:00");
  assert.equal(ambiguous.confidence, "low");
  assert.equal(parseCapture("明天 凌晨3點 交報告", { now: NOW, timeZone: TZ }).time, "03:00");
});

test("days are computed in the given zone, also across a DST change elsewhere", () => {
  // America/New_York falls back on 2026-11-01: 09:00 local that day is 14:00Z.
  const parse = parseCapture("明天 9:00 交報告", { now: new Date("2026-10-31T12:00:00-04:00"), timeZone: "America/New_York" });
  assert.equal(parse.due, "2026-11-01T14:00:00.000Z");
  // Taipei has no DST: 23:59 is always 15:59Z.
  assert.equal(parseCapture("11/1 交報告", { now: NOW, timeZone: TZ }).due, "2026-11-01T15:59:00.000Z");
});

test("retype: Tab cycles 待辦 → 行程 → 靈感 and keeps the day and time", () => {
  assert.deepEqual(CAPTURE_TYPE_ORDER, ["todo", "event", "idea"]);
  assert.equal(nextCaptureType("todo"), "event");
  assert.equal(nextCaptureType("event"), "idea");
  assert.equal(nextCaptureType("idea"), "todo");
  const text = "明天 9:00 交報告";
  const todo = parseCapture(text, { now: NOW, timeZone: TZ });
  const event = retypeCapture(todo, "event", { now: NOW, timeZone: TZ, text });
  assert.equal(event.type, "event");
  assert.equal(event.title, "交報告");
  assert.equal(event.start, "2026-10-13T01:00:00.000Z");
  assert.equal(event.end, "2026-10-13T02:00:00.000Z");
  assert.equal(event.due, undefined);
  const idea = retypeCapture(event, "idea", { now: NOW, timeZone: TZ, text });
  assert.equal(idea.type, "idea");
  assert.equal(idea.title, "明天 9:00 交報告");
  assert.equal(idea.start, undefined);
  const back = retypeCapture(idea, "todo", { now: NOW, timeZone: TZ, text });
  assert.equal(back.title, "交報告");
  assert.equal(back.due, "2026-10-13T01:00:00.000Z");
});

test("retype: an event without a day starts at the next whole hour; an all-day todo becomes an all-day event", () => {
  const text = "買 USB-C 轉接頭";
  const event = retypeCapture(parseCapture(text, { now: NOW, timeZone: TZ }), "event", { now: NOW, timeZone: TZ, text });
  assert.equal(event.start, "2026-10-12T01:00:00.000Z"); // 09:00 Taipei
  const dated = "週五前 繳電費";
  const allDay = retypeCapture(parseCapture(dated, { now: NOW, timeZone: TZ }), "event", { now: NOW, timeZone: TZ, text: dated });
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.start, "2026-10-16");
  assert.equal(allDay.end, "2026-10-17");
  assert.deepEqual(captureMoment(allDay, TZ), { day: "2026-10-16" });
});

test("captureMoment gives the local day and times for the chips", () => {
  const parse = parseCapture("10/25 13:30 SITCON 秋季交流會 @中研院", { now: NOW, timeZone: TZ });
  assert.deepEqual(captureMoment(parse, TZ), { day: "2026-10-25", time: "13:30", endTime: "14:30" });
  assert.equal(captureMoment(parseCapture("買牛奶", { now: NOW, timeZone: TZ }), TZ), undefined);
});

test("helpers: numbers, verbs and idea bodies", () => {
  assert.equal(parseNumber("三"), 3);
  assert.equal(parseNumber("十"), 10);
  assert.equal(parseNumber("十五"), 15);
  assert.equal(parseNumber("二十三"), 23);
  assert.equal(parseNumber("兩"), 2);
  assert.ok(Number.isNaN(parseNumber("百")));
  assert.equal(startsWithTodoVerb("記得繳電費"), true);
  assert.equal(startsWithTodoVerb("跟教授 meeting"), false);
  assert.equal(ideaBody("靈感：CTF 平台 #CTF #idea"), "CTF 平台");
  assert.equal(ideaBody("審查 #127"), "審查 #127");
  assert.equal(ideaBody("靈感：CTF 平台：用 docker ＃CTF 跑題目"), "CTF 平台：用 docker 跑題目", "punctuation stays as typed");
});

test("setCaptureMoment moves a capture to another day or time and keeps an event's length", () => {
  const event = parseCapture("14:00-15:30 讀書會", { now: NOW, timeZone: TZ });
  const moved = setCaptureMoment(event, "2026-10-14", "10:00", TZ);
  assert.equal(moved.start, "2026-10-14T02:00:00.000Z");
  assert.equal(moved.end, "2026-10-14T03:30:00.000Z");
  const todo = parseCapture("明天 9:00 交報告", { now: NOW, timeZone: TZ });
  const dayOnly = setCaptureMoment(todo, "2026-10-16", null, TZ);
  assert.equal(dayOnly.allDay, true);
  assert.equal(dayOnly.due, "2026-10-16T15:59:00.000Z");
  const keepTime = setCaptureMoment(todo, "2026-10-15", undefined, TZ);
  assert.equal(keepTime.due, "2026-10-15T01:00:00.000Z");
  assert.equal(keepTime.confidence, "high");
});

test("an empty or blank text is a low-confidence todo with the text as title", () => {
  const parse = parseCapture("   ", { now: NOW, timeZone: TZ });
  assert.equal(parse.type, "todo");
  assert.equal(parse.confidence, "low");
  assert.equal(parse.title, "");
});

test("a weekly event keeps its repeat through Tab and chip edits, and 直到 never ends before the first day", () => {
  const text = "每週五 交週報";
  const todo = parseCapture(text, { now: NOW, timeZone: TZ });
  const event = retypeCapture(todo, "event", { now: NOW, timeZone: TZ, text });
  assert.deepEqual([event.type, event.repeat, event.allDay, event.start], ["event", { freq: "weekly" }, true, "2026-10-16"], "Tab from the todo to 行程 repeats every Friday");

  const class_ = parseCapture("每週一 10:10 作業系統", { now: NOW, timeZone: TZ });
  const until = withRepeat(class_, { freq: "weekly", until: "2026-12-21" });
  assert.deepEqual(until.repeat, { freq: "weekly", until: "2026-12-21" });
  assert.equal(withRepeat(until, undefined).repeat, undefined, "不重複");
  assert.deepEqual(withRepeat(class_, { freq: "weekly", until: "2026-10-05" }).repeat, { freq: "weekly" }, "a 直到 before the first day is dropped");
  const plain = parseCapture("週三 14:00 計算機網路 @EC122", { now: NOW, timeZone: TZ });
  const chip = withRepeat(retypeCapture(plain, "event", { now: NOW, timeZone: TZ, text: "週三 14:00 計算機網路 @EC122" }), { freq: "weekly" });
  assert.deepEqual([chip.type, chip.repeat, chip.start], ["event", { freq: "weekly" }, "2026-10-14T06:00:00.000Z"], "the 重複 chip on a plain event");

  // Moving the first day keeps the series, on the new weekday; a 直到 before the new day goes.
  const moved = setCaptureMoment(until, "2026-10-14", undefined, TZ);
  assert.deepEqual([moved.day, moved.repeat], ["2026-10-14", { freq: "weekly", until: "2026-12-21" }]);
  assert.deepEqual(setCaptureMoment(until, "2027-01-05", undefined, TZ).repeat, { freq: "weekly" });
});
