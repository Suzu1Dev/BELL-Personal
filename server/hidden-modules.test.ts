import assert from "node:assert/strict";
import test from "node:test";
import type { MailMessage } from "../shared/mail.js";
import { MODULE_FEATURES, type FeatureOverrides, type ProfileRole } from "../shared/profile.js";
import type { AssignmentSuggestion } from "../shared/suggestions.js";
import { eventsModule } from "./features/events/index.js";
import { lmsModule } from "./features/lms/index.js";
import { assignmentRows } from "./features/lms/moodle.js";
import { MOODLE_NOW as NOW } from "./features/lms/test-support.js";
import { projectsModule } from "./features/projects/index.js";
import { startTestServer, testServices } from "./test-helpers.js";

/**
 * profile.roles and features.overrides hide role-owned modules
 * (shared/profile.ts visibleFeatures; an override wins). Hidden is not
 * just not shown: a stale screen, a second tab or a script gets the same 409
 * module_hidden from every way a module acts, while reads, undo, 略過 and the
 * module's connection keep working, since hiding never removes data.
 */

const mail = (id: string): MailMessage => ({
  id, threadId: `t-${id}`, from: { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" }, subject: "【作業系統】HW5 公告",
  snippet: "HW5：系統呼叫實作…", excerpt: "HW5：系統呼叫實作，請於 10/16（五）23:59 前上傳至 E3。",
  receivedAt: "2026-10-12T00:10:00.000Z", unread: false, labels: ["INBOX"], webUrl: `https://mail.google.com/mail/u/0/#inbox/t-${id}`,
});

async function setup(t: test.TestContext) {
  const services = testServices(t, { seams: { now: () => NOW } });
  services.sourceItems.replace("moodle", "assignment", assignmentRows([{
    id: "moodle:30512", origin: "moodle", externalId: "30512", courseName: "作業系統", title: "HW3", dueAt: "2026-10-12T15:59:00.000Z",
    url: "https://e3p.nycu.edu.tw/mod/assign/view.php?id=30512", submission: "not-submitted", updatedAt: NOW.toISOString(),
  }]));
  services.sourceItems.upsert("gmail", ["hw5", "hw6"].map((id) => ({ kind: "mail", externalId: id, value: mail(id) })));
  const suggestion = services.suggestions.create<AssignmentSuggestion>({
    kind: "assignment", title: "Lab 3", payload: { title: "Lab 3", dueAt: "2026-10-21T04:00:00.000Z", detectedBy: "rule" },
    sourceRef: { source: "gmail", externalId: "lab3", url: "https://mail.google.com/lab3" }, dedupeKey: "mail-assignment:lab3",
  });
  const server = await startTestServer(t, services, { modules: [lmsModule, projectsModule, eventsModule] });
  const roles = (value: ProfileRole[]) => services.settings.update({ "profile.roles": value });
  const overrides = (value: FeatureOverrides) => services.settings.update({ "features.overrides": value });
  return { services, server, suggestion, roles, overrides };
}

const hidden = (response: { status: number; json: any }, module: string, roles: string[]) => {
  assert.equal(response.status, 409, JSON.stringify(response.json));
  assert.deepEqual([response.json.code, response.json.module, response.json.feature, response.json.roles], ["module_hidden", module, MODULE_FEATURES[module], roles]);
};

test("學校作業 hidden without 學生: its actions, accept and writes refuse with module_hidden; reads, undo, 略過 and the connection still work", async (t) => {
  const { services, server, suggestion, roles, overrides } = await setup(t);
  const act = (itemId: string, action: string) => server.call("POST", "/api/actions", { body: { itemId, action } });

  // Before: every role ticked (testServices' default) shows everything.
  const converted = await act("gmail:hw5", "assignment");
  assert.equal(converted.status, 202, converted.text);
  const created = await server.call("POST", "/api/lms/assignments", { body: { title: "讀書心得" } });
  assert.equal(created.status, 201, created.text);

  roles(["developer"]);
  const refused = await act("gmail:hw6", "assignment");
  hidden(refused, "lms", ["student"]);
  assert.match(refused.json.error, /「學校作業」目前沒有開啟/);
  assert.match(refused.json.error, /設定 › 身分與功能 勾選「學生」/);
  hidden(await act("moodle:30512", "submitted"), "lms", ["student"]);
  hidden(await act(`ai:${suggestion.id}`, "assignment"), "lms", ["student"]);
  hidden(await server.call("POST", `/api/suggestions/${suggestion.id}/accept`, { body: {} }), "lms", ["student"]);
  assert.equal(services.suggestions.get(suggestion.id)?.status, "pending", "a refused accept decides nothing");

  // The assignment routes, however the path is written (Express matches case-insensitively, a trailing slash too).
  hidden(await server.call("POST", "/api/lms/assignments", { body: { title: "新作業" } }), "lms", ["student"]);
  hidden(await server.call("POST", "/api/lms/Assignments/", { body: { title: "新作業" } }), "lms", ["student"]);
  hidden(await server.call("PATCH", `/api/lms/assignments/${created.json.id}`, { body: { title: "改名" } }), "lms", ["student"]);
  hidden(await server.call("DELETE", `/api/lms/assignments/${created.json.id}`, { body: {} }), "lms", ["student"]);
  const listed = await server.call("GET", "/api/lms/assignments");
  assert.equal(listed.status, 200, "reads still answer: the data is kept");
  assert.ok(listed.json.assignments.some((row: { title: string }) => row.title === "讀書心得"));

  // What stays open: the connection 設定 manages, undo of an earlier action, 略過 on a suggestion.
  assert.equal((await server.call("POST", "/api/lms/canvas/connect", { body: {} })).status, 400, "reaches the route's own validation");
  assert.equal((await server.call("DELETE", "/api/lms/moodle", { body: {} })).status, 200);
  assert.equal((await server.call("DELETE", `/api/actions/${converted.json.actionId}`, { body: {} })).status, 200);
  assert.equal((await server.call("POST", `/api/suggestions/${suggestion.id}/dismiss`, { body: {} })).status, 200);

  // Any role that turns it on, or a manual "on" without one, brings everything back as it was.
  roles(["student", "ctf"]);
  assert.equal((await server.call("POST", "/api/lms/assignments", { body: { title: "新作業" } })).status, 201);
  assert.equal((await act("gmail:hw6", "assignment")).status, 202);
  roles([]);
  overrides({ assignments: true });
  assert.equal((await server.call("PATCH", `/api/lms/assignments/${created.json.id}`, { body: { title: "改名" } })).status, 200);
});

test("features.overrides win over the roles both ways, say it was switched off by hand, and keep winning when the roles change", async (t) => {
  const { server, roles, overrides } = await setup(t);
  const assignment = () => server.call("POST", "/api/lms/assignments", { body: { title: "新作業" } });
  const project = () => server.call("POST", "/api/projects", { body: { name: "OS 期末專題" } });

  // Off by hand with 學生 ticked: refused, and the message points at the switch, not at a role to tick.
  roles(["student"]);
  overrides({ assignments: false });
  const off = await assignment();
  hidden(off, "lms", ["student"]);
  assert.match(off.json.error, /「學校作業」已在 設定 › 身分與功能 手動關閉/);
  assert.doesNotMatch(off.json.error, /勾選/);
  assert.equal((await project()).status, 201, "only the switched-off feature: 學生 still has 專案");

  // On by hand with no role that owns it.
  roles(["ctf"]);
  overrides({ assignments: false, projects: true });
  assert.equal((await project()).status, 201);
  hidden(await assignment(), "lms", ["student"]);

  // Changing the roles afterwards does not undo a manual choice…
  roles(["student", "developer", "ctf"]);
  overrides({ projects: false });
  hidden(await project(), "projects", ["student", "developer"]);
  roles([]);
  overrides({ projects: true });
  assert.equal((await project()).status, 201);
  // …removing the entry follows the roles again.
  overrides({});
  hidden(await project(), "projects", ["student", "developer"]);
  roles(["developer"]);
  assert.equal((await project()).status, 201);
});

test("every role-owned module behaves the same: projects and events refuse writes while hidden, events keeps its feeds", async (t) => {
  const { server, roles } = await setup(t);
  roles([]);
  hidden(await server.call("POST", "/api/projects", { body: { name: "OS 期末專題" } }), "projects", ["student", "developer"]);
  assert.equal((await server.call("GET", "/api/projects")).status, 200);
  assert.equal((await server.call("POST", "/api/events/feeds", { body: {} })).status, 400, "a feed is a connection: still manageable");
  roles(["developer"]);
  assert.equal((await server.call("POST", "/api/projects", { body: { name: "OS 期末專題" } })).status, 201, "developer turns projects on too");
  roles(["student", "developer"]);
  assert.equal((await server.call("POST", "/api/events/feeds", { body: {} })).status, 400);
});
