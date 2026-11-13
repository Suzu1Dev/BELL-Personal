/**
 * BELL Suite contract v1 — Personal's own copy of the shared types and the
 * route rules (suite-contract v1, 2026-11-08, rev. d — the routes are unchanged since rev. b; the executable
 * definition lives in bell-suite/contracts/v1/reference.mjs). No cross-repo
 * import: change both together.
 */

export const SUITE_APP_IDS = ["explain", "personal", "pr", "reader", "campaign"] as const;
export type SuiteAppId = (typeof SUITE_APP_IDS)[number];
/** The siblings Personal links to and reads from. */
export const SUITE_SIBLINGS = ["explain", "pr", "reader", "campaign"] as const;
export type SuiteSiblingId = (typeof SUITE_SIBLINGS)[number];

export const SUITE_LIMITS = {
  title: 120,
  detail: 80,
  id: 128,
  href: 512,
  items: 5,
  counts: 8,
  countMax: 100_000,
  links: 5,
  handoffText: 2000,
  handoffTitle: 120,
  back: 512,
  fetchTimeoutMs: 3000,
  fetchMaxBytes: 64 * 1024,
  cacheFreshMs: 60_000,
  activePollMs: 5 * 60_000,
  staleDropMs: 30 * 60_000,
} as const;

export type SuiteLinks = Partial<Record<SuiteAppId, string>>;

const HREF = /^#\/[A-Za-z0-9/_\-.~%:]*(?:\?[A-Za-z0-9_\-.~%=&+]*)?$/;
/** C0, DEL, C1, and the bidi embedding/override/isolate controls. */
export const SUITE_UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export const SUITE_OBJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** A relative hash route inside the sibling's own origin (contract §3 `validHref`). */
export function validSuiteHref(value: unknown, max: number = SUITE_LIMITS.href): value is string {
  if (typeof value !== "string" || value.length > max || !HREF.test(value)) return false;
  if (value.includes("//")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return false;
  }
  return !SUITE_UNSAFE_TEXT.test(decoded) && !decoded.includes("\\") && !decoded.slice(2).startsWith("/");
}

/**
 * Contract §5.1: the routes each app may name, for a feed item `href` and a
 * handoff `back` alike. `{id}` is one raw segment of SUITE_OBJECT_ID, never
 * `.` or `..`, so `%`, `?` and `/` cannot reach it. PR names none in v1.
 */
export const SUITE_ROUTES: Record<SuiteAppId, readonly string[]> = {
  explain: ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/{id}"],
  personal: ["#/today", "#/tasks", "#/tasks/{id}", "#/events", "#/events/{id}", "#/ideas", "#/ideas/{id}", "#/inbox", "#/inbox/{id}"],
  pr: ["#/", "#/home", "#/demo", "#/repos", "#/repos/{id}", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/{id}"],
  reader: ["#/", "#/library", "#/topics", "#/page/{id}"],
  campaign: ["#/", "#/schedule", "#/tasks", "#/partners", "#/forms", "#/files", "#/meetings", "#/inspirations", "#/notes", "#/bot"],
};

/** True when `value` passes validSuiteHref and is exactly one of `app`'s allowed routes. */
export function allowedSuiteRoute(app: SuiteAppId, value: unknown, max: number = SUITE_LIMITS.href): value is string {
  if (!validSuiteHref(value, max)) return false;
  return SUITE_ROUTES[app].some((route) => {
    const at = route.indexOf("{id}");
    if (at < 0) return value === route;
    const id = value.slice(at);
    return value.startsWith(route.slice(0, at)) && SUITE_OBJECT_ID.test(id) && id !== "." && id !== "..";
  });
}

export interface SuiteCapability {
  id: string;
  kind: "accept-handoff" | "today-feed" | "object-route";
  route?: string;
  api?: string;
  accepts?: ["text"];
  maxChars?: number;
}

export interface SuiteManifest {
  schemaVersion: 1;
  appId: SuiteAppId;
  displayName: string;
  summary: string;
  capabilities: SuiteCapability[];
  /** Validated browser origins of linked siblings only; an absent app is 未連結. */
  links: SuiteLinks;
}

export const SUITE_ITEM_STATES = ["due", "new", "waiting", "needs-you"] as const;
export type SuiteItemState = (typeof SUITE_ITEM_STATES)[number];

export interface SuiteObjectRef {
  sourceApp: SuiteAppId;
  type: string;
  id: string;
  title: string;
  /** A hash route inside the sibling's own origin (`#/note/abc`). */
  href: string;
}

export interface SuiteTodayItem extends SuiteObjectRef {
  state: SuiteItemState;
  updatedAt: string;
  dueAt?: string;
  detail?: string;
}

export interface SuiteTodayFeed {
  schemaVersion: 1;
  appId: SuiteAppId;
  generatedAt: string;
  counts: Record<string, number>;
  items: SuiteTodayItem[];
  truncated: boolean;
}

export const SUITE_SOURCE_STATUSES = ["ready", "stale", "unavailable", "unconfigured", "unsupported"] as const;
export type SuiteSourceStatus = (typeof SUITE_SOURCE_STATUSES)[number];

export interface SuiteSource {
  appId: SuiteSiblingId;
  status: SuiteSourceStatus;
  /** ISO UTC of the last successful read (ready, stale, sometimes unavailable). */
  lastSuccessAt?: string;
  /** Only for ready and stale. */
  feed?: SuiteTodayFeed;
}

export interface SuiteSourcesResponse {
  schemaVersion: 1;
  sources: SuiteSource[];
}

export interface SuitePrStatus {
  configured: boolean;
  fetchConfigured: boolean;
  link?: string;
  connected: boolean;
  source: "env" | "vault" | null;
  deviceName?: string;
  connectedAt?: string;
  vaultEnabled: boolean;
}

export interface SuitePrPairRequest {
  code: string;
}

export interface SuitePrTokenRequest {
  token: string;
}
