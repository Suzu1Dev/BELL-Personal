/**
 * The SPEC-ux §13 mockup day (Monday 2026-10-12, 08:42) as a TodayPayload,
 * for unit tests. Not imported by the app bundle.
 */
import type { TodayPayload } from "../../shared/today";

export function mockupToday(): TodayPayload {
  return {
    date: "2026-10-12",
    now: "2026-10-12T00:42:00.000Z",
    greeting: "早安",
    weather: { city: "新竹", tempC: 24, text: "多雲", rain: { from: "2026-10-12T13:00:00.000Z", pct: 60 } },
    brief: { state: "ready", source: "ai", generatedAt: "2026-10-11T22:30:00.000Z", text: "先回林教授的專題信，再把 OS HW3 收尾，今晚 23:59 截止。" },
    counts: { open: 8, handled: 3, total: 11, handledBy: { reply: 1, done: 1, snooze: 1, calendar: 0 }, inboxUnread: 12, habitsLeft: 2 },
    paceMinutes: 35,
    nextUp: { start: "2026-10-12T02:10:00.000Z", title: "作業系統" },
    queue: [
      {
        group: "now",
        hidden: 0,
        items: [
          {
            id: "gmail:thread-os", kind: "mail.reply", group: "now", source: "gmail", title: "Re: OS 期末專題題目討論",
            meta: ["林志明 教授", "作業系統", "待回覆"], avatar: { initial: "林" }, when: { label: "08:05", tone: "muted", mono: true },
            actions: [
              { id: "reply", label: "回覆", touchLabel: "回覆", key: "Enter" },
              { id: "todo", label: "轉待辦", touchLabel: "轉待辦", key: "T" },
              { id: "snooze", label: "延後", touchLabel: "延後", key: "S" },
              { id: "archive", label: "封存", touchLabel: "封存", key: "E" },
            ],
          },
          {
            id: "moodle:hw3", kind: "assignment", group: "now", source: "moodle", title: "作業系統 HW3：CPU Scheduling 模擬",
            meta: ["NYCU E3", "作業系統", "今晚 23:59 截止", "尚未繳交"], when: { label: "剩 15 小時", tone: "hot", mono: false },
            actions: [{ id: "open", label: "開啟 E3", touchLabel: "已交", key: "Enter" }, { id: "submitted", label: "標為已交", touchLabel: "已交", key: "E" }],
          },
          {
            id: "github:sitcon-127", kind: "review", group: "now", source: "github", title: "審查 #127 新增議程頁深色模式",
            meta: ["sitcon-tw/2027.sitcon.org", "yuchen 請你審查"], when: { label: "昨天", tone: "muted", mono: false },
            actions: [{ id: "open", label: "開始審查", touchLabel: "審查", key: "Enter" }, { id: "reviewed", label: "標為已審查", touchLabel: "已審查", key: "E" }],
          },
        ],
      },
      {
        group: "today",
        hidden: 0,
        items: [
          {
            id: "ai:sitcon", kind: "suggestion.event", group: "today", source: "ai", title: "從信件找到 1 個活動，要加入行事曆嗎？",
            meta: ["SITCON 秋季交流會", "10/25（六）13:30", "中研院人文館"],
            actions: [{ id: "calendar", label: "加入行事曆", touchLabel: "加入", key: "C" }, { id: "dismiss", label: "略過", touchLabel: "略過", key: "E" }],
          },
          {
            id: "gmail:bill", kind: "mail.bill", group: "today", source: "gmail", title: "中華電信 9 月帳單 NT$599",
            meta: ["帳單", "10/20 截止"], when: { label: "還有 8 天", tone: "muted", mono: false },
            actions: [{ id: "todo", label: "轉成待辦", touchLabel: "轉待辦", key: "T" }, { id: "archive", label: "封存", touchLabel: "封存", key: "E" }],
          },
          {
            id: "native:slides", kind: "todo", group: "today", source: "native", title: "準備讀書會簡報：Ch.5 Deadlocks",
            meta: ["待辦", "讀書會 14:00 前", "預估 40 分鐘"], when: { label: "14:00", tone: "warm", mono: true },
            actions: [{ id: "done", label: "完成", touchLabel: "完成", key: "E" }],
          },
        ],
      },
      {
        group: "later",
        hidden: 0,
        items: [
          {
            id: "moodle:lab2", kind: "assignment", group: "later", source: "moodle", title: "計算機網路 Lab 2：Socket Programming",
            meta: ["NYCU E3", "計算機網路", "週三 23:59 截止"], when: { label: "還有 2 天", tone: "muted", mono: false },
            actions: [{ id: "open", label: "開啟 E3", touchLabel: "開啟", key: "Enter" }],
          },
          {
            id: "ctftime:balsn", kind: "event.decide", group: "later", source: "ctftime", title: "Balsn CTF 2026，要參加嗎？", subject: "Balsn CTF 2026",
            meta: ["CTFtime", "10/17（六）08:00 起 48 小時", "線上"], when: { label: "還有 5 天", tone: "muted", mono: false },
            actions: [{ id: "going", label: "要參加", touchLabel: "要參加", key: "C" }, { id: "dismiss", label: "略過", touchLabel: "略過", key: "E" }],
          },
        ],
      },
    ],
    digest: { total: 9, categories: [{ key: "newsletter", label: "電子報", count: 3, action: "read" }, { key: "school", label: "學校公告", count: 2, action: "open" }, { key: "notification", label: "GitHub 通知", count: 4, action: "read" }] },
    agenda: {
      items: [
        { start: "2026-10-12T02:10:00.000Z", end: "2026-10-12T04:00:00.000Z", title: "作業系統", meta: "工程三館 EC115 · 林志明", kind: "event", past: false },
        { start: "2026-10-12T06:00:00.000Z", end: "2026-10-12T07:30:00.000Z", title: "OS 讀書會 · Ch.5", meta: "浩然圖書館 討論室 B", kind: "event", past: false },
      ],
      gap: { start: "2026-10-12T07:30:00.000Z", hours: 4, forItemId: "moodle:hw3", label: "適合寫 HW3" },
    },
    habits: [
      { id: "read", name: "閱讀 20 分鐘", short: "閱讀", cadence: "今天 07:50 完成", doneToday: true, week: ["y", "y", "y", "y", "y", "y", "y"], streak: 12, streakUnit: "天" },
      { id: "workout", name: "運動", short: "運動", cadence: "每週 3 次 · 0/3", doneToday: false, week: ["y", "rest", "y", "rest", "y", "rest", "n"], streak: 4, streakUnit: "週" },
      { id: "journal", name: "寫日記", short: "日記", cadence: "每天 · 睡前", doneToday: false, week: ["y", "y", "y", "y", "y", "y", "n"], streak: 27, streakUnit: "天" },
    ],
    ideas: [{ id: "i1", text: "用 eBPF 量 CFS 排程延遲，當期末專題", at: "2026-10-11T12:00:00.000Z" }, { id: "i2", text: "CTF writeup 改寫成部落格系列", at: "2026-10-09T12:00:00.000Z" }],
    later: {
      events: [{ date: "2026-10-13", label: "明天", title: "09:00 計算機網路", meta: "工程三館 EC122 · Google 行事曆" }],
      projects: [
        { name: "OS 期末專題", pct: 20, next: "10/19 題目提案", color: "task" },
        { name: "ctf-notes", pct: 64, next: "Balsn 前整理 heap 筆記", color: "event" },
        { name: "vitejs/vite #18234", next: "等待審查 3 天", pr: true },
      ],
    },
    sources: [{ id: "gmail", label: "Gmail", state: "ok", lastSyncedAt: "2026-10-12T00:40:00.000Z" }],
  };
}
