import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { dayKey } from "../../../shared/time";
import { todoDeadline, todoDuration, todoWhen } from "../../../shared/todo-format";
import type { Todo } from "../../../shared/todos";
import { TASKS, TIDY, TODO_ORIGIN_LABELS, tasksCopy } from "../../copy/tasks";
import strings from "../../copy/tasks-strings.json";
import { groupTodos, schedulePresets, scheduleWhen, taskMeta } from "./model";

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

function makeTodo(title: string, extra: Partial<Todo> = {}): Todo {
  return {
    id: title.toLowerCase().replaceAll(" ", "-"),
    title,
    status: "open",
    priority: "normal",
    origin: "manual",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

test("tasks has 103/103 paired keys with verbatim signed-off values and matching placeholders", () => {
  const zh = leaves(strings["zh-TW"].tasks);
  const en = leaves(strings.en.tasks);
  assert.equal(zh.length, 103);
  assert.equal(en.length, 103);
  assert.deepEqual(en.map(([key]) => key), zh.map(([key]) => key));
  en.forEach(([key, value], index) => {
    assert.deepEqual(placeholders(value).sort(), placeholders(zh[index][1]).sort(), key);
    assert.doesNotMatch(value, CJK, key);
  });
  assert.doesNotMatch(JSON.stringify(strings), /點子/);
  assert.equal(tasksCopy("zh-TW").PAGE_HEAD_TITLE, strings["zh-TW"].tasks.pageHead.title);
  assert.equal(tasksCopy("en").PAGE_HEAD_TITLE, strings.en.tasks.pageHead.title);
  assert.deepEqual(tasksCopy("zh-TW").DUE_FORMAT, strings["zh-TW"].tasks.dueFormat);
  assert.deepEqual(tasksCopy("en").DUE_FORMAT, strings.en.tasks.dueFormat);
});

test("legacy Tasks exports resolve the active locale without changing their signatures", (t) => {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  const window = { location: { search: "?lang=en" } };
  scope.window = window;
  t.after(() => {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  });

  assert.equal(TASKS.emptyTitle, "All clear. Enjoy the breather.");
  assert.equal(TASKS.countLabel(1), "1 task");
  assert.equal(TASKS.countLabel(2), "2 tasks");
  assert.equal(TASKS.checkLabel("Pay bill", false), "Complete “Pay bill”");
  assert.equal(TASKS.toasts.scheduled("Pay bill", "today"), "Scheduled “Pay bill” for today");
  assert.equal(TODO_ORIGIN_LABELS["quick-capture"], "Quick note");
  assert.equal(TIDY.action, "Tidy up");
  assert.equal(TIDY.failed("No response."), "Couldn't tidy up: No response.");

  window.location.search = "?lang=zh-TW";
  assert.equal(TASKS.emptyTitle, "沒有待辦，享受一下。");
  assert.equal(TASKS.countLabel(1), "1 件");
  assert.equal(TASKS.checkLabel("繳電費", false), "完成「繳電費」");
  assert.equal(TASKS.toasts.scheduled("繳電費", "今天"), "已排到今天「繳電費」");
  assert.equal(TODO_ORIGIN_LABELS["quick-capture"], "快速記下");
  assert.equal(TIDY.action, "整理");
});

test("English task groups, metadata, scheduling, and due formatting preserve zh-TW defaults", () => {
  const todos = [
    makeTodo("Pay bill", { dueDay: TODAY, origin: "mail", estimateMinutes: 40 }),
    makeTodo("Write checklist"),
  ];
  assert.deepEqual(groupTodos(todos, TODAY, NOW, TZ, "en").map((group) => group.label), ["Today", "No due date"]);
  assert.deepEqual(taskMeta(todos[0], TODAY, NOW, TZ, undefined, "en"), ["Mail", "Due today", "Est. 40 min"]);
  assert.deepEqual(taskMeta(makeTodo("Report", { dueDay: "2026-11-13", origin: "mail" }), TODAY, NOW, TZ, undefined, "en"), ["Mail", "Due Fri"]);
  assert.deepEqual(schedulePresets(TODAY, "en").map((preset) => preset.label), ["Today", "Tomorrow", "This weekend", "Next Monday"]);
  assert.equal(scheduleWhen(TODAY, TODAY, TZ, "en"), "today");
  assert.equal(scheduleWhen("2026-11-12", TODAY, TZ, "en"), "tomorrow");
  assert.equal(scheduleWhen("2026-11-14", TODAY, TZ, "en"), "Sat, Nov 14");
  assert.equal(todoWhen({ dueDay: TODAY }, TODAY, NOW, TZ, "en")?.label, "Due today");
  assert.equal(todoWhen({ dueDay: TODAY, dueTime: "08:00" }, TODAY, NOW, TZ, "en")?.label, "1h overdue");
  assert.equal(todoDeadline({ dueDay: "2026-11-12", dueTime: "09:00" }, TODAY, NOW, TZ, "en"), "Due tomorrow 09:00");
  assert.equal(todoDuration(90, "en"), "1 hr 30 min");

  assert.deepEqual(groupTodos(todos, TODAY, NOW, TZ).map((group) => group.label), ["今天", "沒有期限"]);
  assert.deepEqual(taskMeta(todos[0], TODAY, NOW, TZ), ["信件", "今天截止", "預估 40 分鐘"]);
  assert.equal(scheduleWhen(TODAY, TODAY, TZ), "今天");
  assert.equal(scheduleWhen("2026-11-12", TODAY, TZ), "明天");
  assert.equal(todoWhen({ dueDay: TODAY }, TODAY, NOW, TZ)?.label, "今天到期");
  assert.equal(todoDeadline({ dueDay: "2026-11-12", dueTime: "09:00" }, TODAY, NOW, TZ), "明天 09:00 截止");
  assert.equal(todoDuration(90), "1 小時 30 分鐘");

  const preMidnight = new Date("2026-11-11T23:59:30+08:00");
  assert.equal(dayKey(TZ, preMidnight), "2026-11-11");
  assert.deepEqual(todoWhen({ dueDay: "2026-11-12", dueTime: "02:00" }, "2026-11-12", preMidnight, TZ, "en"), { label: "02:00", tone: "warm", mono: true });
  assert.deepEqual(todoWhen({ dueDay: "2026-11-12", dueTime: "02:00" }, "2026-11-12", preMidnight, TZ, "zh-TW"), { label: "02:00", tone: "warm", mono: true });
  const postMidnight = new Date("2026-11-12T00:05:00+08:00");
  assert.equal(dayKey(TZ, postMidnight), "2026-11-12");
  assert.deepEqual(todoWhen({ dueDay: "2026-11-12", dueTime: "09:00" }, TODAY, postMidnight, TZ, "en"), { label: "Tomorrow 09:00", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-11-12", dueTime: "09:00" }, TODAY, postMidnight, TZ, "zh-TW"), { label: "明天 09:00", mono: false });
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

test("HappyDOM renders English empty, grouped, editor, schedule, done, and linked-done states without CJK", { skip: !HappyWindow }, async (t) => {
  const RealDate = globalThis.Date;
  let currentMs = NOW.getTime();
  const setFrozenDate = (next: Date) => {
    currentMs = next.getTime();
  };
  function FrozenDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(currentMs).toString();
    if (args.length === 0) return new RealDate(currentMs);
    if (args.length === 1) return new RealDate(args[0] as string | number | Date);
    const [year, month, date = 1, hours = 0, minutes = 0, seconds = 0, ms = 0] = args as number[];
    return new RealDate(year, month, date, hours, minutes, seconds, ms);
  }
  FrozenDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(FrozenDate, RealDate);
  FrozenDate.now = () => currentMs;
  FrozenDate.parse = RealDate.parse.bind(RealDate);
  FrozenDate.UTC = RealDate.UTC.bind(RealDate);
  globalThis.Date = FrozenDate as unknown as DateConstructor;

  const dom = new HappyWindow({ url: "http://personal.test/?lang=en#/tasks" });
  (dom as unknown as { Date: DateConstructor }).Date = globalThis.Date;
  const names = [
    "window", "document", "navigator", "Element", "HTMLElement", "HTMLButtonElement", "HTMLHeadingElement", "HTMLInputElement",
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

  const done = makeTodo("Finished report", {
    id: "done-1",
    status: "done",
    completedAt: "2026-11-08T06:30:00.000Z",
  });
  let list = { day: TODAY, open: [] as Todo[], completedToday: [] as Todo[] };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const path = String(input);
    let body: unknown;
    if (path === "/api/todos") body = list;
    else if (path === "/api/todos/done-1") body = done;
    else if (path === "/api/status") body = { today: TODAY, timeZone: TZ, sources: [], modules: { capture: { aiParse: true, eventTarget: "local" } } };
    else if (path === "/api/today") body = { date: TODAY, now: NOW.toISOString(), counts: { open: 0, inboxUnread: 0, habitsLeft: 0, nav: {} }, queue: [], sources: [], sidebar: { projects: [], streakDays: 0 } };
    else if (path === "/api/sync") body = { started: [], sources: [] };
    else if (path === "/api/suite/manifest") body = { schemaVersion: 1, links: {} };
    else throw new Error(`Unexpected test request: ${path}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const roots: Array<{ unmount(): void }> = [];
  t.after(async () => {
    try {
      const { act } = await import("react");
      for (const root of roots) await act(async () => root.unmount());
    } finally {
      globalThis.Date = RealDate;
      globalThis.fetch = previousFetch;
      for (const name of names) {
        const descriptor = descriptors.get(name);
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
      await dom.happyDOM.close();
    }
  });

  const [{ act, createElement }, { createRoot }, { default: TasksPage }, { ToastProvider }, { StatusProvider }, { TodayProvider }, { clearTidying, markTidying }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./TasksPage"),
    import("../../components/toast/ToastProvider"),
    import("../../lib/status"),
    import("../../lib/today"),
    import("../../components/capture/tidy"),
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
  const mount = async (route: { name: "tasks"; id?: string }): Promise<HTMLElement> => {
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(ToastProvider, null,
        createElement(StatusProvider, null,
          createElement(TodayProvider, null,
            createElement(TasksPage, { route })))));
    });
    return container;
  };

  await mount({ name: "tasks" });
  await waitFor("All clear. Enjoy the breather.");
  assert.match(dom.document.body.textContent!, /One thing at a time\./);
  assert.match(dom.document.body.innerHTML, /placeholder="Add a task, like “Pay bill by Fri”"/);
  assertEnglish();

  list = {
    day: TODAY,
    open: [
      makeTodo("Pay bill", { id: "bill", dueDay: TODAY, origin: "mail", estimateMinutes: 40 }),
      makeTodo("Write checklist", {
        id: "checklist",
        origin: "quick-capture",
        notes: "Launch details",
        originalText: "Write the full launch checklist",
        tidiedAt: "2026-11-10T00:00:00.000Z",
        pretidy: { title: "Write the full launch checklist", notes: "Launch details" },
      }),
    ],
    completedToday: [done],
  };
  const grouped = await mount({ name: "tasks" });
  await waitFor("Pay bill");
  assert.equal(Boolean(grouped.querySelector(".q-group.is-overdue")), false);
  assert.match(grouped.textContent!, /Today/);
  assert.match(grouped.textContent!, /No due date/);
  assert.match(grouped.textContent!, /Mail · Due today · Est\. 40 min/);
  assert.match(grouped.textContent!, /1 completed today/);
  assertEnglish();

  assert.equal(Boolean(grouped.querySelector('[data-todo="checklist"] .task-sched')), true);
  assert.equal(Boolean(grouped.querySelector('[data-todo="checklist"] .tidy-mark')), false);
  const tidyStart = { kind: "todo" as const, id: "checklist", jobId: "job-checklist-1" };
  try {
    await act(async () => {
      markTidying(tidyStart);
    });
    assert.equal(Boolean(grouped.querySelector('[data-todo="checklist"] .task-sched')), false);
    assert.equal(grouped.querySelector('[data-todo="checklist"] .tidy-mark')?.textContent, "Tidying…");
    assertEnglish();
  } finally {
    await act(async () => {
      clearTidying(tidyStart);
    });
  }
  assert.equal(Boolean(grouped.querySelector('[data-todo="checklist"] .task-sched')), true);
  assert.equal(Boolean(grouped.querySelector('[data-todo="checklist"] .tidy-mark')), false);

  await act(async () => {
    grouped.querySelector<HTMLButtonElement>('[data-todo="checklist"] .q-title')!.click();
  });
  await waitFor("Original: Write the full launch checklist");
  assert.match(grouped.textContent!, /Tidy up/);
  assert.match(grouped.textContent!, /Revert tidy/);
  assert.match(grouped.innerHTML, /aria-label="Tidy up “Write checklist” with AI"/);
  assertEnglish();

  await act(async () => {
    grouped.querySelector<HTMLButtonElement>('[data-todo="checklist"] .task-sched')!.click();
  });
  await waitFor("Schedule for…");
  assert.equal(dom.document.body.querySelector('[role="dialog"]')?.getAttribute("aria-modal"), "true");
  assert.match(dom.document.body.textContent!, /This weekend/);
  assert.match(dom.document.body.textContent!, /Next Monday/);
  assert.match(dom.document.body.textContent!, /Pick a date…/);
  assertEnglish();
  await act(async () => {
    dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(Boolean(dom.document.body.querySelector('[role="dialog"]')), false);

  await act(async () => {
    grouped.querySelector<HTMLButtonElement>(".tasks-done-toggle")!.click();
  });
  await waitFor("Finished report");
  assert.match(grouped.innerHTML, /aria-label="“Finished report” is done\. Press to mark incomplete"/);
  assertEnglish();

  list = { day: TODAY, open: [], completedToday: [done] };
  const linked = await mount({ name: "tasks", id: "done-1" });
  await waitFor("Completed · Nov 8, 14:30");
  assert.match(linked.textContent!, /Reopen/);
  assert.match(linked.textContent!, /Back to all tasks/);
  assertEnglish();

  setFrozenDate(new RealDate("2026-11-11T23:59:30+08:00"));
  list = {
    day: "2026-11-12",
    open: [makeTodo("Morning standup", { id: "standup", dueDay: "2026-11-12", dueTime: "02:00" })],
    completedToday: [],
  };
  const midnightSkew = await mount({ name: "tasks" });
  await waitFor("Morning standup");
  assert.equal(Boolean(midnightSkew.querySelector(".q-group.is-overdue")), false);
  assert.equal(midnightSkew.querySelector("h3")?.textContent, "Today");
  assert.equal(midnightSkew.querySelector('[data-todo="standup"] .when.warm')?.textContent, "02:00");
  assertEnglish();

  setFrozenDate(new RealDate("2026-11-12T00:05:00+08:00"));
  list = {
    day: TODAY,
    open: [
      makeTodo("Late bill", { id: "late-bill", dueDay: TODAY, origin: "mail" }),
      makeTodo("Morning sync", { id: "morning-sync", dueDay: "2026-11-12", dueTime: "09:00" }),
    ],
    completedToday: [],
  };
  const postMidnight = await mount({ name: "tasks" });
  await waitFor("Late bill");
  assert.equal(postMidnight.querySelector(".q-group.is-overdue h3")?.textContent, "Overdue");
  assert.equal(postMidnight.querySelector('[data-todo="late-bill"] .when.hot')?.textContent, "1h overdue");
  assert.equal(postMidnight.querySelector('[data-todo="morning-sync"] .when')?.textContent, "Tomorrow 09:00");
  assertEnglish();
});
