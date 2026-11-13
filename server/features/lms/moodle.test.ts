import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Assignment } from "../../../shared/assignments.js";
import { appContext } from "../../app.js";
import { safeFetch, type FetchLike } from "../../sync.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { lmsModule } from "./index.js";
import { LMS_VAULT, normalizeBaseUrl, type MoodleCredential } from "./lms.js";
import { MoodleSync, fetchMoodleAssignments, moodleToken, submissionFrom } from "./moodle.js";
import { MOODLE_NOW, fakeMoodle } from "./test-support.js";

const PASSWORD = "S3cret-pässwörd!&x=1";
const BASE = "https://e3p.nycu.edu.tw";

function filesUnder(directory: string): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(directory); } catch { return []; }
  return entries.flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Everything logEvent writes while `task` runs (logging is normally off in tests). */
async function capturingLogs<T>(task: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const previous = process.env.BELLPERSONAL_LOG;
  const write = process.stdout.write;
  process.env.BELLPERSONAL_LOG = "on";
  // Only logEvent's lines: the test runner reports through stdout too, and those writes must go through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"time":')) { lines.push(chunk); return true; }
    return (write as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return { value: await task(), lines };
  } finally {
    process.stdout.write = write;
    process.env.BELLPERSONAL_LOG = previous;
  }
}

test("Moodle connect exchanges the password once and never stores or logs it", async (t) => {
  const moodle = fakeMoodle();
  const services = testServices(t, { seams: { fetch: moodle.fetch, now: () => MOODLE_NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });

  const { value: response, lines } = await capturingLogs(async () => {
    const answer = await server.call("POST", "/api/lms/moodle/connect", { body: { baseUrl: "e3p.nycu.edu.tw/", username: "312551000", password: PASSWORD } });
    await appContext(server.app).modules.source("moodle")!.sync();
    return answer;
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.connected, true);
  assert.equal(response.json.source, "moodle");
  assert.deepEqual(response.json.account, { name: "林鈴", username: "312551000", siteName: "國立陽明交通大學 E3 數位教學平台" });
  assert.ok(!response.text.includes(PASSWORD) && !response.text.includes(moodle.fixture.token.token), "no secret in the response");

  // The password travels exactly once, in the body of login/token.php, over HTTPS.
  const tokenCalls = moodle.calls.filter((call) => call.url.endsWith("/login/token.php"));
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].url, `${BASE}/login/token.php`);
  assert.equal(tokenCalls[0].method, "POST");
  const form = new URLSearchParams(tokenCalls[0].body);
  assert.equal(form.get("password"), PASSWORD);
  assert.equal(form.get("service"), "moodle_mobile_app");
  for (const call of moodle.calls) {
    assert.ok(call.url.startsWith("https://"), call.url);
    assert.ok(!call.url.includes(encodeURIComponent(PASSWORD)) && !call.url.includes("wstoken"), "no secret in a URL");
    if (call !== tokenCalls[0]) assert.ok(!call.body.includes(encodeURIComponent(PASSWORD)), "the password is not resent");
  }

  // Only the token (and who it belongs to) is kept.
  const stored = await services.vault.get<MoodleCredential>(LMS_VAULT.moodle);
  assert.equal(stored?.token, moodle.fixture.token.token);
  assert.equal(stored?.baseUrl, BASE);
  assert.ok(!JSON.stringify(stored).includes(PASSWORD));
  assert.ok(!JSON.stringify(stored).includes(moodle.fixture.token.privatetoken), "the private token is dropped");
  const encoded = encodeURIComponent(PASSWORD);
  for (const file of [...filesUnder(services.config.dataDir), ...filesUnder(services.config.secretsDir)]) {
    const bytes = readFileSync(file);
    assert.ok(!bytes.includes(Buffer.from(PASSWORD)) && !bytes.includes(Buffer.from(encoded)), `password found in ${file}`);
  }
  assert.ok(lines.length > 0, "logging was captured");
  for (const line of lines) assert.ok(!line.includes(PASSWORD) && !line.includes(encoded) && !line.includes(moodle.fixture.token.token), "nothing secret is logged");

  const list = await server.call("GET", "/api/lms/assignments");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.assignments.map((item: Assignment) => item.externalId), ["30401", "30512", "event-9001", "30744", "30800"]);
  const account = list.json.accounts.find((entry: { source: string }) => entry.source === "moodle");
  assert.equal(account.connected, true);
  assert.equal(account.short, "E3");
  assert.equal(account.status.state, "ok");
  assert.ok(!list.text.includes(moodle.fixture.token.token));
});

test("Moodle connect refuses a wrong password and stores nothing", async (t) => {
  const moodle = fakeMoodle({ tokenError: "invalidlogin" });
  const services = testServices(t, { seams: { fetch: moodle.fetch, now: () => MOODLE_NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const response = await server.call("POST", "/api/lms/moodle/connect", { body: { baseUrl: BASE, username: "312551000", password: PASSWORD } });
  assert.equal(response.status, 400);
  assert.match(response.json.error, /帳號或密碼不正確/);
  assert.equal(await services.vault.has(LMS_VAULT.moodle), false);
  assert.ok(!response.text.includes("Invalid login"), "the site's English message is not echoed");
});

test("a school connect that cannot reach the site says what to do, not 「稍後會自動重試」", async (t) => {
  const moodle = fakeMoodle();
  let failure: "unreachable" | "timeout" | "throttled" = "unreachable";
  const fetch: FetchLike = async (input, init) => {
    if (failure === "unreachable") throw new TypeError("fetch failed");
    if (failure === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    if (String(input).endsWith("/webservice/rest/server.php")) return new Response("{}", { status: 429 });
    return moodle.fetch(input, init);
  };
  const services = testServices(t, { seams: { fetch, now: () => MOODLE_NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  const connect = () => server.call("POST", "/api/lms/moodle/connect", { body: { baseUrl: "https://moodle.invalid", username: "312551000", password: PASSWORD } });

  const unreachable = await connect();
  assert.equal(unreachable.status, 502);
  assert.equal(unreachable.json.error, "連不到這個網址，請確認學校系統的網址後再按一次連接。");
  failure = "timeout";
  const slow = await connect();
  assert.equal(slow.status, 504);
  assert.equal(slow.json.error, "學校系統沒有及時回應，請確認網址後再按一次連接。");
  failure = "throttled";
  const throttled = await connect();
  assert.equal(throttled.status, 429);
  assert.equal(throttled.json.error, "Moodle 暫時限制請求頻率，請稍後再按一次連接。");
  for (const answer of [unreachable, slow, throttled]) assert.ok(!answer.json.error.includes("自動重試"), answer.json.error);
  assert.equal(await services.vault.has(LMS_VAULT.moodle), false, "nothing is stored, so nothing would retry");

  failure = "unreachable";
  const canvas = await server.call("POST", "/api/lms/canvas/connect", { body: { baseUrl: "https://canvas.invalid", token: "21~not-a-real-token" } });
  assert.equal(canvas.status, 502);
  assert.equal(canvas.json.error, "連不到這個網址，請確認學校系統的網址後再按一次連接。");
});

test("Moodle connect accepts HTTPS site addresses only", async (t) => {
  const moodle = fakeMoodle();
  const services = testServices(t, { seams: { fetch: moodle.fetch, now: () => MOODLE_NOW } });
  const server = await startTestServer(t, services, { modules: [lmsModule] });
  for (const baseUrl of ["http://e3p.nycu.edu.tw", "https://user:pw@e3p.nycu.edu.tw", "https://e3p.nycu.edu.tw/?a=1"]) {
    const response = await server.call("POST", "/api/lms/moodle/connect", { body: { baseUrl, username: "a", password: "b" } });
    assert.equal(response.status, 400, baseUrl);
  }
  const extra = await server.call("POST", "/api/lms/moodle/connect", { body: { baseUrl: BASE, username: "a", password: "b", remember: true } });
  assert.equal(extra.status, 400, "unknown fields are refused");
  assert.equal(moodle.calls.length, 0);
  assert.equal(normalizeBaseUrl(" https://e3p.nycu.edu.tw/login/index.php "), BASE);
  assert.equal(normalizeBaseUrl("moodle.example.edu/moodle/"), "https://moodle.example.edu/moodle");
});

test("Moodle answers map to assignments with submission states, extensions and quizzes", async () => {
  const moodle = fakeMoodle();
  const http = (url: string | URL, init?: Parameters<typeof safeFetch>[3]) => safeFetch(moodle.fetch, url, new AbortController().signal, init);
  const credential: MoodleCredential = { token: moodle.fixture.token.token, baseUrl: BASE, siteName: "E3", connectedAt: MOODLE_NOW.toISOString() };
  const assignments = await fetchMoodleAssignments(http, credential, MOODLE_NOW);
  const byId = new Map(assignments.map((item) => [item.externalId, item]));
  assert.deepEqual([...byId.keys()].sort(), ["30401", "30512", "30744", "30800", "event-9001"], "HW1 (outside the window) is left out");

  const hw3 = byId.get("30512")!;
  assert.equal(hw3.id, "moodle:30512");
  assert.equal(hw3.courseName, "作業系統 Operating Systems", "the term tag is dropped");
  assert.equal(hw3.title, "HW3：CPU Scheduling 模擬");
  assert.equal(hw3.dueAt, "2026-10-12T15:59:00.000Z");
  assert.equal(hw3.submission, "not-submitted");
  assert.equal(hw3.url, `${BASE}/mod/assign/view.php?id=30512`);
  assert.equal(hw3.description, "請實作 FCFS & RR，並比較平均等待時間。");
  assert.deepEqual(hw3.site, { label: "NYCU E3", short: "E3" });

  assert.equal(byId.get("30401")!.submission, "graded");
  assert.equal(byId.get("30401")!.grade, "95.00 / 100.00");
  assert.equal(byId.get("30744")!.dueAt, "2026-10-15T15:59:00.000Z", "an extension moves the deadline");
  assert.equal(byId.get("30744")!.submission, "not-submitted", "a draft is not submitted");
  assert.equal(byId.get("30800")!.submission, "submitted");
  const quiz = byId.get("event-9001")!;
  assert.equal(quiz.title, "Quiz 2：TCP");
  assert.equal(quiz.courseName, "計算機網路");
  assert.equal(quiz.url, `${BASE}/mod/quiz/view.php?id=30900`);
  assert.equal(quiz.submission, "not-submitted");

  const functions = moodle.calls.map((call) => new URLSearchParams(call.body).get("wsfunction"));
  assert.equal(functions.filter((name) => name === "mod_assign_get_submission_status").length, 4, "one status call per assignment in the window");
  const assignCall = moodle.calls.find((call) => call.body.includes("mod_assign_get_assignments"))!;
  assert.deepEqual(new URLSearchParams(assignCall.body).getAll("courseids[0]"), ["101"]);
});

test("submission status mapping covers new, draft, reopened, submitted and graded", () => {
  assert.equal(submissionFrom(undefined, true), "not-submitted");
  assert.equal(submissionFrom(undefined, false), "unknown");
  assert.equal(submissionFrom({ lastattempt: { submission: { status: "reopened" } } }, false), "not-submitted");
  assert.equal(submissionFrom({ lastattempt: { teamsubmission: { status: "submitted" } } }, false), "submitted");
  assert.equal(submissionFrom({ lastattempt: { submission: { status: "new" }, gradingstatus: "graded" } }, false), "graded");
});

test("an invalid Moodle token turns the source to needs_reconnect", async (t) => {
  const moodle = fakeMoodle({ invalidToken: true });
  const services = testServices(t, { seams: { fetch: moodle.fetch, now: () => MOODLE_NOW } });
  await services.vault.set(LMS_VAULT.moodle, { token: moodle.fixture.token.token, baseUrl: BASE, connectedAt: MOODLE_NOW.toISOString() } satisfies MoodleCredential);
  const source = new MoodleSync(services);
  const status = await source.sync();
  assert.equal(status.state, "needs_reconnect");
  assert.match(status.lastError ?? "", /需要重新連線/);
  const calls = moodle.calls.length;
  source.schedule();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(moodle.calls.length, calls, "background retries stop until the user reconnects");
  await source.close();
});

test("a Moodle sync forgets 標為已交 once the LMS shows the submission", async (t) => {
  const moodle = fakeMoodle();
  const services = testServices(t, { seams: { fetch: moodle.fetch, now: () => MOODLE_NOW } });
  await services.vault.set(LMS_VAULT.moodle, { token: moodle.fixture.token.token, baseUrl: BASE, connectedAt: MOODLE_NOW.toISOString() } satisfies MoodleCredential);
  const mark = (itemId: string, fingerprint: string) => services.itemState.record({
    itemId, kind: "assignment", action: "submitted", title: "作業", closes: true, state: { state: "dismissed", fingerprint },
  });
  mark("moodle:30800", "2026-10-28T15:59:00.000Z|not-submitted");
  mark("moodle:30512", "2026-10-12T15:59:00.000Z|not-submitted");
  const source = new MoodleSync(services);
  assert.equal((await source.sync()).state, "ok");
  assert.equal(services.itemState.get("moodle:30800"), undefined, "Moodle agrees: the local mark is cleared");
  assert.equal(services.itemState.get("moodle:30512")?.state, "dismissed", "still local until Moodle shows it");
  assert.equal(services.sourceItems.count("moodle", "assignment"), 5);
  await source.close();
});

test("Moodle: an offline assignment is unknown (not 未交) until graded, and drops out once its deadline passed ungraded", async () => {
  const moodle = fakeMoodle();
  const assignments = structuredClone(moodle.fixture.assignments);
  const course = assignments.courses[0];
  course.assignments.push(
    { id: 777, cmid: 40777, course: course.id, name: "期中報告（紙本繳交）", duedate: Math.floor(Date.parse("2026-10-20T15:59:00Z") / 1000), nosubmissions: 1 },
    { id: 778, cmid: 40778, course: course.id, name: "口頭報告", duedate: Math.floor(Date.parse("2026-10-05T15:59:00Z") / 1000), nosubmissions: 1 },
    { id: 779, cmid: 40779, course: course.id, name: "書面心得", duedate: Math.floor(Date.parse("2026-10-06T15:59:00Z") / 1000), nosubmissions: 1 },
  );
  const statuses: Record<string, unknown> = { ...moodle.fixture.statuses, 777: { lastattempt: { submissionsenabled: false, gradingstatus: "notgraded" } }, 778: { lastattempt: { submissionsenabled: false, gradingstatus: "notgraded" } }, 779: { lastattempt: { submissionsenabled: false, gradingstatus: "released" } } };
  const fake = fakeMoodle({ answers: { mod_assign_get_assignments: assignments } });
  const fetch: typeof fake.fetch = async (input, init) => {
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("wsfunction") === "mod_assign_get_submission_status") return new Response(JSON.stringify(statuses[form.get("assignid") ?? ""] ?? { warnings: [] }), { headers: { "content-type": "application/json" } });
    return fake.fetch(input, init);
  };
  const http = (url: string | URL, init?: Parameters<typeof safeFetch>[3]) => safeFetch(fetch, url, new AbortController().signal, init);
  const byId = new Map((await fetchMoodleAssignments(http, { token: moodle.fixture.token.token, baseUrl: BASE, connectedAt: MOODLE_NOW.toISOString() }, MOODLE_NOW)).map((item) => [item.externalId, item]));
  assert.equal(byId.get("40777")?.submission, "unknown", "nothing to submit online: never 未交");
  assert.equal(byId.has("40778"), false, "an ungraded offline assignment past its deadline is dropped");
  assert.equal(byId.get("40779")?.submission, "graded", "the marking workflow's released counts as graded");
  assert.equal(submissionFrom({ lastattempt: { gradingstatus: "released" } }, true), "graded");
  assert.equal(submissionFrom(undefined, true, true), "unknown");
});

test("Moodle: action events are read page by page with aftereventid", async () => {
  const moodle = fakeMoodle();
  const event = (id: number) => ({ id, name: `Quiz ${id}`, activityname: `Quiz ${id}`, modulename: "quiz", instance: id, timesort: Math.floor(MOODLE_NOW.getTime() / 1000) + id * 3600, url: `${BASE}/mod/quiz/view.php?id=${id}`, course: { id: 101, fullname: "作業系統" }, action: { actionable: true } });
  const pages: Record<string, unknown> = {
    "": { events: Array.from({ length: 50 }, (_, index) => event(index + 1)), firstid: 1, lastid: 50 },
    "50": { events: Array.from({ length: 12 }, (_, index) => event(index + 51)), firstid: 51, lastid: 62 },
  };
  const seen: string[] = [];
  const fetch: typeof moodle.fetch = async (input, init) => {
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("wsfunction") === "core_calendar_get_action_events_by_timesort") {
      seen.push(form.get("aftereventid") ?? "");
      assert.equal(form.get("limitnum"), "50");
      return new Response(JSON.stringify(pages[form.get("aftereventid") ?? ""]), { headers: { "content-type": "application/json" } });
    }
    return moodle.fetch(input, init);
  };
  const http = (url: string | URL, init?: Parameters<typeof safeFetch>[3]) => safeFetch(fetch, url, new AbortController().signal, init);
  const assignments = await fetchMoodleAssignments(http, { token: moodle.fixture.token.token, baseUrl: BASE, connectedAt: MOODLE_NOW.toISOString() }, MOODLE_NOW);
  assert.deepEqual(seen, ["", "50"]);
  assert.equal(assignments.filter((item) => item.externalId.startsWith("event-")).length, 62);
});

test("Moodle: an expired token (accessexception, then invalidtoken) asks to reconnect on the first sync; token.php errors say what to do", async (t) => {
  const moodle = fakeMoodle();
  let expired = false;
  const fetch: typeof moodle.fetch = async (input, init) => {
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("wsfunction")) {
      const answer = expired ? { exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token - token not found" } : { exception: "webservice_access_exception", errorcode: "accessexception", message: "Access control exception" };
      expired = true; // Moodle deleted the expired token while refusing the first call.
      return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    }
    return moodle.fetch(input, init);
  };
  const services = testServices(t, { seams: { fetch, now: () => MOODLE_NOW } });
  await services.vault.set(LMS_VAULT.moodle, { token: moodle.fixture.token.token, baseUrl: BASE, connectedAt: MOODLE_NOW.toISOString() } satisfies MoodleCredential);
  const source = new MoodleSync(services);
  t.after(() => source.close());
  assert.equal((await source.sync()).state, "needs_reconnect");

  for (const [code, pattern] of [["passwordisexpired", /密碼已過期/], ["usernotconfirmed", /電子郵件確認/], ["sitemaintenance", /維護中/]] as const) {
    const failing = fakeMoodle({ tokenError: code });
    const http = (url: string | URL, init?: Parameters<typeof safeFetch>[3]) => safeFetch(failing.fetch, url, new AbortController().signal, init);
    await assert.rejects(moodleToken(http, BASE, "u", "p"), pattern);
  }
});
