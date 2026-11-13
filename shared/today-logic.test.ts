import test from "node:test";
import assert from "node:assert/strict";
import type { QueueCandidate, QueueKind, TodayContribution } from "./today.js";
import {
  ACTION_EFFECTS, applyActionToPayload, buildQueue, buildToday, greetingFor, groupFor, handledToday, largestFreeSlot, laterProjects,
  paceMinutes, ruleBrief, type HandledLogEntry, type ItemStateView,
} from "./today-logic.js";
import { queueAction } from "./today-format.js";

const TZ = "Asia/Taipei";
/** Monday 2026-10-12 08:42 in Taipei (the mockup's moment). */
const NOW = new Date("2026-10-12T00:42:00.000Z");
/** "2026-10-12T14:00" Taipei → ISO UTC. */
const taipei = (local: string) => new Date(`${local}:00+08:00`).toISOString();

function candidate(id: string, kind: QueueKind, hints: QueueCandidate["hints"], title = id): QueueCandidate {
  const [source] = id.split(":");
  return { id, kind, source: source as QueueCandidate["source"], title, meta: [], actions: [queueAction("open")], hints };
}

/** The eight queue rows of the mockup (SPEC §13), in a shuffled order. */
function mockupQueue(): QueueCandidate[] {
  return [
    candidate("ctftime:balsn", "event.decide", { startsAt: taipei("2026-10-17T08:00") }, "Balsn CTF 2026，要參加嗎？"),
    candidate("native:slides", "todo", { dueAt: taipei("2026-10-12T14:00") }, "準備讀書會簡報：Ch.5 Deadlocks"),
    candidate("moodle:lab2", "assignment", { dueAt: taipei("2026-10-14T23:59"), hardDeadline: true }, "計算機網路 Lab 2：Socket Programming"),
    candidate("gmail:lin", "mail.reply", { receivedAt: taipei("2026-10-12T08:05"), important: true, rank: 1 }, "Re: OS 期末專題題目討論"),
    candidate("ai:sitcon", "suggestion.event", {}, "從信件找到 1 個活動，要加入行事曆嗎？"),
    candidate("moodle:hw3", "assignment", { dueAt: taipei("2026-10-12T23:59"), hardDeadline: true }, "作業系統 HW3：CPU Scheduling 模擬"),
    candidate("gmail:cht", "mail.bill", { dueAt: taipei("2026-10-20T23:59"), hardDeadline: true, receivedAt: taipei("2026-10-12T06:12") }, "中華電信 9 月帳單 NT$599"),
    candidate("github:pr127", "review", { receivedAt: taipei("2026-10-11T08:00") }, "審查 #127 新增議程頁深色模式"),
  ];
}

function mockupContributions(): TodayContribution[] {
  return [
    { queue: mockupQueue().slice(0, 4), gapCandidates: [{ itemId: "moodle:hw3", label: "適合寫 HW3", dueAt: taipei("2026-10-12T23:59"), estimateMinutes: 180 }] },
    {
      queue: mockupQueue().slice(4),
      agenda: [
        { start: taipei("2026-10-12T19:30"), end: taipei("2026-10-12T20:30"), title: "健身", meta: "光復校區 體育館", kind: "event", habitLink: "運動" },
        { start: taipei("2026-10-12T10:10"), end: taipei("2026-10-12T12:00"), title: "作業系統", meta: "工程三館 EC115 · 林志明", kind: "event" },
        { start: taipei("2026-10-12T14:00"), end: taipei("2026-10-12T15:30"), title: "OS 讀書會 · Ch.5", meta: "浩然圖書館 討論室 B", kind: "event" },
        { start: taipei("2026-10-12T23:59"), title: "HW3 截止", meta: "作業系統 · NYCU E3", kind: "due", itemId: "moodle:hw3" },
      ],
      nextUp: [{ start: taipei("2026-10-13T09:00"), title: "計算機網路" }],
      later: {
        events: [
          { start: taipei("2026-10-30T00:00"), title: "停修申請截止", meta: "NYCU 校園行事曆" },
          { start: taipei("2026-10-13T09:00"), title: "09:00 計算機網路", meta: "工程三館 EC122 · Google 行事曆" },
          { start: taipei("2026-10-24T09:00"), title: "g0v 零時政府第柒拾次大松", meta: "中研院 · g0v 行事曆訂閱" },
          { start: taipei("2026-10-14T23:59"), title: "Lab 2 截止", meta: "NYCU E3", itemId: "moodle:lab2" },
        ],
      },
      digest: [{ key: "newsletter", label: "電子報", count: 3, action: "read" }, { key: "school", label: "學校公告", count: 2, action: "open" }],
      inboxUnread: 12,
    },
    { digest: [{ key: "github", label: "GitHub 通知", count: 4, action: "read" }], nav: { work: 3 } },
    {
      habits: [
        { id: "read", name: "閱讀 20 分鐘", short: "閱讀", cadence: "今天 07:50 完成", doneToday: true, week: ["y", "y", "y", "y", "y", "y", "y"], streak: 12, streakUnit: "天" },
        { id: "move", name: "運動", short: "運動", cadence: "每週 3 次 · 0/3", doneToday: false, week: ["y", "rest", "y", "rest", "y", "rest", "n"], streak: 4, streakUnit: "週" },
        { id: "diary", name: "寫日記", short: "日記", cadence: "每天 · 睡前", doneToday: false, week: ["y", "y", "y", "y", "y", "y", "n"], streak: 27, streakUnit: "天" },
      ],
      ideas: [
        { id: "i2", text: "CTF writeup 改寫成部落格系列", at: taipei("2026-10-09T21:00") },
        { id: "i1", text: "用 eBPF 量 CFS 排程延遲，當期末專題", at: taipei("2026-10-11T23:10") },
        { id: "i0", text: "舊靈感", at: taipei("2026-10-01T10:00") },
      ],
      sidebar: { streakDays: 12 },
      nav: { tasks: 4 },
      brief: { state: "ready", text: "先回林教授的專題信，再把 OS HW3 收尾。", generatedAt: taipei("2026-10-12T06:30") },
    },
  ];
}

const handledEntry = (itemId: string, at: string, action: HandledLogEntry["action"] = "done", kind = "todo"): HandledLogEntry =>
  ({ actionId: `a-${itemId}-${at}`, itemId, kind, title: itemId, action, at, undoable: true, ...(action === "reply" ? { closes: true } : {}) });

function mockupHandled(): HandledLogEntry[] {
  return [
    handledEntry("gmail:ta", taipei("2026-10-12T08:20"), "reply", "mail.reply"),
    handledEntry("native:fee", taipei("2026-10-12T08:27")),
    handledEntry("native:scholarship", taipei("2026-10-12T08:33")),
  ];
}

function build(overrides: Partial<Parameters<typeof buildToday>[0]> = {}) {
  return buildToday({
    now: NOW, timeZone: TZ, contributions: mockupContributions(), states: new Map(), handledLog: mockupHandled(),
    sources: [], ai: { enabled: true, briefTime: "06:30" }, ...overrides,
  });
}

test("the mockup day groups into 3 · 3 · 2 with the SPEC order inside each group", () => {
  const { payload } = build();
  const ids = Object.fromEntries(payload.queue.map((group) => [group.group, group.items.map((item) => item.id)]));
  assert.deepEqual(ids, {
    now: ["moodle:hw3", "gmail:lin", "github:pr127"],
    today: ["native:slides", "gmail:cht", "ai:sitcon"],
    later: ["moodle:lab2", "ctftime:balsn"],
  });
  assert.deepEqual(payload.queue.map((group) => group.hidden), [0, 0, 0]);
  assert.ok(payload.queue.every((group) => group.items.every((item) => item.group === group.group && !("hints" in item))));
});

test("counts are one store: open 8, handled 3, total 11, pace 35 minutes, habits left 2", () => {
  const { payload } = build();
  assert.deepEqual(payload.counts, {
    open: 8, handled: 3, total: 11, handledBy: { reply: 1, done: 2, snooze: 0, calendar: 0 },
    inboxUnread: 12, habitsLeft: 2, nav: { tasks: 4, work: 3, events: 0 },
  });
  assert.equal(payload.paceMinutes, 35);
  assert.equal(payload.greeting, "早安");
  assert.equal(payload.date, "2026-10-12");
});

test("backlog: contributions sum, 0 leaves the field out, and it never moves counts, queue or nav", () => {
  const base = build().payload;
  assert.equal("backlog" in base, false, "no contribution, no field");
  assert.equal("backlog" in build({ contributions: [...mockupContributions(), { backlog: { undatedTodos: 0 } }, { backlog: {} }] }).payload, false, "0 is not sent");
  const withBacklog = build({ contributions: [...mockupContributions(), { backlog: { undatedTodos: 2 } }, { backlog: { undatedTodos: 1 } }] }).payload;
  assert.deepEqual(withBacklog.backlog, { undatedTodos: 3 });
  const { backlog: _backlog, ...rest } = withBacklog;
  assert.deepEqual(rest, base, "the headline count, progress, queue groups and nav badges are exactly what they were");
});

test("agenda, free slot, next-up and later card match the mockup", () => {
  const { payload } = build();
  assert.deepEqual(payload.agenda.items.map((item) => [item.title, item.past]), [
    ["作業系統", false], ["OS 讀書會 · Ch.5", false], ["健身", false], ["HW3 截止", false],
  ]);
  assert.deepEqual(payload.agenda.gap, {
    start: taipei("2026-10-12T15:30"), end: taipei("2026-10-12T19:30"), hours: 4, forItemId: "moodle:hw3", label: "適合寫 HW3", estimateMinutes: 180,
  });
  assert.deepEqual(payload.nextUp, { start: taipei("2026-10-12T10:10"), title: "作業系統" });
  assert.deepEqual(payload.later.events.map((event) => [event.date, event.label, event.title]), [
    ["10/13", "明天", "09:00 計算機網路"], ["10/24", "週六", "g0v 零時政府第柒拾次大松"],
  ], "Lab 2 is open in the queue; 10/30 is beyond 14 days");
  assert.deepEqual(payload.digest, {
    total: 9,
    categories: [
      { key: "newsletter", label: "電子報", count: 3, action: "read" },
      { key: "school", label: "學校公告", count: 2, action: "open" },
      { key: "github", label: "GitHub 通知", count: 4, action: "read" },
    ],
  });
  assert.deepEqual(payload.ideas.map((idea) => idea.id), ["i1", "i2"]);
  assert.deepEqual(payload.sidebar, { projects: [], streakDays: 12 });
  assert.equal(payload.brief.state, "ready");
  assert.equal(payload.brief.source, "ai");
  assert.equal(payload.brief.next, "06:30");
});

test("the rule brief reproduces state 05b and degrades clause by clause", () => {
  const contributions = mockupContributions().map((item) => ({ ...item, brief: undefined }));
  const fallback = build({ contributions }).payload.brief;
  assert.deepEqual(fallback, {
    state: "fallback", source: "rule", next: "06:30",
    text: "1 封信待回覆，1 項作業今晚 23:59 截止。第一個行程是 10:10 作業系統，15:30 後有 4 小時空檔。",
  });
  const failed = mockupContributions().map((item) => (item.brief ? { ...item, brief: { state: "fallback" as const, reason: "Claude 尚未登入" as const } } : item));
  assert.equal(build({ contributions: failed }).payload.brief.reason, "Claude 尚未登入");
  const off = build({ ai: { enabled: false, briefTime: "06:30" } }).payload.brief;
  assert.equal(off.state, "off");
  assert.equal(off.source, "rule");
  assert.equal(off.next, undefined);

  const empty = { ordered: [], candidates: new Map(), agenda: [], now: NOW, timeZone: TZ };
  assert.equal(ruleBrief({ ...empty, upcoming: [] }), "沒有到期的作業，也沒有行程。");
  assert.equal(ruleBrief({ ...empty, upcoming: [{ start: taipei("2026-10-19T09:00"), title: "計算機網路" }] }), "沒有到期的作業，也沒有行程。下一個是 10/19（一）09:00 計算機網路。");
  const noonDue = buildQueue([candidate("moodle:a", "assignment", { dueAt: taipei("2026-10-12T12:00"), hardDeadline: true })], new Map(), NOW, TZ);
  assert.equal(ruleBrief({ ...empty, ...noonDue, upcoming: [] }), "1 項作業今天 12:00 截止。");
});

test("an empty day: three empty groups, zero counts, no gap pairing, no pace", () => {
  const { payload } = build({ contributions: [], handledLog: [] });
  assert.deepEqual(payload.queue, [
    { group: "now", items: [], hidden: 0, cap: 5 }, { group: "today", items: [], hidden: 0, cap: 5 }, { group: "later", items: [], hidden: 0, cap: 3 },
  ]);
  assert.deepEqual(payload.counts, { open: 0, handled: 0, total: 0, handledBy: { reply: 0, done: 0, snooze: 0, calendar: 0 }, inboxUnread: 0, habitsLeft: 0 });
  assert.equal(payload.paceMinutes, undefined);
  assert.equal(payload.agenda.gap, undefined);
  assert.equal(payload.nextUp, undefined);
  assert.equal(payload.digest, undefined);
  assert.equal(payload.brief.text, "沒有到期的作業，也沒有行程。");
});

test("an all-handled day: every row closed, total stays, no pace", () => {
  const states = new Map<string, ItemStateView>(mockupQueue().map((item) => [item.id, { state: "handled", fingerprint: null }]));
  const log = [...mockupHandled(), ...mockupQueue().map((item, index) => handledEntry(item.id, taipei(`2026-10-12T09:${String(10 + index).padStart(2, "0")}`), item.kind === "suggestion.event" ? "calendar" : "done", item.kind))];
  const { payload } = build({ states, handledLog: log });
  assert.equal(payload.counts.open, 0);
  assert.equal(payload.counts.handled, 11);
  assert.equal(payload.counts.total, 11);
  assert.deepEqual(payload.counts.handledBy, { reply: 1, done: 9, snooze: 0, calendar: 1 });
  assert.equal(payload.paceMinutes, undefined);
  assert.equal(payload.handled?.[0].itemId, "github:pr127", "newest first");
});

test("caps: 最重要 and 今天內 show 5 rows, 可以等 3; event.decide keeps the two nearest", () => {
  const now = Array.from({ length: 7 }, (_, index) => candidate(`gmail:n${index}`, "mail.reply", { important: true, receivedAt: taipei(`2026-10-12T0${index}:00`) }));
  const later = Array.from({ length: 4 }, (_, index) => candidate(`moodle:l${index}`, "assignment", { dueAt: taipei(`2026-10-1${5 + index}T12:00`), hardDeadline: true }));
  const events = [18, 16, 25].map((day) => candidate(`ctftime:e${day}`, "event.decide", { startsAt: taipei(`2026-10-${day}T09:00`) }));
  const { queue } = buildQueue([...now, ...later, ...events], new Map(), NOW, TZ);
  assert.equal(queue[0].items.length, 7);
  assert.equal(queue[0].hidden, 2);
  assert.deepEqual(queue[0].items.slice(0, 2).map((item) => item.id), ["gmail:n6", "gmail:n5"], "received descending");
  assert.deepEqual(queue[2].items.map((item) => item.id), ["moodle:l0", "moodle:l1", "moodle:l2", "moodle:l3", "ctftime:e16", "ctftime:e18"]);
  assert.equal(queue[2].hidden, 3);
});

test("可以等: the two event.decide rows are shown by start time, whatever their ids", () => {
  const events = [
    candidate("ctftime:a", "event.decide", { startsAt: taipei("2026-10-18T09:00") }),
    candidate("ctftime:z", "event.decide", { startsAt: taipei("2026-10-16T09:00") }),
    candidate("ctftime:far", "event.decide", { startsAt: taipei("2026-10-19T09:00") }),
  ];
  const deadline = candidate("moodle:hw", "assignment", { dueAt: taipei("2026-10-17T12:00"), hardDeadline: true });
  const { queue } = buildQueue([...events, deadline], new Map(), NOW, TZ);
  assert.deepEqual(queue[2].items.map((item) => item.id), ["moodle:hw", "ctftime:z", "ctftime:a"], "a deadline first, then the nearest event, then the next");
});

test("an action on a served payload follows ACTION_EFFECTS: rows, counts, caps, 回覆中… and the free slot", () => {
  const { payload } = build();
  const archived = applyActionToPayload(payload, "gmail:cht", "archive");
  assert.deepEqual(archived.queue[1].items.map((item) => item.id), ["native:slides", "ai:sitcon"]);
  assert.deepEqual([archived.counts.open, archived.counts.handled, archived.counts.total, archived.counts.inboxUnread], [7, 4, 11, 11]);
  assert.equal(archived.counts.handledBy.done, payload.counts.handledBy.done + 1);
  assert.equal(applyActionToPayload(archived, "gmail:cht", "archive"), archived, "applying twice changes nothing");
  assert.equal(applyActionToPayload(payload, "ai:sitcon", "calendar").counts.handledBy.calendar, 1);
  assert.equal(applyActionToPayload(payload, "native:slides", "todo").counts.inboxUnread, 12, "轉待辦 leaves mail unread");

  const replying = applyActionToPayload(payload, "gmail:lin", "reply");
  assert.equal(replying.queue[0].items.find((item) => item.id === "gmail:lin")?.replying, true);
  assert.deepEqual(replying.counts, payload.counts, "回覆 is handled only when the mail module sees it sent");
  assert.equal(applyActionToPayload(payload, "moodle:hw3", "open"), payload);
  assert.equal(applyActionToPayload(payload, "moodle:hw3", "schedule").agenda.gap, undefined);
  assert.equal(applyActionToPayload(payload, "moodle:lab2", "schedule"), payload, "排進 only removes the slot it filled");

  const allRead = applyActionToPayload(payload, "gmail:digest", "read");
  assert.equal(allRead.digest, undefined, "全部標為已讀 empties the digest strip");
  assert.equal(allRead.counts.inboxUnread, payload.counts.inboxUnread - 9);
  assert.deepEqual([allRead.counts.open, allRead.counts.handled], [payload.counts.open, payload.counts.handled], "digest mail is never queue work");
  assert.equal(applyActionToPayload(allRead, "gmail:digest", "read"), allRead, "applying twice changes nothing");
  const oneCategory = applyActionToPayload(payload, "gmail:digest:newsletter", "read");
  assert.deepEqual(oneCategory.digest, { total: 6, categories: payload.digest!.categories.filter((category) => category.key !== "newsletter") });
  assert.equal(oneCategory.counts.inboxUnread, payload.counts.inboxUnread - 3);
  assert.equal(applyActionToPayload(payload, "gmail:digest:school", "open"), payload, "開啟 a category changes nothing");

  const now = Array.from({ length: 7 }, (_, index) => candidate(`gmail:n${index}`, "mail.reply", { important: true, receivedAt: taipei(`2026-10-12T0${index}:00`) }));
  const crowded = build({ contributions: [{ queue: now }] }).payload;
  assert.equal(crowded.queue[0].hidden, 2);
  const fewer = applyActionToPayload(crowded, "gmail:n6", "archive");
  assert.deepEqual([fewer.queue[0].items.length, fewer.queue[0].hidden], [6, 1], "a hidden row moves up into view");
});

test("SPEC-mail-assignments §1.3: 刪除 closes a mail row like 封存, 移回收件匣 touches no row, 轉成作業 closes like 轉待辦", () => {
  const { payload } = build();
  const trashed = applyActionToPayload(payload, "gmail:lin", "trash");
  assert.equal(trashed.queue[0].items.some((item) => item.id === "gmail:lin"), false);
  assert.deepEqual([trashed.counts.open, trashed.counts.handled, trashed.counts.inboxUnread], [7, 4, 11], "刪除 also lowers the unread badge");
  assert.equal(trashed.counts.handledBy.done, payload.counts.handledBy.done + 1);
  assert.equal(applyActionToPayload(payload, "gmail:lin", "unarchive"), payload, "移回收件匣 is never a queue row change");
  const converted = applyActionToPayload(payload, "gmail:lin", "assignment");
  assert.deepEqual([converted.counts.open, converted.counts.handled, converted.counts.inboxUnread], [7, 4, 12], "轉成作業 leaves the mail unread");
  assert.deepEqual(
    [ACTION_EFFECTS.trash.route, ACTION_EFFECTS.unarchive.route, ACTION_EFFECTS.assignment.route, ACTION_EFFECTS.unarchive.closes],
    ["source", "source", "any-assignment", false],
  );
  const suggestion = candidate("ai:hw5", "suggestion.assignment", { receivedAt: taipei("2026-10-12T07:00") });
  assert.equal(groupFor(suggestion, NOW, TZ), "today", "assignment suggestions sit in 今天內 like the others");
  assert.deepEqual(handledToday([{ actionId: "a1", itemId: "ai:hw5", kind: "suggestion.assignment", title: "HW5", action: "assignment", at: taipei("2026-10-12T08:40"), undoable: true }], new Set()).map((item) => item.kind), ["suggestion.assignment"]);
});

test("grouping rules follow SPEC §4.3, including Asia/Taipei day boundaries on a UTC host", () => {
  const group = (kind: QueueKind, hints: QueueCandidate["hints"], now = NOW) => groupFor(candidate("native:x", kind, hints), now, TZ);
  assert.equal(group("todo", { dueAt: taipei("2026-10-12T08:00") }), "now", "overdue");
  assert.equal(group("todo", { dueAt: taipei("2026-10-12T20:00"), hardDeadline: true }), "now", "hard deadline within 24 h");
  assert.equal(group("todo", { dueAt: taipei("2026-10-12T20:00") }), "today", "soft deadline today");
  assert.equal(group("todo", { dueAt: taipei("2026-10-17T20:00") }), "later");
  assert.equal(group("todo", { dueAt: taipei("2026-10-20T20:00") }), null, "beyond 7 days");
  assert.equal(group("todo", {}), null, "someday todos stay on #/tasks");
  assert.equal(group("mail.bill", { dueAt: taipei("2026-10-25T23:59"), hardDeadline: true }), "today", "bills are always today unless urgent");
  assert.equal(group("mail.reply", {}), "today");
  assert.equal(group("review", { receivedAt: taipei("2026-10-12T07:00") }), "today");
  assert.equal(group("pr.changes", {}), "now");
  assert.equal(group("suggestion.todo", { dueAt: taipei("2026-10-30T12:00") }), "today");
  // 00:30 on 10/13 in Taipei is still 10/12 16:30 UTC: a deadline at 23:59 on 10/12 is already overdue.
  const afterMidnight = new Date("2026-10-12T16:30:00.000Z");
  assert.equal(group("todo", { dueAt: taipei("2026-10-12T23:59") }, afterMidnight), "now");
  assert.equal(group("todo", { dueAt: taipei("2026-10-13T23:59") }, afterMidnight), "today");
  assert.equal(greetingFor(new Date("2026-10-12T21:00:00.000Z"), TZ), "早安", "05:00 Taipei");
  assert.equal(greetingFor(new Date("2026-10-12T02:59:00.000Z"), TZ), "早安", "10:59");
  assert.equal(greetingFor(new Date("2026-10-12T03:00:00.000Z"), TZ), "午安", "11:00");
  assert.equal(greetingFor(new Date("2026-10-12T09:00:00.000Z"), TZ), "辛苦了", "17:00");
  assert.equal(greetingFor(new Date("2026-10-12T20:59:00.000Z"), TZ), "辛苦了", "04:59");
});

test("item state: snooze until, dismiss forever or until change, handled, replying", () => {
  const items = [
    candidate("gmail:snoozed", "mail.action", {}),
    candidate("gmail:woke", "mail.action", {}),
    candidate("ctftime:gone", "event.decide", { startsAt: taipei("2026-10-15T09:00") }),
    candidate("moodle:same", "assignment", { dueAt: taipei("2026-10-13T12:00"), hardDeadline: true, fingerprint: "due-1" }),
    candidate("moodle:moved", "assignment", { dueAt: taipei("2026-10-13T12:00"), hardDeadline: true, fingerprint: "due-2" }),
    candidate("gmail:reply", "mail.reply", {}),
  ];
  const states = new Map<string, ItemStateView>([
    ["gmail:snoozed", { state: "snoozed", until: taipei("2026-10-12T20:00") }],
    ["gmail:woke", { state: "snoozed", until: taipei("2026-10-12T08:00") }],
    ["ctftime:gone", { state: "dismissed", fingerprint: null }],
    ["moodle:same", { state: "dismissed", fingerprint: "due-1" }],
    ["moodle:moved", { state: "dismissed", fingerprint: "due-1" }],
    ["gmail:reply", { state: "replying" }],
  ]);
  const { ordered } = buildQueue(items, states, NOW, TZ);
  assert.deepEqual(ordered.map((item) => item.id).sort(), ["gmail:reply", "gmail:woke", "moodle:moved"]);
  assert.equal(ordered.find((item) => item.id === "gmail:reply")?.replying, true);
  // A snooze that already woke up is open again, so it is not also counted as handled.
  const handled = handledToday([handledEntry("gmail:woke", taipei("2026-10-12T07:00"), "snooze", "mail.action"), handledEntry("gmail:snoozed", taipei("2026-10-12T07:05"), "snooze", "mail.action")], new Set(ordered.map((item) => item.id)));
  assert.deepEqual(handled.map((item) => item.itemId), ["gmail:snoozed"]);
});

test("handled counting: latest action per item, queue kinds and closing actions only", () => {
  const log = [
    handledEntry("gmail:a", taipei("2026-10-12T08:00"), "snooze", "mail.action"),
    handledEntry("gmail:a", taipei("2026-10-12T08:30"), "archive", "mail.action"),
    handledEntry("gmail:digest", taipei("2026-10-12T08:31"), "read", "digest"),
    handledEntry("gmail:b", taipei("2026-10-12T08:32"), "open", "mail.action"),
    handledEntry("gmail:c", taipei("2026-10-12T08:33"), "reply", "mail.reply"),
    { ...handledEntry("gmail:d", taipei("2026-10-12T08:34"), "reply", "mail.reply"), closes: false },
  ];
  const handled = handledToday(log, new Set());
  assert.deepEqual(handled.map((item) => [item.itemId, item.action]), [["gmail:c", "reply"], ["gmail:a", "archive"]]);
  assert.equal(ACTION_EFFECTS.reply.closes, false, "a user's 回覆 keeps the row; only the module's sent-reply detection closes it");
});

test("pace: (first → last ÷ handled) × open, clamped 5–120, rounded to 5", () => {
  const at = (minute: number) => taipei(`2026-10-12T08:${String(minute).padStart(2, "0")}`);
  assert.equal(paceMinutes([at(20), at(27)], 8), undefined, "needs 3 handled");
  assert.equal(paceMinutes([at(20), at(27), at(33)], 8), 35);
  assert.equal(paceMinutes([at(20), at(20), at(20)], 8), 5, "clamped up");
  assert.equal(paceMinutes([at(0), at(30), at(59)], 30), 120, "clamped down");
  assert.equal(paceMinutes([at(0), at(30), at(59)], 0), undefined);
});

test("free slots: at least 90 minutes, between now and 22:00, paired with a deadline in 48 h", () => {
  const event = (start: string, end: string) => ({ start: taipei(start), end: taipei(end), title: "x", meta: "", kind: "event" as const, past: false });
  const agenda = [event("2026-10-12T09:00", "2026-10-12T20:45")];
  assert.equal(largestFreeSlot(agenda, NOW, TZ), undefined, "08:42–09:00 and 20:45–22:00 are too short");
  const late = new Date(taipei("2026-10-12T22:10"));
  assert.equal(largestFreeSlot([], late, TZ), undefined, "after 22:00");
  const slot = largestFreeSlot([event("2026-10-12T09:00", "2026-10-12T19:00")], NOW, TZ);
  assert.deepEqual(slot && [slot.start.toISOString(), slot.end.toISOString()], [taipei("2026-10-12T19:00"), taipei("2026-10-12T22:00")]);
  const far = mockupContributions().map((item) => (item.gapCandidates ? { ...item, gapCandidates: [{ itemId: "moodle:lab2", label: "適合寫 Lab 2", dueAt: taipei("2026-10-14T23:59") }] } : item));
  assert.equal(build({ contributions: far }).payload.agenda.gap, undefined, "Lab 2 is due in more than 48 h");
});

test("later projects keep one slot for a waiting PR", () => {
  const project = (name: string) => ({ name, pct: 10, next: "x" });
  const pr = { name: "vitejs/vite #18234", next: "等待審查 3 天", pr: true };
  assert.deepEqual(laterProjects([{ later: { projects: [project("a"), project("b"), project("c")] } }, { later: { projects: [pr] } }]).map((item) => item.name), ["a", "b", "vitejs/vite #18234"]);
  assert.deepEqual(laterProjects([{ later: { projects: [project("a"), project("b"), project("c"), project("d")] } }]).map((item) => item.name), ["a", "b", "c"]);
});

test("past agenda rows and the weather/sidebar merge", () => {
  const noon = new Date(taipei("2026-10-12T12:30"));
  const { payload } = build({ now: noon });
  assert.deepEqual(payload.agenda.items.map((item) => item.past), [true, false, false, false]);
  assert.equal(payload.greeting, "午安");
  assert.deepEqual(payload.nextUp, { start: taipei("2026-10-12T14:00"), title: "OS 讀書會 · Ch.5" });
  const withWeather = build({ contributions: [{ weather: { city: "新竹", tempC: 24, text: "多雲" } }, { weather: { city: "台北", tempC: 20, text: "晴" } }] });
  assert.equal(withWeather.payload.weather?.city, "新竹", "first contribution wins");
});
