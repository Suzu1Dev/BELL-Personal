import { LMS_ORIGINS, NATIVE_ASSIGNMENT_SITES, NATIVE_ASSIGNMENT_SOURCE, isNativeOrigin, type Assignment, type AssignmentSite, type AssignmentStatus, type AssignmentView, type LmsOrigin } from "../../../shared/assignments.js";
import type { QueueSource } from "../../../shared/today.js";
import { CONNECT_LIMITS } from "../../../shared/connect.js";
import { AppError } from "../../errors.js";
import { stripHiddenElements } from "../../html.js";
import type { ModuleContext } from "../../modules.js";
import type { ItemStateRow } from "../../today/item-state.js";

/**
 * Pieces both LMS sources share: the vault records, site labels, text
 * clean-up, the fingerprint the Today queue uses and the #/work status.
 */

/** Vault names (docs/ARCHITECTURE.md §7). */
export const LMS_VAULT = { moodle: "moodle.token", canvas: "canvas.token" } as const;

/** `moodle.token`: only the token and what identifies the account; the password is never kept. */
export interface MoodleCredential {
  token: string;
  baseUrl: string;
  userId?: number;
  username?: string;
  fullName?: string;
  siteName?: string;
  connectedAt: string;
}

/** `canvas.token`: the personal access token and the account it belongs to. */
export interface CanvasCredential {
  token: string;
  baseUrl: string;
  userId?: number;
  name?: string;
  connectedAt: string;
}

/** Background cadence (SPEC: every 30 min) and how old data must be before POST /api/sync refetches. */
export const LMS_INTERVAL_MS = 30 * 60_000;
export const LMS_STALE_AFTER_MS = 10 * 60_000;
/** Assignments due this long ago still show (overdue) and are fetched. */
export const LMS_PAST_WINDOW_MS = 14 * 86_400_000;
/** …and this far ahead. */
export const LMS_FUTURE_WINDOW_MS = 90 * 86_400_000;

const DAY = 86_400_000;

/**
 * The site URL a user typed, normalised to `https://host[/path]` without a
 * trailing slash. Only HTTPS, no credentials, query or fragment.
 */
export function normalizeBaseUrl(input: string): string {
  const text = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new AppError(400, "網址格式不正確，請貼上學校系統的首頁網址。"); }
  if (url.protocol !== "https:") throw new AppError(400, "網址必須使用 HTTPS。");
  if (url.username || url.password) throw new AppError(400, "網址不可包含帳號密碼。");
  if (url.search || url.hash) throw new AppError(400, "請只貼上網站首頁的網址，不要包含 ? 或 # 之後的部分。");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(login\/index\.php|my\/?)$/i, "");
  const normalised = `${url.origin}${path}`;
  if (normalised.length > CONNECT_LIMITS.url) throw new AppError(400, "網址太長。");
  return normalised;
}

const E3_HOST = /(^|\.)e3p?\.nycu\.edu\.tw$/i;
const COOL_HOST = /(^|\.)cool\.ntu\.edu\.tw$/i;

/** 「NYCU E3」/「E3」 for NYCU's Moodle, the site name otherwise; Canvas keeps 「Canvas」 on buttons. */
export function siteFor(origin: LmsOrigin, baseUrl?: string, siteName?: string): AssignmentSite {
  let host = "";
  try { host = baseUrl ? new URL(baseUrl).hostname : ""; } catch { host = ""; }
  const name = siteName?.replace(/\s+/g, " ").trim().slice(0, 40);
  if (origin === "moodle") {
    if (E3_HOST.test(host)) return { label: "NYCU E3", short: "E3" };
    return { label: name || host || "Moodle", short: "Moodle" };
  }
  if (COOL_HOST.test(host)) return { label: "NTU COOL", short: "Canvas" };
  return { label: name || host || "Canvas", short: "Canvas" };
}

/** The site of a row: native ones are 「信件」 / 「手動」; older LMS rows have no `site`, so derive it from the link. */
export function assignmentSite(assignment: Pick<Assignment, "origin" | "site" | "url">): AssignmentSite {
  if (isNativeOrigin(assignment.origin)) return NATIVE_ASSIGNMENT_SITES[assignment.origin];
  if (assignment.site) return assignment.site;
  let base: string | undefined;
  try { base = assignment.url ? new URL(assignment.url).origin : undefined; } catch { base = undefined; }
  return siteFor(assignment.origin, base);
}

/** Drops leading term tags (【113上】, [1131]) and squeezes spaces from a course name. */
export function cleanCourseName(name: string | undefined): string {
  const text = (name ?? "").replace(/^\s*(?:【[^】]{0,20}】|\[[^\]]{0,20}\])\s*/u, "").replace(/\s+/g, " ").trim();
  return (text || "未命名課程").slice(0, 80);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };

/** LMS HTML is cut to this many characters before parsing (descriptions keep 500). */
const MAX_HTML_CHARS = 65_536;

/**
 * Plain text from LMS HTML (descriptions, grades): tags removed, entities
 * decoded, truncated. Linear in the input: it is cut first, script and style
 * go in one scan, and tag patterns stop at the next `<`.
 */
export function htmlToText(html: string | null | undefined, max = 500): string {
  if (!html) return "";
  const text = stripHiddenElements(html.slice(0, MAX_HTML_CHARS), ["script", "style"])
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^<>]+>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/&(#\d+|#39|[a-z]+);/gi, (match, entity: string) => {
      const known = ENTITIES[entity.toLowerCase()];
      if (known !== undefined) return known;
      if (entity.startsWith("#")) {
        const code = Number(entity.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return match;
    })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n\s*/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 「HW3」 from 「HW3：CPU Scheduling 模擬」, for 「適合寫 HW3」 and 「HW3 截止」. */
export function shortTitle(title: string): string {
  const head = title.split(/[：:｜|]| - /u)[0].trim() || title.trim();
  return head.length > 16 ? `${head.slice(0, 15)}…` : head;
}

/** Changes when the due date or the LMS submission state changes (Today's until-change rule). */
export function assignmentFingerprint(assignment: Pick<Assignment, "dueAt" | "submission">): string {
  return `${assignment.dueAt ?? "none"}|${assignment.submission}`;
}

/** The Today item id: `moodle:<cmid>`, `canvas:<type>-<id>`, or `assignment:<uuid>` for native rows (their `id`). */
export function itemIdOf(assignment: Pick<Assignment, "origin" | "externalId">): string {
  return `${queueSourceOf(assignment)}:${assignment.externalId}`;
}

/** The queue source a row's actions are routed by: the LMS, or `assignment` (lms) for native rows. */
export function queueSourceOf(assignment: Pick<Assignment, "origin">): QueueSource {
  return isNativeOrigin(assignment.origin) ? NATIVE_ASSIGNMENT_SOURCE : assignment.origin;
}

/** Every cached assignment from both LMS sources. */
export function cachedAssignments(ctx: Pick<ModuleContext, "sourceItems">): Assignment[] {
  return LMS_ORIGINS.flatMap((source) => ctx.sourceItems.list<Assignment>({ source, kind: "assignment" }).map((item) => item.value));
}

/** Unix seconds (0 = none) → ISO, or null. */
export function isoFromUnix(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/** Whether the user pressed 標為已交 and the LMS has not changed since (the core's until-change state). */
export function locallySubmitted(state: ItemStateRow | undefined, assignment: Pick<Assignment, "dueAt" | "submission">): boolean {
  return !!state && state.state === "dismissed" && state.action === "submitted"
    && (state.fingerprint === null || state.fingerprint === assignmentFingerprint(assignment));
}

/**
 * The #/work status pill for an assignment. 標為已交 on a native one (mail,
 * manual) is final: nothing will ever agree or disagree, so it reads 已繳交
 * (SPEC-mail-assignments D7), not 已交（本機）.
 */
export function assignmentStatus(assignment: Assignment, state: ItemStateRow | undefined, now: Date): AssignmentStatus {
  if (assignment.submission === "graded") return "graded";
  if (assignment.submission === "submitted") return "submitted";
  if (locallySubmitted(state, assignment)) return isNativeOrigin(assignment.origin) ? "submitted" : "local";
  if (assignment.missing || (assignment.dueAt && Date.parse(assignment.dueAt) < now.getTime())) return "overdue";
  return "open";
}

export function assignmentView(assignment: Assignment, state: ItemStateRow | undefined, now: Date): AssignmentView {
  const status = assignmentStatus(assignment, state, now);
  const marked = !!state && locallySubmitted(state, assignment) && (status === "local" || isNativeOrigin(assignment.origin));
  return {
    ...assignment,
    site: assignmentSite(assignment),
    itemId: itemIdOf(assignment),
    status,
    ...(marked ? { localSubmittedAt: state.at } : {}),
  };
}

/** Rows due inside the fetch window (or without a due date). */
export function inWindow(dueAt: string | null, now: Date): boolean {
  if (!dueAt) return true;
  const due = Date.parse(dueAt);
  return due >= now.getTime() - LMS_PAST_WINDOW_MS && due <= now.getTime() + LMS_FUTURE_WINDOW_MS;
}

/** Sort: dated first by due date, then undated, then by course and title. */
export function compareAssignments(a: Assignment, b: Assignment): number {
  const dueA = a.dueAt ? Date.parse(a.dueAt) : Infinity;
  const dueB = b.dueAt ? Date.parse(b.dueAt) : Infinity;
  if (dueA !== dueB) return dueA - dueB;
  return a.courseName.localeCompare(b.courseName, "zh-Hant") || a.title.localeCompare(b.title, "zh-Hant");
}

export { DAY as DAY_MS };
