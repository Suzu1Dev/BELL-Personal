import assert from "node:assert/strict";
import test from "node:test";
import { appContext } from "../../app.js";
import { safeFetch } from "../../sync.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { CanvasSync, fetchCanvasAssignments, nextLink } from "./canvas.js";
import { lmsModule } from "./index.js";
import { LMS_VAULT, type CanvasCredential } from "./lms.js";
import { MOODLE_NOW as NOW, fakeCanvas } from "./test-support.js";

const BASE = "https://cool.ntu.edu.tw";

test("Canvas connect checks the token with /users/self and keeps only the token and the name", async (t) => {
  const canvas = fakeCanvas();
  const services = testServices(t, { seams: { fetch: canvas.fetch, now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const response = await server.call("POST", "/api/lms/canvas/connect", { body: { baseUrl: `${BASE}/`, token: canvas.fixture.token } });
  assert.equal(response.status, 201, response.text);
  assert.deepEqual(response.json.account, { name: "林鈴", siteName: "NTU COOL" });
  assert.ok(!response.text.includes(canvas.fixture.token));
  assert.equal(canvas.calls[0].url, `${BASE}/api/v1/users/self`);
  assert.equal(canvas.calls[0].headers.authorization, `Bearer ${canvas.fixture.token}`);
  for (const call of canvas.calls) assert.ok(!call.url.includes(canvas.fixture.token), "the token is a header, never in a URL");
  const stored = await services.vault.get<CanvasCredential>(LMS_VAULT.canvas);
  assert.deepEqual({ token: stored?.token, baseUrl: stored?.baseUrl, name: stored?.name, userId: stored?.userId }, { token: canvas.fixture.token, baseUrl: BASE, name: "林鈴", userId: 7 });

  await appContext(server.app).modules.source("canvas")!.sync();
  const list = await server.call("GET", "/api/lms/assignments");
  assert.equal(list.json.assignments.length, 5);
  assert.equal(list.json.accounts.find((entry: { source: string }) => entry.source === "canvas").status.state, "ok");

  const disconnect = await server.call("DELETE", "/api/lms/canvas", { body: {} });
  assert.deepEqual(disconnect.json, { disconnected: true, removedItems: 5 });
  assert.equal(await services.vault.has(LMS_VAULT.canvas), false);
  assert.equal((await server.call("GET", "/api/lms")).json.accounts[1].status.state, "not_configured");
});

test("Canvas connect refuses a token Canvas rejects", async (t) => {
  const canvas = fakeCanvas({ unauthorized: true });
  const services = testServices(t, { seams: { fetch: canvas.fetch, now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const response = await server.call("POST", "/api/lms/canvas/connect", { body: { baseUrl: BASE, token: "21~revoked-token-value" } });
  assert.equal(response.status, 400);
  assert.match(response.json.error, /不接受這個權杖/);
  assert.equal(await services.vault.has(LMS_VAULT.canvas), false);
});

test("Canvas planner items and missing submissions map to assignments", async () => {
  const canvas = fakeCanvas();
  const http = (url: string | URL, init?: Parameters<typeof safeFetch>[3]) => safeFetch(canvas.fetch, url, new AbortController().signal, init);
  const assignments = await fetchCanvasAssignments(http, { token: canvas.fixture.token, baseUrl: BASE, connectedAt: NOW.toISOString() }, NOW);
  const byId = new Map(assignments.map((item) => [item.externalId, item]));
  assert.deepEqual([...byId.keys()].sort(), ["assignment-480", "assignment-501", "assignment-502", "discussion_topic-88", "quiz-77"]);

  const hw1 = byId.get("assignment-501")!;
  assert.equal(hw1.id, "canvas:assignment-501");
  assert.equal(hw1.courseName, "機器學習 (ML)");
  assert.equal(hw1.dueAt, "2026-10-13T15:59:00.000Z");
  assert.equal(hw1.submission, "not-submitted");
  assert.equal(hw1.url, `${BASE}/courses/3001/assignments/501`, "relative links become absolute");
  assert.deepEqual(hw1.site, { label: "NTU COOL", short: "Canvas" });

  assert.equal(byId.get("quiz-77")!.submission, "submitted");
  assert.equal(byId.get("discussion_topic-88")!.submission, "graded");
  assert.equal(byId.get("discussion_topic-88")!.courseName, "科技與社會");
  assert.equal(byId.get("discussion_topic-88")!.dueAt, "2026-10-20T15:59:00.000Z", "plannable_date when there is no due_at");
  assert.equal(byId.get("assignment-502")!.submission, "not-submitted", "a redo request reopens it");
  const missing = byId.get("assignment-480")!;
  assert.equal(missing.missing, true);
  assert.equal(missing.submission, "not-submitted");
  assert.ok(!byId.has("assignment-300"), "missing work older than the window is left out");
  assert.ok(!assignments.some((item) => item.title === "期中考範圍"), "announcements are not assignments");

  assert.ok(canvas.calls.some((call) => call.url.includes("page=2")), "the Link header's next page was followed");
  const planner = new URL(canvas.calls[0].url);
  assert.equal(planner.pathname, "/api/v1/planner/items");
  assert.equal(planner.searchParams.get("start_date"), "2026-09-28T00:42:00.000Z");
});

test("a revoked Canvas token turns the source to needs_reconnect", async (t) => {
  const canvas = fakeCanvas({ unauthorized: true });
  const services = testServices(t, { seams: { fetch: canvas.fetch, now: () => NOW } });
  await services.vault.set(LMS_VAULT.canvas, { token: "21~old", baseUrl: BASE, connectedAt: NOW.toISOString() } satisfies CanvasCredential);
  const source = new CanvasSync(services);
  const status = await source.sync();
  assert.equal(status.state, "needs_reconnect");
  await source.close();
});

test("Link pagination only follows the same origin", () => {
  assert.equal(nextLink('<https://cool.ntu.edu.tw/api/v1/x?page=2>; rel="next", <https://cool.ntu.edu.tw/api/v1/x?page=9>; rel="last"', BASE), "https://cool.ntu.edu.tw/api/v1/x?page=2");
  assert.equal(nextLink('<https://evil.example/api?page=2>; rel="next"', BASE), undefined);
  assert.equal(nextLink(null, BASE), undefined);
});

/** A Canvas that answers the planner and missing_submissions lists from memory. */
function cannedCanvas(planner: unknown[], missing: unknown[]) {
  return async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.stringify(path.endsWith("/planner/items") ? planner : path.endsWith("/missing_submissions") ? missing : []);
    const buffer = Buffer.from(body);
    return { status: 200, ok: true, headers: new Headers(), body: buffer, text: () => body, json: <T>() => JSON.parse(body) as T };
  };
}

test("Canvas: an overdue classic quiz and a graded discussion are one row each, keyed by their assignment", async () => {
  const planner = [
    { plannable_id: 77, plannable_type: "quiz", plannable: { id: 77, title: "Quiz 2", assignment_id: 9001, due_at: "2026-10-09T15:59:00Z" }, plannable_date: "2026-10-09T15:59:00Z", course_id: 3001, context_name: "機器學習", html_url: "/courses/3001/quizzes/77", submissions: { submitted: false, missing: true } },
    { plannable_id: 88, plannable_type: "discussion_topic", plannable: { id: 88, title: "第三週討論", assignment_id: 9002, due_at: "2026-10-10T15:59:00Z" }, plannable_date: "2026-10-10T15:59:00Z", course_id: 3001, context_name: "機器學習", html_url: "/courses/3001/discussion_topics/88", submissions: { submitted: false } },
  ];
  const missing = [
    { id: 9001, quiz_id: 77, name: "Quiz 2", due_at: "2026-10-09T15:59:00Z", course_id: 3001, course: { name: "機器學習" } },
    { id: 9002, discussion_topic: { id: 88 }, name: "第三週討論", due_at: "2026-10-10T15:59:00Z", course_id: 3001, course: { name: "機器學習" } },
  ];
  const renamed: Array<[string, string]> = [];
  const assignments = await fetchCanvasAssignments(cannedCanvas(planner, missing), { token: "t", baseUrl: BASE, connectedAt: NOW.toISOString() }, NOW, (from, to) => renamed.push([from, to]));
  assert.deepEqual(assignments.map((item) => [item.externalId, item.missing ?? false, item.submission]).sort(),
    [["assignment-9001", true, "not-submitted"], ["assignment-9002", true, "not-submitted"]]);
  assert.deepEqual(renamed, [["quiz-77", "assignment-9001"], ["discussion_topic-88", "assignment-9002"]]);

  // Without assignment_id the planner row keeps its own key, and the missing entry still finds it.
  const plain = planner.map((item) => ({ ...item, plannable: { ...item.plannable, assignment_id: undefined } }));
  const merged = await fetchCanvasAssignments(cannedCanvas(plain, missing), { token: "t", baseUrl: BASE, connectedAt: NOW.toISOString() }, NOW);
  assert.deepEqual(merged.map((item) => [item.externalId, item.missing ?? false]).sort(), [["discussion_topic-88", true], ["quiz-77", true]]);
});

test("Canvas: the student's effective due date (plannable_date) wins over the assignment's base date", async () => {
  const planner = [{
    plannable_id: 601, plannable_type: "assignment", plannable: { id: 601, title: "HW3", due_at: "2026-10-15T15:59:00Z" },
    plannable_date: "2026-10-20T15:59:00Z", course_id: 3001, context_name: "機器學習", html_url: "/courses/3001/assignments/601", submissions: { submitted: false },
  }];
  const [hw3] = await fetchCanvasAssignments(cannedCanvas(planner, []), { token: "t", baseUrl: BASE, connectedAt: NOW.toISOString() }, NOW);
  assert.equal(hw3.dueAt, "2026-10-20T15:59:00.000Z");
});

test("Canvas: a 標為已交 mark on the old quiz-<id> row follows it to the assignment key", async (t) => {
  const planner = [{ plannable_id: 77, plannable_type: "quiz", plannable: { id: 77, title: "Quiz 2", assignment_id: 9001, due_at: "2026-10-20T15:59:00Z" }, plannable_date: "2026-10-20T15:59:00Z", course_id: 3001, context_name: "機器學習", submissions: { submitted: false } }];
  const canned = cannedCanvas(planner, []);
  const fetch = async (url: string | URL) => new Response((await canned(url)).text(), { status: 200, headers: { "content-type": "application/json" } });
  const services = testServices(t, { seams: { now: () => NOW, fetch } });
  await services.vault.set(LMS_VAULT.canvas, { token: "t", baseUrl: BASE, connectedAt: NOW.toISOString() } satisfies CanvasCredential);
  services.itemState.record({ itemId: "canvas:quiz-77", kind: "assignment", action: "submitted", title: "Quiz 2", closes: true, state: { state: "dismissed", fingerprint: "2026-10-20T15:59:00.000Z|not-submitted" } });
  const source = new CanvasSync(services);
  t.after(() => source.close());
  assert.equal((await source.sync()).state, "ok");
  assert.equal(services.itemState.get("canvas:quiz-77"), undefined);
  assert.equal(services.itemState.get("canvas:assignment-9001")?.action, "submitted");
});
