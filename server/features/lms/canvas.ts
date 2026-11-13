import type { Assignment, SubmissionState } from "../../../shared/assignments.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import { ReconnectRequiredError, SourceSync, expectOk, type SyncContext, type SyncOutcome } from "../../sync.js";
import {
  LMS_FUTURE_WINDOW_MS, LMS_INTERVAL_MS, LMS_PAST_WINDOW_MS, LMS_STALE_AFTER_MS, LMS_VAULT,
  cleanCourseName, htmlToText, siteFor, type CanvasCredential,
} from "./lms.js";
import { assignmentRows, type Http } from "./moodle.js";
import { reconcileLocalSubmissions } from "./reconcile.js";

/**
 * Canvas (NTU COOL and others) with a personal access token sent as a Bearer
 * header (brief D9): /api/v1/planner/items for what is due, plus
 * /api/v1/users/self/missing_submissions for what is overdue.
 */

/** Pages followed per list (per_page=100). */
const MAX_PAGES = 5;
const GRADABLE = new Set(["assignment", "quiz", "discussion_topic", "sub_assignment"]);

export interface CanvasUser { id?: number; name?: string; short_name?: string; login_id?: string }

interface PlannerItem {
  plannable_id: number | string;
  plannable_type: string;
  plannable?: { id?: number | string; title?: string; name?: string; due_at?: string | null; todo_date?: string | null; description?: string; assignment_id?: number | string | null };
  plannable_date?: string | null;
  course_id?: number;
  context_name?: string;
  html_url?: string;
  submissions?: false | { submitted?: boolean; excused?: boolean; graded?: boolean; missing?: boolean; redo_request?: boolean };
}

interface MissingSubmission {
  id: number;
  /** A classic quiz's id, and a graded discussion's topic: the planner keys those items by them. */
  quiz_id?: number | null;
  discussion_topic?: { id?: number } | null;
  name?: string;
  due_at?: string | null;
  html_url?: string;
  course_id?: number;
  course?: { name?: string };
  description?: string | null;
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "application/json" };
}

/** The next page from a Link header (`<…>; rel="next"`), only on the same origin. */
export function nextLink(link: string | null, origin: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      return url.origin === origin ? url.toString() : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

/** GET with the token; 401 → ReconnectRequiredError; follows Link rel=next up to MAX_PAGES. */
export async function canvasList<T>(http: Http, credential: Pick<CanvasCredential, "baseUrl" | "token">, path: string): Promise<T[]> {
  const origin = new URL(credential.baseUrl).origin;
  let url: string | undefined = `${credential.baseUrl}${path}`;
  const all: T[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response = await http(url, { headers: headers(credential.token) });
    if (response.status === 401) throw new ReconnectRequiredError("Canvas 拒絕了保存的權杖，需要重新連線。");
    expectOk(response, "Canvas");
    let data: unknown;
    try { data = JSON.parse(response.text()); } catch { throw new AppError(502, "Canvas 回傳的資料格式不正確，稍後會自動重試。"); }
    if (!Array.isArray(data)) throw new AppError(502, "Canvas 回傳的資料格式不正確，稍後會自動重試。");
    all.push(...(data as T[]));
    url = nextLink(response.headers.get("link"), origin);
  }
  return all;
}

/** GET /api/v1/users/self: confirms the token and names the account. */
export async function canvasSelf(http: Http, credential: Pick<CanvasCredential, "baseUrl" | "token">): Promise<CanvasUser> {
  const response = await http(`${credential.baseUrl}/api/v1/users/self`, { headers: headers(credential.token), timeoutMs: 20_000 });
  if (response.status === 401) throw new AppError(400, "Canvas 不接受這個權杖，請確認權杖沒有過期或被刪除。");
  if (response.status === 404) throw new AppError(400, "找不到 Canvas 的 API，請確認網址是學校 Canvas 的首頁。");
  if (!response.ok) throw new AppError(502, `Canvas 回應 HTTP ${response.status}，請稍後再試。`);
  try { return JSON.parse(response.text()) as CanvasUser; }
  catch { throw new AppError(502, "Canvas 回傳的資料格式不正確，請確認網址是學校 Canvas 的首頁。"); }
}

function submissionOf(submissions: PlannerItem["submissions"]): SubmissionState {
  if (!submissions) return "unknown";
  if (submissions.redo_request) return "not-submitted";
  if (submissions.graded) return "graded";
  if (submissions.submitted || submissions.excused) return "submitted";
  return "not-submitted";
}

function absolute(baseUrl: string, link: string | undefined): string | undefined {
  if (!link) return undefined;
  try { return new URL(link, `${new URL(baseUrl).origin}/`).toString(); } catch { return undefined; }
}

/** Planner types whose plannable_id is not the assignment's id (Canvas planner_item.rb): keyed by assignment_id instead. */
const KEYED_BY_ASSIGNMENT = new Set(["quiz", "discussion_topic"]);

/**
 * The row key of a planner item: `assignment-<assignment id>` for classic
 * quizzes and graded discussions (whose plannable_id is the quiz or topic
 * id), so the same work from missing_submissions (keyed by the assignment id)
 * merges into one row; `<type>-<id>` otherwise.
 */
export function plannerKey(item: Pick<PlannerItem, "plannable_type" | "plannable_id" | "plannable">): { key: string; legacy?: string } {
  const legacy = `${item.plannable_type}-${item.plannable_id}`;
  const assignmentId = item.plannable?.assignment_id;
  if (KEYED_BY_ASSIGNMENT.has(item.plannable_type) && assignmentId !== undefined && assignmentId !== null && String(assignmentId) !== "")
    return { key: `assignment-${assignmentId}`, legacy };
  return { key: legacy };
}

/**
 * Planner items and missing submissions → Assignment rows (pure apart from
 * `http`). `onRekey(from, to)` reports rows whose key changed from the old
 * `quiz-<id>` / `discussion_topic-<id>` form, so local marks can follow.
 */
export async function fetchCanvasAssignments(http: Http, credential: CanvasCredential, now: Date, onRekey?: (from: string, to: string) => void): Promise<Assignment[]> {
  const site = siteFor("canvas", credential.baseUrl);
  const updatedAt = now.toISOString();
  const start = new Date(now.getTime() - LMS_PAST_WINDOW_MS).toISOString();
  const end = new Date(now.getTime() + LMS_FUTURE_WINDOW_MS).toISOString();
  const planner = await canvasList<PlannerItem>(http, credential, `/api/v1/planner/items?${new URLSearchParams({ start_date: start, end_date: end, per_page: "100" })}`);
  const missing = await canvasList<MissingSubmission>(http, credential, "/api/v1/users/self/missing_submissions?include[]=course&filter[]=submittable&per_page=100");

  const result = new Map<string, Assignment>();
  for (const item of planner) {
    if (!GRADABLE.has(item.plannable_type) || item.submissions === undefined || item.submissions === false) continue;
    const { key: externalId, legacy } = plannerKey(item);
    if (legacy) onRekey?.(legacy, externalId);
    // plannable_date is the student's effective due date (section and student overrides);
    // plannable.due_at is the assignment's base date.
    const dueAt = item.plannable_date ?? item.plannable?.due_at ?? null;
    const description = htmlToText(item.plannable?.description);
    const link = absolute(credential.baseUrl, item.html_url);
    result.set(externalId, {
      id: `canvas:${externalId}`,
      origin: "canvas",
      externalId,
      ...(item.course_id !== undefined ? { courseId: String(item.course_id) } : {}),
      courseName: cleanCourseName(item.context_name),
      title: (item.plannable?.title ?? item.plannable?.name ?? "未命名作業").trim().slice(0, 200),
      dueAt: dueAt && !Number.isNaN(Date.parse(dueAt)) ? new Date(dueAt).toISOString() : null,
      ...(link ? { url: link } : {}),
      submission: submissionOf(item.submissions),
      ...(description ? { description } : {}),
      updatedAt,
      site,
      ...(item.submissions.missing ? { missing: true } : {}),
    });
  }
  const oldest = now.getTime() - LMS_PAST_WINDOW_MS;
  for (const entry of missing) {
    const externalId = `assignment-${entry.id}`;
    // A planner row for the same quiz or discussion may still carry the plannable key (no assignment_id).
    const aliases = [externalId, entry.quiz_id ? `quiz-${entry.quiz_id}` : "", entry.discussion_topic?.id ? `discussion_topic-${entry.discussion_topic.id}` : ""];
    const alias = aliases.find((key) => key && result.has(key));
    if (alias && alias !== externalId) {
      result.set(alias, { ...result.get(alias)!, missing: true, submission: "not-submitted" });
      continue;
    }
    const known = result.get(externalId);
    if (known) { result.set(externalId, { ...known, missing: true, submission: "not-submitted" }); continue; }
    if (!entry.due_at || Date.parse(entry.due_at) < oldest) continue;
    const link = absolute(credential.baseUrl, entry.html_url);
    result.set(externalId, {
      id: `canvas:${externalId}`,
      origin: "canvas",
      externalId,
      ...(entry.course_id !== undefined ? { courseId: String(entry.course_id) } : {}),
      courseName: cleanCourseName(entry.course?.name),
      title: (entry.name ?? "未命名作業").trim().slice(0, 200),
      dueAt: new Date(entry.due_at).toISOString(),
      ...(link ? { url: link } : {}),
      submission: "not-submitted",
      updatedAt,
      site,
      missing: true,
    });
  }
  return [...result.values()];
}

/** SourceSync `canvas`: every 30 min while `canvas.token` is in the vault. */
export class CanvasSync extends SourceSync {
  constructor(private readonly ctx: ModuleContext, options: { intervalMs?: number } = {}) {
    super({
      id: "canvas",
      state: ctx.syncState,
      intervalMs: options.intervalMs ?? LMS_INTERVAL_MS,
      staleAfterMs: LMS_STALE_AFTER_MS,
      fetch: ctx.fetch,
      now: ctx.now,
    });
  }

  async configured(): Promise<boolean> {
    return this.ctx.vault.enabled && (await this.ctx.vault.has(LMS_VAULT.canvas));
  }

  async credential(): Promise<CanvasCredential | undefined> {
    if (!this.ctx.vault.enabled) return undefined;
    return this.ctx.vault.get<CanvasCredential>(LMS_VAULT.canvas);
  }

  protected async run({ http, now, signal }: SyncContext): Promise<SyncOutcome> {
    const credential = await this.credential();
    if (!credential?.token) throw new ReconnectRequiredError("Canvas 尚未連線。");
    const renamed: Array<[string, string]> = [];
    const assignments = await fetchCanvasAssignments(http, credential, now, (from, to) => renamed.push([from, to]));
    signal.throwIfAborted();
    // 標為已交 and snoozes made on the old quiz-/discussion_topic- rows follow them to the new key.
    for (const [from, to] of renamed) this.ctx.itemState.rename(`canvas:${from}`, `canvas:${to}`);
    this.ctx.sourceItems.replace("canvas", "assignment", assignmentRows(assignments));
    reconcileLocalSubmissions(this.ctx, assignments);
    return { items: assignments.length };
  }
}
