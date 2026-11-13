import test from "node:test";
import assert from "node:assert/strict";
import { allowedSuiteRoute } from "../../shared/suite.js";
import { parseTodayFeed, validHref } from "./feed.js";
import { EMPTY_FEED, VALID_FEED } from "./test-fixtures.js";

const clone = <T>(value: T): T => structuredClone(value);

test("the contract's valid feeds parse into an equal, fresh copy", () => {
  for (const feed of [VALID_FEED, EMPTY_FEED, { ...clone(VALID_FEED), items: [], counts: {} }]) {
    const checked = parseTodayFeed(clone(feed), "explain");
    assert.equal(checked.ok, true);
    if (checked.ok) assert.deepEqual(checked.feed, feed);
  }
  const withDue = clone(VALID_FEED);
  withDue.items[0]!.dueAt = "2026-11-08T15:59:59Z";
  assert.equal(parseTodayFeed(withDue, "explain").ok, true);
});

test("every invalid feed of the contract (invalid.json) is refused whole", () => {
  const item = (patch: Record<string, unknown>) => {
    const feed = clone(VALID_FEED) as unknown as Record<string, any>;
    Object.assign(feed.items[0], patch);
    return feed;
  };
  const top = (patch: Record<string, unknown>) => ({ ...clone(VALID_FEED), ...patch });
  const cases: Array<[string, unknown, "invalid" | "version"]> = [
    ["feed leaks the answer", item({ answer: "F(ω)=∫f(t)e^{-iωt}dt" }), "invalid"],
    ["feed carries hints at the top level", top({ hints: ["積分"] }), "invalid"],
    ["absolute href", item({ href: "https://evil.example/#/review" }), "invalid"],
    ["protocol-relative href", item({ href: "#//evil.example" }), "invalid"],
    ["encoded slash href", item({ href: "#/%2Fevil.example" }), "invalid"],
    ["javascript href", item({ href: "javascript:alert(1)" }), "invalid"],
    ["CRLF in href", item({ href: "#/a%0d%0aSet-Cookie" }), "invalid"],
    ["backslash href", item({ href: "#/\\evil" }), "invalid"],
    ["href not among Explain's routes", item({ href: "#/settings" }), "invalid"],
    ["href with a query", item({ href: "#/review?x=1" }), "invalid"],
    ["href with an encoded slash in the id", item({ href: "#/note/a%2Fb" }), "invalid"],
    ["href to a dot-dot note", item({ href: "#/note/.." }), "invalid"],
    ["title too long", item({ title: "長".repeat(121) }), "invalid"],
    ["title with RTL override", item({ title: "今日\u202e複習" }), "invalid"],
    ["title with newline", item({ title: "今日\n複習" }), "invalid"],
    ["blank title", item({ title: "  " }), "invalid"],
    ["detail too long", item({ detail: "字".repeat(81) }), "invalid"],
    ["id with spaces", item({ id: "a b" }), "invalid"],
    ["unknown state", item({ state: "overdue" }), "invalid"],
    ["item from another app", item({ sourceApp: "pr" }), "invalid"],
    ["local time without Z", item({ updatedAt: "2026-11-08T13:30:00+08:00" }), "invalid"],
    ["six items", top({ items: Array.from({ length: 6 }, (_, index) => ({ ...VALID_FEED.items[0], id: `item-${index}` })) }), "invalid"],
    ["nine counts", top({ counts: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`c${index}`, 1])) }), "invalid"],
    ["negative count", top({ counts: { due: -1 } }), "invalid"],
    ["fractional count", top({ counts: { due: 1.5 } }), "invalid"],
    ["count over the maximum", top({ counts: { due: 100_001 } }), "invalid"],
    ["count key with a dash", top({ counts: { "due-now": 1 } }), "invalid"],
    ["feed of another app", top({ appId: "pr", items: [] }), "invalid"],
    ["feed claiming to be Personal", top({ appId: "personal", items: [] }), "invalid"],
    ["truncated as a string", top({ truncated: "false" }), "invalid"],
    ["schemaVersion as a string", top({ schemaVersion: "1" }), "invalid"],
    ["unknown version", top({ schemaVersion: 2 }), "version"],
    ["not an object", [VALID_FEED], "invalid"],
    ["null", null, "invalid"],
    ["a __proto__ key", JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(VALID_FEED).slice(1)}`), "invalid"],
  ];
  for (const [name, value, reason] of cases) assert.deepEqual(parseTodayFeed(value, "explain"), { ok: false, reason }, name);
});

test("hrefs are relative hash routes inside the sibling's own origin", () => {
  for (const href of ["#/review", "#/note/abc-1", "#/explain?text=a+b&from=personal", "#/", "#/a%20b"]) assert.equal(validHref(href), true, href);
  for (const href of ["", "#", "/review", "#review", "#//x", "#/a//b", "#/%2F%2Fx", "#/%5Cx", "#/%e0%a4%a", "#/a b", "#/a\u202e", `#/${"a".repeat(511)}`, 42])
    assert.equal(validHref(href), false, String(href));
});

test("contract §5.1: an item href must be exactly one of the sender's allowed routes", () => {
  const withHref = (href: string) => {
    const feed = clone(VALID_FEED);
    feed.items[1]!.href = href;
    return feed;
  };
  for (const href of ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/b:c.d_e-f", `#/note/${"a".repeat(128)}`])
    assert.equal(parseTodayFeed(withHref(href), "explain").ok, true, href);
  for (const href of ["#/note/", "#/note/.", "#/note/a/b", "#/note/a%3Ab", `#/note/${"a".repeat(129)}`, "#/library/", "#/explain?text=a", "#/tasks", "#/a%20b"])
    assert.deepEqual(parseTodayFeed(withHref(href), "explain"), { ok: false, reason: "invalid" }, href);
  // Explain routes (#/review) are rejected for BELL PR, while PR's own #/runs/{id} and #/repos/{id} routes pass.
  const pr = { ...clone(VALID_FEED), appId: "pr", items: [{ ...VALID_FEED.items[0]!, sourceApp: "pr" }] };
  assert.deepEqual(parseTodayFeed(pr, "pr"), { ok: false, reason: "invalid" });
  assert.equal(parseTodayFeed({ ...pr, items: [{ ...VALID_FEED.items[0]!, sourceApp: "pr", href: "#/runs/run_1" }] }, "pr").ok, true);
  assert.equal(parseTodayFeed({ ...pr, items: [] }, "pr").ok, true);
  assert.equal(allowedSuiteRoute("personal", "#/events/ics:feed-1:abc"), true);
  assert.equal(allowedSuiteRoute("personal", "#/settings"), false);
});

test("contract §5.1: an item id outside the object-id rule, or its href, makes the whole feed invalid", () => {
  const outside = [".", "..", "a/b", "a%2Fb", "50%", "a b", "筆記", "x".repeat(129), ""];
  for (const id of outside) {
    const feed = clone(VALID_FEED);
    feed.items[1]!.id = id;
    feed.items[1]!.href = "#/library";
    // "." and ".." are object ids; only a route's {id} may not be one.
    assert.equal(parseTodayFeed(feed, "explain").ok, id === "." || id === "..", `id ${id}`);
    for (const href of [`#/note/${id}`, `#/note/${encodeURIComponent(id)}`]) {
      const withHref = clone(VALID_FEED);
      withHref.items[1]!.href = href;
      assert.deepEqual(parseTodayFeed(withHref, "explain"), { ok: false, reason: "invalid" }, href);
    }
  }
  const longest = clone(VALID_FEED);
  longest.items[1]!.id = "y".repeat(128);
  longest.items[1]!.href = `#/note/${"y".repeat(128)}`;
  assert.equal(parseTodayFeed(longest, "explain").ok, true);
});
