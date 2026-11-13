import type { SuiteTodayFeed } from "../../shared/suite.js";

// suite-contract v1 fixtures (bell-suite/contracts/v1/fixtures), copied: no cross-repo import.
export const VALID_FEED: SuiteTodayFeed = {
  schemaVersion: 1,
  appId: "explain",
  generatedAt: "2026-11-08T05:30:00.000Z",
  counts: { due: 12, newAvailable: 3, reviewedToday: 5 },
  items: [
    { sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "due", updatedAt: "2026-11-08T05:30:00.000Z", detail: "12 張到期 · 3 張新卡" },
    { sourceApp: "explain", type: "lesson", id: "6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", title: "示範資料 · 傅立葉轉換的直覺", href: "#/note/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", state: "waiting", updatedAt: "2026-11-07T14:02:11.000Z" },
  ],
  truncated: false,
};
export const EMPTY_FEED: SuiteTodayFeed = {
  schemaVersion: 1,
  appId: "explain",
  generatedAt: "2026-11-08T05:30:00.000Z",
  counts: { due: 0, newAvailable: 0, reviewedToday: 0 },
  items: [{ sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "waiting", updatedAt: "2026-11-08T05:30:00.000Z", detail: "今天沒有到期的複習" }],
  truncated: false,
};
