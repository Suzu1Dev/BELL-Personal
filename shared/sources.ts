/**
 * External sources. Each id owns one SourceSync on the server, one row in
 * sync_state and its rows in source_items (sources.sqlite). A source that
 * aggregates several subscriptions (feeds, ics) still has one id.
 */
export const SOURCE_IDS = [
  "gmail",
  "google-calendar",
  "ics",
  "moodle",
  "canvas",
  "github",
  "ctftime",
  "feeds",
  "weather",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_LABELS: Record<SourceId, string> = {
  gmail: "Gmail",
  "google-calendar": "Google 行事曆",
  ics: "iCal 訂閱",
  moodle: "Moodle",
  canvas: "Canvas",
  github: "GitHub",
  ctftime: "CTFtime",
  feeds: "活動訂閱",
  weather: "天氣",
};

/**
 * not_configured: no credentials or settings yet (never an error).
 * needs_reconnect: credentials were rejected (e.g. Google invalid_grant); only the user can fix it.
 */
export const SOURCE_STATES = [
  "not_configured",
  "idle",
  "syncing",
  "ok",
  "error",
  "needs_reconnect",
  "disabled",
] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export const SOURCE_STATE_LABELS: Record<SourceState, string> = {
  not_configured: "尚未設定",
  idle: "等待同步",
  syncing: "同步中",
  ok: "已連線",
  error: "同步失敗",
  needs_reconnect: "需要重新連線",
  disabled: "已停用",
};

/** What /api/status and each widget show about a source. Never carries credentials. */
export interface SourceStatus {
  id: SourceId;
  label: string;
  configured: boolean;
  state: SourceState;
  /** ISO instant of the last successful sync. */
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  /** Redacted, user-facing zh-TW text; null after a success. */
  lastError: string | null;
  /** Items stored by the last successful sync, when the source reports it. */
  items: number | null;
  /** True when the last success is older than the source's staleness window. */
  stale: boolean;
}

/** The kinds of rows a source writes to the generic item cache. */
export const SOURCE_ITEM_KINDS = [
  "mail",
  "calendar-event",
  "assignment",
  "github-item",
  "contribution-day",
  "external-event",
  "weather",
] as const;
export type SourceItemKind = (typeof SOURCE_ITEM_KINDS)[number];

/** A pointer from a local record (todo, suggestion, manual event) back to the source item it came from. */
export interface SourceRef {
  source: SourceId;
  externalId: string;
  /** Link to open the original (Gmail thread, Moodle page, GitHub PR…). */
  url?: string;
}
