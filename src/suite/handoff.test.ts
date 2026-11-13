/**
 * BELL Suite handoff rules (src/suite/handoff.ts): the contracts v1 vectors
 * for target personal (bell-suite/contracts/v1/fixtures/handoff.cases.json,
 * inlined — no cross-repo import), the SPEC §5.6 back routes, the one
 * sessionStorage key (a new draft replaces, never merges), the form's
 * starting values, and the 解釋這個 URL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  backUrlFor,
  clearTaskHandoff,
  clipUnits,
  draftFields,
  explainThisUrl,
  hasTaskHandoffParams,
  handoffKindFromBack,
  handoffSourceLine,
  parseTaskHandoff,
  readTaskHandoff,
  personalBackRoute,
  siblingRoute,
  TASK_HANDOFF_KEY,
  toStoredHandoff,
  validHref,
  writeTaskHandoff,
  type StoredTaskHandoff,
} from "./handoff";
import { explainThisHref } from "./ExplainThis";
import { sendToPrHref } from "./SendToPr";
import { routeHref } from "../lib/router";

const EXPLAIN = "http://127.0.0.1:21101";
const LINKS = { explain: EXPLAIN };

// contracts v1 handoff.cases.json, target "personal" (copied 2026-11-08, rev. d: D7, D9 and handoff attempts E1–E11).
const CASES: { case: string; hash: string; expect: null | { rejected: "duplicate" | "missing" | "from" | "empty" } | { from: string; text: string; truncated: boolean; backUrl?: string } }[] = [
  { case: "todo draft from Explain", hash: "#/tasks?draft=%E8%A4%87%E7%BF%92+%E5%82%85%E7%AB%8B%E8%91%89&from=explain&back=%23%2Fnote%2Fabc", expect: { from: "explain", text: "複習 傅立葉", truncated: false, backUrl: "http://127.0.0.1:21101/#/note/abc" } },
  { case: "E9 no handoff params", hash: "#/tasks", expect: null },
  { case: "unconfigured from", hash: "#/tasks?draft=x&from=pr", expect: { rejected: "from" } },
  { case: "missing from", hash: "#/tasks?draft=x", expect: { rejected: "from" } },
  { case: "from itself", hash: "#/tasks?draft=x&from=personal", expect: { rejected: "from" } },
  { case: "empty draft after cleaning", hash: "#/tasks?draft=%00%01+&from=explain", expect: { rejected: "empty" } },
  { case: "absolute back dropped, draft kept", hash: "#/tasks?draft=x&from=explain&back=https%3A%2F%2Fevil.example", expect: { from: "explain", text: "x", truncated: false } },
  { case: "protocol-relative back dropped", hash: "#/tasks?draft=x&from=explain&back=%2F%2Fevil.example", expect: { from: "explain", text: "x", truncated: false } },
  { case: "javascript back dropped", hash: "#/tasks?draft=x&from=explain&back=javascript%3Aalert(1)", expect: { from: "explain", text: "x", truncated: false } },
  { case: "CRLF back dropped", hash: "#/tasks?draft=x&from=explain&back=%23%2Fa%250d%250a", expect: { from: "explain", text: "x", truncated: false } },
  { case: "control and bidi characters stripped", hash: "#/tasks?draft=a%E2%80%AEb%07c%0Ad&from=explain", expect: { from: "explain", text: "abc\nd", truncated: false } },
  { case: "title ignored for tasks", hash: "#/tasks?draft=x&title=y&from=explain", expect: { from: "explain", text: "x", truncated: false } },
  { case: "back outside the sender's routes dropped (#/settings)", hash: "#/tasks?draft=x&from=explain&back=%23%2Fsettings", expect: { from: "explain", text: "x", truncated: false } },
  { case: "back naming the receiver's route dropped (#/tasks from explain)", hash: "#/tasks?draft=x&from=explain&back=%23%2Ftasks", expect: { from: "explain", text: "x", truncated: false } },
  { case: "percent in back dropped (double encoding)", hash: "#/tasks?draft=x&from=explain&back=%23%2Fnote%2F%252F%252Fevil", expect: { from: "explain", text: "x", truncated: false } },
  { case: "query in back dropped", hash: "#/tasks?draft=x&from=explain&back=%23%2Freview%3Fx%3D1", expect: { from: "explain", text: "x", truncated: false } },
  { case: "dot-dot id in back dropped", hash: "#/tasks?draft=x&from=explain&back=%23%2Fnote%2F..", expect: { from: "explain", text: "x", truncated: false } },
  { case: "512+ character back dropped", hash: `#/tasks?draft=x&from=explain&back=%23%2Fnote%2F${"a".repeat(506)}`, expect: { from: "explain", text: "x", truncated: false } },
  { case: "colon id in back kept", hash: "#/tasks?draft=x&from=explain&back=%23%2Fnote%2Fb%3Ac.d_e-f", expect: { from: "explain", text: "x", truncated: false, backUrl: "http://127.0.0.1:21101/#/note/b:c.d_e-f" } },
  { case: "plain allowed back kept", hash: "#/tasks?draft=x&from=explain&back=%23%2Flibrary", expect: { from: "explain", text: "x", truncated: false, backUrl: "http://127.0.0.1:21101/#/library" } },
  { case: "D9 duplicate draft rejected", hash: "#/tasks?draft=a&draft=b&from=explain", expect: { rejected: "duplicate" } },
  { case: "D9 duplicate from rejected though the first is linked", hash: "#/tasks?draft=x&from=explain&from=pr", expect: { rejected: "duplicate" } },
  { case: "D9 duplicate from rejected though the last is linked", hash: "#/tasks?draft=x&from=pr&from=explain", expect: { rejected: "duplicate" } },
  { case: "D9 duplicate from rejected even when both copies agree", hash: "#/tasks?draft=x&from=explain&from=explain", expect: { rejected: "duplicate" } },
  { case: "D9 duplicate back rejected, not only dropped", hash: "#/tasks?draft=x&from=explain&back=%23%2Flibrary&back=%23%2Freview", expect: { rejected: "duplicate" } },
  { case: "D9 an empty second back still counts", hash: "#/tasks?draft=x&from=explain&back=%23%2Flibrary&back=", expect: { rejected: "duplicate" } },
  { case: "D9 duplicate title rejected on tasks too", hash: "#/tasks?draft=x&title=a&title=b&from=explain", expect: { rejected: "duplicate" } },
  { case: "D9 duplicate text rejected on tasks too", hash: "#/tasks?draft=x&text=a&text=b&from=explain", expect: { rejected: "duplicate" } },
  { case: "D9 a percent-encoded key is the same key", hash: "#/tasks?draft=a&dr%61ft=b&from=explain", expect: { rejected: "duplicate" } },
  { case: "D9 a repeated unrelated key is ignored", hash: "#/tasks?draft=x&from=explain&utm=1&utm=2", expect: { from: "explain", text: "x", truncated: false } },
  { case: "E4 D9 a repeated from without a draft is still refused as a repeat", hash: "#/tasks?from=explain&from=pr", expect: { rejected: "duplicate" } },
  { case: "D7 LRM and RLM kept in the draft, overrides stripped", hash: "#/tasks?draft=%E2%80%8F%D7%A9%D7%9C%D7%95%D7%9D%E2%80%AE+%E2%80%8Eabc&from=explain", expect: { from: "explain", text: "\u200f\u05e9\u05dc\u05d5\u05dd \u200eabc", truncated: false } },
  { case: "E1 attempt: only from, no draft", hash: "#/tasks?from=explain", expect: { rejected: "missing" } },
  { case: "E2 attempt: only back and from, no draft", hash: "#/tasks?back=%23%2Flibrary&from=explain", expect: { rejected: "missing" } },
  { case: "E3 attempt: title and from, no draft (title is reserved on tasks too)", hash: "#/tasks?title=x&from=explain", expect: { rejected: "missing" } },
  { case: "E5 attempt: Explain's text key is not a to-do draft", hash: "#/tasks?text=a&from=explain", expect: { rejected: "missing" } },
  { case: "attempt: a reserved key without a value", hash: "#/tasks?back", expect: { rejected: "missing" } },
  { case: "attempt: a percent-encoded reserved key counts", hash: "#/tasks?fr%6Fm=explain", expect: { rejected: "missing" } },
  { case: "attempt: an empty draft key is empty, not missing", hash: "#/tasks?draft=&from=explain", expect: { rejected: "empty" } },
  { case: "E10 ordinary: Tasks' own group query is no handoff", hash: "#/tasks?group=someday", expect: null },
  { case: "ordinary: reserved keys are case-sensitive", hash: "#/tasks?Draft=x&From=explain", expect: null },
  { case: "E10 ordinary: a task deep link with from is no handoff", hash: "#/tasks/t-1?from=explain", expect: null },
  { case: "E11 ordinary: a query without reserved keys keeps the route", hash: "#/tasks?x=1", expect: null },
  { case: "E10 ordinary: Tasks' own focus query is no handoff", hash: "#/tasks?focus=t-1", expect: null },
];

for (const vector of CASES) {
  test(`contracts v1 vector: ${vector.case}`, () => {
    assert.deepEqual(parseTaskHandoff(vector.hash, LINKS), vector.expect ?? undefined);
    // rev. d: every vector that is not null is an attempt, so the capture clears the address and the older draft first.
    assert.equal(hasTaskHandoffParams(vector.hash), vector.expect !== null);
  });
}

test("contracts v1 vector: 2001 characters are clipped to 2000 and marked truncated", () => {
  const parsed = parseTaskHandoff(`#/tasks?draft=${"字".repeat(2001)}&from=explain`, LINKS);
  assert.ok(parsed && !("rejected" in parsed));
  assert.equal([...parsed.text].length, 2000);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.from, "explain");
});

test("2000 characters exactly are kept whole; code points are counted, not UTF-16 units", () => {
  const parsed = parseTaskHandoff(`#/tasks?draft=${encodeURIComponent("😀".repeat(2000))}&from=explain`, LINKS);
  assert.ok(parsed && !("rejected" in parsed));
  assert.equal([...parsed.text].length, 2000);
  assert.equal(parsed.truncated, false);
});

test("a sender the manifest does not link is rejected, even with a valid draft", () => {
  assert.deepEqual(parseTaskHandoff("#/tasks?draft=x&from=explain", {}), { rejected: "from" });
  assert.deepEqual(parseTaskHandoff("#/tasks?draft=x&from=nobody", LINKS), { rejected: "from" });
});

test("any reserved key on #/tasks is a handoff attempt (contract rev. d); other routes never are", () => {
  for (const hash of ["#/tasks?draft=x", "#/tasks?from=explain", "#/tasks?back=%23%2F", "#/tasks?title=y", "#/tasks?text=y", "#/tasks?draft="]) {
    assert.equal(hasTaskHandoffParams(hash), true, hash);
  }
  for (const hash of ["#/tasks", "#/tasks?", "#/tasks?filter=open", "#/tasks/abc?draft=x", "#/today?draft=x", "", "#/"]) {
    assert.equal(hasTaskHandoffParams(hash), false, hash);
  }
  // An attempt without a draft is cleaned up and refused with a notice, not taken for an ordinary visit.
  assert.deepEqual(parseTaskHandoff("#/tasks?from=explain", LINKS), { rejected: "missing" });
});

test("contract §5.1: back is kept only for Explain's own routes, matched exactly", () => {
  const kept = ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/abc", "#/note/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", "#/note/a.b_c-d.1", "#/note/a:b"];
  for (const back of kept) {
    const parsed = parseTaskHandoff(`#/tasks?draft=x&from=explain&back=${encodeURIComponent(back)}`, LINKS);
    assert.deepEqual(parsed, { from: "explain", text: "x", truncated: false, backUrl: `${EXPLAIN}/${back}` }, back);
  }
  const dropped = [
    "#/note/a%2Fb", "#/note/..", "#/note/.", "#/note/", "#/review?x=1", "#/settings", "#/library/", "#/note/a/b",
    `#/note/${"a".repeat(129)}`, "#//evil.example", "#/note/a\\b", "/#/review", "review",
    // Personal's own routes are not Explain's.
    "#/tasks", "#/note/a%3Ab",
  ];
  for (const back of dropped) {
    const parsed = parseTaskHandoff(`#/tasks?draft=x&from=explain&back=${encodeURIComponent(back)}`, LINKS);
    assert.deepEqual(parsed, { from: "explain", text: "x", truncated: false }, back);
  }
  for (const prRoute of ["#/", "#/home", "#/demo", "#/repos", "#/repos/bell-suite", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/run_1"]) {
    assert.equal(siblingRoute("pr", prRoute), true, prRoute);
  }
  for (const badPrRoute of ["#/runs/", "#/runs/..", "#/repos/a/b", "#/discover?draft=x", "#/unknown"]) {
    assert.equal(siblingRoute("pr", badPrRoute), false, badPrRoute);
  }
});

test("validHref is the contract rule: relative hash routes only, nothing that decodes to a control or a second slash", () => {
  for (const href of ["#/", "#/note/abc", "#/tasks/t-1", "#/explain?text=a+b&x=%E4%B8%AD"]) assert.equal(validHref(href), true, href);
  for (const href of ["https://x.example/#/", "//x", "#//x", "#/a%0d", "#/a%5Cb", "#/%2Fx", "javascript:alert(1)", "#/a b", "#/%E0%A4%A", 7, undefined, `#/${"a".repeat(600)}`]) {
    assert.equal(validHref(href), false, String(href));
  }
});

// ── sessionStorage: one key, written whole ────────────────────────────────

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const at = new Date("2026-11-08T05:30:00.000Z");

test("a new draft replaces the old one under the same key — it is never merged", () => {
  const storage = memoryStorage();
  const first = toStoredHandoff({ from: "explain", text: "第一份", truncated: true, backUrl: `${EXPLAIN}/#/note/abc` }, at);
  const second = toStoredHandoff({ from: "explain", text: "第二份", truncated: false }, new Date("2026-11-08T05:31:00.000Z"));
  assert.equal(writeTaskHandoff(storage, first), true);
  assert.equal(writeTaskHandoff(storage, second), true);
  assert.deepEqual([...storage.map.keys()], [TASK_HANDOFF_KEY]);
  assert.equal(TASK_HANDOFF_KEY, "bell.suite.handoff.tasks");
  const read = readTaskHandoff(storage);
  assert.deepEqual(read, { v: 1, text: "第二份", from: "explain", receivedAt: "2026-11-08T05:31:00.000Z" });
  assert.equal("backUrl" in (read ?? {}), false, "the first draft's back link must not survive");
  assert.equal("truncated" in (read ?? {}), false, "the first draft's 已截斷 must not survive");
  clearTaskHandoff(storage);
  assert.equal(readTaskHandoff(storage), undefined);
});

test("a stored draft round-trips, 已截斷 included", () => {
  const storage = memoryStorage();
  const draft = toStoredHandoff({ from: "explain", text: "複習 傅立葉\n第二行", truncated: true, backUrl: `${EXPLAIN}/#/note/abc` }, at);
  writeTaskHandoff(storage, draft);
  assert.deepEqual(readTaskHandoff(storage), draft);
});

test("anything in the key that is not a draft we wrote reads as no draft", () => {
  const storage = memoryStorage();
  const put = (value: unknown) => storage.map.set(TASK_HANDOFF_KEY, typeof value === "string" ? value : JSON.stringify(value));
  const valid: StoredTaskHandoff = { v: 1, text: "x", from: "explain", receivedAt: at.toISOString() };
  const bad: unknown[] = [
    "not json", "null", "[]", "42",
    { ...valid, v: 2 },
    { ...valid, from: "personal" },
    { ...valid, from: "nobody" },
    { ...valid, text: "" },
    { ...valid, text: "\u0000\u0001 " },
    { ...valid, text: 7 },
    { ...valid, receivedAt: "yesterday" },
  ];
  for (const value of bad) {
    put(value);
    assert.equal(readTaskHandoff(storage), undefined, JSON.stringify(value));
  }
  // A bad back link is dropped; the draft is kept and cleaned again.
  put({ ...valid, text: "a\u202eb", backUrl: "javascript:alert(1)//#/review" });
  assert.deepEqual(readTaskHandoff(storage), { ...valid, text: "ab" });
  put({ ...valid, backUrl: `${EXPLAIN}/#/settings` });
  assert.deepEqual(readTaskHandoff(storage), valid);
  put({ ...valid, text: "字".repeat(2100) });
  const clipped = readTaskHandoff(storage);
  assert.equal([...(clipped?.text ?? "")].length, 2000);
  assert.equal(clipped?.truncated, true);
});

test("storage that throws is treated as empty and reports the failed write", () => {
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.equal(readTaskHandoff(throwing), undefined);
  assert.equal(writeTaskHandoff(throwing, { v: 1, text: "x", from: "explain", receivedAt: at.toISOString() }), false);
  assert.doesNotThrow(() => clearTaskHandoff(throwing));
  assert.equal(writeTaskHandoff(undefined, { v: 1, text: "x", from: "explain", receivedAt: at.toISOString() }), false);
});

test("the back link only goes to the origin the manifest links right now", () => {
  const draft = { from: "explain" as const, backUrl: `${EXPLAIN}/#/note/abc` };
  assert.equal(backUrlFor(draft, LINKS), `${EXPLAIN}/#/note/abc`);
  assert.equal(backUrlFor(draft, {}), undefined);
  assert.equal(backUrlFor(draft, { explain: "http://127.0.0.1:9999" }), undefined);
  assert.equal(backUrlFor({ from: "explain" }, LINKS), undefined);
});

// ── The form ──────────────────────────────────────────────────────────────

test("the first line becomes the title and the rest the notes, within the server's limits", () => {
  assert.deepEqual(draftFields("複習 傅立葉"), { title: "複習 傅立葉", notes: "" });
  assert.deepEqual(draftFields("  標題  \n\n第一段\n第二段  "), { title: "標題", notes: "第一段\n第二段" });
  const long = "長".repeat(250);
  const fields = draftFields(`${long}\n其他`);
  assert.equal(fields.title.length, 200);
  assert.equal(fields.notes, `${long}\n其他`, "a clipped title keeps the whole text in the notes");
  assert.equal(draftFields(`t\n${"n".repeat(5000)}`).notes.length, 4000);
});

test("clipUnits counts UTF-16 units like the server and never splits a surrogate pair", () => {
  assert.equal(clipUnits("abc", 5), "abc");
  assert.equal(clipUnits("abcdef", 3), "abc");
  assert.equal(clipUnits("a😀", 2), "a");
  assert.equal(clipUnits("😀😀", 3), "😀");
  assert.equal(clipUnits("😀😀", 4), "😀😀");
});

// ── 解釋這個 ──────────────────────────────────────────────────────────────

const explainParams = (url: string) => {
  const prefix = `${EXPLAIN}/#/explain?`;
  assert.ok(url.startsWith(prefix), url);
  return new URLSearchParams(url.slice(prefix.length));
};

test("解釋這個: text, title, from and back survive the URL exactly", () => {
  const url = explainThisUrl({ origin: EXPLAIN, text: "What is a Fourier transform?", title: "信號與系統", back: "#/tasks/t-1" });
  const params = explainParams(url);
  assert.deepEqual([...params.keys()], ["text", "title", "from", "back"]);
  assert.equal(params.get("text"), "What is a Fourier transform?");
  assert.equal(params.get("title"), "信號與系統");
  assert.equal(params.get("from"), "personal");
  assert.equal(params.get("back"), "#/tasks/t-1");
  // The contract's own vector, read back the way BELL Explain splits it.
  const [path, query] = url.slice(url.indexOf("#") + 1).split("?", 2);
  assert.equal(path, "/explain");
  assert.equal(new URLSearchParams(query).get("text"), "What is a Fourier transform?");
});

test("解釋這個: '+', '&', '#', '=', '%', emoji and line breaks are encoded, not lost", () => {
  const text = "a+b & c#d = 100% 😀\n第二行\r\n第三行";
  const url = explainThisUrl({ origin: EXPLAIN, text });
  assert.equal(url.indexOf("#"), url.lastIndexOf("#"), "only the route's own #");
  assert.equal(url.split("?").length, 2, "one query");
  const params = explainParams(url);
  assert.equal(params.get("text"), text);
  assert.equal(params.get("from"), "personal");
  assert.equal(params.has("title"), false);
  assert.equal(params.has("back"), false);
  assert.match(url, /a%2Bb/);
  assert.match(url, /%26/);
  assert.match(url, /c%23d/);
});

test("解釋這個: text is clipped to 2000 and title to 120 code points", () => {
  const params = explainParams(explainThisUrl({ origin: EXPLAIN, text: "😀".repeat(2500), title: "題".repeat(200) }));
  assert.equal([...(params.get("text") ?? "")].length, 2000);
  assert.equal(params.get("text"), "😀".repeat(2000));
  assert.equal([...(params.get("title") ?? "")].length, 120);
});

test("解釋這個: a back that is not a relative hash route is dropped, the rest is kept", () => {
  for (const back of ["https://evil.example/#/", "//evil.example", "#//evil", "javascript:alert(1)", "#/a%0d%0a", "tasks", "#/settings", "#/tasks?x=1", "#/calendar", "#/work/projects/p1"]) {
    const params = explainParams(explainThisUrl({ origin: EXPLAIN, text: "x", back }));
    assert.equal(params.has("back"), false, back);
    assert.equal(params.get("text"), "x");
  }
});

test("解釋這個: back is one of Personal's own routes with the raw id, else its list page", () => {
  const backOf = (back: string) => explainParams(explainThisUrl({ origin: EXPLAIN, text: "x", back })).get("back");
  assert.equal(backOf("#/events/ics%3Afeed-1%3Aabc"), "#/events/ics:feed-1:abc", "routeHref's encoded ':' goes raw");
  assert.equal(backOf("#/events/ctftime:123"), "#/events/ctftime:123");
  assert.equal(backOf("#/tasks/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41"), "#/tasks/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41");
  assert.equal(backOf("#/inbox/18c2f0a9b1d3e4f5"), "#/inbox/18c2f0a9b1d3e4f5");
  assert.equal(backOf("#/ideas/a%20b"), "#/ideas", "an id with a space is not an object id: the list page instead");
  assert.equal(backOf("#/events/a%2Fb"), "#/events", "a decoded slash never becomes a second segment");
  assert.equal(backOf("#/events/%E0%A4%A"), "#/events", "a malformed escape falls back to the list");
  assert.equal(backOf(`#/tasks/${"a".repeat(129)}`), "#/tasks");
  assert.equal(backOf("#/events/.."), "#/events");
  assert.equal(backOf("#/today"), "#/today");
  assert.equal(backOf("#/settings/sources"), null, "not an allowed route and no list page to fall back to");
  assert.equal(personalBackRoute(undefined), undefined);
  assert.equal(personalBackRoute("#/inbox?view=sent"), undefined, "no query in a back route");
});

test("an id outside the object-id rule: every Personal kind sends its list page, never the encoded id", () => {
  // Ids are randomUUID() (tasks, ideas, event feeds, AI suggestions), ctftime:<int>, feed:<uuid>:<hash>
  // or Gmail thread ids, which all fit; these stand for a stored or imported value that does not.
  const outside = [".", "..", "a/b", "50%", "a b", "筆記", "x".repeat(129)];
  const backOf = (back: string) => explainParams(explainThisUrl({ origin: EXPLAIN, text: "x", back })).get("back");
  // Built as the pages build them (TasksPage, EventsPage, IdeasPage, MailReader): routeHref encodes the id.
  const pages: [string, (id?: string) => string][] = [
    ["#/tasks", id => routeHref({ name: "tasks", id })],
    ["#/events", id => routeHref({ name: "events", id })],
    ["#/ideas", id => routeHref({ name: "ideas", id })],
    ["#/inbox", threadId => routeHref({ name: "inbox", threadId })],
  ];
  for (const [list, href] of pages) {
    for (const id of outside) {
      assert.equal(backOf(href(id)), list, `${list} ${id}`);
      assert.equal(personalBackRoute(href(id)), list, `${list} ${id}`);
    }
    const longest = "y".repeat(128);
    assert.equal(backOf(href(longest)), `${list}/${longest}`, `${list} 128 characters`);
    assert.equal(backOf(href("feed:6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41:Ab-_9xYz0123QrSt")), `${list}/feed:6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41:Ab-_9xYz0123QrSt`, `${list} raw colons`);
    assert.equal(backOf(href()), list);
  }
});

test("an id outside the object-id rule in a back from Explain is dropped, the draft kept", () => {
  for (const id of [".", "..", "a/b", "50%", "a b", "筆記", "x".repeat(129)]) {
    for (const back of [`#/note/${id}`, `#/note/${encodeURIComponent(id)}`]) {
      const parsed = parseTaskHandoff(`#/tasks?draft=x&from=explain&back=${encodeURIComponent(back)}`, LINKS);
      assert.deepEqual(parsed, { from: "explain", text: "x", truncated: false }, back);
    }
  }
});

test("解釋這個 is offered only with a linked Explain and some text", () => {
  assert.equal(explainThisHref(undefined, { text: "x", back: "#/tasks" }), undefined);
  assert.equal(explainThisHref(EXPLAIN, { text: "  \n ", back: "#/tasks" }), undefined);
  const href = explainThisHref(EXPLAIN, { text: "x", title: "  標題  ", back: "#/tasks/t-1" });
  assert.ok(href);
  const params = explainParams(href);
  assert.equal(params.get("title"), "標題");
  assert.equal(params.get("back"), "#/tasks/t-1");
});

test("source kind comes only from the validated back route and is never guessed", () => {
  assert.equal(handoffKindFromBack(`${EXPLAIN}/#/note/abc`), "筆記");
  assert.equal(handoffKindFromBack("#/tasks/t-1"), "待辦");
  assert.equal(handoffKindFromBack("#/ideas/i-1"), "靈感");
  assert.equal(handoffKindFromBack("#/inbox/m-1"), "郵件");
  assert.equal(handoffKindFromBack("#/events/e-1"), "行程");
  assert.equal(handoffKindFromBack("#/today"), undefined);
  assert.equal(handoffKindFromBack(undefined), undefined);
  assert.equal(handoffSourceLine("BELL Explain", `${EXPLAIN}/#/note/abc`), "來自 BELL Explain · 筆記");
  assert.equal(handoffSourceLine("BELL Explain"), "來自 BELL Explain");
});

test("送到 BELL PR opens #/discover with draft, title, from=personal, and validated back route", () => {
  const PR = "http://127.0.0.1:4603";
  assert.equal(sendToPrHref(undefined, { text: "Fix bug", back: "#/tasks" }), undefined);
  assert.equal(sendToPrHref(PR, { text: "   ", back: "#/tasks" }), undefined);
  const href = sendToPrHref(PR, { text: "Fix bug\nDetails", title: "  Bug fix  ", back: "#/tasks/t-1" });
  assert.ok(href?.startsWith(`${PR}/#/discover?`));
  const params = new URLSearchParams(href!.split("?")[1]);
  assert.equal(params.get("draft"), "Fix bug\nDetails");
  assert.equal(params.get("title"), "Bug fix");
  assert.equal(params.get("from"), "personal");
  assert.equal(params.get("back"), "#/tasks/t-1");

  const incomingFromPr = parseTaskHandoff("#/tasks?draft=Follow+up+PR&from=pr&back=%23%2Fruns%2Frun_99", { pr: PR });
  assert.deepEqual(incomingFromPr, { from: "pr", text: "Follow up PR", truncated: false, backUrl: `${PR}/#/runs/run_99` });
});
