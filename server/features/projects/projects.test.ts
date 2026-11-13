import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubItem } from "../../../shared/github.js";
import type { Project, ProjectDetail, ProjectListResponse } from "../../../shared/projects.js";
import type { TodayPayload } from "../../../shared/today.js";
import type { CoreServices } from "../../services.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { projectsModule } from "./index.js";
import { nextText, projectsToday, sidebarProjects } from "./today.js";

const NOW = new Date("2026-10-12T00:42:00Z");

function insertTodo(services: CoreServices, id: string, title: string, projectId: string, extra: Record<string, unknown> = {}) {
  const todo = { id, title, status: "open", priority: "normal", origin: "manual", projectId, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...extra };
  services.db.personal.db.prepare("INSERT INTO todos (id, json, updated_at, status, due_day, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, JSON.stringify(todo), todo.updatedAt, String(todo.status), (extra.dueDay as string | undefined) ?? null, projectId, todo.createdAt);
}

test("projects CRUD: create, list, edit, milestones, delete and restore", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [projectsModule] });

  const created = await server.call("POST", "/api/projects", { body: {
    name: "  OS 期末專題 ", description: "用 eBPF 觀察 CFS 排程延遲。", color: "task", repos: ["Suzu1Dev/os-final", "suzu1dev/OS-final"],
    milestones: [{ title: "題目提案", dueDay: "2026-10-19" }, { title: "期中進度報告", dueDay: "2026-11-11" }],
  } });
  assert.equal(created.status, 201, created.text);
  const project = created.json as Project;
  assert.equal(project.name, "OS 期末專題", "names are trimmed");
  assert.equal(project.status, "active");
  assert.deepEqual(project.repos, ["Suzu1Dev/os-final"], "repos are de-duplicated ignoring case");
  assert.equal(project.repo, "Suzu1Dev/os-final");
  assert.equal(project.milestones.length, 2);

  let list = (await server.call("GET", "/api/projects")).json as ProjectListResponse;
  assert.equal(list.projects.length, 1);
  assert.deepEqual(
    { pct: list.projects[0].pct, manual: list.projects[0].manualProgress, next: list.projects[0].next, milestones: list.projects[0].milestones },
    { pct: 0, manual: false, next: { title: "題目提案", dueDay: "2026-10-19" }, milestones: { done: 0, total: 2 } },
  );

  const first = project.milestones[0].id;
  const done = await server.call("PATCH", `/api/projects/${project.id}/milestones/${first}`, { body: { done: true } });
  assert.equal(done.status, 200, done.text);
  assert.equal((done.json as Project).milestones[0].done, true);
  assert.equal((done.json as Project).milestones[0].doneAt, NOW.toISOString());
  list = (await server.call("GET", "/api/projects")).json as ProjectListResponse;
  assert.equal(list.projects[0].pct, 50, "progress follows milestones");
  assert.equal(list.projects[0].next?.title, "期中進度報告");

  const added = await server.call("POST", `/api/projects/${project.id}/milestones`, { body: { title: "期末 demo" } });
  assert.equal(added.status, 201);
  const third = (added.json as Project).milestones[2].id;
  const renamed = await server.call("PATCH", `/api/projects/${project.id}/milestones/${third}`, { body: { title: "期末 demo 與報告", dueDay: "2026-12-30" } });
  assert.equal((renamed.json as Project).milestones[2].dueDay, "2026-12-30");
  const cleared = await server.call("PATCH", `/api/projects/${project.id}/milestones/${third}`, { body: { dueDay: null } });
  assert.equal((cleared.json as Project).milestones[2].dueDay, undefined);
  const removed = await server.call("DELETE", `/api/projects/${project.id}/milestones/${third}`, { body: {} });
  assert.equal((removed.json as Project).milestones.length, 2);

  const edited = await server.call("PATCH", `/api/projects/${project.id}`, { body: { progress: 20, status: "paused", description: null, repos: [] } });
  assert.equal(edited.status, 200, edited.text);
  const after = edited.json as Project;
  assert.equal(after.progress, 20);
  assert.equal(after.status, "paused");
  assert.equal(after.description, undefined);
  assert.equal(after.repos, undefined);
  assert.equal(after.repo, undefined);
  list = (await server.call("GET", "/api/projects")).json as ProjectListResponse;
  assert.deepEqual([list.projects[0].pct, list.projects[0].manualProgress], [20, true]);
  const auto = await server.call("PATCH", `/api/projects/${project.id}`, { body: { progress: null } });
  assert.equal((auto.json as Project).progress, undefined, "null goes back to milestone progress");

  const deleted = await server.call("DELETE", `/api/projects/${project.id}`, { body: {} });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.deleted, true);
  assert.equal((await server.call("GET", `/api/projects/${project.id}`)).status, 404);
  const restored = await server.call("POST", "/api/trash/restore", { body: { token: deleted.json.undoToken } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal((await server.call("GET", `/api/projects/${project.id}`)).status, 200);
});

test("project input is validated", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [projectsModule] });
  const bad = [
    { name: "" },
    { name: "x", repos: ["not a repo"] },
    { name: "x", color: "pink" },
    { name: "x", progress: 140 },
    { name: "x", milestones: [{ title: "m", dueDay: "10/19" }] },
    { name: "x", owner: "me" },
  ];
  for (const body of bad) assert.equal((await server.call("POST", "/api/projects", { body })).status, 400, JSON.stringify(body));
  assert.equal((await server.call("PATCH", "/api/projects/nope", { body: { name: "y" } })).status, 404);
  const project = (await server.call("POST", "/api/projects", { body: { name: "x" } })).json as Project;
  assert.equal((await server.call("PATCH", `/api/projects/${project.id}/milestones/nope`, { body: { done: true } })).status, 404);

  await server.call("PATCH", `/api/projects/${project.id}`, { body: { status: "archived" } });
  assert.equal(((await server.call("GET", "/api/projects")).json as ProjectListResponse).projects.length, 0, "archived projects leave the list");
  assert.equal(((await server.call("GET", "/api/projects?archived=include")).json as ProjectListResponse).projects.length, 1);
  assert.equal((await server.call("GET", `/api/projects/${project.id}`)).status, 200, "and keep their page");
});

test("project detail lists linked todos and what GitHub knows about linked repositories", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [projectsModule] });
  const project = (await server.call("POST", "/api/projects", { body: { name: "bell-personal", repos: ["Suzu1Dev/bell-personal"] } })).json as Project;
  insertTodo(services, "todo-a", "寫作業頁", project.id, { dueDay: "2026-10-14" });
  insertTodo(services, "todo-b", "寫 README", project.id, { status: "done" });
  insertTodo(services, "todo-c", "別的專案", "other");
  const items: GitHubItem[] = [
    { id: "pr:PR_1", kind: "pr", repo: "Suzu1Dev/bell-personal", title: "Add the work page", url: "https://github.com/Suzu1Dev/bell-personal/pull/42", number: 42, updatedAt: NOW.toISOString() },
    { id: "issue:I_1", kind: "issue", repo: "suzu1dev/BELL-personal", title: "Week view overflows", url: "https://github.com/Suzu1Dev/bell-personal/issues/9", number: 9, updatedAt: NOW.toISOString() },
    { id: "pr:PR_2", kind: "pr", repo: "vitejs/vite", title: "elsewhere", url: "https://github.com/vitejs/vite/pull/1", number: 1, updatedAt: NOW.toISOString() },
  ];
  services.sourceItems.replace("github", "github-item", items.map((value) => ({ kind: "github-item" as const, externalId: value.id, value })));

  const detail = (await server.call("GET", `/api/projects/${project.id}`)).json as ProjectDetail;
  assert.deepEqual(detail.todos.map((todo) => [todo.id, todo.status, todo.dueDay]), [["todo-a", "open", "2026-10-14"], ["todo-b", "done", undefined]]);
  assert.equal(detail.summary.openTodos, 1);
  assert.deepEqual(detail.repos, [{
    repo: "Suzu1Dev/bell-personal",
    url: "https://github.com/Suzu1Dev/bell-personal",
    pullRequests: [{ number: 42, title: "Add the work page", url: "https://github.com/Suzu1Dev/bell-personal/pull/42", kind: "pr" }],
    issues: [{ number: 9, title: "Week view overflows", url: "https://github.com/Suzu1Dev/bell-personal/issues/9" }],
  }]);
});

test("today(): active projects by next milestone in the later card; sidebar pinned ids first", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [projectsModule] });
  const create = async (body: object) => (await server.call("POST", "/api/projects", { body })).json as Project;
  const os = await create({ name: "OS 期末專題", color: "task", progress: 20, milestones: [{ title: "題目提案", dueDay: "2026-10-19" }] });
  const ctf = await create({ name: "ctf-notes", color: "event", progress: 64, milestones: [{ title: "Balsn 前整理 heap 筆記", dueDay: "2026-10-16" }] });
  const bell = await create({ name: "bell-personal", color: "accent", progress: 38, milestones: [{ title: "完成 Today 頁" }] });
  await create({ name: "舊專案", status: "done" });
  const paused = await create({ name: "暫停的", status: "paused" });

  const payload = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.deepEqual(payload.later.projects, [
    { name: "ctf-notes", pct: 64, next: "10/16 Balsn 前整理 heap 筆記", color: "event", href: `#/work/projects/${ctf.id}` },
    { name: "OS 期末專題", pct: 20, next: "10/19 題目提案", color: "task", href: `#/work/projects/${os.id}` },
    { name: "bell-personal", pct: 38, next: "完成 Today 頁", color: "accent", href: `#/work/projects/${bell.id}` },
  ]);
  assert.deepEqual(payload.sidebar?.projects.map((project) => project.name), ["ctf-notes", "OS 期末專題", "bell-personal"]);

  const pinned = await server.call("PUT", "/api/settings/app", { body: { "sidebar.projectIds": [bell.id, paused.id, "missing", os.id] } });
  assert.equal(pinned.status, 200, pinned.text);
  const again = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.deepEqual(again.sidebar?.projects, [
    { id: bell.id, name: "bell-personal", pct: 38, color: "accent" },
    { id: paused.id, name: "暫停的", pct: 0, color: "accent" },
    { id: os.id, name: "OS 期末專題", pct: 20, color: "task" },
  ]);
});

test("project text helpers", () => {
  const base: Project = { id: "p", name: "p", color: "accent", status: "active", milestones: [], createdAt: "", updatedAt: "" };
  assert.equal(nextText(base), "還沒有里程碑");
  assert.equal(nextText({ ...base, milestones: [{ id: "m", title: "完成", done: true }] }), "里程碑都完成了");
  assert.equal(nextText({ ...base, milestones: [{ id: "m", title: "提案", dueDay: "2026-10-09", done: false }] }), "10/9 提案");
  assert.deepEqual(sidebarProjects([{ ...base, status: "archived" }], ["p"]), []);
  assert.deepEqual(projectsToday([], { settings: { "sidebar.projectIds": [] } as never }), {});
});
