import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { IdeaListResponse, IdeaView } from "../../../shared/ideas";
import { COMPOSER, IDEAS, ideasCopy } from "../../copy/ideas";
import strings from "../../copy/ideas-strings.json";
import { groupIdeas } from "./model";

const TODAY = "2026-11-11";
const TZ = "Asia/Taipei";
const NOW = new Date("2026-11-11T08:42:00+08:00");
const CJK = /[㐀-鿿豈-﫿]/u;

function leaves(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.entries(value).flatMap(([key, entry]) => leaves(entry, path ? `${path}.${key}` : key));
}

const placeholders = (value: string) => value.match(/\{\w+\}/g) ?? [];

function makeIdea(id: string, day: string, extra: Partial<IdeaView> = {}): IdeaView {
  return {
    id,
    text: id,
    tags: [],
    pinned: false,
    archived: false,
    origin: "manual",
    day,
    createdAt: `${day}T05:00:00.000Z`,
    updatedAt: `${day}T05:00:00.000Z`,
    proposals: [],
    ...extra,
  };
}

test("ideas has 71/71 paired keys with signed-off values, matching placeholders, and the O2 override", () => {
  const zh = leaves(strings["zh-TW"].ideas);
  const en = leaves(strings.en.ideas);
  assert.equal(zh.length, 71);
  assert.equal(en.length, 71);
  assert.deepEqual(en.map(([key]) => key), zh.map(([key]) => key));
  en.forEach(([key, value], index) => {
    assert.deepEqual(placeholders(value).sort(), placeholders(zh[index][1]).sort(), key);
    assert.doesNotMatch(value, CJK, key);
  });
  assert.doesNotMatch(JSON.stringify(strings), /點子/);
  assert.equal(strings["zh-TW"].ideas.composer.placeholders.todo, "例如：週五前繳電費…");
  assert.equal(strings.en.ideas.composer.placeholders.todo, "e.g., Pay bill by Fri");
  assert.equal(ideasCopy("zh-TW").PAGE_HEAD_TITLE, strings["zh-TW"].ideas.pageHead.title);
  assert.equal(ideasCopy("en").PAGE_HEAD_TITLE, strings.en.ideas.pageHead.title);
});

test("legacy Ideas exports resolve the active locale without changing their signatures", (t) => {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  const window = { location: { search: "?lang=en" } };
  scope.window = window;
  t.after(() => {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  });

  assert.equal(COMPOSER.label, "Write an idea, task, or note");
  assert.equal(COMPOSER.placeholders.todo, "e.g., Pay bill by Fri");
  assert.equal(COMPOSER.enterType.event, "Create event");
  assert.equal(COMPOSER.tooLong(500), "Keep it under 500 characters.");
  assert.equal(IDEAS.count(1), "1 idea");
  assert.equal(IDEAS.count(2), "2 ideas");
  assert.equal(IDEAS.archivedToggle(3), "View archived");
  assert.equal(IDEAS.toasts.toTodo("Pay bill"), "Turned into task “Pay bill”");
  assert.equal(IDEAS.proposalLabel("work"), "Add AI-suggested tag #work");

  window.location.search = "?lang=zh-TW";
  assert.equal(COMPOSER.label, "寫下靈感、待辦或筆記");
  assert.equal(COMPOSER.placeholders.todo, "例如：週五前繳電費…");
  assert.equal(COMPOSER.enterType.event, "建立行程");
  assert.equal(COMPOSER.tooLong(500), "內容最多 500 字。");
  assert.equal(IDEAS.count(1), "1 則");
  assert.equal(IDEAS.toasts.toTodo("繳電費"), "已轉成待辦「繳電費」");
  assert.equal(IDEAS.proposalLabel("工作"), "加上 AI 建議的標籤 #工作");
});

test("English idea groups and dates preserve the byte-identical zh-TW defaults", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const ideas = [
    makeIdea("Older", "2026-10-09"),
    makeIdea("Today idea", TODAY),
    makeIdea("Yesterday idea", "2026-11-10"),
    makeIdea("Pinned idea", "2026-10-06", { pinned: true }),
  ];
  assert.deepEqual(groupIdeas(ideas, TODAY, TZ, "en").map((group) => group.label), ["Pinned", "Today", "Yesterday", "Fri, Oct 9"]);
  assert.deepEqual(groupIdeas(ideas, TODAY, TZ).map((group) => group.label), ["釘選", "今天", "昨天", "10/9（五）"]);
});

test("SSR renders English IdeasPage shell and all three Composer tabs without CJK", async (t) => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const scope = globalThis as { window?: unknown; localStorage?: unknown; navigator?: unknown };
  const prevWindow = scope.window;
  const prevStorage = scope.localStorage;
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const mockWin = {
    location: { search: "?lang=en", hash: "#/ideas" },
    localStorage: storage,
    navigator: { platform: "Linux x86_64", userAgent: "Mozilla/5.0" },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  };
  scope.window = mockWin;
  scope.localStorage = storage;
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: mockWin.navigator });
  t.after(() => {
    if (prevWindow === undefined) delete scope.window;
    else scope.window = prevWindow;
    if (prevStorage === undefined) delete scope.localStorage;
    else scope.localStorage = prevStorage;
    if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
    else delete scope.navigator;
  });

  const [{ createElement }, { renderToStaticMarkup }, { default: IdeasPage }, { ToastProvider }, { StatusProvider }, { TodayProvider }] = await Promise.all([
    import("react"),
    import("react-dom/server"),
    import("./IdeasPage"),
    import("../../components/toast/ToastProvider"),
    import("../../lib/status"),
    import("../../lib/today"),
  ]);
  const renderTab = (tab: "idea" | "todo" | "note") => {
    store.set("bell-personal.composer.tab", tab);
    return renderToStaticMarkup(
      createElement(ToastProvider, null,
        createElement(StatusProvider, null,
          createElement(TodayProvider, null,
            createElement(IdeasPage, { route: { name: "ideas" } })))),
    );
  };

  const ideaHtml = renderTab("idea");
  assert.match(ideaHtml, />Never let a good idea slip away\.<\/h1>/);
  assert.match(ideaHtml, /View archived/);
  assert.match(ideaHtml, /placeholder="Jot down whatever comes to mind\. Use #tags to organize…"/);
  assert.doesNotMatch(ideaHtml, CJK);

  const todoHtml = renderTab("todo");
  assert.match(todoHtml, /placeholder="e\.g\., Pay bill by Fri"/);
  assert.match(todoHtml, /Add task/);
  assert.doesNotMatch(todoHtml, CJK);

  const noteHtml = renderTab("note");
  assert.match(noteHtml, /placeholder="First line becomes the title, with your note below…"/);
  assert.match(noteHtml, /Save note/);
  assert.doesNotMatch(noteHtml, CJK);
});

const happyDomPackage = "happy-dom";
const happyDom = await import(happyDomPackage).catch(() => {
  try {
    return createRequire(import.meta.url)(happyDomPackage);
  } catch {
    return undefined;
  }
});
const HappyWindow = happyDom?.Window;

test("HappyDOM renders English Composer, empty, grouped, archived, and missing states without CJK", { skip: !HappyWindow }, async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const dom = new HappyWindow({ url: "http://personal.test/?lang=en#/ideas" });
  (dom as unknown as { Date: DateConstructor }).Date = globalThis.Date;
  const names = [
    "window", "document", "navigator", "Element", "HTMLElement", "HTMLButtonElement", "HTMLHeadingElement", "HTMLInputElement", "HTMLTextAreaElement",
    "Node", "CSS", "Event", "CustomEvent", "KeyboardEvent", "PointerEvent", "StorageEvent", "MutationObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const values: Record<string, unknown> = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLHeadingElement: dom.HTMLHeadingElement,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    Node: dom.Node,
    CSS: dom.CSS,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    KeyboardEvent: dom.KeyboardEvent,
    PointerEvent: dom.PointerEvent,
    StorageEvent: dom.StorageEvent,
    MutationObserver: dom.MutationObserver,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  dom.HTMLElement.prototype.scrollIntoView = () => {};

  let list: IdeaListResponse = { today: TODAY, ideas: [], tags: [], total: 0, aiTags: true };
  const archivedList: IdeaListResponse = {
    today: TODAY,
    ideas: [makeIdea("Archived thought", "2026-11-09", { archived: true })],
    tags: [],
    total: 0,
    aiTags: true,
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const path = String(input);
    let body: unknown;
    let status = 200;
    if (path === "/api/ideas?") body = list;
    else if (path === "/api/ideas?archived=1") body = archivedList;
    else if (path === "/api/ideas/missing") { body = { error: "Not found" }; status = 404; }
    else if (path === "/api/status") body = { today: TODAY, timeZone: TZ, sources: [], modules: { capture: { aiParse: true, eventTarget: "local" } } };
    else if (path === "/api/today") body = { date: TODAY, now: NOW.toISOString(), counts: { open: 0, inboxUnread: 0, habitsLeft: 0, nav: {} }, queue: [], sources: [], sidebar: { projects: [], streakDays: 0 } };
    else if (path === "/api/sync") body = { started: [], sources: [] };
    else if (path === "/api/suite/manifest") body = { schemaVersion: 1, links: {} };
    else throw new Error(`Unexpected test request: ${path}`);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };

  const roots: Array<{ unmount(): void }> = [];
  t.after(async () => {
    const { act } = await import("react");
    for (const root of roots) await act(async () => root.unmount());
    globalThis.fetch = previousFetch;
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    await dom.happyDOM.close();
  });

  const [{ act, createElement }, { createRoot }, { default: IdeasPage }, { ToastProvider }, { StatusProvider }, { TodayProvider }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./IdeasPage"),
    import("../../components/toast/ToastProvider"),
    import("../../lib/status"),
    import("../../lib/today"),
  ]);

  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  const waitFor = async (text: string) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (dom.document.body.textContent?.includes(text)) return;
      await flush();
    }
    assert.fail(`Rendered text not found: ${text}\n${dom.document.body.textContent}`);
  };
  const assertEnglish = () => assert.doesNotMatch(dom.document.body.innerHTML, CJK, dom.document.body.textContent);
  const mount = async (route: { name: "ideas"; id?: string }): Promise<HTMLElement> => {
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(ToastProvider, null,
        createElement(StatusProvider, null,
          createElement(TodayProvider, null,
            createElement(IdeasPage, { route })))));
    });
    return container;
  };
  const tab = (container: HTMLElement, label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((button) => button.textContent === label)!;

  const empty = await mount({ name: "ideas" });
  await waitFor("No ideas yet. Capture your first one.");
  assert.match(empty.textContent!, /Never let a good idea slip away\./);
  assert.match(empty.textContent!, /View archived/);
  assert.match(empty.innerHTML, /placeholder="Jot down whatever comes to mind\. Use #tags to organize…"/);
  assert.match(empty.innerHTML, /placeholder="Search ideas or #tags"/);
  assertEnglish();

  await act(async () => tab(empty, "Task").click());
  assert.match(empty.innerHTML, /placeholder="e\.g\., Pay bill by Fri"/);
  assert.match(empty.textContent!, /Add task/);
  assertEnglish();

  await act(async () => tab(empty, "Note").click());
  assert.match(empty.innerHTML, /placeholder="First line becomes the title, with your note below…"/);
  assert.match(empty.textContent!, /Save note/);
  assertEnglish();

  list = {
    today: TODAY,
    ideas: [
      makeIdea("Pinned thought", "2026-10-06", { pinned: true, tags: ["work"] }),
      makeIdea("Today thought", TODAY, { proposals: [{ suggestionId: "suggestion-1", tag: "focus" }] }),
      makeIdea("Yesterday thought", "2026-11-10"),
      makeIdea("Older thought", "2026-10-09"),
    ],
    tags: [{ tag: "work", count: 1 }],
    total: 4,
    aiTags: true,
  };
  const grouped = await mount({ name: "ideas" });
  await waitFor("Pinned thought");
  assert.match(grouped.textContent!, /Pinned/);
  assert.match(grouped.textContent!, /Today/);
  assert.match(grouped.textContent!, /Yesterday/);
  assert.match(grouped.textContent!, /Fri, Oct 9/);
  assert.match(grouped.innerHTML, /aria-label="Add AI-suggested tag #focus"/);
  assert.match(grouped.innerHTML, /aria-label="Turn into task"/);
  assertEnglish();

  await act(async () => {
    Array.from(grouped.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "View archived")!.click();
  });
  await waitFor("Archived thought");
  assert.match(grouped.textContent!, /Archived ideas/);
  assert.match(grouped.textContent!, /Back to Ideas/);
  assert.match(grouped.innerHTML, /aria-label="Move to Ideas"/);
  assert.equal(grouped.querySelector(".composer"), null);
  assertEnglish();

  const missing = await mount({ name: "ideas", id: "missing" });
  await waitFor("Can't find this idea");
  assert.match(missing.textContent!, /Back to all ideas/);
  assertEnglish();
});
