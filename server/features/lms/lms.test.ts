import assert from "node:assert/strict";
import test from "node:test";
import type { Assignment, AssignmentView } from "../../../shared/assignments.js";
import type { TodayPayload } from "../../../shared/today.js";
import type { CoreServices } from "../../services.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { lmsModule } from "./index.js";
import { assignmentFingerprint, cleanCourseName, htmlToText, shortTitle, siteFor } from "./lms.js";
import { assignmentRows } from "./moodle.js";
import { lmsToday } from "./today.js";
import { MOODLE_NOW as NOW } from "./test-support.js";

const TZ = "Asia/Taipei";

function assignment(externalId: string, title: string, dueAt: string | null, extra: Partial<Assignment> = {}): Assignment {
  return {
    id: `moodle:${externalId}`, origin: "moodle", externalId, courseName: extra.courseName ?? "作業系統", title, dueAt,
    url: `https://e3p.nycu.edu.tw/mod/assign/view.php?id=${externalId}`, submission: "not-submitted", updatedAt: NOW.toISOString(), ...extra,
  };
}

/** The mockup's E3 (SPEC §13): HW3 tonight, Lab 2 on Wednesday, HW5 in 10 days, HW4 in 16, one graded. */
function seed(services: CoreServices, overrides: Assignment[] = []): Assignment[] {
  const rows = [
    assignment("30512", "HW3：CPU Scheduling 模擬", "2026-10-12T15:59:00.000Z"),
    assignment("30744", "Lab 2：Socket Programming", "2026-10-14T15:59:00.000Z", { courseName: "計算機網路" }),
    assignment("30900", "HW5：File Systems", "2026-10-22T15:59:00.000Z"),
    assignment("30801", "HW4：Memory Management", "2026-10-28T15:59:00.000Z"),
    assignment("30401", "HW2：Threads", "2026-10-05T15:59:00.000Z", { submission: "graded", grade: "95 / 100" }),
    assignment("30300", "HW1：Process", "2026-09-01T15:59:00.000Z"),
    ...overrides,
  ];
  services.sourceItems.replace("moodle", "assignment", assignmentRows(rows));
  return rows;
}

test("today(): assignment rows, the due agenda row, the gap label, later deadlines and the work badge", (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  seed(services);
  const today = lmsToday(services, { now: NOW, timeZone: TZ, day: "2026-10-12" });
  assert.deepEqual(today.queue!.map((row) => row.id).sort(), ["moodle:30512", "moodle:30744", "moodle:30801", "moodle:30900"], "graded and long-overdue rows are left out");
  const row = (id: string) => today.queue!.find((entry) => entry.id === id)!;
  const hw3 = row("moodle:30512");
  assert.equal(hw3.kind, "assignment");
  assert.equal(hw3.source, "moodle");
  assert.equal(hw3.title, "作業系統 HW3：CPU Scheduling 模擬");
  assert.deepEqual(hw3.meta, ["NYCU E3", "作業系統", "今晚 23:59 截止", "尚未繳交"]);
  assert.deepEqual(hw3.when, { label: "剩 15 小時", tone: "hot", mono: false });
  assert.deepEqual(hw3.actions.map((action) => [action.id, action.label, action.touchLabel]), [["open", "開啟 E3", "開啟"], ["submitted", "標為已交", "已交"], ["snooze", "延後", "延後"]]);
  assert.equal(hw3.snoozeLimit, "2026-10-12T13:59:00.000Z");
  assert.deepEqual(hw3.hints, { dueAt: "2026-10-12T15:59:00.000Z", hardDeadline: true, fingerprint: "2026-10-12T15:59:00.000Z|not-submitted" });
  assert.deepEqual(row("moodle:30744").meta, ["NYCU E3", "計算機網路", "週三 23:59 截止", "尚未繳交"]);

  assert.deepEqual(today.agenda, [{ start: "2026-10-12T15:59:00.000Z", title: "HW3 截止", meta: "作業系統 · NYCU E3", kind: "due", itemId: "moodle:30512" }]);
  assert.deepEqual(today.gapCandidates, [{ itemId: "moodle:30512", label: "適合寫 HW3", dueAt: "2026-10-12T15:59:00.000Z" }], "only deadlines within 48 h fill the free slot");
  assert.deepEqual(today.later?.events?.map((event) => event.title).sort(), ["HW5 截止", "Lab 2 截止"], "HW4 is beyond the 14-day horizon");
  assert.equal(today.nav?.work, 2, "due within 7 days");
});

test("GET /api/today groups E3 rows: tonight's HW3 in 最重要, Lab 2 in 可以等, HW5 left for later", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  seed(services);
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const payload = (await server.call("GET", "/api/today")).json as TodayPayload;
  const ids = (group: string) => payload.queue.find((entry) => entry.group === group)!.items.map((item) => item.id);
  assert.deepEqual(ids("now"), ["moodle:30512"]);
  assert.deepEqual(ids("today"), []);
  assert.deepEqual(ids("later"), ["moodle:30744"]);
  assert.equal(payload.counts.open, 2);
  assert.equal(payload.counts.nav?.work, 2);
  assert.equal(payload.agenda.gap?.forItemId, "moodle:30512");
  assert.equal(payload.agenda.gap?.label, "適合寫 HW3");
  assert.deepEqual(payload.later.events.map((event) => event.title), ["HW5 截止"], "Lab 2 is open in the queue, so it is not repeated");
  assert.equal(payload.sources.find((source) => source.id === "moodle")?.state, "off", "no token yet: 尚未設定, not an error");
});

test("標為已交 from #/work keeps the fingerprint of a row Today did not serve", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  seed(services);
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  await server.call("GET", "/api/today");

  // HW5 is due in 10 days: not a queue row, so the lms handler describes it.
  const accepted = await server.call("POST", "/api/actions", { body: { itemId: "moodle:30900", action: "submitted" } });
  assert.equal(accepted.status, 202, accepted.text);
  const state = services.itemState.get("moodle:30900");
  assert.equal(state?.state, "dismissed");
  assert.equal(state?.fingerprint, "2026-10-22T15:59:00.000Z|not-submitted");
  assert.equal(services.itemState.log(accepted.json.actionId)?.kind, "assignment");
  assert.equal(services.itemState.log(accepted.json.actionId)?.title, "作業系統 HW5：File Systems");

  let list = (await server.call("GET", "/api/lms/assignments")).json.assignments as AssignmentView[];
  const hw5 = list.find((item) => item.externalId === "30900")!;
  assert.equal(hw5.status, "local");
  assert.equal(hw5.itemId, "moodle:30900");
  assert.ok(hw5.localSubmittedAt);
  assert.equal(list.find((item) => item.externalId === "30401")!.status, "graded");
  assert.equal(list.find((item) => item.externalId === "30300")!.status, "overdue");

  // The teacher moves the deadline: the mark no longer applies.
  seed(services, [assignment("30900", "HW5：File Systems", "2026-10-24T15:59:00.000Z")]);
  list = (await server.call("GET", "/api/lms/assignments")).json.assignments as AssignmentView[];
  assert.equal(list.find((item) => item.externalId === "30900")!.status, "open");

  // Undo works like any generic action.
  const undo = await server.call("DELETE", `/api/actions/${accepted.json.actionId}`, { body: {} });
  assert.equal(undo.status, 200, undo.text);
});

test("標為已交 on tonight's HW3 closes the row; the work badge and agenda follow", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  seed(services);
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  await server.call("GET", "/api/today");
  const accepted = await server.call("POST", "/api/actions", { body: { itemId: "moodle:30512", action: "submitted" } });
  assert.equal(accepted.status, 202, accepted.text);
  const payload = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(payload.queue.find((entry) => entry.group === "now")!.items.length, 0);
  assert.deepEqual([payload.counts.open, payload.counts.handled], [1, 1]);
  assert.equal(payload.counts.nav?.work, 1);
  assert.ok(!payload.agenda.items.some((item) => item.itemId === "moodle:30512"), "a deadline marked 已交 leaves the agenda");

  const refused = await server.call("POST", "/api/actions", { body: { itemId: "moodle:30744", action: "done" } });
  assert.equal(refused.status, 400, "an assignment has no 完成");
  const gone = await server.call("POST", "/api/actions", { body: { itemId: "moodle:99999", action: "submitted" } });
  assert.equal(gone.status, 404);
  const graded = await server.call("POST", "/api/actions", { body: { itemId: "moodle:30401", action: "submitted" } });
  assert.equal(graded.status, 409);
});

test("GET /api/lms reports both connections without credentials", async (t) => {
  const services = testServices(t, { seams: { now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const response = await server.call("GET", "/api/lms");
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.accounts.map((account: { source: string; connected: boolean; short: string }) => [account.source, account.connected, account.short]), [["moodle", false, "E3"], ["canvas", false, "Canvas"]]);
});

test("LMS text helpers", () => {
  assert.equal(shortTitle("HW3：CPU Scheduling 模擬"), "HW3");
  assert.equal(shortTitle("Lab 2: Socket"), "Lab 2");
  assert.equal(shortTitle("期末專題報告書與口頭報告準備事項清單"), "期末專題報告書與口頭報告準備事…");
  assert.equal(cleanCourseName("【115上】作業系統   Operating Systems"), "作業系統 Operating Systems");
  assert.equal(cleanCourseName("[1151] 演算法"), "演算法");
  assert.equal(htmlToText("<p>A &amp; B</p><script>x()</script><br>C&#x27;"), "A & B\nC&#x27;");
  assert.deepEqual(siteFor("moodle", "https://moodle.ntust.edu.tw", "NTUST Moodle"), { label: "NTUST Moodle", short: "Moodle" });
  assert.equal(assignmentFingerprint({ dueAt: null, submission: "unknown" }), "none|unknown");
});

test("LMS htmlToText stays linear on hostile descriptions", () => {
  for (const html of ["<".repeat(1_000_000), "<script>".repeat(150_000), `x${"　".repeat(500_000)}y`, "<style>a{}".repeat(100_000)]) {
    const started = performance.now();
    htmlToText(html);
    const ms = performance.now() - started;
    assert.ok(ms < 200, `${JSON.stringify(html.slice(0, 8))}… took ${ms.toFixed(0)} ms`);
  }
  assert.equal(htmlToText("<p>前</p><script>x()</script><b>後</b> a < b"), "前\n後 a b");
});
