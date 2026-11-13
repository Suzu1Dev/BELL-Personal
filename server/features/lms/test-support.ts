import { readFileSync } from "node:fs";
import type { FetchLike } from "../../sync.js";

/**
 * Fake LMS servers for tests: they answer from the JSON fixtures in
 * ./fixtures and record every request, so tests can assert what was sent
 * (and that a password never travels anywhere but login/token.php).
 */

export interface RecordedRequest {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

export const MOODLE_NOW = new Date("2026-10-12T00:42:00Z");

export function loadFixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function record(calls: RecordedRequest[], input: string | URL, init?: RequestInit): RecordedRequest {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
  const entry = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "", headers };
  calls.push(entry);
  return entry;
}

export interface MoodleFakeOptions {
  /** login/token.php answers with this errorcode instead of a token. */
  tokenError?: string;
  /** Every web-service call answers {exception, errorcode: "invalidtoken"}. */
  invalidToken?: boolean;
  /** Override answers per wsfunction. */
  answers?: Record<string, unknown>;
}

export function fakeMoodle(options: MoodleFakeOptions = {}) {
  const fixture = loadFixture("moodle.json");
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = record(calls, input, init);
    const url = new URL(call.url);
    if (url.pathname.endsWith("/login/token.php")) {
      if (options.tokenError) return json({ error: "Invalid login, please try again", errorcode: options.tokenError, stacktrace: null, debuginfo: null });
      return json(fixture.token);
    }
    if (url.pathname.endsWith("/webservice/rest/server.php")) {
      const form = new URLSearchParams(call.body);
      const wsfunction = form.get("wsfunction") ?? "";
      if (options.invalidToken || form.get("wstoken") !== fixture.token.token)
        return json({ exception: "moodle_exception", errorcode: "invalidtoken", message: "Invalid token - token not found" });
      if (options.answers && wsfunction in options.answers) return json(options.answers[wsfunction]);
      switch (wsfunction) {
        case "core_webservice_get_site_info": return json(fixture.siteInfo);
        case "core_course_get_enrolled_courses_by_timeline_classification": return json(fixture.courses);
        case "core_calendar_get_action_events_by_timesort": return json(fixture.events);
        case "mod_assign_get_assignments": return json(fixture.assignments);
        case "mod_assign_get_submission_status": return json(fixture.statuses[form.get("assignid") ?? ""] ?? { warnings: [] });
        default: return json({ exception: "webservice_access_exception", errorcode: "accessexception", message: "Access control exception" });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls, fixture };
}

export interface CanvasFakeOptions {
  /** Every request answers 401 (a revoked token). */
  unauthorized?: boolean;
}

export function fakeCanvas(options: CanvasFakeOptions = {}) {
  const fixture = loadFixture("canvas.json");
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call = record(calls, input, init);
    const url = new URL(call.url);
    if (options.unauthorized || call.headers.authorization !== `Bearer ${fixture.token}`)
      return json({ errors: [{ message: "Invalid access token." }] }, 401);
    if (url.pathname === "/api/v1/users/self") return json(fixture.self);
    if (url.pathname === "/api/v1/planner/items") {
      if (url.searchParams.get("page") === "2") return json(fixture.plannerPage2);
      const next = `https://cool.ntu.edu.tw/api/v1/planner/items?page=2&per_page=100`;
      return json(fixture.plannerPage1, 200, { link: `<${next}>; rel="next", <https://cool.ntu.edu.tw/api/v1/planner/items?page=1&per_page=100>; rel="first"` });
    }
    if (url.pathname === "/api/v1/users/self/missing_submissions") return json(fixture.missing);
    return json({ errors: [{ message: "not found" }] }, 404);
  };
  return { fetch, calls, fixture };
}
