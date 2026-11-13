/**
 * Pure helpers behind #/work (grouping, phrasing, form parsing), kept out of
 * the components so they can be tested with node:test.
 */
import {
  NATIVE_ASSIGNMENT_ORIGINS, NATIVE_ASSIGNMENT_SITES, UNSORTED_COURSE, isNativeOrigin,
  type AssignmentCreateRequest, type AssignmentOrigin, type AssignmentView, type LmsAccountView,
} from "../../../shared/assignments";
import type { GitHubItem } from "../../../shared/github";
import type { ProfileRole } from "../../../shared/profile";
import { REPO_PATTERN, type ProjectStatus, type ProjectSummary } from "../../../shared/projects";
import { ApiError } from "../../api";
import { dayKey, daysBetween, isDayKey, isLocalTime, localTime, zonedTimeToUtc } from "../../../shared/time";
import type { QueueItem } from "../../../shared/today";
import { deadlineWhen, metaDeadline, monthDay, receivedWhen } from "../../../shared/today-format";
import { format, onboardingCopy, type OnboardingCopy } from "../../copy/onboarding";
import { assignmentFormCopy, ASSIGNMENT_STATUS_LABELS, CHECK_LABELS, GITHUB, NOTIFICATION_REASONS, PROJECTS, REVIEW_PILLS } from "../../copy/work";
import type { PillTone } from "../../components/Pill";

export type SourceFilter = "all" | AssignmentOrigin;

export interface CourseGroup {
  key: string;
  course: string;
  rows: AssignmentView[];
  /** Rows still to hand in (open, overdue). */
  pending: number;
  /** The sites present, for the group hint (「NYCU E3 · 信件」). */
  sites: string[];
}

const DONE = new Set(["submitted", "graded", "local"]);
const isPending = (row: AssignmentView) => !DONE.has(row.status);

/** A native assignment (from a teacher's mail or added by hand): editable on #/work. */
export const isNative = (row: Pick<AssignmentView, "origin">) => isNativeOrigin(row.origin);

/** 「作業系統」, 「 作業系統 」 and 「ＯＳ」/「os」 fold together; 「未分類」 is its own key. */
export function courseGroupKey(course: string): string {
  return course.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 作業 by course, every origin merged by course name (SPEC-mail-assignments
 * §5.8: E3's 作業系統 and a teacher's mail about 作業系統 are one group):
 * pending rows first (soonest deadline first), then what is handed in
 * (newest first); courses with the nearest pending deadline first, courses
 * with nothing pending after them, 「未分類」 last.
 */
export function groupByCourse(assignments: AssignmentView[], filter: SourceFilter = "all"): CourseGroup[] {
  const groups = new Map<string, CourseGroup>();
  for (const row of assignments) {
    if (filter !== "all" && row.origin !== filter) continue;
    const key = courseGroupKey(row.courseName);
    const group = groups.get(key) ?? { key, course: row.courseName.trim(), rows: [], pending: 0, sites: [] };
    group.rows.push(row);
    if (isPending(row)) group.pending++;
    const site = row.site?.label;
    if (site && !group.sites.includes(site)) group.sites.push(site);
    groups.set(key, group);
  }
  const due = (row: AssignmentView) => (row.dueAt ? Date.parse(row.dueAt) : Infinity);
  for (const group of groups.values()) {
    group.rows.sort((a, b) => {
      const pendingA = isPending(a) ? 0 : 1;
      const pendingB = isPending(b) ? 0 : 1;
      if (pendingA !== pendingB) return pendingA - pendingB;
      return pendingA === 0 ? due(a) - due(b) : due(b) - due(a);
    });
  }
  const unsorted = (group: CourseGroup) => (group.course === UNSORTED_COURSE ? 1 : 0);
  const firstPending = (group: CourseGroup) => (group.pending ? due(group.rows[0]) : Infinity);
  return [...groups.values()].sort((a, b) => unsorted(a) - unsorted(b) || firstPending(a) - firstPending(b) || a.course.localeCompare(b.course, "zh-Hant"));
}

export function pendingCount(assignments: AssignmentView[] | undefined): number {
  return assignments?.filter(isPending).length ?? 0;
}

export const ASSIGNMENT_PILL_TONES: Record<AssignmentView["status"], PillTone> = {
  open: "neutral",
  overdue: "danger",
  local: "accent",
  submitted: "ok",
  graded: "ok",
};

export function assignmentPill(row: AssignmentView): { label: string; tone: PillTone } {
  return { label: ASSIGNMENT_STATUS_LABELS[row.status], tone: ASSIGNMENT_PILL_TONES[row.status] };
}

/** The right-column phrase: 剩 15 小時 / 還有 2 天 for pending work, the date for the rest. */
export function assignmentWhen(row: AssignmentView, now: Date, timeZone: string): NonNullable<QueueItem["when"]> | undefined {
  if (!row.dueAt) return undefined;
  if (isPending(row)) return deadlineWhen(row.dueAt, now, timeZone);
  return { label: monthDay(timeZone, row.dueAt), tone: "muted", mono: true };
}

export interface AssignmentMetaLabels {
  noDue: string;
  grade: (grade: string) => string;
  missing: string;
  notYetShown: (site: string) => string;
  /** Native rows marked 標為已交 (D7: 已繳交 plus who said so). */
  markedByYou: string;
}

/**
 * 「NYCU E3 · 今晚 23:59 截止」 (+ 成績 / 缺交 / E3 還沒顯示繳交); native rows
 * 「信件 · 週五 23:59 截止 · 上傳到 E3」 (+ 你標為已交).
 */
export function assignmentMeta(row: AssignmentView, now: Date, timeZone: string, labels: AssignmentMetaLabels): string[] {
  const site = row.site ?? { label: row.origin === "moodle" ? "Moodle" : "Canvas", short: row.origin === "moodle" ? "Moodle" : "Canvas" };
  const meta = [site.label, row.dueAt ? metaDeadline(row.dueAt, now, timeZone) : labels.noDue];
  if (isNative(row)) {
    if (row.submitHint) meta.push(row.submitHint);
    if (row.status === "submitted" && row.localSubmittedAt) meta.push(labels.markedByYou);
    return meta;
  }
  if (row.status === "local") meta.push(labels.notYetShown(site.short));
  if (row.grade) meta.push(labels.grade(row.grade));
  else if (row.missing && row.status === "overdue") meta.push(labels.missing);
  return meta;
}

export interface SourceOption {
  value: AssignmentOrigin;
  label: string;
  count: number;
  error: boolean;
  errorTitle?: string;
}

/**
 * Source chips E3 · Canvas · 信件 · 手動 (SPEC-mail-assignments §5.8): an LMS
 * when it is connected or has rows, 信件 and 手動 when they have rows.
 */
export function sourceOptions(accounts: LmsAccountView[], assignments: AssignmentView[]): SourceOption[] {
  const pendingOf = (origin: AssignmentOrigin) => assignments.filter((row) => row.origin === origin && isPending(row)).length;
  const lms = accounts
    .filter((account) => account.connected || assignments.some((row) => row.origin === account.source))
    .map((account): SourceOption => {
      const error = account.status.state === "needs_reconnect" || account.status.state === "error";
      return {
        value: account.source,
        label: account.short,
        count: pendingOf(account.source),
        error,
        ...(error ? { errorTitle: account.status.lastError ?? `${account.short} 需要重新連線` } : {}),
      };
    });
  const native = NATIVE_ASSIGNMENT_ORIGINS
    .filter((origin) => assignments.some((row) => row.origin === origin))
    .map((origin): SourceOption => ({ value: origin, label: NATIVE_ASSIGNMENT_SITES[origin].short, count: pendingOf(origin), error: false }));
  return [...lms, ...native];
}

/* ------------------------------------------------- 新增作業 / 編輯作業 form */

export interface AssignmentFormState {
  title: string;
  courseName: string;
  /** <input type=date>: "YYYY-MM-DD" or "". */
  date: string;
  /** <input type=time>: "HH:MM" or "". */
  time: string;
  submitHint: string;
  url: string;
  notes: string;
}

export type AssignmentFormErrors = Partial<Record<"title" | "time" | "url", string>>;

export function moduleHiddenRoles(cause: unknown): ProfileRole[] | undefined {
  return cause instanceof ApiError && cause.status === 409 && cause.code === "module_hidden" ? cause.roles : undefined;
}

export function moduleHiddenMessage(cause: unknown, module: keyof OnboardingCopy["moduleHidden"]["modules"], manuallyDisabled: boolean): string | undefined {
  const roles = moduleHiddenRoles(cause);
  if (!roles) return undefined;
  const copy = onboardingCopy();
  const hidden = copy.moduleHidden;
  const label = hidden.modules[module];
  if (manuallyDisabled) return format(hidden.manuallyDisabled, { label });
  const names = roles.map((role) => copy.roles[role].name);
  if (names.length === 1) return format(hidden.roleUntickedSingle, { label, role: names[0] });
  const roleList = names.map((role) => format(hidden.roleQuote, { role })).join(hidden.roleOr);
  return format(hidden.roleUnticked, { label, roles: roleList });
}

/** The form for a row (編輯) or an empty one (新增); the deadline in the user's zone, 23:59 date-only shown as no time. */
export function assignmentForm(row: AssignmentView | undefined, timeZone: string): AssignmentFormState {
  const due = row?.dueAt;
  return {
    title: row?.title ?? "",
    courseName: row && row.courseName !== UNSORTED_COURSE ? row.courseName : "",
    date: due ? dayKey(timeZone, due) : "",
    time: due && !row?.dueDateOnly ? localTime(timeZone, due) : "",
    submitHint: row?.submitHint ?? "",
    url: row?.url ?? "",
    notes: row?.notes ?? "",
  };
}

/** What is wrong with the form, in the copy deck's words (§7.4); empty when it can be saved. */
export function validateAssignmentForm(form: AssignmentFormState): AssignmentFormErrors {
  const copy = assignmentFormCopy();
  const errors: AssignmentFormErrors = {};
  if (!form.title.trim()) errors.title = copy.titleRequired;
  if (form.time && !form.date) errors.time = copy.timeNeedsDate;
  const url = form.url.trim();
  if (url) {
    let https = false;
    try { https = new URL(url).protocol === "https:"; } catch { https = false; }
    if (!https) errors.url = copy.urlHttps;
  }
  return errors;
}

/**
 * The request body: the deadline as an instant in the user's zone (a date
 * alone is 23:59 that day, `dueDateOnly`), blank optional fields left out on
 * create and cleared (null) on edit.
 */
export function assignmentBody(form: AssignmentFormState, timeZone: string, editing: boolean): AssignmentCreateRequest & Record<string, unknown> {
  const date = isDayKey(form.date) ? form.date : undefined;
  const time = date && isLocalTime(form.time) ? form.time : undefined;
  const [hour, minute] = time ? time.split(":").map(Number) : [23, 59];
  const dueAt = date ? zonedTimeToUtc(timeZone, date, hour, minute).toISOString() : null;
  const optional = (value: string) => {
    const text = value.trim();
    return text ? text : editing ? null : undefined;
  };
  const body: Record<string, unknown> = { title: form.title.trim(), dueAt, dueDateOnly: !!date && !time };
  for (const key of ["courseName", "submitHint", "url", "notes"] as const) {
    const value = optional(form[key]);
    if (value !== undefined) body[key] = value;
  }
  return body as AssignmentCreateRequest & Record<string, unknown>;
}

/* ---------------------------------------------------------------- Projects */

export type ProjectFilter = "all" | Exclude<ProjectStatus, "archived">;

export function filterProjects(projects: ProjectSummary[], filter: ProjectFilter): ProjectSummary[] {
  return filter === "all" ? projects : projects.filter((project) => project.status === filter);
}

/** 「10/19」 from a DayKey. */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${month}/${date}`;
}

/** 「下一步：10/19 題目提案」 / 「還沒有里程碑」. */
export function projectNext(project: ProjectSummary): string {
  if (project.next) return PROJECTS.next(project.next.dueDay ? `${shortDay(project.next.dueDay)} ${project.next.title}` : project.next.title);
  return project.milestones.total ? PROJECTS.nextAllDone : PROJECTS.nextNone;
}

/** Active projects' next dated milestones, soonest first. */
export function upcomingMilestones(projects: ProjectSummary[], limit = 5): Array<{ project: ProjectSummary; title: string; dueDay: string }> {
  return projects
    .filter((project) => project.status === "active" && project.next?.dueDay)
    .map((project) => ({ project, title: project.next!.title, dueDay: project.next!.dueDay! }))
    .sort((a, b) => a.dueDay.localeCompare(b.dueDay))
    .slice(0, limit);
}

/** The repos textarea: one per line (commas and spaces also split); returns the first invalid line. */
export function parseRepos(text: string): { repos: string[]; invalid?: string } {
  const parts = text.split(/[\s,，、]+/).map((part) => part.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "")).filter(Boolean);
  const invalid = parts.find((part) => !REPO_PATTERN.test(part));
  const seen = new Set<string>();
  const repos = parts.filter((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return invalid ? { repos, invalid } : { repos };
}

/* ------------------------------------------------------------------ GitHub */

export function reviewPill(item: GitHubItem): { label: string; tone: PillTone } {
  if (item.isDraft) return { label: REVIEW_PILLS.DRAFT, tone: "neutral" };
  switch (item.reviewDecision) {
    case "APPROVED": return { label: REVIEW_PILLS.APPROVED, tone: "ok" };
    case "CHANGES_REQUESTED": return { label: REVIEW_PILLS.CHANGES_REQUESTED, tone: "danger" };
    default: return { label: REVIEW_PILLS.REVIEW_REQUIRED, tone: "neutral" };
  }
}

/** 「vitejs/vite · 檢查通過 · 等待審查 3 天」 / 「… · yuchen 要求修改」. */
export function pullMeta(item: GitHubItem, now: Date, timeZone: string): string[] {
  const meta = [item.repo];
  if (item.checks) meta.push(CHECK_LABELS[item.checks]);
  if (item.reviewDecision === "CHANGES_REQUESTED") meta.push(GITHUB.changesBy(item.changesRequestedBy ?? "審查者"));
  else if (!item.isDraft && item.reviewDecision !== "APPROVED") {
    const days = daysBetween(dayKey(timeZone, item.createdAt ?? item.updatedAt), dayKey(timeZone, now));
    meta.push(days > 0 ? GITHUB.waiting(days) : GITHUB.waitingToday);
  }
  return meta;
}

export function notificationReason(reason: string | undefined): string {
  return (reason && NOTIFICATION_REASONS[reason]) || "通知";
}

/** 「#127 新增議程頁深色模式」 */
export function numbered(item: Pick<GitHubItem, "number" | "title">): string {
  return item.number !== undefined ? `#${item.number} ${item.title}` : item.title;
}

export { receivedWhen };

/** 「08:40」 today, 「昨天 22:10」, else 「10/9 22:10」, for 上次同步. */
export function syncTime(iso: string | null | undefined, now: Date, timeZone: string): string | undefined {
  if (!iso) return undefined;
  const days = daysBetween(dayKey(timeZone, iso), dayKey(timeZone, now));
  const time = localTime(timeZone, iso);
  if (days <= 0) return time;
  if (days === 1) return `昨天 ${time}`;
  return `${monthDay(timeZone, iso)} ${time}`;
}

/**
 * Where focus goes when a row is deleted from its 編輯作業 dialog (the
 * dialog's opener, the row's title, is gone with it): the next row, else the
 * previous one, else nothing (the page's 新增作業 then). SPEC-mail-assignments §9.
 */
export function focusAfterDelete(order: readonly string[], removed: string): string | undefined {
  const index = order.indexOf(removed);
  if (index < 0) return undefined;
  return order[index + 1] ?? order[index - 1];
}
