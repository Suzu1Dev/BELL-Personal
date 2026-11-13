import type { EventRepeatInput } from "./calendar.js";
import type { FeedKind, FeedTarget } from "./events.js";
import type { SourceStatus } from "./sources.js";
import type { WeatherLocation } from "./weather.js";

/**
 * Request and response bodies of the "connect a source" endpoints
 * (docs/ARCHITECTURE.md §10). The owning team implements the route; the
 * settings UI (today-settings team) builds against these types. Every write
 * is JSON (DELETE sends `{}`), every error is `{ error: string }` in zh-TW.
 * Credentials go into the vault and never come back in a response.
 */

export const CONNECT_LIMITS = {
  url: 2000,
  username: 200,
  password: 500,
  token: 500,
  feedLabel: 60,
  feeds: 50,
  geocodeQuery: 80,
  geocodeResults: 8,
} as const;

/** Every disconnect: credentials deleted, the source's cached items cleared, sync state reset. */
export interface DisconnectResponse {
  disconnected: true;
  /** Cached rows removed from source_items. */
  removedItems: number;
}

/* ---------------------------------------------------------------- Google (core, implemented) */

/** `openid email` identify the account; Gmail and Calendar per decisions.md item 1. */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;
export type GoogleScope = (typeof GOOGLE_SCOPES)[number];

/** What the granted scopes allow; partial consent leaves some false. */
export interface GoogleCapabilities {
  gmail: boolean;
  calendarRead: boolean;
  calendarWrite: boolean;
}

/** GET /api/google */
export interface GoogleStatus {
  /** A master key exists, so the token can be stored at all. */
  vaultEnabled: boolean;
  clientConfigured: boolean;
  /** builtin: built-in PKCE OAuth client; env: BELLPERSONAL_GOOGLE_CLIENT_ID/_SECRET; settings: custom client in 連線與設定. */
  clientSource: "builtin" | "env" | "settings" | null;
  /** web: redirect to /oauth/google/callback. desktop: loopback redirect + paste (the fallback). */
  clientKind: "web" | "desktop" | null;
  /** "1234…apps.googleusercontent.com"; the secret is never returned. */
  clientIdHint?: string;
  connected: boolean;
  email?: string;
  grantedScopes: string[];
  /** Requested but not granted (partial consent). */
  missingScopes: string[];
  capabilities: GoogleCapabilities;
  connectedAt?: string;
  /** The exact URI to register on a Web client (shown in the guide with 複製). */
  redirectUri: string;
  /** The loopback URI a Desktop client redirects to (paste flow). */
  loopbackRedirectUri: string;
}

/** PUT /api/google/client → 200 GoogleStatus. 409 when the env provides the client or Google is still connected. */
export interface GoogleClientRequest {
  clientId: string;
  clientSecret: string;
  kind?: "web" | "desktop";
}

/**
 * GET /oauth/google/start[?mode=paste] → 302 to Google (a browser navigation,
 * not fetch). The callback redirects to `/#/settings/sources?google=connected`
 * (plus `&missing=<scope,scope>` after partial consent) or
 * `?google=error&reason=<GoogleErrorReason>`.
 */
export const GOOGLE_ERROR_REASONS = ["vault", "client", "state", "denied", "exchange", "no-refresh-token", "no-scopes"] as const;
export type GoogleErrorReason = (typeof GOOGLE_ERROR_REASONS)[number];

/** POST /api/google/paste: the full redirect URL the desktop-client flow left in the address bar. */
export interface GooglePasteRequest {
  url: string;
}

/** POST /api/google/paste → 200 */
export interface GoogleConnectResponse {
  connected: true;
  email?: string;
  grantedScopes: string[];
  missingScopes: string[];
}

/** DELETE /api/google → 200 (revokes at Google best-effort, deletes the token, clears gmail + google-calendar caches). */
export interface GoogleDisconnectResponse extends DisconnectResponse {
  /** False when Google could not be reached; the token is deleted locally anyway. */
  revoked: boolean;
}

/* ---------------------------------------------------------------- LMS (work team) */

/** POST /api/lms/moodle/connect: the password is exchanged once at login/token.php and never stored. */
export interface MoodleConnectRequest {
  /** https only; default suggestion https://e3p.nycu.edu.tw */
  baseUrl: string;
  username: string;
  password: string;
}

/** POST /api/lms/canvas/connect */
export interface CanvasConnectRequest {
  baseUrl: string;
  /** Personal access token (Canvas › 設定 › 新增存取權杖). */
  token: string;
}

/** 201 from either connect endpoint. DELETE /api/lms/moodle and /api/lms/canvas → DisconnectResponse. */
export interface LmsConnectResponse {
  connected: true;
  source: "moodle" | "canvas";
  /** Shown as 「已連線為 …」. */
  account: { name?: string; username?: string; siteName?: string };
  status: SourceStatus;
}

/* ---------------------------------------------------------------- Feeds (calendar-events team) */

/** POST /api/events/feeds → 201 FeedSummary. */
export interface FeedCreateRequest {
  /** https:// (or webcal://, read as https). A URL with a token or a private path is kept in the vault. */
  url: string;
  label: string;
  /** Detected from the response when omitted. */
  kind?: FeedKind;
  /** iCal only: "calendar" shows the feed on the agenda (a personal calendar), "events" on #/events. Detected from the URL when omitted. */
  target?: FeedTarget;
}

/** GET /api/events/feeds → { feeds: FeedSummary[] }. Secret URLs are never returned. */
export interface FeedSummary {
  id: string;
  label: string;
  kind: FeedKind;
  /** Display form: host + path for public feeds, host only when `secret`. */
  urlHint: string;
  secret: boolean;
  enabled: boolean;
  createdAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** Upcoming events cached from this feed. */
  events: number;
  /** Where its items appear (#/events or the agenda). */
  target?: FeedTarget;
}

export interface FeedListResponse {
  feeds: FeedSummary[];
}

/** DELETE /api/events/feeds/:id → 200 */
export interface FeedDeleteResponse {
  deleted: true;
  removedItems: number;
}

/* ---------------------------------------------------------------- Weather (habits-brief team) */

/** GET /api/weather/geocode?q=新竹 → 200 (Open-Meteo geocoding; save one with PUT /api/settings/app { "weather.location" }). */
export interface GeocodeResponse {
  results: Array<WeatherLocation & { label: string; country?: string; admin?: string }>;
}

/* ---------------------------------------------------------------- Gmail (mail team) */

/** POST /api/gmail/purge {} → 200: deletes every cached message, excerpt and summary (資料與隱私 › 清除快取的信件). */
export interface GmailPurgeResponse {
  removed: number;
}

/* ---------------------------------------------------------------- Brief (habits-brief team) */

/**
 * POST /api/brief/refresh {} → NDJSON job stream (streamJob; JobEvent lines).
 * The final `{type:"done", result}` carries BriefRefreshResult; 429 while one
 * is running; 503 when AI is off or the CLI is not logged in.
 */
export interface BriefRefreshResult {
  day: string;
  source: "ai" | "rule";
}

/* ---------------------------------------------------------------- Capture (tasks team) */

export const CAPTURE_TYPES = ["todo", "event", "idea"] as const;
export type CaptureType = (typeof CAPTURE_TYPES)[number];

/**
 * POST /api/capture → 201 CaptureResponse. `type`, `start`, `due` come from the rule parser or the chosen AI option.
 * Without `type` the server runs the rule parser (shared/capture-parse.ts) on `text` itself.
 */
export interface CaptureRequest {
  text: string;
  type?: CaptureType;
  /** The record's title (todo title, event title, idea text); default: parsed from `text`. */
  title?: string;
  start?: string;
  end?: string;
  due?: string;
  /** A due day without a time, or an all-day event (start/end are then DayKeys). */
  allDay?: boolean;
  location?: string;
  tags?: string[];
  /** A todo's 「預估 N 分鐘」. */
  estimateMinutes?: number;
  /** An event that happens every week on the weekday of `start` (kept in BELL, never added to Google Calendar). */
  repeat?: EventRepeatInput;
}

export interface CaptureResponse {
  type: CaptureType;
  id: string;
  /** The toast line, e.g. 「已加入待辦「交報告」· 明天 09:00」. */
  message: string;
  /** 復原 = send("DELETE") to this path (e.g. /api/todos/<id>), which removes the record just created. */
  undoPath: string;
  /** 自動整理 started in the background for this todo or event (setting ai.captureTidy, AI on, a title worth it). */
  tidy?: CaptureTidyStart;
}

/* 自動整理 / 整理 (SPEC-ux §6.6.1): the model rewrites a saved todo's or event's title and notes, reversibly. */

export const TIDY_TARGETS = ["todo", "event"] as const;
export type TidyTarget = (typeof TIDY_TARGETS)[number];

/**
 * What 整理 may rewrite: text the owner typed. Todos made by hand or by quick
 * capture, and local events from quick capture or 新增行程 — never records
 * derived from mail, LMS, GitHub or feeds (their text is source data).
 */
export const TIDY_TODO_ORIGINS = ["manual", "quick-capture"] as const;
export const TIDY_EVENT_ORIGINS = ["capture"] as const;

/** Why a tidy changed nothing: already tidy · the model was unsure · its answer failed a check · the record changed or went away meanwhile · the event is in Google Calendar. */
export const TIDY_REASONS = ["same", "unsure", "rejected", "edited", "gone", "google"] as const;
export type TidyReason = (typeof TIDY_REASONS)[number];

/** A running tidy: follow GET /api/jobs/:jobId/events; the `done` event's result is a CaptureTidyResult. */
export interface CaptureTidyStart {
  jobId: string;
  kind: TidyTarget;
  /** The todo id or the local event id. */
  id: string;
}

/** POST /api/capture/tidy → 202 CaptureTidyStart (the manual 整理; one job per record). */
export interface CaptureTidyRequest {
  kind: TidyTarget;
  id: string;
}

export interface CaptureTidyResult {
  kind: TidyTarget;
  id: string;
  applied: boolean;
  reason?: TidyReason;
  /** applied: the new title. */
  title?: string;
  /** applied: the toast line 「已整理成「Deep Hacking 簡報」· 10/18（日）」 (the capture toast's when-part). */
  message?: string;
  /** applied: 復原 = POST /api/capture/tidy/undo { token }. */
  undoToken?: string;
}

/**
 * POST /api/capture/tidy/undo { token } (the toast's 復原) or POST
 * /api/capture/tidy/revert { kind, id } (復原整理 on the record, while it has
 * `pretidy`) → the title, notes and place from before the tidy are back.
 */
export interface CaptureTidyUndoResponse {
  restored: true;
  kind: TidyTarget;
  id: string;
  title: string;
}

export const CAPTURE_LIMITS = { text: 500, title: 200, tags: 8, searchQuery: 80, searchResults: 12 } as const;

/** GET /api/status → modules.capture: what the capture UI may offer. */
export interface CaptureStatus {
  /** 使用 AI is on and the selected CLI is signed in: offer 「AI 解析」 and ⌘↵. */
  aiParse: boolean;
  /** Where a captured event goes: Google Calendar (connected with calendar.events and 新行程加到 Google 行事曆 on) or the local calendar. */
  eventTarget: "google" | "local";
}

/** The AI's reading of a capture the rules found vague (POST /api/capture/parse → job; `done.result`). */
export interface CaptureParseOption {
  type: CaptureType;
  title: string;
  start?: string;
  end?: string;
  due?: string;
  allDay: boolean;
  location?: string;
  /** The words the time was read from, for 「從「週三 meeting 前」推得」. */
  basis?: string;
}

export interface CaptureParseResult {
  /** A pending `quick-capture` suggestion; confirm with POST /api/suggestions/:id/accept (→ `result`: CaptureResponse). */
  suggestionId: string;
  option: CaptureParseOption;
}

/** GET /api/capture/search?q= : the palette's 搜尋 section across todos, ideas and projects. */
export interface CaptureSearchResult {
  kind: "todo" | "idea" | "project";
  id: string;
  title: string;
  /** In-app link: #/tasks?focus=<id>, #/ideas?focus=<id>, #/work/projects/<id>. */
  href: string;
  /** todo: finished. */
  done?: boolean;
  /** todo: due day and time. */
  dueDay?: string;
  dueTime?: string;
  /** idea: when it was written. */
  at?: string;
  /** project: progress 0–100. */
  pct?: number;
}

export interface CaptureSearchResponse {
  results: CaptureSearchResult[];
}
