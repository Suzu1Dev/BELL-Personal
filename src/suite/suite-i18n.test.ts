import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SuiteSourcesResponse, SuiteTodayFeed } from "../../shared/suite";
import { ApiError, OFFLINE_MESSAGE, OFFLINE_MESSAGE_EN, api, isOfflineErrorMessage, send } from "../api";
import { ToastHost, ToastProvider } from "../components/toast/ToastProvider";
import { TOAST } from "../copy/common";
import strings from "../copy/suite-strings.json";
import { EXPLAIN_CARD, EXPLAIN_THIS, PERSONAL_TOAST, SOURCE_DETAILS, SOURCE_STATUS, SUITE_APPS, TASK_DRAFT, suiteCopy, toastCopy } from "../copy/suite";
import { ExplainTodayView } from "./ExplainTodayCard";
import { ExplainThisView } from "./ExplainThis";
import { explainCardView, type ExplainCardInput } from "./explain-view";
import type { StoredTaskHandoff } from "./handoff";
import { SourceDetails, sourceRows } from "./SourceDetails";
import { TaskDraftFormView, TaskHandoffNotice } from "./TaskDraftPanel";
import { submitTaskDraft, type TaskDraftForm } from "./useTaskDraftForm";

const EXPLAIN = "http://127.0.0.1:21101";
const NOW = new Date("2026-11-08T05:35:00.000Z");
const noop = () => {};

function inEnglish(node: () => ReactNode): string {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = { location: { search: "?lang=en" } };
  try {
    return renderToStaticMarkup(createElement(() => node()));
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
}

async function withLocaleSearch<T>(search: string, run: () => Promise<T>): Promise<T> {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = { location: { search } };
  try {
    return await run();
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
}

function leafKeys(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [path];
  return Object.entries(value).flatMap(([key, child]) => leafKeys(child, path ? `${path}.${key}` : key));
}

function assertEnglish(html: string): void {
  assert.doesNotMatch(html, /[㐀-鿿豈-﫿]/, html);
}

const FEED: SuiteTodayFeed = {
  schemaVersion: 1,
  appId: "explain",
  generatedAt: "2026-11-08T05:30:00.000Z",
  counts: { due: 1, newAvailable: 2, reviewedToday: 0 },
  items: [{ sourceApp: "explain", type: "lesson", id: "fourier", title: "Fourier intuition", href: "#/note/fourier", state: "waiting", updatedAt: "2026-11-08T05:30:00.000Z" }],
  truncated: false,
};

const data: SuiteSourcesResponse = {
  schemaVersion: 1,
  sources: [
    { appId: "explain", status: "ready", lastSuccessAt: "2026-11-08T05:30:00.000Z", feed: FEED },
    { appId: "pr", status: "unsupported" },
  ],
};

const input = (extra: Partial<ExplainCardInput> = {}): ExplainCardInput => ({
  pollState: "ready",
  data,
  updatedAt: NOW.getTime() - 60_000,
  links: { explain: EXPLAIN },
  timeZone: "Asia/Taipei",
  now: NOW,
  locale: "en",
  ...extra,
});

const form: TaskDraftForm = {
  sourceName: "BELL Explain",
  backUrl: `${EXPLAIN}/#/note/fourier`,
  truncated: true,
  title: "Review Fourier",
  notes: "Finish the example",
  titleError: "Enter a task title.",
  error: "Couldn't create task: Offline",
  pending: false,
  setTitle: noop,
  setNotes: noop,
  create: async () => {},
  discard: noop,
};

test("suite dictionaries have exact zh-TW/en key parity and preserve legacy zh-TW exports", () => {
  assert.deepEqual(leafKeys(strings["zh-TW"]), leafKeys(strings.en));
  assert.deepEqual(SUITE_APPS, suiteCopy("zh-TW").apps);
  assert.deepEqual(SOURCE_STATUS, suiteCopy("zh-TW").sourceStatus);
  assert.deepEqual(SOURCE_DETAILS, suiteCopy("zh-TW").sourceDetails);
  assert.deepEqual(EXPLAIN_THIS, suiteCopy("zh-TW").explainThis);
  assert.deepEqual(PERSONAL_TOAST, suiteCopy("zh-TW").personalToast);
  assert.deepEqual(toastCopy("zh-TW"), TOAST);
  assert.equal(EXPLAIN_CARD.toReview("1"), "1 張待複習");
  assert.equal(EXPLAIN_CARD.due("1"), "1 到期");
  assert.equal(EXPLAIN_CARD.fresh("2"), "2 新卡");
  assert.equal(EXPLAIN_CARD.stale(1), "1 分鐘前的資料");
  assert.equal(EXPLAIN_CARD.updated("13:30"), "更新於 13:30");
  assert.equal(TASK_DRAFT.back("BELL Explain"), "回到 BELL Explain");
  assert.equal(TASK_DRAFT.failed("離線"), "無法建立待辦：離線");
  assert.equal(TASK_DRAFT.fromSource("BELL Explain"), "來自 BELL Explain");
  assert.equal(TASK_DRAFT.fromSourceKind("BELL Explain", "筆記"), "來自 BELL Explain · 筆記");
});

test("English count and stale helpers follow Muse's singular/plural-safe templates", () => {
  const copy = suiteCopy("en");
  assert.equal(copy.explainCard.headline(copy.explainCard.toReview("1"), copy.explainCard.due("1"), copy.explainCard.fresh("0")), "1 to review · 1 due · 0 new");
  assert.equal(copy.explainCard.headline(copy.explainCard.toReview("12"), copy.explainCard.due("8"), copy.explainCard.fresh("4")), "12 to review · 8 due · 4 new");
  assert.equal(copy.explainCard.stale(1), "Data from 1 min ago");
  assert.equal(copy.explainCard.stale(25), "Data from 25 min ago");
  assert.equal(copy.taskDraft.fromSourceKind("BELL Explain", copy.taskDraft.kinds.note), "From BELL Explain · note");
});

test("ExplainTodayCard renders English without CJK in ready, empty, stale, unavailable, unconfigured, and loading states", () => {
  const views = [
    explainCardView(input()),
    explainCardView(input({ data: { ...data, sources: [{ ...data.sources[0]!, feed: { ...FEED, counts: { due: 0, newAvailable: 0 }, items: [] } }, data.sources[1]!] } })),
    explainCardView(input({ data: { ...data, sources: [{ ...data.sources[0]!, status: "stale", lastSuccessAt: "2026-11-08T05:10:00.000Z" }, data.sources[1]!] } })),
    explainCardView(input({ pollState: "error", data: undefined, updatedAt: undefined })),
    explainCardView(input({ data: { ...data, sources: [{ appId: "explain", status: "unconfigured" }, data.sources[1]!] }, links: {} })),
    explainCardView(input({ pollState: "loading", data: undefined })),
  ];
  for (const view of views) {
    const html = inEnglish(() => createElement(ExplainTodayView, { view, onRetry: noop, onOpenDetails: noop }));
    assertEnglish(html);
    assert.match(html, /Review/);
  }
});

test("SourceDetails renders its complete English drawer without CJK", () => {
  const html = inEnglish(() => createElement(SourceDetails, {
    open: true,
    onClose: noop,
    rows: sourceRows(input()),
    onRefresh: noop,
    refreshing: false,
  }));
  assertEnglish(html);
  assert.match(html, /Source details/);
  assert.match(html, /Open BELL Explain/);
  assert.match(html, /Not supported/);
});

test("TaskDraftPanel renders English form, checking, rejected, unverified, and created states without CJK", () => {
  const links = { explain: EXPLAIN };
  const views = [
    inEnglish(() => createElement(TaskDraftFormView, { form })),
    inEnglish(() => createElement(TaskHandoffNotice, { state: { kind: "checking" }, links, onRetry: noop, onDismiss: noop })),
    inEnglish(() => createElement(TaskHandoffNotice, { state: { kind: "unverified" }, links, onRetry: noop, onDismiss: noop })),
    inEnglish(() => createElement(TaskHandoffNotice, { state: { kind: "rejected", reason: "duplicate" }, links, onRetry: noop, onDismiss: noop })),
    inEnglish(() => createElement(TaskHandoffNotice, { state: { kind: "created", id: "t1", title: "Review Fourier", from: "explain", backUrl: `${EXPLAIN}/#/note/fourier` }, links, onRetry: noop, onDismiss: noop })),
  ];
  for (const html of views) assertEnglish(html);
  assert.match(views[0]!, /From BELL Explain · note/);
  assert.match(views[0]!, /Back to BELL Explain/);
  assert.match(views[4]!, /Task created/);
});

test("offline POST /todos throws English ApiError under ?lang=en without CJK and preserves zh-TW OFFLINE_MESSAGE", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  const draft: StoredTaskHandoff = {
    v: 1,
    text: "Review Fourier\nFinish the example",
    from: "explain",
    backUrl: `${EXPLAIN}/#/note/fourier`,
    receivedAt: "2026-11-08T05:30:00.000Z",
  };

  await withLocaleSearch("?lang=en", async () => {
    await assert.rejects(api("/todos", send("POST", { title: "Review Fourier" })), (cause) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.status, 0);
      assert.equal(cause.message, "Can't reach the local service. Make sure BELL Personal is running.");
      assert.equal(cause.message, OFFLINE_MESSAGE_EN);
      assert.equal(isOfflineErrorMessage(cause.message), true);
      assertEnglish(cause.message);
      return true;
    });

    const outcome = await submitTaskDraft(draft, { title: "Review Fourier", notes: "Finish the example" }, draft.backUrl, async () => {});
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "Couldn't create task: Can't reach the local service. Make sure BELL Personal is running.");
    assertEnglish(outcome.error ?? "");
    const html = renderToStaticMarkup(createElement(TaskDraftFormView, { form: { ...form, error: outcome.error } }));
    assertEnglish(html);
    assert.match(html, /Can&#x27;t reach the local service\. Make sure BELL Personal is running\./);
  });

  await withLocaleSearch("", async () => {
    await assert.rejects(api("/todos", send("POST", { title: "Review Fourier" })), (cause) => {
      assert.ok(cause instanceof ApiError);
      assert.equal(cause.status, 0);
      assert.equal(cause.message, OFFLINE_MESSAGE);
      assert.equal(isOfflineErrorMessage(cause.message), true);
      return true;
    });

    const outcome = await submitTaskDraft(draft, { title: "Review Fourier", notes: "" }, draft.backUrl, async () => {});
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error, `無法建立待辦：${OFFLINE_MESSAGE}`);
  });
});

test("ExplainThis renders its English label and accessible description without CJK", () => {
  const html = inEnglish(() => createElement(ExplainThisView, { href: `${EXPLAIN}/#/explain?text=Fourier`, compact: true }));
  assertEnglish(html);
  assert.match(html, /Explain this/);
  assert.match(html, /Open this text in BELL Explain/);
  assert.equal(inEnglish(() => createElement(ExplainThisView, {})), "");
});

test("ToastHost renders English undo, retry, dismiss, and region labels without CJK under ?lang=en", () => {
  const html = inEnglish(() =>
    createElement(ToastProvider, {
      initialToasts: [
        { kind: "undo", message: "Task created", onUndo: noop },
        { kind: "error", message: OFFLINE_MESSAGE_EN, onRetry: noop },
      ],
      children: createElement(ToastHost),
    }),
  );
  assertEnglish(html);
  assert.match(html, /aria-label="Notifications"/);
  assert.match(html, />Undo<kbd>/);
  assert.match(html, />Try again<\/button>/);
  assert.match(html, /aria-label="Dismiss notification"/);
});

test("narrow viewport <=720px rules keep .explain-this and .suite-draft notice buttons at 44px (--tap) over precise.css .btn-sm", () => {
  const strip = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const narrowBlock = (css: string) => /@media\s*\(max-width:\s*720px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const explainNarrow = narrowBlock(strip("./ExplainThis.css"));
  const draftNarrow = narrowBlock(strip("./TaskDraftPanel.css"));
  assert.match(explainNarrow, /\.btn-sm\.explain-this[\s\S]*?min-height:\s*var\(--tap\)/);
  assert.match(draftNarrow, /\.suite-draft\s+\.notice\s+\.btn-sm[\s\S]*?min-height:\s*var\(--tap\)/);
});
