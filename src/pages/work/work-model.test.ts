import assert from "node:assert/strict";
import test from "node:test";
import type { AssignmentView, LmsAccountView } from "../../../shared/assignments";
import type { GitHubItem } from "../../../shared/github";
import type { ProjectSummary } from "../../../shared/projects";
import { reasoningEfforts } from "../../../shared/models";
import type { SourceStatus } from "../../../shared/sources";
import { ApiError } from "../../api";
import {
  assignmentBody, assignmentForm, assignmentMeta, assignmentPill, assignmentWhen, groupByCourse, parseRepos, pendingCount, projectNext, pullMeta, reviewPill,
  sourceOptions, syncTime, upcomingMilestones, validateAssignmentForm, focusAfterDelete, moduleHiddenMessage, moduleHiddenRoles } from "./work-model";

const NOW = new Date("2026-10-12T00:42:00Z");
const TZ = "Asia/Taipei";
const E3 = { label: "NYCU E3", short: "E3" };
const LABELS = { noDue: "沒有期限", grade: (grade: string) => `成績 ${grade}`, missing: "缺交", notYetShown: (site: string) => `${site} 還沒顯示繳交`, markedByYou: "你標為已交" };

function row(externalId: string, courseName: string, dueAt: string | null, status: AssignmentView["status"], extra: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: `moodle:${externalId}`, itemId: `moodle:${externalId}`, origin: "moodle", externalId, courseId: courseName, courseName, title: `作業 ${externalId}`, dueAt,
    submission: status === "graded" ? "graded" : status === "submitted" ? "submitted" : "not-submitted", updatedAt: NOW.toISOString(), site: E3, status, ...extra,
  };
}

const status = (state: SourceStatus["state"]): SourceStatus => ({ id: "moodle", label: "Moodle", configured: true, state, lastSyncedAt: null, lastAttemptAt: null, lastError: null, items: null, stale: false });

test("assignments group by course: pending first by deadline, courses by their nearest pending deadline", () => {
  const groups = groupByCourse([
    row("1", "作業系統", "2026-10-20T15:59:00Z", "open"),
    row("2", "作業系統", "2026-10-05T15:59:00Z", "graded"),
    row("3", "計算機網路", "2026-10-12T15:59:00Z", "open"),
    row("4", "作業系統", "2026-10-12T20:00:00Z", "local"),
    row("5", "作業系統", "2026-10-13T15:59:00Z", "overdue"),
    row("6", "演算法", "2026-10-01T15:59:00Z", "submitted"),
  ]);
  assert.deepEqual(groups.map((group) => [group.course, group.pending]), [["計算機網路", 1], ["作業系統", 2], ["演算法", 0]]);
  assert.deepEqual(groups[1].rows.map((item) => item.externalId), ["5", "1", "4", "2"], "pending by deadline, then handed in, newest first");
  assert.equal(pendingCount(groups.flatMap((group) => group.rows)), 3);
  assert.deepEqual(groupByCourse([row("1", "A", null, "open"), { ...row("2", "B", null, "open"), origin: "canvas" }], "canvas").map((group) => group.course), ["B"]);
});

test("assignment pills, deadline phrases and meta", () => {
  assert.deepEqual(assignmentPill(row("1", "A", null, "open")), { label: "未繳交", tone: "neutral" });
  assert.deepEqual(assignmentPill(row("1", "A", null, "local")), { label: "已交（本機）", tone: "accent" });
  assert.deepEqual(assignmentPill(row("1", "A", null, "overdue")), { label: "逾期", tone: "danger" });
  assert.deepEqual(assignmentPill(row("1", "A", null, "graded")), { label: "已繳交", tone: "ok" });
  assert.deepEqual(assignmentWhen(row("1", "A", "2026-10-12T15:59:00Z", "open"), NOW, TZ), { label: "剩 15 小時", tone: "hot", mono: false });
  assert.deepEqual(assignmentWhen(row("1", "A", "2026-10-05T15:59:00Z", "graded"), NOW, TZ), { label: "10/5", tone: "muted", mono: true });
  assert.equal(assignmentWhen(row("1", "A", null, "open"), NOW, TZ), undefined);
  assert.deepEqual(assignmentMeta(row("1", "A", "2026-10-12T15:59:00Z", "local"), NOW, TZ, LABELS), ["NYCU E3", "今晚 23:59 截止", "E3 還沒顯示繳交"]);
  assert.deepEqual(assignmentMeta(row("1", "A", null, "graded", { grade: "95 / 100" }), NOW, TZ, LABELS), ["NYCU E3", "沒有期限", "成績 95 / 100"]);
  assert.deepEqual(assignmentMeta(row("1", "A", "2026-10-08T15:59:00Z", "overdue", { missing: true }), NOW, TZ, LABELS), ["NYCU E3", "10/8 截止", "缺交"]);
});

test("source chips list connected sources or sources with rows, flagging broken ones", () => {
  const accounts: LmsAccountView[] = [
    { source: "moodle", connected: true, short: "E3", siteLabel: "NYCU E3", status: status("needs_reconnect") },
    { source: "canvas", connected: false, short: "Canvas", siteLabel: "Canvas", status: { ...status("not_configured"), id: "canvas" } },
  ];
  const options = sourceOptions(accounts, [row("1", "A", null, "open"), row("2", "A", null, "submitted")]);
  assert.deepEqual(options.map((option) => [option.value, option.label, option.count, option.error]), [["moodle", "E3", 1, true]]);
});

function native(uuid: string, origin: "mail" | "manual", courseName: string, dueAt: string | null, status: AssignmentView["status"], extra: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: `assignment:${uuid}`, itemId: `assignment:${uuid}`, origin, externalId: uuid, courseName, title: `作業 ${uuid}`, dueAt, submission: "not-submitted",
    updatedAt: NOW.toISOString(), site: origin === "mail" ? { label: "信件", short: "信件" } : { label: "手動", short: "手動" }, status, ...extra,
  };
}

test("courses merge across origins by name; 未分類 is last; the hint lists the sites", () => {
  const groups = groupByCourse([
    row("1", "作業系統", "2026-10-20T15:59:00Z", "open"),
    native("a", "mail", " 作業系統 ", "2026-10-16T15:59:00Z", "open"),
    native("b", "manual", "未分類", "2026-10-13T15:59:00Z", "open"),
    native("c", "mail", "計算機網路", "2026-10-18T04:00:00Z", "submitted", { localSubmittedAt: NOW.toISOString() }),
    { ...row("2", "OS", "2026-10-30T15:59:00Z", "open"), origin: "canvas", site: { label: "NTU COOL", short: "Canvas" } },
    native("d", "manual", "ｏｓ", null, "open"),
  ]);
  assert.deepEqual(groups.map((group) => [group.course, group.pending, group.sites.join(" · ")]), [
    ["作業系統", 2, "NYCU E3 · 信件"],
    ["OS", 2, "NTU COOL · 手動"],
    ["計算機網路", 0, "信件"],
    ["未分類", 1, "手動"],
  ], "full-width and case fold together; nothing pending sorts after pending courses; 未分類 last even with the nearest deadline");
  assert.deepEqual(groups[0].rows.map((item) => item.id), ["assignment:a", "moodle:1"]);
  assert.deepEqual(groupByCourse([native("a", "mail", "作業系統", null, "open"), row("1", "作業系統", null, "open")], "mail").map((group) => group.rows.length), [1]);
});

test("native rows: 已繳交 when marked (D7), meta with the hand-in way, chips 信件 · 手動", () => {
  const marked = native("c", "mail", "計算機網路", "2026-10-16T15:59:00Z", "submitted", { localSubmittedAt: NOW.toISOString(), submitHint: "上傳到 E3" });
  assert.deepEqual(assignmentPill(marked), { label: "已繳交", tone: "ok" });
  assert.deepEqual(assignmentMeta(marked, NOW, TZ, LABELS), ["信件", "週五 23:59 截止", "上傳到 E3", "你標為已交"]);
  assert.deepEqual(assignmentMeta(native("d", "manual", "未分類", null, "open"), NOW, TZ, LABELS), ["手動", "沒有期限"]);
  const accounts: LmsAccountView[] = [
    { source: "moodle", connected: true, short: "E3", siteLabel: "NYCU E3", status: status("ok") },
    { source: "canvas", connected: false, short: "Canvas", siteLabel: "Canvas", status: { ...status("not_configured"), id: "canvas" } },
  ];
  const options = sourceOptions(accounts, [row("1", "A", null, "open"), native("a", "mail", "A", null, "open"), native("b", "mail", "A", null, "submitted"), native("c", "manual", "A", null, "overdue")]);
  assert.deepEqual(options.map((option) => [option.value, option.label, option.count]), [["moodle", "E3", 1], ["mail", "信件", 1], ["manual", "手動", 1]]);
});

test("the 新增作業 / 編輯作業 form: Taipei deadlines, a date alone is 23:59, blanks clear on edit", () => {
  assert.deepEqual(assignmentForm(undefined, TZ), { title: "", courseName: "", date: "", time: "", submitHint: "", url: "", notes: "" });
  const dated = native("a", "mail", "作業系統", "2026-10-16T15:59:00.000Z", "open", { dueDateOnly: true, submitHint: "上傳到 E3" });
  assert.deepEqual(assignmentForm(dated, TZ), { title: "作業 a", courseName: "作業系統", date: "2026-10-16", time: "", submitHint: "上傳到 E3", url: "", notes: "" });
  assert.equal(assignmentForm(native("b", "manual", "未分類", "2026-10-21T04:00:00.000Z", "open"), TZ).time, "12:00");
  assert.equal(assignmentForm(native("b", "manual", "未分類", null, "open"), TZ).courseName, "", "未分類 is shown as an empty course");

  const form = { title: " HW5 ", courseName: "", date: "2026-10-16", time: "", submitHint: " ", url: "", notes: "" };
  assert.deepEqual(assignmentBody(form, TZ, false), { title: "HW5", dueAt: "2026-10-16T15:59:00.000Z", dueDateOnly: true });
  assert.deepEqual(assignmentBody({ ...form, time: "12:00", url: "https://e3p.nycu.edu.tw/x" }, TZ, true),
    { title: "HW5", dueAt: "2026-10-16T04:00:00.000Z", dueDateOnly: false, courseName: null, submitHint: null, url: "https://e3p.nycu.edu.tw/x", notes: null });
  assert.deepEqual(assignmentBody({ ...form, date: "" }, TZ, false), { title: "HW5", dueAt: null, dueDateOnly: false });

  assert.deepEqual(validateAssignmentForm(form), {});
  assert.deepEqual(validateAssignmentForm({ ...form, title: "  ", date: "", time: "09:00", url: "http://example.com" }), {
    title: "請輸入作業名稱。", time: "截止時間需要先選日期。", url: "連結必須是 https:// 開頭的網址。",
  });
});

test("project phrasing, upcoming milestones and the repos field", () => {
  const project = (id: string, next?: ProjectSummary["next"], status: ProjectSummary["status"] = "active", total = 2): ProjectSummary => ({
    id, name: id, color: "task", status, pct: 0, manualProgress: false, ...(next ? { next } : {}), milestones: { done: 0, total }, repos: [], openTodos: 0, updatedAt: "",
  });
  assert.equal(projectNext(project("a", { title: "題目提案", dueDay: "2026-10-19" })), "下一步：10/19 題目提案");
  assert.equal(projectNext(project("a", { title: "寫 README" })), "下一步：寫 README");
  assert.equal(projectNext(project("a", undefined, "active", 0)), "還沒有里程碑");
  assert.equal(projectNext(project("a", undefined, "active", 3)), "里程碑都完成了");
  const upcoming = upcomingMilestones([project("b", { title: "B", dueDay: "2026-10-20" }), project("a", { title: "A", dueDay: "2026-10-16" }), project("c", { title: "C" }), project("d", { title: "D", dueDay: "2026-10-01" }, "paused")]);
  assert.deepEqual(upcoming.map((item) => item.title), ["A", "B"]);
  assert.deepEqual(parseRepos("Suzu1Dev/bell-personal\nhttps://github.com/vitejs/vite.git, suzu1dev/BELL-personal"), { repos: ["Suzu1Dev/bell-personal", "vitejs/vite"] });
  assert.equal(parseRepos("bell-personal").invalid, "bell-personal");
  assert.deepEqual(parseRepos("  "), { repos: [] });
});

test("PR meta and review pills", () => {
  const pr: GitHubItem = { id: "pr:1", kind: "pr", repo: "vitejs/vite", title: "fix", url: "https://github.com/vitejs/vite/pull/1", updatedAt: "2026-10-09T07:00:00Z", createdAt: "2026-10-09T07:00:00Z", checks: "SUCCESS", reviewDecision: "REVIEW_REQUIRED" };
  assert.deepEqual(pullMeta(pr, NOW, TZ), ["vitejs/vite", "檢查通過", "等待審查 3 天"]);
  assert.deepEqual(pullMeta({ ...pr, reviewDecision: "CHANGES_REQUESTED", changesRequestedBy: "yuchen", checks: "FAILURE" }, NOW, TZ), ["vitejs/vite", "檢查沒有通過", "yuchen 要求修改"]);
  assert.deepEqual(reviewPill({ ...pr, isDraft: true }), { label: "草稿", tone: "neutral" });
  assert.deepEqual(reviewPill({ ...pr, reviewDecision: "APPROVED" }), { label: "已核准", tone: "ok" });
  assert.equal(syncTime("2026-10-12T00:40:00Z", NOW, TZ), "08:40");
  assert.equal(syncTime("2026-10-11T14:10:00Z", NOW, TZ), "昨天 22:10");
  assert.equal(syncTime(null, NOW, TZ), undefined);
});

test("刪除作業 from its dialog moves focus to the next row, else the previous one, never <body>", () => {
  assert.equal(focusAfterDelete(["a", "b", "c"], "b"), "c");
  assert.equal(focusAfterDelete(["a", "b", "c"], "c"), "b");
  assert.equal(focusAfterDelete(["a"], "a"), undefined, "the list is empty: the page's 新增作業");
  assert.equal(focusAfterDelete(["a"], "x"), undefined);
});

test("only a structured module_hidden 409 supplies roles for the settings recovery link", () => {
  const hidden = new ApiError("hidden", 409, { error: "hidden", code: "module_hidden", module: "lms", feature: "assignments", roles: ["student"] });
  assert.deepEqual(moduleHiddenRoles(hidden), ["student"]);
  assert.equal(moduleHiddenRoles(new ApiError("wrong code", 409, { error: "wrong code", code: "ai_key_invalid" })), undefined);
  assert.equal(moduleHiddenRoles(new ApiError("wrong status", 422, { error: "wrong status", code: "module_hidden", module: "lms", feature: "assignments", roles: ["student"] })), undefined);
  assert.equal(moduleHiddenRoles(new Error("hidden")), undefined);
});

test("?lang=en resolves assignment validation and module_hidden explanations at call time", (t) => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { location: { search: "?lang=en" } };
  t.after(() => { (globalThis as { window?: unknown }).window = previous; });

  const form = { title: " ", courseName: "", date: "", time: "09:00", submitHint: "", url: "http://example.com", notes: "" };
  assert.deepEqual(validateAssignmentForm(form), {
    title: "Enter an assignment title.", time: "Pick a due date before setting a time.", url: "Link must start with https://.",
  });
  const hidden = new ApiError("伺服器中文訊息", 409, { error: "伺服器中文訊息", code: "module_hidden", module: "lms", feature: "assignments", roles: ["student"] });
  assert.equal(moduleHiddenMessage(hidden, "lms", false), "\"School assignments\" isn't turned on. Check \"Student\" in Settings › Roles & Spaces to use it.");
  assert.equal(moduleHiddenMessage(hidden, "lms", true), "\"School assignments\" was turned off in Settings › Roles & Spaces. Turn it back on to use it.");
  const projects = new ApiError("伺服器中文訊息", 409, { error: "伺服器中文訊息", code: "module_hidden", module: "projects", feature: "projects", roles: ["student", "developer"] });
  assert.equal(moduleHiddenMessage(projects, "projects", false), "\"Projects\" isn't turned on. Check \"Student\" or \"Developer\" in Settings › Roles & Spaces to use it.");
  assert.equal(moduleHiddenMessage(new Error("hidden"), "lms", false), undefined);
});

test("reasoning efforts ascend from no thinking to the max ceiling", () => {
  assert.deepEqual(reasoningEfforts, ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"]);
});
