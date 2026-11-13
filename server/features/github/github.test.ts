import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { GitHubItem, GitHubOverview } from "../../../shared/github.js";
import type { TodayPayload } from "../../../shared/today.js";
import { appContext } from "../../app.js";
import { AppError } from "../../errors.js";
import { fakeCommand, startTestServer, testServices, type RecordedCall } from "../../test-helpers.js";
import { githubModule } from "./index.js";
import { GH_RECONNECT_MESSAGE, GITHUB_QUERY, GitHubSync, ghFailure, notificationUrl, parseGraphQL, parseIncluded, readCursor, type GraphQLAnswer } from "./sync.js";
import { githubToday } from "./today.js";

const NOW = new Date("2026-10-12T00:42:00Z");
const TZ = "Asia/Taipei";
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const GRAPHQL = fixture<GraphQLAnswer>("graphql.json");
const NOTIFICATIONS = fixture<unknown[]>("notifications.json");
const LAST_MODIFIED = "Mon, 12 Oct 2026 00:30:00 GMT";

interface GhOptions {
  notifications: 200 | 304 | 401;
  graphql: "ok" | "auth" | "broken";
  loggedIn: boolean;
}

/** A gh CLI that answers like the real one (validated on this host: 304 exits 1 with the headers on stdout). */
function fakeGh(initial: Partial<GhOptions> = {}) {
  const options: GhOptions = { notifications: 200, graphql: "ok", loggedIn: true, ...initial };
  const gh = fakeCommand((call: RecordedCall) => {
    const args = call.args;
    if (args[0] === "auth") return options.loggedIn ? "github.com\n  ✓ Logged in to github.com account Suzu1Dev" : { stdout: "", stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login", code: 1 };
    if (args[0] === "api" && args[1] === "graphql") {
      if (options.graphql === "auth") throw new AppError(422, "gh 執行失敗：HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login");
      if (options.graphql === "broken") throw new AppError(422, "gh 執行失敗：Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host");
      return JSON.stringify(GRAPHQL);
    }
    if (args.includes("--include")) {
      if (options.notifications === 304) return { stdout: `HTTP/2.0 304 Not Modified\nLast-Modified: ${LAST_MODIFIED}\nX-Poll-Interval: 60\n\n`, stderr: "gh: HTTP 304", code: 1 };
      if (options.notifications === 401) return { stdout: "HTTP/2.0 401 Unauthorized\nContent-Type: application/json\n\n{\"message\":\"Bad credentials\"}", stderr: "gh: Bad credentials (HTTP 401)", code: 1 };
      return `HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\nLast-Modified: ${LAST_MODIFIED}\nX-Poll-Interval: 60\n\n${JSON.stringify(NOTIFICATIONS)}`;
    }
    if (args.includes("PATCH")) return "";
    return undefined;
  });
  return { ...gh, options };
}

const callsOf = (calls: RecordedCall[], match: (args: string[]) => boolean) => calls.filter((call) => match(call.args));
const isGraphql = (args: string[]) => args[1] === "graphql";
const isNotifications = (args: string[]) => args.includes("--include");
const isPatch = (args: string[]) => args.includes("PATCH");

test("the GraphQL answer maps to PRs, review requests, issues and contribution days", () => {
  const parsed = parseGraphQL(GRAPHQL, NOW);
  assert.equal(parsed.login, "Suzu1Dev");
  assert.equal(parsed.contributions.length, 16);
  assert.deepEqual(parsed.contributions.at(-1), { date: "2026-10-12", count: 1 });
  const byId = new Map(parsed.items.map((item) => [item.id, item]));
  assert.deepEqual([...byId.keys()], [
    "pr:PR_kwDOVite18234", "pr:PR_kwDOBell42", "pr:PR_kwDOCtf7", "pr:PR_kwDODraft9", "review-request:PR_kwDOSitcon127", "issue:I_kwDOBell9",
  ], "an empty search node is skipped");
  const changes = byId.get("pr:PR_kwDOBell42")!;
  assert.equal(changes.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(changes.changesRequestedBy, "yuchen");
  assert.equal(changes.changesRequestedAt, "2026-10-11T11:30:00.000Z");
  assert.equal(changes.checks, "SUCCESS");
  assert.equal(byId.get("pr:PR_kwDOCtf7")!.checks, "FAILURE");
  const review = byId.get("review-request:PR_kwDOSitcon127")!;
  assert.deepEqual(
    { repo: review.repo, number: review.number, author: review.author, additions: review.additions, deletions: review.deletions, requestedAt: review.requestedAt },
    { repo: "sitcon-tw/2027.sitcon.org", number: 127, author: "yuchen", additions: 142, deletions: 38, requestedAt: "2026-10-11T00:00:00.000Z" },
    "the request time is the one for the viewer, not a later one for someone else",
  );
  assert.equal(byId.get("issue:I_kwDOBell9")!.kind, "issue");
  assert.match(GITHUB_QUERY, /review-requested:@me/);
});

test("notification helpers: API subject URLs become pages; --include output is split into status, headers and body", () => {
  assert.deepEqual(notificationUrl({ subject: { url: "https://api.github.com/repos/o/r/pulls/7" }, repository: { full_name: "o/r" } }), { url: "https://github.com/o/r/pull/7", number: 7 });
  assert.deepEqual(notificationUrl({ subject: { url: "https://api.github.com/repos/o/r/commits/abc123" }, repository: { full_name: "o/r" } }), { url: "https://github.com/o/r/commit/abc123" });
  assert.deepEqual(notificationUrl({ subject: { url: null, type: "CheckSuite" }, repository: { full_name: "o/r", html_url: "https://github.com/o/r" } }), { url: "https://github.com/o/r/actions" });
  const included = parseIncluded("HTTP/2.0 304 Not Modified\r\nLast-Modified: x\r\nX-Poll-Interval: 120\r\n\r\n");
  assert.equal(included?.status, 304);
  assert.equal(included?.headers.get("x-poll-interval"), "120");
  assert.equal(parseIncluded("gh: something broke"), undefined);
  assert.deepEqual(readCursor("not json"), {});
});

test("a sync stores everything, sends If-Modified-Since, keeps notifications on a 304 and honours X-Poll-Interval", async (t) => {
  let now = NOW;
  const gh = fakeGh();
  const services = testServices(t, { seams: { command: gh.runner, now: () => now } });
  const source = new GitHubSync(services);
  t.after(() => source.close());

  const first = await source.sync();
  assert.equal(first.state, "ok", first.lastError ?? "");
  assert.equal(first.items, 10, "6 GraphQL items + 4 notifications");
  assert.equal(services.sourceItems.count("github", "contribution-day"), 16);
  const graphCall = callsOf(gh.calls, isGraphql)[0];
  assert.equal(graphCall.executable, services.config.ghPath);
  assert.deepEqual(graphCall.args.slice(0, 3), ["api", "graphql", "-f"]);
  assert.ok(!("BELLPERSONAL_MASTER_KEY" in (graphCall.options.env ?? {})), "gh never sees the service environment");
  assert.equal(callsOf(gh.calls, isNotifications)[0].args.includes("-H"), false, "the first fetch is unconditional");
  assert.equal(source.login(), "Suzu1Dev");
  const cursor = readCursor(services.syncState.get("github")?.cursor);
  assert.deepEqual(cursor.notifications, { lastModified: LAST_MODIFIED, pollIntervalSec: 60, fetchedAt: NOW.toISOString() });

  // Within GitHub's poll interval only GraphQL runs.
  now = new Date(NOW.getTime() + 30_000);
  assert.equal((await source.sync()).state, "ok");
  assert.equal(callsOf(gh.calls, isGraphql).length, 2);
  assert.equal(callsOf(gh.calls, isNotifications).length, 1, "X-Poll-Interval: 60 is honoured");

  // After it, a conditional request; a 304 keeps the cached threads.
  now = new Date(NOW.getTime() + 5 * 60_000);
  gh.options.notifications = 304;
  const third = await source.sync();
  assert.equal(third.state, "ok", third.lastError ?? "");
  const conditional = callsOf(gh.calls, isNotifications)[1];
  assert.deepEqual(conditional.args.slice(-2), ["-H", `If-Modified-Since: ${LAST_MODIFIED}`]);
  assert.deepEqual(conditional.options.allowedCodes, [0, 1]);
  const notifications = services.sourceItems.list<GitHubItem>({ source: "github", kind: "github-item" }).map((item) => item.value).filter((item) => item.kind === "notification");
  assert.deepEqual(notifications.map((item) => item.id).sort(), ["notification:101", "notification:102", "notification:103", "notification:104"]);
  const release = notifications.find((item) => item.id === "notification:103")!;
  assert.equal(release.url, "https://github.com/vitejs/vite/releases");
  assert.equal(release.subjectType, "Release");
});

test("a dead gh login becomes needs_reconnect and no CLI output reaches the status", async (t) => {
  const gh = fakeGh({ graphql: "auth" });
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const source = new GitHubSync(services);
  t.after(() => source.close());
  const status = await source.sync();
  assert.equal(status.state, "needs_reconnect");
  assert.doesNotMatch(status.lastError ?? "", /Bad credentials|gh auth|https:/);
  // The fix is a new gh login on the host, not 連線與設定: the status says so, with no CLI output or path.
  assert.equal(status.lastError, GH_RECONNECT_MESSAGE);
  assert.equal((await source.status()).lastError, GH_RECONNECT_MESSAGE);
  assert.doesNotMatch(status.lastError ?? "", /連線與設定|\/|~|\$/);

  gh.options.graphql = "broken";
  source.reset();
  const broken = await source.sync();
  assert.equal(broken.state, "error");
  assert.equal(broken.lastError, "無法從 GitHub 取得資料，稍後會自動重試。");

  gh.options.graphql = "ok";
  gh.options.notifications = 401;
  source.reset();
  const notifications = await source.sync();
  assert.equal(notifications.state, "needs_reconnect", "a 401 on notifications too");
  assert.equal(notifications.lastError, GH_RECONNECT_MESSAGE);
});

test("the reconnect copy names the host and 重試, never raw gh output", () => {
  assert.equal(GH_RECONNECT_MESSAGE, "GitHub 連線已失效：請在執行 BELL Personal 的主機上重新登入 GitHub CLI，再按重試。");
  for (const raw of ["To get started with GitHub CLI, please run:  gh auth login", "HTTP 401: Bad credentials (https://api.github.com/graphql)", "You are not logged in to any GitHub hosts."]) {
    const error = ghFailure(raw);
    assert.equal(error.message, GH_RECONNECT_MESSAGE, raw);
    assert.doesNotMatch(error.message, /gh auth|https:|Bad credentials/);
  }
});

test("configured() asks gh auth status once and caches the answer", async (t) => {
  const gh = fakeGh({ loggedIn: false });
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const source = new GitHubSync(services);
  t.after(() => source.close());
  assert.equal(await source.configured(), false);
  assert.equal(await source.configured(), false);
  assert.equal(callsOf(gh.calls, (args) => args[0] === "auth").length, 1);
  assert.deepEqual(callsOf(gh.calls, (args) => args[0] === "auth")[0].args, ["auth", "status", "--hostname", "github.com"]);
  assert.equal((await source.status()).state, "not_configured");
});

test("today(): review and pr.changes rows, the waiting PR for 專案, and the work badge", async (t) => {
  const gh = fakeGh();
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const source = new GitHubSync(services);
  t.after(() => source.close());
  await source.sync();

  const today = githubToday(services, { now: NOW, timeZone: TZ });
  const review = today.queue!.find((row) => row.kind === "review")!;
  assert.equal(review.id, "github:PR_kwDOSitcon127");
  assert.equal(review.title, "審查 #127 新增議程頁深色模式");
  assert.deepEqual(review.meta, ["sitcon-tw/2027.sitcon.org", "yuchen 請你審查"]);
  assert.deepEqual(review.diff, { add: 142, del: 38 });
  assert.deepEqual(review.when, { label: "昨天", mono: false });
  assert.deepEqual(review.actions.map((action) => [action.id, action.label, action.touchLabel]), [["open", "開始審查", "審查"], ["reviewed", "標為已審查", "已審查"], ["snooze", "延後", "延後"]]);
  assert.deepEqual(review.hints, { receivedAt: "2026-10-11T00:00:00.000Z", fingerprint: "2026-10-11T00:00:00.000Z" });

  const changes = today.queue!.filter((row) => row.kind === "pr.changes");
  assert.deepEqual(changes.map((row) => [row.title, row.meta[1]]).sort(), [["修改 #42 Add the work page", "yuchen 要求修改"], ["修改 #7 Bump vite to 7.1", "檢查沒有通過"]], "a draft with failing checks is not asked for");
  assert.deepEqual(today.later?.projects, [{ name: "vitejs/vite #18234", next: "fix(css): preserve @layer order · 等待審查 3 天", pr: true, href: "https://github.com/vitejs/vite/pull/18234" }]);
  assert.equal(today.nav?.work, 1);

  const server = await startTestServer(t, services, { modules: [githubModule] });
  const payload = (await server.call("GET", "/api/today")).json as TodayPayload;
  const now = payload.queue.find((group) => group.group === "now")!.items.map((item) => item.id);
  assert.deepEqual(now.sort(), ["github:PR_kwDOBell42", "github:PR_kwDOCtf7", "github:PR_kwDOSitcon127"], "a review requested over 24 h ago and pr.changes are 最重要");
  assert.equal(payload.later.projects[0].pr, true);
});

test("標為已讀 on notification threads waits for the undo window, and 復原 means nothing reaches GitHub", async (t) => {
  const gh = fakeGh();
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [githubModule] });
  const source = appContext(server.app).modules.source("github")!;
  await source.sync();

  const accepted = await server.call("POST", "/api/actions", { body: { itemId: "github:digest-notifications-1", action: "read", params: { threads: ["101", "102"] } } });
  assert.equal(accepted.status, 202, accepted.text);
  assert.equal(accepted.json.label, "已將 2 則通知標為已讀");
  let overview = (await server.call("GET", "/api/github")).json as GitHubOverview;
  assert.deepEqual(overview.notifications.map((item) => item.id), ["notification:104", "notification:103"], "read threads leave the list at once");

  // A sync before the commit does not bring them back.
  await (source as GitHubSync).sync();
  overview = (await server.call("GET", "/api/github")).json as GitHubOverview;
  assert.equal(overview.notifications.length, 2);

  const undo = await server.call("DELETE", `/api/actions/${accepted.json.actionId}`, { body: {} });
  assert.equal(undo.status, 200, undo.text);
  overview = (await server.call("GET", "/api/github")).json as GitHubOverview;
  assert.equal(overview.notifications.length, 4);
  assert.equal(callsOf(gh.calls, isPatch).length, 0, "undo before the commit cancels the PATCH");

  const refused = await server.call("POST", "/api/actions", { body: { itemId: "github:digest-notifications-2", action: "read", params: { threads: ["12a"] } } });
  assert.equal(refused.status, 400);
});

test("標為已讀 commits PATCH notifications/threads/:id after the window", async (t) => {
  const gh = fakeGh();
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [githubModule], today: { commitMs: 20 } });
  await appContext(server.app).modules.source("github")!.sync();
  const accepted = await server.call("POST", "/api/actions", { body: { itemId: "github:digest-notifications-1", action: "read", params: { threads: ["103"] } } });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(callsOf(gh.calls, isPatch).map((call) => call.args), [["api", "--method", "PATCH", "notifications/threads/103"]]);
  assert.equal((await server.call("GET", `/api/actions/${accepted.json.actionId}`)).json.state, "committed");
});

test("GET /api/github lists reviews (with the local 已審查 mark), PRs, issues, unread threads and contributions", async (t) => {
  const gh = fakeGh();
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const server = await startTestServer(t, services, { modules: [githubModule] });
  await appContext(server.app).modules.source("github")!.sync();
  await server.call("GET", "/api/today");
  const reviewed = await server.call("POST", "/api/actions", { body: { itemId: "github:PR_kwDOSitcon127", action: "reviewed" } });
  assert.equal(reviewed.status, 202, reviewed.text);

  const overview = (await server.call("GET", "/api/github")).json as GitHubOverview;
  assert.equal(overview.login, "Suzu1Dev");
  assert.equal(overview.status.id, "github");
  assert.deepEqual(overview.reviewRequests.map((item) => [item.itemId, item.localReviewed]), [["github:PR_kwDOSitcon127", true]]);
  assert.deepEqual(overview.pullRequests.map((item) => item.number), [7, 42, 18234, 9]);
  assert.deepEqual(overview.issues.map((item) => item.number), [9]);
  assert.equal(overview.notifications.length, 4);
  assert.deepEqual(overview.contributions, { week: 14, month: 31 });
  assert.equal((await server.call("GET", "/api/today")).json.counts.nav.work, 0, "a review marked 已審查 leaves the badge");
});

test("a GraphQL answer with partial errors (a SAML-protected org) still syncs its data; exit 1 without data maps by stderr", async (t) => {
  const partial = structuredClone(GRAPHQL);
  partial.data!.assigned!.nodes = [...(partial.data!.assigned!.nodes ?? []), null];
  (partial as { errors?: unknown[] }).errors = [{ type: "FORBIDDEN", path: ["assigned", "nodes", 3], message: "Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization." }];
  let mode: "partial" | "unauthorized" = "partial";
  const gh = fakeCommand((call: RecordedCall) => {
    const args = call.args;
    if (args[0] === "auth") return "github.com\n  ✓ Logged in to github.com account Suzu1Dev";
    if (args[1] === "graphql") {
      assert.deepEqual(call.options.allowedCodes, [0, 1]);
      if (mode === "unauthorized") return { stdout: "{\"message\":\"Bad credentials\",\"documentation_url\":\"https://docs.github.com/graphql\"}", stderr: "gh: Bad credentials (HTTP 401)", code: 1 };
      return { stdout: JSON.stringify(partial), stderr: "gh: Resource protected by organization SAML enforcement.", code: 1 };
    }
    if (args.includes("--include")) return `HTTP/2.0 200 OK\nContent-Type: application/json\nLast-Modified: ${LAST_MODIFIED}\n\n${JSON.stringify(NOTIFICATIONS)}`;
    return undefined;
  });
  const services = testServices(t, { seams: { command: gh.runner, now: () => NOW } });
  const source = new GitHubSync(services);
  t.after(() => source.close());
  const status = await source.sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  assert.equal(status.items, 10, "the null node is skipped, the rest is kept");
  mode = "unauthorized";
  assert.equal((await source.sync()).state, "needs_reconnect");
});

test("a gh auth probe that times out is not 尚未設定, and a known answer is served while it refreshes", async (t) => {
  let now = NOW;
  let mode: "timeout" | "ok" | "hang" = "timeout";
  let release: (() => void) | undefined;
  const gh = fakeCommand(async (call: RecordedCall) => {
    if (call.args[0] !== "auth") return undefined;
    if (mode === "timeout") throw new AppError(504, "gh 執行逾時。");
    if (mode === "hang") await new Promise<void>((resolve) => { release = resolve; });
    return "github.com\n  ✓ Logged in to github.com account Suzu1Dev";
  });
  const services = testServices(t, { seams: { command: gh.runner, now: () => now } });
  const source = new GitHubSync(services);
  t.after(() => source.close());
  assert.equal(await source.configured(), true, "no answer: let run() try and report the problem");
  const probes = () => gh.calls.filter((call) => call.args[0] === "auth").length;
  assert.equal(probes(), 1);
  mode = "ok";
  now = new Date(NOW.getTime() + 61_000);
  assert.equal(await source.configured(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes(), 2, "retried after a minute, not ten");
  mode = "hang";
  now = new Date(NOW.getTime() + 20 * 60_000);
  const started = Date.now();
  assert.equal(await source.configured(), true, "the stale answer is served at once");
  assert.ok(Date.now() - started < 100);
  release?.();
});
