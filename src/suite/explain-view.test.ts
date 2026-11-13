/**
 * The 今日複習 view model (src/suite/explain-view.ts) and 來源詳情 rows: unknown
 * is never 0, zero parts are left out, stale data is shown with its time and
 * dropped after 30 min, links only while BELL Explain is linked and only to
 * its own routes. Feeds are the contracts v1 fixtures, inlined.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SuiteSource, SuiteSourcesResponse, SuiteTodayFeed } from "../../shared/suite";
import { EXPLAIN_CARD, SOURCE_DETAILS } from "../copy/suite";
import { effectiveStatus, explainCardView, readCount, suiteTime, type ExplainCardInput } from "./explain-view";
import { sourceRows } from "./SourceDetails";
import { sanitizeLinks, sourcesPath } from "./useSuite";

const EXPLAIN = "http://127.0.0.1:21101";
const TZ = "Asia/Taipei";
const NOW = new Date("2026-11-08T05:35:00.000Z"); // 13:35 in Taipei
const READ_AT = NOW.getTime() - 60_000;

// contracts v1 fixtures/today.explain.valid.json
const FEED: SuiteTodayFeed = {
  schemaVersion: 1,
  appId: "explain",
  generatedAt: "2026-11-08T05:30:00.000Z",
  counts: { due: 12, newAvailable: 3, reviewedToday: 5 },
  items: [
    { sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review", state: "due", updatedAt: "2026-11-08T05:30:00.000Z", detail: "12 張到期 · 3 張新卡" },
    { sourceApp: "explain", type: "lesson", id: "6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", title: "示範資料 · 傅立葉轉換的直覺", href: "#/note/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", state: "waiting", updatedAt: "2026-11-07T14:02:11.000Z" },
  ],
  truncated: false,
};

const response = (explain: Partial<SuiteSource> & Pick<SuiteSource, "status">, pr: SuiteSource = { appId: "pr", status: "unsupported" }): SuiteSourcesResponse => ({
  schemaVersion: 1,
  sources: [{ appId: "explain", lastSuccessAt: "2026-11-08T05:30:00.000Z", ...explain }, pr],
});
const readyWith = (feed: Partial<SuiteTodayFeed>) => response({ status: "ready", feed: { ...FEED, ...feed } });

const view = (input: Partial<ExplainCardInput>) => explainCardView({
  pollState: "ready",
  data: response({ status: "ready", feed: FEED }),
  updatedAt: READ_AT,
  links: { explain: EXPLAIN },
  timeZone: TZ,
  now: NOW,
  ...input,
});

test("ready: the headline, 開始複習 and the lessons, with the time of the last read", () => {
  const card = view({});
  assert.equal(card.kind, "ready");
  assert.equal(card.headline, "15 張待複習 · 12 到期 · 3 新卡");
  assert.equal(card.reviewHref, `${EXPLAIN}/#/review`);
  assert.deepEqual(card.lessons, [{ id: "6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41", title: "示範資料 · 傅立葉轉換的直覺", href: `${EXPLAIN}/#/note/6f1c2a9e-3b7d-4c11-9a3e-0d2f5b8c7e41` }]);
  assert.equal(card.updatedAt, "13:30");
  assert.equal(card.linked, true);
});

test("the headline includes the total and both known zero parts", () => {
  assert.equal(view({ data: readyWith({ counts: { due: 4, newAvailable: 0, reviewedToday: 2 } }) }).headline, "4 張待複習 · 4 到期 · 0 新卡");
  assert.equal(view({ data: readyWith({ counts: { due: 0, newAvailable: 3, reviewedToday: 0 } }) }).headline, "3 張待複習 · 0 到期 · 3 新卡");
  assert.equal(view({ data: readyWith({ counts: { due: 1234, newAvailable: 0, reviewedToday: 0 } }) }).headline, "1,234 張待複習 · 1,234 到期 · 0 新卡");
});

test("English headlines use Muse's singular and plural-safe count templates", () => {
  const card = view({ locale: "en", data: readyWith({ counts: { due: 1, newAvailable: 2, reviewedToday: 0 } }) });
  assert.equal(card.headline, "3 to review · 1 due · 2 new");
  const unknown = view({ locale: "en", data: readyWith({ counts: { due: 1 } }) });
  assert.equal(unknown.headline, "— to review · 1 due · — new");
  assert.equal(unknown.headlineSpoken, "Unknown to review · 1 due · Unknown new");
});

test("unknown is never 0: a count the feed does not report reads 「—」, and is spoken as 未知", () => {
  const card = view({ data: readyWith({ counts: { due: 12 } }) });
  assert.equal(card.kind, "ready", "due 12 with new unknown is not empty");
  assert.equal(card.headline, "— 張待複習 · 12 到期 · — 新卡");
  assert.equal(card.headlineSpoken, "未知 張待複習 · 12 到期 · 未知 新卡");
  assert.deepEqual(card.counts, { due: 12, newAvailable: undefined, reviewedToday: undefined });

  const nothing = view({ data: readyWith({ counts: {} }) });
  assert.notEqual(nothing.kind, "empty", "no counts at all is not 「沒有到期」");
  assert.equal(nothing.headline, "—");
  assert.equal(nothing.headlineSpoken, "未知");
  assert.ok(!nothing.headline?.includes("0"));
});

test("a count that is not a whole number in range is unknown, not 0", () => {
  for (const value of [-1, 1.5, "3", null, Number.NaN, 100_001, true]) {
    assert.equal(readCount({ due: value }, "due"), undefined, String(value));
  }
  assert.equal(readCount({ due: 0 }, "due"), 0);
  assert.equal(readCount({ due: 100_000 }, "due"), 100_000);
  assert.equal(readCount(undefined, "due"), undefined);
  const card = view({ data: readyWith({ counts: { due: -3, newAvailable: 0 } as Record<string, number> }) });
  assert.equal(card.headline, "— 張待複習 · — 到期 · 0 新卡");
});

test("empty only when due and new are both reported as 0, with 開啟知識庫 when linked", () => {
  const card = view({ data: readyWith({ counts: { due: 0, newAvailable: 0, reviewedToday: 0 } }) });
  assert.equal(card.kind, "empty");
  assert.equal(card.headline, EXPLAIN_CARD.empty);
  assert.equal(card.headline, "今天沒有到期的複習");
  assert.equal(card.reviewHref, undefined, "nothing to start");
  assert.equal(card.libraryHref, `${EXPLAIN}/#/library`);
  assert.equal(view({ data: readyWith({ counts: { due: 0, newAvailable: 0, reviewedToday: 5 } }) }).headline, "今天沒有到期的複習");
  assert.equal(view({ data: readyWith({ counts: { due: 0 } }) }).kind, "ready", "new unknown: not empty");
});

test("stale: the old counts with their age in minutes; Personal's own server gone too long drops them", () => {
  const served = view({ data: response({ status: "stale", lastSuccessAt: "2026-11-08T05:10:00.000Z", feed: { ...FEED, counts: { due: 4, newAvailable: 0, reviewedToday: 2 } } }) });
  assert.equal(served.kind, "stale");
  assert.equal(served.headline, "4 張待複習 · 4 到期 · 0 新卡");
  assert.equal(served.updatedAt, "13:10");
  assert.equal(served.staleMinutes, 25);
  assert.equal(EXPLAIN_CARD.stale(served.staleMinutes ?? 0), "25 分鐘前的資料");

  const pollFailed = view({ pollState: "error", updatedAt: NOW.getTime() - 10 * 60_000 });
  assert.equal(pollFailed.kind, "stale", "a failed poll keeps the last answer for a while");
  assert.equal(pollFailed.headline, "15 張待複習 · 12 到期 · 3 新卡");

  const tooOld = view({ pollState: "stale", updatedAt: NOW.getTime() - 31 * 60_000 });
  assert.equal(tooOld.kind, "unavailable", "older than 30 min on this device's clock: dropped");
  assert.equal(tooOld.headline, "—");
});

test("unavailable shows 「—」, never 0", () => {
  for (const data of [
    response({ status: "unavailable" }),
    response({ status: "ready" }),
    response({ status: "ready", feed: { ...FEED, appId: "pr" } }),
    { schemaVersion: 1, sources: [] } as SuiteSourcesResponse,
    undefined,
  ]) {
    const card = view({ data, pollState: data ? "ready" : "error", updatedAt: data ? READ_AT : undefined });
    assert.equal(card.kind, "unavailable", JSON.stringify(data));
    assert.equal(card.headline, "—");
    assert.equal(card.headlineSpoken, "未知");
    assert.deepEqual(card.counts, {});
    assert.equal(card.reviewHref, undefined);
    assert.deepEqual(card.lessons, []);
  }
});

test("loading, unconfigured and unsupported carry no counts", () => {
  assert.equal(view({ pollState: "loading", data: undefined }).kind, "loading");
  const quiet = view({ data: response({ status: "unconfigured" }), links: {} });
  assert.equal(quiet.kind, "unconfigured");
  assert.equal(quiet.headline, undefined);
  assert.equal(view({ data: response({ status: "unsupported" }) }).kind, "unsupported");
});

test("links only while Explain is linked, at most 4 lessons, each only to Explain's own routes", () => {
  const lesson = (id: string, href: string, title = `課程 ${id}`) => ({ sourceApp: "explain" as const, type: "lesson", id, title, href, state: "waiting" as const, updatedAt: "2026-11-08T05:00:00.000Z" });
  const data = readyWith({
    items: [
      FEED.items[0]!,
      lesson("a", "#/note/a"),
      lesson("b", "https://evil.example/#/note/b"),
      lesson("c", "#/settings"),
      lesson("d", "#/note/.."),
      lesson("e", "#/note/e", "  \u202e標題\u0007  "),
      lesson("f", "#/note/f"),
    ],
  });
  const linked = view({ data });
  assert.deepEqual(linked.lessons.map((row) => [row.id, row.href]), [
    ["a", `${EXPLAIN}/#/note/a`],
    ["b", undefined],
    ["c", undefined],
    ["d", undefined],
  ]);
  const unlinked = view({ data, links: {} });
  assert.equal(unlinked.linked, false);
  assert.equal(unlinked.reviewHref, undefined);
  assert.ok(unlinked.lessons.every((row) => row.href === undefined));
  assert.equal(unlinked.headline, "15 張待複習 · 12 到期 · 3 新卡", "counts still show; only links need the manifest");

  const cleaned = view({ data: readyWith({ items: [lesson("e", "#/note/e", "  \u202e標題\u0007  "), lesson("long", "#/note/long", "長".repeat(130))] }) });
  assert.equal(cleaned.lessons[0]?.title, "標題");
  assert.equal([...(cleaned.lessons[1]?.title ?? "")].length, 120);
  assert.ok(cleaned.lessons[1]?.title.endsWith("…"));
});

test("times read 「HH:mm」 today and 「M/D HH:mm」 before, in the user's time zone", () => {
  assert.equal(suiteTime("2026-11-08T05:10:00.000Z", TZ, NOW), "13:10");
  assert.equal(suiteTime("2026-11-07T05:10:00.000Z", TZ, NOW), "11/7 13:10");
  assert.equal(suiteTime("not a date", TZ, NOW), undefined);
  assert.equal(suiteTime(undefined, TZ, NOW), undefined);
  assert.equal(typeof suiteTime("2026-11-08T05:10:00.000Z", "Not/AZone", NOW), "string", "a bad zone falls back to the browser's");
});

test("effectiveStatus: the poll state wins over a ready answer only to make it older, never fresher", () => {
  const ready: SuiteSource = { appId: "explain", status: "ready", feed: FEED };
  assert.equal(effectiveStatus(ready, "loading", undefined, NOW), "loading");
  assert.equal(effectiveStatus(ready, "ready", READ_AT, NOW), "ready");
  assert.equal(effectiveStatus(ready, "stale", READ_AT, NOW), "stale");
  assert.equal(effectiveStatus(ready, "error", undefined, NOW), "unavailable");
  assert.equal(effectiveStatus({ appId: "explain", status: "bogus" as SuiteSource["status"], feed: FEED }, "ready", READ_AT, NOW), "unavailable");
});

test("來源詳情: Explain says what is shared and can be refreshed; PR has no summary yet", () => {
  const rows = sourceRows({ pollState: "ready", data: response({ status: "ready", feed: FEED }), updatedAt: READ_AT, links: { explain: EXPLAIN }, timeZone: TZ, now: NOW });
  assert.deepEqual(rows.map((row) => row.id), ["explain", "pr"]);
  const [explain, pr] = rows;
  assert.equal(explain?.status, "ready");
  assert.equal(explain?.lastSuccess, "13:30");
  assert.equal(explain?.note, SOURCE_DETAILS.explainShared);
  assert.equal(explain?.openHref, `${EXPLAIN}/`);
  assert.equal(explain?.refreshable, true);
  assert.equal(pr?.status, "unsupported");
  assert.equal(pr?.note, "尚未支援");
  assert.equal(pr?.refreshable, false);
  assert.equal(pr?.openHref, undefined);

  const unlinked = sourceRows({ pollState: "ready", data: response({ status: "unconfigured" }, { appId: "pr", status: "unconfigured" }), links: {}, now: NOW });
  assert.equal(unlinked[0]?.note, "尚未連結");
  assert.equal(unlinked[0]?.refreshable, false);
  assert.equal(unlinked[0]?.openHref, undefined);
  assert.equal(unlinked[1]?.note, "尚未連結");
});

test("links from the manifest are kept only as exact http(s) origins of explain and pr", () => {
  assert.deepEqual(sanitizeLinks({ explain: EXPLAIN, pr: "https://pr.example", personal: "http://x" }), { explain: EXPLAIN, pr: "https://pr.example" });
  for (const bad of ["javascript:alert(1)", `${EXPLAIN}/`, `${EXPLAIN}/path`, "http://user:pw@host", "http://*.example", "ftp://x", "", 7, null]) {
    assert.deepEqual(sanitizeLinks({ explain: bad }), {}, String(bad));
  }
  assert.deepEqual(sanitizeLinks(null), {});
  assert.deepEqual(sanitizeLinks(["http://x"]), {});
});

test("a manual retry asks Personal's own server for a fresh read", () => {
  assert.equal(sourcesPath(false), "/suite/sources");
  assert.equal(sourcesPath(true), "/suite/sources?refresh=1");
});
