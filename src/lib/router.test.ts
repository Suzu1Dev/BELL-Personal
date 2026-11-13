import test from "node:test";
import assert from "node:assert/strict";
import { canonicalHash, navSection, pageKey, parseHash, routeHref, type Route } from "./router";

test("every SPEC-ux §3.1 route parses and round-trips through routeHref", () => {
  const cases: Array<[string, Route]> = [
    ["#/today", { name: "today" }],
    ["#/bot", { name: "bot" }],
    ["#/inbox", { name: "inbox" }],
    ["#/inbox/18f2a%2Fb", { name: "inbox", threadId: "18f2a/b" }],
    ["#/inbox?view=archive", { name: "inbox", view: "archive" }],
    ["#/inbox?view=all&q=HW5+%E4%BD%9C%E6%A5%AD", { name: "inbox", view: "all", q: "HW5 作業" }],
    ["#/inbox/18f2a?view=archive&q=from%3Acmlin", { name: "inbox", threadId: "18f2a", view: "archive", q: "from:cmlin" }],
    ["#/calendar", { name: "calendar", view: "day" }],
    ["#/calendar?view=week", { name: "calendar", view: "week" }],
    ["#/calendar?view=month", { name: "calendar", view: "month" }],
    ["#/tasks", { name: "tasks" }],
    ["#/work", { name: "work", tab: "assignments" }],
    ["#/work?tab=projects", { name: "work", tab: "projects" }],
    ["#/work?tab=github", { name: "work", tab: "github" }],
    ["#/work/projects/os-final", { name: "project", id: "os-final" }],
    ["#/work/projects/a%2Fb", { name: "project", id: "a/b" }],
    ["#/events", { name: "events" }],
    ["#/ideas", { name: "ideas" }],
    ["#/habits", { name: "habits" }],
    ["#/settings/sources", { name: "settings", tab: "sources" }],
    ["#/settings/roles", { name: "settings", tab: "roles" }],
    ["#/settings/ai", { name: "settings", tab: "ai" }],
    ["#/settings/brief", { name: "settings", tab: "brief" }],
    ["#/settings/appearance", { name: "settings", tab: "appearance" }],
    ["#/settings/privacy", { name: "settings", tab: "privacy" }],
    ["#/settings/sources/google", { name: "google-guide" }],
    ["#/setup", { name: "setup" }],
    ["#/guide", { name: "guide" }],
    ["#/nowhere", { name: "not-found", path: "/nowhere" }],
  ];
  for (const [hash, route] of cases) {
    assert.deepEqual(parseHash(hash), route, hash);
    assert.equal(routeHref(route), hash, `routeHref ${hash}`);
    assert.deepEqual(parseHash(routeHref(route)), route, `round-trip ${hash}`);
  }
});

test("lenient spellings resolve to the same routes", () => {
  const cases: Array<[string, Route]> = [
    ["", { name: "today" }],
    ["#", { name: "today" }],
    ["#/", { name: "today" }],
    ["#/calendar/", { name: "calendar", view: "day" }],
    ["#/calendar?view=year", { name: "calendar", view: "day" }],
    ["#/work?tab=nope", { name: "work", tab: "assignments" }],
    ["#/work/projects", { name: "work", tab: "projects" }],
    ["#/settings", { name: "settings", tab: "sources" }],
    ["#/settings/", { name: "settings", tab: "sources" }],
    ["#/guide#keys", { name: "guide" }],
    ["#/projects", { name: "work", tab: "projects" }],
    ["#/projects/os-final", { name: "project", id: "os-final" }],
  ];
  for (const [hash, route] of cases) assert.deepEqual(parseHash(hash), route, hash);
});

test("unknown and malformed paths are a 404, never a silent redirect", () => {
  for (const hash of ["#/settings/unknown", "#/settings/sources/github", "#/inbox/a/b", "#/today/extra", "#/work/projects/%E0%A4%A", "#/projects/a/b", "#/calendar/week"]) {
    assert.equal(parseHash(hash).name, "not-found", hash);
  }
  assert.deepEqual(parseHash("#/today/extra"), { name: "not-found", path: "/today/extra" });
});

test("canonicalHash rewrites the root and the legacy project routes only", () => {
  assert.equal(canonicalHash(""), "#/today");
  assert.equal(canonicalHash("#"), "#/today");
  assert.equal(canonicalHash("#/"), "#/today");
  assert.equal(canonicalHash("#/projects/os-final"), "#/work/projects/os-final");
  assert.equal(canonicalHash("#/projects"), "#/work?tab=projects");
  assert.equal(canonicalHash("#/work/projects"), "#/work?tab=projects");
  for (const hash of ["#/today", "#/inbox/abc", "#/work/projects/x", "#/calendar?view=week", "#/nowhere", "#/projects/a/b"]) {
    assert.equal(canonicalHash(hash), undefined, hash);
  }
});

test("navSection maps detail routes to their sidebar item", () => {
  assert.equal(navSection({ name: "project", id: "x" }), "work");
  assert.equal(navSection({ name: "google-guide" }), "settings");
  assert.equal(navSection({ name: "inbox", threadId: "t" }), "inbox");
  assert.equal(navSection({ name: "not-found", path: "/x" }), "not-found");
});

test("pageKey: tabs, views and inbox conversations stay on their page; detail routes are pages of their own", () => {
  const key = (hash: string) => pageKey(parseHash(hash));
  assert.equal(key("#/calendar?view=week"), key("#/calendar"));
  assert.equal(key("#/settings/brief"), key("#/settings/sources"));
  assert.equal(key("#/work?tab=github"), key("#/work"));
  assert.equal(key("#/inbox/18f2a"), key("#/inbox"));
  assert.equal(key("#/inbox?view=archive&q=hw"), key("#/inbox"), "a mail view or search keeps focus where it is");
  assert.notEqual(key("#/work/projects/os-final"), key("#/work"));
  assert.notEqual(key("#/work/projects/os-final"), key("#/work/projects/other"));
  assert.notEqual(key("#/settings/sources/google"), key("#/settings/sources"));
  assert.notEqual(key("#/today"), key("#/tasks"));
});

test("the inbox view and search live in the hash (SPEC-mail-assignments §1.1)", () => {
  assert.deepEqual(parseHash("#/inbox?view=inbox&q="), { name: "inbox" }, "the default view and an empty search are left out");
  assert.deepEqual(parseHash("#/inbox?view=spam"), { name: "inbox" }, "an unknown view falls back to 收件匣");
  assert.deepEqual(parseHash("#/inbox?q=%20%20hw5%20"), { name: "inbox", q: "hw5" });
  assert.equal((parseHash(`#/inbox?q=${"作".repeat(300)}`) as { q?: string }).q?.length, 200);
  assert.equal(routeHref({ name: "inbox", view: "inbox", q: "" }), "#/inbox");
  assert.equal(routeHref({ name: "inbox", view: "all", q: "作業" }), "#/inbox?view=all&q=%E4%BD%9C%E6%A5%AD");
  assert.equal(routeHref({ name: "inbox", threadId: "a/b", view: "archive" }), "#/inbox/a%2Fb?view=archive");
});

test("tasks, events and ideas deep-link one object by a single URI-decoded id", () => {
  const cases: Array<[string, Route]> = [
    ["#/tasks/t_abc123", { name: "tasks", id: "t_abc123" }],
    ["#/events/ctftime%3A123", { name: "events", id: "ctftime:123" }],
    ["#/events/feed%3Ankust%3Ak%2F1", { name: "events", id: "feed:nkust:k/1" }],
    ["#/ideas/x%2Fy", { name: "ideas", id: "x/y" }],
    ["#/ideas/%E9%BB%9E%E5%AD%90", { name: "ideas", id: "點子" }],
  ];
  for (const [hash, route] of cases) {
    assert.deepEqual(parseHash(hash), route, hash);
    assert.equal(routeHref(route), hash, `routeHref ${hash}`);
    assert.equal(navSection(route), route.name, `navSection ${hash}`);
    assert.equal(canonicalHash(hash), undefined, `canonicalHash ${hash}`);
  }
  assert.deepEqual(parseHash("#/tasks/abc/"), { name: "tasks", id: "abc" }, "a trailing slash is lenient");
  assert.equal(routeHref({ name: "tasks", id: "" }), "#/tasks", "an empty id is the list");
});

test("a malformed or multi-segment object id is a 404", () => {
  for (const hash of ["#/tasks/%E0%A4%A", "#/tasks/a/b", "#/events/%", "#/events/a/b/c", "#/ideas/%E0%A4%A", "#/ideas/a/b", "#/ideas/..", "#/tasks/.", "#/events/%2E%2E"]) {
    assert.equal(parseHash(hash).name, "not-found", hash);
    assert.equal(canonicalHash(hash), undefined, `${hash} keeps its URL`);
  }
  assert.deepEqual(parseHash("#/tasks/a/b"), { name: "not-found", path: "/tasks/a/b" });
});

test("opening an object keeps the page key, so focus and scroll are not reset", () => {
  const key = (hash: string) => pageKey(parseHash(hash));
  assert.equal(key("#/tasks/x"), key("#/tasks"));
  assert.equal(key("#/tasks/x"), key("#/tasks/y"));
  assert.equal(key("#/events/ctftime%3A1"), key("#/events"));
  assert.equal(key("#/ideas/i1"), key("#/ideas"));
  assert.notEqual(key("#/tasks/x"), key("#/ideas/x"));
});

test("the bare quick-add hash #/tasks?draft=…&from=…&back=… stays the list and is never rewritten", () => {
  const hash = "#/tasks?draft=%E8%AE%80%E8%AB%96%E6%96%87&from=explain&back=%23%2Finbox%2F18f2a";
  assert.deepEqual(parseHash(hash), { name: "tasks" });
  assert.equal(canonicalHash(hash), undefined);
  assert.deepEqual(parseHash("#/tasks?focus=t1"), { name: "tasks" }, "the older ?focus= link still lands on the list");
  assert.equal(canonicalHash("#/tasks?focus=t1"), undefined);
  assert.deepEqual(parseHash("#/ideas?draft=x&from=explain&back=%23%2Ftasks"), { name: "ideas" });
  assert.equal(canonicalHash("#/ideas?draft=x&from=explain&back=%23%2Ftasks"), undefined);
});
