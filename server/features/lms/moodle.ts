import type { Assignment, SubmissionState } from "../../../shared/assignments.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import type { SourceItemInput } from "../../stores/source-items.js";
import { ReconnectRequiredError, SourceSync, type HttpRequestInit, type HttpResponse, type SyncContext, type SyncOutcome } from "../../sync.js";
import {
  LMS_FUTURE_WINDOW_MS, LMS_INTERVAL_MS, LMS_PAST_WINDOW_MS, LMS_STALE_AFTER_MS, LMS_VAULT,
  cleanCourseName, htmlToText, isoFromUnix, siteFor, type MoodleCredential,
} from "./lms.js";
import { reconcileLocalSubmissions } from "./reconcile.js";

/**
 * NYCU E3 and any other Moodle site through the mobile web service
 * (decisions.md item 2, brief D4): the password is exchanged once at
 * login/token.php for a token (only the token is stored), then
 * webservice/rest/server.php is called with the token in the POST body,
 * never in a URL.
 */

export type Http = (url: string | URL, init?: HttpRequestInit) => Promise<HttpResponse>;

const FORM = { "content-type": "application/x-www-form-urlencoded" };
/** get_submission_status is one call per assignment: cap it per sync. */
export const MOODLE_STATUS_CALLS = 40;
const STATUS_CONCURRENCY = 4;

/** Moodle errors that mean the stored token is dead (brief R14). */
const DEAD_TOKEN = new Set(["invalidtoken", "invalidlogin"]);
/** core_calendar_get_action_events_by_timesort pages: Moodle refuses limitnum above 50. */
const ACTION_EVENT_PAGE = 50;
const ACTION_EVENT_PAGES = 6;

export interface MoodleSiteInfo {
  sitename?: string;
  username?: string;
  fullname?: string;
  userid?: number;
  siteurl?: string;
}

interface MoodleCourse { id: number; fullname?: string; shortname?: string }

interface MoodleActionEvent {
  id: number;
  name?: string;
  activityname?: string;
  modulename?: string;
  instance?: number;
  eventtype?: string;
  timesort?: number;
  url?: string;
  course?: MoodleCourse;
  action?: { name?: string; url?: string; actionable?: boolean };
}

interface MoodleAssign {
  id: number;
  cmid: number;
  course: number;
  name?: string;
  duedate?: number;
  intro?: string;
  timemodified?: number;
  /** 1 when no submission plugin is enabled: handed in on paper or presented (an offline assignment). */
  nosubmissions?: number;
}

export interface MoodleSubmissionStatus {
  lastattempt?: {
    submission?: { status?: string; timemodified?: number };
    teamsubmission?: { status?: string; timemodified?: number };
    /** "graded" / "notgraded", or the marking-workflow state ("released" means graded and shown). */
    gradingstatus?: string;
    extensionduedate?: number | null;
    /** false for an assignment with nothing to submit online. */
    submissionsenabled?: boolean;
  };
  feedback?: { gradefordisplay?: string; grade?: { grade?: string | null } | null };
}

/**
 * login/token.php: username + password → token. The password exists only in
 * this request's body; errors never echo the site's own message.
 */
export async function moodleToken(http: Http, baseUrl: string, username: string, password: string): Promise<string> {
  const body = new URLSearchParams({ username, password, service: "moodle_mobile_app" }).toString();
  const response = await http(`${baseUrl}/login/token.php`, { method: "POST", headers: FORM, body, timeoutMs: 20_000, maxBytes: 200_000 });
  if (response.status === 404) throw new AppError(400, "找不到 Moodle 的登入服務，請確認網址是學校 Moodle 的首頁。");
  if (!response.ok) throw new AppError(502, `Moodle 回應 HTTP ${response.status}，請稍後再試。`);
  const json = parseJson<{ token?: unknown; errorcode?: unknown }>(response, "Moodle 回傳的資料格式不正確，請確認網址是學校 Moodle 的首頁。");
  if (typeof json.token === "string" && /^[A-Za-z0-9]{8,128}$/.test(json.token)) return json.token;
  switch (json.errorcode) {
    case "invalidlogin":
      throw new AppError(400, "帳號或密碼不正確，請再試一次。");
    case "enablewsdescription":
    case "servicenotavailable":
    case "servicerequireslogin":
      throw new AppError(400, "這個 Moodle 網站沒有開放 App 連線，無法用帳號密碼取得權杖。");
    case "usernotfullysetup":
      throw new AppError(400, "請先登入 Moodle 網站，完成個人資料設定後再連線。");
    case "restoredaccountresetpassword":
    case "forcepasswordchangenotice":
      throw new AppError(400, "Moodle 要求先變更密碼，請到網站完成後再連線。");
    case "passwordisexpired":
      throw new AppError(400, "Moodle 密碼已過期，請先到網站變更密碼後再連線。");
    case "usernotconfirmed":
      throw new AppError(400, "請先完成 Moodle 帳號的電子郵件確認，再回來連線。");
    case "sitemaintenance":
      throw new AppError(503, "Moodle 網站維護中，請稍後再試。");
    default:
      throw new AppError(502, "Moodle 沒有核發權杖，請稍後再試。");
  }
}

/**
 * One web-service call; a dead token becomes ReconnectRequiredError (需要重新連線).
 * An expired token answers `accessexception` once (Moodle deletes it while
 * refusing the call) and `invalidtoken` from then on, so an access exception
 * is retried once: a dead token then says so, a real permission problem stays
 * a 502.
 */
export async function moodleCall<T>(http: Http, credential: Pick<MoodleCredential, "baseUrl" | "token">, wsfunction: string, params: Record<string, string | number | Array<string | number>> = {}, retried = false): Promise<T> {
  const form = new URLSearchParams({ wstoken: credential.token, wsfunction, moodlewsrestformat: "json" });
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((entry, index) => form.append(`${key}[${index}]`, String(entry)));
    else form.append(key, String(value));
  }
  const response = await http(`${credential.baseUrl}/webservice/rest/server.php`, { method: "POST", headers: FORM, body: form.toString(), timeoutMs: 20_000 });
  if (response.status === 401 || response.status === 403) throw new ReconnectRequiredError("Moodle 拒絕了保存的權杖，需要重新連線。");
  if (response.status === 429) throw new AppError(429, "Moodle 暫時限制請求頻率，稍後會自動重試。");
  if (!response.ok) throw new AppError(502, `Moodle 回應 HTTP ${response.status}，稍後會自動重試。`);
  const json = parseJson<T & { exception?: unknown; errorcode?: unknown }>(response, "Moodle 回傳的資料格式不正確，稍後會自動重試。");
  if (json && typeof json === "object" && "exception" in json) {
    if (typeof json.errorcode === "string" && DEAD_TOKEN.has(json.errorcode)) throw new ReconnectRequiredError("Moodle 登入已失效，重新登入後會自動同步作業。");
    if (json.errorcode === "accessexception" && !retried) return moodleCall<T>(http, credential, wsfunction, params, true);
    throw new AppError(502, "Moodle 無法提供作業資料，稍後會自動重試。");
  }
  return json as T;
}

function parseJson<T>(response: HttpResponse, message: string): T {
  try { return JSON.parse(response.text()) as T; }
  catch { throw new AppError(502, message); }
}

/**
 * mod_assign_get_submission_status → the shared submission state. An offline
 * assignment (nothing to submit online) is `unknown` until it is graded:
 * Moodle never reports it submitted, so 未交 would never clear.
 */
export function submissionFrom(status: MoodleSubmissionStatus | undefined, actionable: boolean, offline = false): SubmissionState {
  const attempt = status?.lastattempt;
  if (attempt?.gradingstatus === "graded" || attempt?.gradingstatus === "released") return "graded";
  if (offline || attempt?.submissionsenabled === false) return "unknown";
  if (!status) return actionable ? "not-submitted" : "unknown";
  const value = attempt?.submission?.status ?? attempt?.teamsubmission?.status;
  if (value === "submitted") return "submitted";
  if (value === undefined || value === "new" || value === "draft" || value === "reopened") return "not-submitted";
  return "unknown";
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * One full fetch: courses in progress → their assignments (+ submission status
 * for those in the window, capped) and the action events (what still needs
 * doing, including quizzes). Pure apart from `http`; tests pass a fake.
 */
export async function fetchMoodleAssignments(http: Http, credential: MoodleCredential, now: Date, signal?: AbortSignal): Promise<Assignment[]> {
  const site = siteFor("moodle", credential.baseUrl, credential.siteName);
  const updatedAt = now.toISOString();
  const from = Math.floor((now.getTime() - LMS_PAST_WINDOW_MS) / 1000);
  const to = Math.floor((now.getTime() + LMS_FUTURE_WINDOW_MS) / 1000);

  const enrolled = await moodleCall<{ courses?: MoodleCourse[] }>(http, credential, "core_course_get_enrolled_courses_by_timeline_classification", { classification: "inprogress", limit: 0, offset: 0 });
  const courses = new Map((enrolled.courses ?? []).map((course) => [course.id, course]));
  const events = await actionEvents(http, credential, from, to, signal);
  signal?.throwIfAborted();

  const assigns: MoodleAssign[] = [];
  if (courses.size) {
    const response = await moodleCall<{ courses?: Array<{ id: number; fullname?: string; assignments?: MoodleAssign[] }> }>(http, credential, "mod_assign_get_assignments", { courseids: [...courses.keys()] });
    for (const course of response.courses ?? []) {
      if (!courses.has(course.id)) courses.set(course.id, { id: course.id, fullname: course.fullname });
      for (const assign of course.assignments ?? []) assigns.push(assign);
    }
  }
  const inRange = assigns
    .filter((assign) => typeof assign.duedate === "number" && assign.duedate >= from && assign.duedate <= to)
    .sort((a, b) => (a.duedate ?? 0) - (b.duedate ?? 0));
  const actionable = new Set(events.filter((event) => event.modulename === "assign" && event.instance !== undefined).map((event) => event.instance!));
  const checked = inRange.slice(0, MOODLE_STATUS_CALLS);
  const statuses = new Map<number, MoodleSubmissionStatus>();
  await mapLimit(checked, STATUS_CONCURRENCY, async (assign) => {
    signal?.throwIfAborted();
    statuses.set(assign.id, await moodleCall<MoodleSubmissionStatus>(http, credential, "mod_assign_get_submission_status", { assignid: assign.id }));
  });

  const result = new Map<string, Assignment>();
  for (const assign of inRange) {
    const status = statuses.get(assign.id);
    const submission = submissionFrom(status, actionable.has(assign.id), assign.nosubmissions === 1);
    // An ungraded offline assignment past its deadline has nothing left to show: BELL cannot know it was handed in.
    if (submission === "unknown" && (assign.duedate ?? 0) * 1000 < now.getTime() && (assign.nosubmissions === 1 || status?.lastattempt?.submissionsenabled === false)) continue;
    const extension = isoFromUnix(status?.lastattempt?.extensionduedate ?? null);
    const grade = htmlToText(status?.feedback?.gradefordisplay, 60);
    const description = htmlToText(assign.intro);
    const course = courses.get(assign.course);
    const externalId = String(assign.cmid);
    result.set(externalId, {
      id: `moodle:${externalId}`,
      origin: "moodle",
      externalId,
      courseId: String(assign.course),
      courseName: cleanCourseName(course?.fullname ?? course?.shortname),
      title: (assign.name ?? "未命名作業").trim().slice(0, 200),
      dueAt: extension ?? isoFromUnix(assign.duedate),
      url: `${credential.baseUrl}/mod/assign/view.php?id=${assign.cmid}`,
      submission,
      ...(grade ? { grade } : {}),
      ...(description ? { description } : {}),
      updatedAt: isoFromUnix(assign.timemodified) ?? updatedAt,
      site,
    });
  }

  // Action events cover what mod_assign does not: quizzes and other activities with a deadline,
  // and assignments in courses the timeline does not list.
  const knownAssigns = new Set(inRange.map((assign) => assign.id));
  for (const event of events) {
    if (event.action && event.action.actionable === false) continue;
    if (event.modulename === "assign" && event.instance !== undefined && knownAssigns.has(event.instance)) continue;
    const dueAt = isoFromUnix(event.timesort);
    if (!dueAt) continue;
    const link = event.url ?? event.action?.url;
    const cmid = event.modulename === "assign" ? /[?&]id=(\d+)/.exec(link ?? "")?.[1] : undefined;
    const externalId = cmid ?? `event-${event.id}`;
    if (result.has(externalId)) continue;
    result.set(externalId, {
      id: `moodle:${externalId}`,
      origin: "moodle",
      externalId,
      ...(event.course?.id !== undefined ? { courseId: String(event.course.id) } : {}),
      courseName: cleanCourseName(event.course?.fullname ?? event.course?.shortname),
      title: (event.activityname ?? event.name ?? "未命名活動").trim().slice(0, 200),
      dueAt,
      ...(link ? { url: link.replace(/[?&]action=[a-z]+$/i, "") } : {}),
      submission: "not-submitted",
      updatedAt,
      site,
    });
  }
  return [...result.values()];
}

/** Every action event in the window, following Moodle's aftereventid paging (50 per page, at most ACTION_EVENT_PAGES). */
async function actionEvents(http: Http, credential: Pick<MoodleCredential, "baseUrl" | "token">, from: number, to: number, signal?: AbortSignal): Promise<MoodleActionEvent[]> {
  const events: MoodleActionEvent[] = [];
  let after: number | undefined;
  for (let page = 0; page < ACTION_EVENT_PAGES; page++) {
    signal?.throwIfAborted();
    const response = await moodleCall<{ events?: MoodleActionEvent[]; lastid?: number }>(http, credential, "core_calendar_get_action_events_by_timesort", {
      timesortfrom: from, timesortto: to, limitnum: ACTION_EVENT_PAGE, ...(after ? { aftereventid: after } : {}),
    });
    const batch = response.events ?? [];
    events.push(...batch);
    const last = response.lastid ?? batch.at(-1)?.id;
    if (batch.length < ACTION_EVENT_PAGE || !last || last === after) break;
    after = last;
  }
  return events;
}

export function assignmentRows(assignments: Assignment[]): SourceItemInput<Assignment>[] {
  return assignments.map((value) => ({ kind: "assignment" as const, externalId: value.externalId, value, dueAt: value.dueAt, updatedAt: value.updatedAt }));
}

/** SourceSync `moodle`: every 30 min while `moodle.token` is in the vault. */
export class MoodleSync extends SourceSync {
  constructor(private readonly ctx: ModuleContext, options: { intervalMs?: number } = {}) {
    super({
      id: "moodle",
      state: ctx.syncState,
      intervalMs: options.intervalMs ?? LMS_INTERVAL_MS,
      staleAfterMs: LMS_STALE_AFTER_MS,
      fetch: ctx.fetch,
      now: ctx.now,
    });
  }

  async configured(): Promise<boolean> {
    return this.ctx.vault.enabled && (await this.ctx.vault.has(LMS_VAULT.moodle));
  }

  async credential(): Promise<MoodleCredential | undefined> {
    if (!this.ctx.vault.enabled) return undefined;
    return this.ctx.vault.get<MoodleCredential>(LMS_VAULT.moodle);
  }

  protected async run({ http, now, signal }: SyncContext): Promise<SyncOutcome> {
    const credential = await this.credential();
    if (!credential?.token) throw new ReconnectRequiredError("Moodle 尚未連線。");
    const assignments = await fetchMoodleAssignments(http, credential, now, signal);
    signal.throwIfAborted();
    this.ctx.sourceItems.replace("moodle", "assignment", assignmentRows(assignments));
    reconcileLocalSubmissions(this.ctx, assignments);
    return { items: assignments.length };
  }
}
