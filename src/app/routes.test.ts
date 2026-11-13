/**
 * Route-level code splitting (src/app/routes.tsx): Today and the 404 stay in
 * the main bundle, every other page has a chunk; while one loads, <main>
 * shows the page's own head and the row skeletons; a chunk that fails shows
 * 「無法載入這個頁面」 with 重新載入, and opening another page clears it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGE_HEADS, ROUTE_LOAD } from "../copy/common";
import { pageKey, parseHash, type Route } from "../lib/router";
import { PAGE_LOADERS, RouteErrorBoundary, RouteFallback, RouteLoadFailed, RoutePage, fallbackHead, lazyPageOf } from "./routes";

const ROUTES: Route[] = [
  "#/today", "#/bot", "#/inbox", "#/inbox/t1?view=archive", "#/calendar?view=week", "#/tasks", "#/tasks/abc", "#/work", "#/work?tab=github",
  "#/work/projects/p1", "#/events", "#/events/e1", "#/ideas", "#/ideas/i1", "#/habits", "#/settings/privacy",
  "#/settings/sources/google", "#/setup", "#/guide", "#/nope",
].map(parseHash);

test("Today and the 404 are in the main bundle; every other route names a chunk, with the head its page shows first", () => {
  for (const route of ROUTES) {
    const chunk = lazyPageOf(route);
    if (route.name === "today" || route.name === "not-found") {
      assert.equal(chunk, undefined, route.name);
      assert.equal(fallbackHead(route), undefined, route.name);
      continue;
    }
    assert.ok(chunk && chunk in PAGE_LOADERS, `${route.name} has a loader`);
    assert.ok(fallbackHead(route), `${route.name} has a fallback head`);
  }
  assert.equal(lazyPageOf({ name: "project", id: "p1" }), "work");
  assert.equal(lazyPageOf({ name: "google-guide" }), "settings");
  assert.equal(fallbackHead({ name: "settings", tab: "brief" })?.title, PAGE_HEADS.settings.title);
  assert.equal(fallbackHead({ name: "google-guide" })?.title, PAGE_HEADS.googleGuide.title);
  assert.deepEqual(Object.keys(PAGE_LOADERS).sort(), ["bot", "calendar", "events", "guide", "habits", "ideas", "inbox", "settings", "setup", "tasks", "work"]);
});

test("the 404 renders at once; a page whose chunk has not arrived shows its head and the skeleton, rows hidden at first", () => {
  const missing = renderToStaticMarkup(createElement(RoutePage, { route: { name: "not-found", path: "/nope" } }));
  assert.match(missing, new RegExp(PAGE_HEADS.notFound.title));
  assert.doesNotMatch(missing, /route-fallback/);

  const habits = renderToStaticMarkup(createElement(RoutePage, { route: { name: "habits" } }));
  assert.match(habits, /class="route-fallback" aria-busy="true"/);
  assert.match(habits, new RegExp(`<h1 class="page-title kp">${PAGE_HEADS.habits.title}</h1>`));
  assert.match(habits, /class="card route-fallback-rows" aria-hidden="true" style="visibility:hidden"/, "no skeleton flash on a fast load");
  assert.equal((habits.match(/class="skel-row"/g) ?? []).length, 3);
  assert.match(habits, /<span class="sr-only" role="status"><\/span>/);
});

test("after the short delay the rows show and 「正在載入這一頁…」 is announced", () => {
  const html = renderToStaticMarkup(createElement(RouteFallback, { route: { name: "tasks", id: "abc" }, rowsShown: true }));
  assert.match(html, new RegExp(PAGE_HEADS.tasks.title));
  assert.doesNotMatch(html, /visibility:hidden/);
  assert.match(html, new RegExp(`role="status">${ROUTE_LOAD.loading}</span>`));
  assert.equal(ROUTE_LOAD.loading, "正在載入這一頁…");
  const project = renderToStaticMarkup(createElement(RouteFallback, { route: { name: "project", id: "p1" }, rowsShown: true }));
  assert.match(project, /<h1 class="page-title kp"><span class="sr-only">專案<\/span><\/h1>/, "the project head matches ProjectDetail's loading head");
});

test("a failed chunk shows 「無法載入這個頁面」 with 重新載入; opening another page clears it without remounting a working page", () => {
  const html = renderToStaticMarkup(createElement(RouteLoadFailed, {}));
  assert.match(html, /class="notice notice-error route-failed" role="alert"/);
  assert.match(html, /<b>無法載入這個頁面<\/b>/);
  assert.match(html, /<button[^>]*class="btn btn-secondary btn-sm"[^>]*>.*重新載入<\/button>/);
  assert.match(html, new RegExp(ROUTE_LOAD.failedHint));

  assert.deepEqual(RouteErrorBoundary.getDerivedStateFromError(), { failed: true });
  const key = pageKey({ name: "inbox" });
  assert.equal(RouteErrorBoundary.getDerivedStateFromProps({ resetKey: key, children: null }, { failed: true, resetKey: key }), null, "the same page keeps the failure");
  assert.equal(pageKey({ name: "inbox", threadId: "t1" }), key, "opening a conversation is the same page");
  assert.deepEqual(RouteErrorBoundary.getDerivedStateFromProps({ resetKey: "tasks", children: null }, { failed: true, resetKey: key }), { failed: false, resetKey: "tasks" });

  const boundary = new RouteErrorBoundary({ resetKey: key, children: "page" });
  assert.equal(boundary.render(), "page");
  boundary.state = { failed: true, resetKey: key };
  const failed = boundary.render() as { type: unknown };
  assert.equal(failed.type, RouteLoadFailed);
});
