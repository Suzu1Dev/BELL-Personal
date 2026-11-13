import test from "node:test";
import assert from "node:assert/strict";
import type { SourceStatus } from "../../shared/sources";
import type { ActionStatus, TodaySource } from "../../shared/today";
import { applyActionToPayload } from "../../shared/today-logic";
import {
  clockTime, createdToast, dayEyebrow, reportRemoteFailure, findQueueItem, followSync, itemTitle, navCounts, offersUndo, projectColorVar, remoteFailure, restoreQueueItem, sidebarProjects,
  snapshotQueueItem, streakDays, syncChipState,
} from "./today-model";
import { mockupToday } from "./today.fixture";

test("a closing action removes the row once and moves one count from open to handled", () => {
  const before = mockupToday();
  const after = applyActionToPayload(before, "native:slides", "done");
  assert.equal(findQueueItem(after, "native:slides"), undefined);
  assert.equal(after.queue.find((group) => group.group === "today")?.items.length, 2);
  assert.deepEqual({ open: after.counts.open, handled: after.counts.handled, total: after.counts.total }, { open: 7, handled: 4, total: 11 });
  assert.equal(after.counts.handledBy.done, 2);
  assert.equal(before.counts.open, 8, "the input is not mutated");
  // Re-applying to data that no longer has the row changes nothing (no double count).
  assert.deepEqual(applyActionToPayload(after, "native:slides", "done"), after);
});

test("handled buckets follow the cleared-state stats and mail reads lower the unread badge", () => {
  const snoozed = applyActionToPayload(mockupToday(), "moodle:hw3", "snooze");
  assert.equal(snoozed.counts.handledBy.snooze, 2);
  const going = applyActionToPayload(mockupToday(), "ctftime:balsn", "going");
  assert.equal(going.counts.handledBy.calendar, 1);
  const archived = applyActionToPayload(mockupToday(), "gmail:thread-os", "archive");
  assert.equal(archived.counts.inboxUnread, 11);
  const toTodo = applyActionToPayload(mockupToday(), "gmail:bill", "todo");
  assert.equal(toTodo.counts.inboxUnread, 12, "轉待辦 leaves the mail unread in Gmail");
});

test("回覆 marks the row 回覆中… and 開啟 keeps it; 排進 removes only the free-slot suggestion", () => {
  const today = mockupToday();
  const replying = applyActionToPayload(today, "gmail:thread-os", "reply");
  assert.equal(findQueueItem(replying, "gmail:thread-os")?.replying, true);
  assert.deepEqual(replying.counts, today.counts, "a reply is not handled until the mail module sees it sent");
  assert.equal(applyActionToPayload(replying, "gmail:thread-os", "reply"), replying, "marking twice is a no-op");
  assert.deepEqual(applyActionToPayload(today, "moodle:hw3", "open"), today);
  const scheduled = applyActionToPayload(today, "moodle:hw3", "schedule");
  assert.equal(scheduled.agenda.gap, undefined);
  assert.equal(scheduled.counts.open, 8);
  assert.deepEqual(applyActionToPayload(today, "other", "schedule"), today);
});

test("復原 puts the row back in its old place and reverses the counts exactly once", () => {
  const original = mockupToday();
  const snapshot = snapshotQueueItem(original, "gmail:bill", "archive");
  assert.ok(snapshot);
  assert.deepEqual({ group: snapshot.group, index: snapshot.index }, { group: "today", index: 1 });
  const archived = applyActionToPayload(original, "gmail:bill", "archive");
  const restored = restoreQueueItem(archived, snapshot);
  assert.deepEqual(restored, original);
  assert.deepEqual(restoreQueueItem(restored, snapshot), restored, "a second restore is a no-op");
  assert.equal(snapshotQueueItem(original, "missing", "done"), undefined);
});

test("nav counts come straight from counts; the module badges come from counts.nav when sent", () => {
  assert.deepEqual(navCounts(undefined), {});
  const today = mockupToday();
  assert.deepEqual(navCounts(today), { today: 8, inbox: 12, tasks: undefined, work: undefined, events: undefined, habits: 2 });
  today.counts.nav = { tasks: 4, work: 3, events: -1 };
  assert.deepEqual(navCounts(today), { today: 8, inbox: 12, tasks: 4, work: 3, events: undefined, habits: 2 });
});

test("sidebar projects come from sidebar.projects, else the later card's native rows", () => {
  const fallback = mockupToday();
  assert.deepEqual(sidebarProjects(fallback), [
    { name: "OS 期末專題", pct: 20, colorVar: "var(--m-task)", href: "#/work?tab=projects" },
    { name: "ctf-notes", pct: 64, colorVar: "var(--m-event)", href: "#/work?tab=projects" },
  ], "PR rows are skipped");
  fallback.later.projects = [{ name: "x", pct: 140, next: "", color: "neon", href: "#/work/projects/x" }, { name: "y", next: "", href: "https://example.com" }];
  assert.deepEqual(sidebarProjects(fallback), [
    { name: "x", pct: 100, colorVar: "var(--m-task)", href: "#/work/projects/x" },
    { name: "y", pct: undefined, colorVar: "var(--m-task)", href: "#/work?tab=projects" },
  ], "progress is clamped, unknown colours fall back, only in-app links are kept");

  const served = mockupToday();
  served.sidebar = { projects: [
    { id: "os-final", name: "OS 期末專題", pct: 20, color: "task" },
    { id: "a/b", name: "bell-personal", pct: 38, color: "accent" },
  ] };
  assert.deepEqual(sidebarProjects(served), [
    { name: "OS 期末專題", pct: 20, colorVar: "var(--m-task)", href: "#/work/projects/os-final" },
    { name: "bell-personal", pct: 38, colorVar: "var(--accent)", href: "#/work/projects/a%2Fb" },
  ]);
  served.sidebar = { projects: [] };
  assert.deepEqual(sidebarProjects(served), [], "the server's sidebar wins even when empty");
  assert.equal(projectColorVar("accent"), "var(--accent)");
});

test("the streak is sidebar.streakDays when sent, else the shortest daily streak", () => {
  assert.equal(streakDays(mockupToday()), 12);
  assert.equal(streakDays({ ...mockupToday(), sidebar: { projects: [], streakDays: 30 } }), 30);
  assert.equal(streakDays({ ...mockupToday(), sidebar: { projects: [] } }), 12);
  assert.equal(streakDays({ ...mockupToday(), habits: [] }), undefined);
  assert.equal(streakDays(undefined), undefined);
});

test("undo toasts only for actions that took something away", () => {
  assert.deepEqual(
    (["archive", "read", "todo", "snooze", "done", "submitted", "reviewed", "calendar", "going", "dismiss", "schedule", "trash", "unarchive", "assignment"] as const).filter((action) => !offersUndo(action)),
    [],
  );
  assert.equal(offersUndo("reply"), false);
  assert.equal(offersUndo("open"), false);
});

/** A wait that records the delays instead of sleeping. */
function fakeWait(log: number[]) {
  return async (ms: number) => { log.push(ms); };
}

test("the commit check reads the action once after the window and reports a failed remote write", async () => {
  const status = (state: ActionStatus["state"], error?: string): ActionStatus => ({
    actionId: "a1", itemId: "gmail:x", action: "archive", state, at: "2026-10-12T00:42:00.000Z", undoUntil: "2026-10-12T00:42:06.500Z", ...(error ? { error } : {}),
  });
  const waits: number[] = [];
  const answers = [status("pending"), status("pending"), status("failed", "Gmail 沒有回應。")];
  assert.equal(await remoteFailure(async () => answers.shift(), fakeWait(waits), { delayMs: 8000, retryMs: 2000 }), "Gmail 沒有回應。");
  assert.deepEqual(waits, [8000, 2000, 2000]);

  assert.equal(await remoteFailure(async () => status("committed"), fakeWait([]), { delayMs: -5 }), undefined);
  assert.equal(await remoteFailure(async () => status("applied"), fakeWait([]), { delayMs: 0 }), undefined);
  assert.equal(await remoteFailure(async () => undefined, fakeWait([]), { delayMs: 0 }), undefined, "an unreadable status is not a failure");
  assert.equal(await remoteFailure(async () => status("failed"), fakeWait([]), { delayMs: 0 }), "", "a failure without a reason");
  const stuck: number[] = [];
  assert.equal(await remoteFailure(async () => status("pending"), fakeWait(stuck), { delayMs: 0, tries: 3 }), undefined);
  assert.equal(stuck.length, 4, "gives up after the tries");
});

test("after a sync starts, Today refreshes until the started sources stop syncing", async () => {
  const source = (id: string, state: TodaySource["state"]): TodaySource => ({ id, label: id, state });
  const rounds = [
    [source("gmail", "syncing"), source("github", "ok")],
    [source("gmail", "syncing"), source("github", "syncing")],
    [source("gmail", "ok"), source("github", "syncing")],
  ];
  let current: TodaySource[] | undefined;
  let refreshes = 0;
  const waits: number[] = [];
  await followSync(["gmail"], { refresh: async () => { current = rounds[refreshes++]; }, sources: () => current, wait: fakeWait(waits) }, { intervalMs: 3000 });
  assert.equal(refreshes, 3, "github syncing does not matter: it was not started");
  assert.deepEqual(waits, [3000, 3000, 3000]);

  refreshes = 0;
  await followSync([], { refresh: async () => { refreshes++; }, sources: () => undefined, wait: fakeWait([]) });
  assert.equal(refreshes, 0, "nothing started, nothing to follow");
  await followSync(["gmail"], { refresh: async () => { refreshes++; }, sources: () => [source("gmail", "syncing")], wait: fakeWait([]) }, { tries: 4 });
  assert.equal(refreshes, 4, "stops after the tries even if a source never finishes");
});

function source(id: SourceStatus["id"], state: SourceStatus["state"], lastSyncedAt: string | null = null, configured = true): SourceStatus {
  return { id, label: id, configured, state, lastSyncedAt, lastAttemptAt: null, lastError: null, items: null, stale: false };
}

test("the sync chip warns on broken sources, spins while syncing and shows the latest sync", () => {
  assert.deepEqual(syncChipState(undefined, true), { kind: "offline" });
  assert.deepEqual(syncChipState(undefined, false), { kind: "syncing" });
  assert.deepEqual(syncChipState([source("gmail", "not_configured", null, false)], false), { kind: "none" });
  assert.deepEqual(syncChipState([
    source("gmail", "ok", "2026-10-12T00:38:00.000Z"),
    source("github", "ok", "2026-10-12T00:40:00.000Z"),
    source("moodle", "not_configured", null, false),
  ], false), { kind: "ok", at: "2026-10-12T00:40:00.000Z" });
  assert.deepEqual(syncChipState([source("gmail", "needs_reconnect"), source("moodle", "error"), source("github", "syncing")], false), { kind: "warn", count: 2 });
  assert.deepEqual(syncChipState([source("gmail", "syncing", "2026-10-12T00:38:00.000Z")], false), { kind: "syncing" });
  assert.equal(clockTime("2026-10-12T00:40:00.000Z"), "08:40");
  assert.equal(dayEyebrow("2026-10-12"), "MON · 10/12");
  assert.equal(dayEyebrow("2026-10-17"), "SAT · 10/17");
  assert.equal(dayEyebrow("nope"), "");
});

test("toasts quote what the row is about: the event of a 要參加嗎 row, the suggestion's subject, else the title", () => {
  const payload = mockupToday();
  assert.equal(itemTitle(findQueueItem(payload, "ctftime:balsn"), payload, "ctftime:balsn"), "Balsn CTF 2026");
  assert.equal(itemTitle(findQueueItem(payload, "moodle:lab2"), payload, "moodle:lab2"), "計算機網路 Lab 2：Socket Programming");
  const suggestion = payload.queue.flatMap((group) => group.items).find((item) => item.kind === "suggestion.event")!;
  assert.equal(itemTitle(suggestion, payload, suggestion.id), suggestion.meta[0]);
  assert.equal(itemTitle(undefined, payload, "missing:1"), "");
});

test("the 轉成作業 toast, once the server answers, names the saved title and deadline (not the page's guess)", () => {
  const monday = new Date("2026-10-12T01:00:00Z");
  // Saved by the server relative to the mail's received day (「明天」 in Monday's mail), read on Thursday: 10/13, not Friday.
  assert.equal(createdToast({ title: "HW2", dueAt: "2026-10-13T15:59:00.000Z" }, new Date("2026-10-15T01:00:00Z"), "Asia/Taipei"), "已加入作業「HW2」· 10/13 截止");
  assert.equal(createdToast({ title: "HW5：系統呼叫實作", dueAt: "2026-10-16T15:59:00.000Z", dueDateOnly: true }, monday, "Asia/Taipei"), "已加入作業「HW5：系統呼叫實作」· 10/16 截止");
  assert.equal(createdToast({ title: "中華電信 9 月電子帳單", dueAt: null }, monday, "Asia/Taipei"), "已加入作業「中華電信 9 月電子帳單」");
});

test("a deferred write that failed drops the caller's own page edits before the error toast and the refresh", () => {
  const calls: string[] = [];
  const handlers = { onFailed: () => calls.push("revert page edit"), error: (reason: string) => calls.push(`error ${reason}`), refresh: () => calls.push("refresh") };
  assert.equal(reportRemoteFailure(undefined, handlers), false);
  assert.deepEqual(calls, [], "a write that went through changes nothing");
  assert.equal(reportRemoteFailure("Gmail 回應 HTTP 500，請稍後再試。", handlers), true);
  assert.deepEqual(calls, ["revert page edit", "error Gmail 回應 HTTP 500，請稍後再試。", "refresh"]);
});
