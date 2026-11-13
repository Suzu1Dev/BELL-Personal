import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionId, QueueCandidate, QueueKind, TodayContribution } from "../../shared/today.js";
import { queueAction } from "../../shared/today-format.js";
import { readRuntimeConfig } from "../runtime-config.js";
import { AppError } from "../errors.js";
import { ModuleHost, type ActionHandler, type FeatureModule } from "../modules.js";
import { SourceSync, type SyncOutcome } from "../sync.js";
import { startTestServer, tempDir, testServices } from "../test-helpers.js";
import { capContribution, todayContributionSchema, todayPayloadSchema } from "./schema.js";
import { INTERRUPTED_MESSAGE, repairActionsAfterRestart } from "./actions.js";
import { MODULE_FAILED_MESSAGE } from "./service.js";

const taipei = (local: string) => new Date(`${local}:00+08:00`).toISOString();

class StubSource extends SourceSync {
  configured() { return true; }
  protected async run(): Promise<SyncOutcome> { return {}; }
}

function row(id: string, kind: QueueKind, hints: QueueCandidate["hints"], actions: readonly ActionId[] = ["open", "snooze"]): QueueCandidate {
  const [source] = id.split(":");
  return { id, kind, source: source as QueueCandidate["source"], title: `title ${id}`, meta: ["m"], actions: actions.map((action) => queueAction(action)), hints };
}

interface Calls { apply: string[]; remote: string[]; undo: string[]; revert: string[] }

/** A mail-like module: three rows, archive with a deferred remote write, optional revert, a switch to fail remotes. */
function mailModule(calls: Calls, options: { revert?: boolean; failRemote?: () => boolean } = {}): FeatureModule {
  return {
    name: "mail",
    label: "信件",
    setup(ctx) {
      const source = new StubSource({ id: "gmail", state: ctx.syncState, now: ctx.now });
      const archive: ActionHandler = (request) => ({
        label: "已封存",
        apply: () => { calls.apply.push(request.itemId); },
        remote: async () => {
          if (options.failRemote?.()) throw new AppError(502, "Gmail 沒有回應。");
          calls.remote.push(request.itemId);
        },
        undo: () => { calls.undo.push(request.itemId); },
        ...(options.revert ? { revert: async () => { calls.revert.push(request.itemId); } } : {}),
      });
      return {
        sources: [source],
        today: (_ctx, input) => ({
          queue: [
            { ...row("gmail:lin", "mail.reply", { important: true, receivedAt: taipei("2026-10-12T08:05") }, ["reply", "todo", "snooze", "archive"]), avatar: { initial: "林" } },
            row("gmail:cht", "mail.bill", { dueAt: taipei("2026-10-20T23:59"), hardDeadline: true }, ["todo", "archive", "snooze"]),
            row("gmail:news", "mail.action", { receivedAt: taipei("2026-10-12T07:00") }, ["read", "todo", "snooze"]),
          ],
          digest: [{ key: "newsletter", label: "電子報", count: 3, action: "read" }],
          inboxUnread: 12,
          ...(input.settings["ai.enabled"] ? {} : {}),
        }),
        actions: { gmail: archive },
      };
    },
  };
}

function lmsModule(): FeatureModule {
  return {
    name: "lms",
    setup: () => ({
      today: () => ({
        queue: [
          row("moodle:hw3", "assignment", { dueAt: taipei("2026-10-12T23:59"), hardDeadline: true, fingerprint: "due-1" }, ["open", "submitted", "snooze"]),
        ].map((item) => ({ ...item, snoozeLimit: taipei("2026-10-12T21:59") })),
        gapCandidates: [{ itemId: "moodle:hw3", label: "適合寫 HW3", dueAt: taipei("2026-10-12T23:59") }],
      }),
    }),
  };
}

const failing = (name: string, behaviour: "throw" | "slow" | "invalid", withSource = false): FeatureModule => ({
  name,
  label: `模組 ${name}`,
  setup(ctx) {
    return {
      ...(withSource ? { sources: [new StubSource({ id: "ctftime", state: ctx.syncState })] } : {}),
      today: async (): Promise<TodayContribution> => {
        if (behaviour === "throw") throw new Error("database exploded");
        if (behaviour === "slow") await new Promise((resolve) => setTimeout(resolve, 500));
        return { queue: [{ id: "bad" } as unknown as QueueCandidate] };
      },
    };
  },
});

async function setup(t: test.TestContext, modules: FeatureModule[], options: { commitMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const clock = { now: new Date(taipei("2026-10-12T08:42")) };
  const services = testServices(t, { env: options.env, seams: { now: () => clock.now } });
  const server = await startTestServer(t, services, { modules, today: { moduleTimeoutMs: 100, commitMs: options.commitMs ?? 6_500 } });
  const today = async () => {
    const response = await server.call("GET", "/api/today");
    assert.equal(response.status, 200, response.text);
    const parsed = todayPayloadSchema.safeParse(response.json);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3)));
    return response.json;
  };
  const ids = (payload: any) => payload.queue.flatMap((group: any) => group.items.map((item: any) => item.id));
  return { services, server, clock, today, ids };
}

test("GET /api/today merges module contributions into one payload with counts", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { server, today, ids, services } = await setup(t, [mailModule(calls), lmsModule()]);
  services.syncState.save("gmail", { state: "ok", lastSyncedAt: taipei("2026-10-12T08:40") });
  const payload = await today();
  assert.deepEqual(ids(payload), ["moodle:hw3", "gmail:lin", "gmail:cht", "gmail:news"]);
  assert.equal(payload.queue[0].items[1].avatar.initial, "林");
  assert.deepEqual(payload.counts, { open: 4, handled: 0, total: 4, handledBy: { reply: 0, done: 0, snooze: 0, calendar: 0 }, inboxUnread: 12, habitsLeft: 0 });
  assert.equal(payload.greeting, "早安");
  assert.equal(payload.date, "2026-10-12");
  assert.equal(payload.brief.source, "rule");
  assert.equal(payload.brief.text, "1 封信待回覆，1 項作業今晚 23:59 截止。08:42 後有 13 小時空檔。");
  assert.deepEqual(payload.sources, [{ id: "gmail", label: "Gmail", state: "ok", lastSyncedAt: taipei("2026-10-12T08:40") }]);
  assert.equal(payload.digest.total, 3);
  assert.equal((await server.call("GET", "/api/today")).headers["cache-control"], "no-store");
});

test("a failing, slow or malformed module degrades to its sources and never fails the page", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { today, ids } = await setup(t, [mailModule(calls), failing("boom", "throw"), failing("slow", "slow", true), failing("weird", "invalid")]);
  const payload = await today();
  assert.deepEqual(ids(payload), ["gmail:lin", "gmail:cht", "gmail:news"], "the healthy module still contributes");
  const sources = Object.fromEntries(payload.sources.map((source: any) => [source.id, source]));
  assert.equal(sources.ctftime.state, "error", "a timed-out module's own source turns to error");
  assert.equal(sources.ctftime.message, MODULE_FAILED_MESSAGE);
  assert.deepEqual(sources.boom, { id: "boom", label: "模組 boom", state: "error", message: MODULE_FAILED_MESSAGE });
  assert.equal(sources.weird.state, "error");
  assert.ok(!JSON.stringify(payload).includes("exploded"));
});

test("profile.roles and features.overrides hide role-owned modules' rows and source chips", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  let eventsCalls = 0;
  const events: FeatureModule = {
    name: "events",
    label: "活動",
    setup: (ctx) => ({
      sources: [new StubSource({ id: "ctftime", state: ctx.syncState, now: ctx.now })],
      today: () => { eventsCalls++; return { queue: [row("ctftime:1", "event.decide", { startsAt: taipei("2026-10-13T09:00") }, ["open", "snooze"])] }; },
    }),
  };
  const { server, today, ids, services } = await setup(t, [mailModule(calls), lmsModule(), events]);
  services.syncState.save("gmail", { state: "ok", lastSyncedAt: taipei("2026-10-12T08:40") });
  const sourceIds = (payload: any) => payload.sources.map((source: any) => source.id).sort();
  const everything = await today();
  assert.deepEqual(ids(everything).sort(), ["ctftime:1", "gmail:cht", "gmail:lin", "gmail:news", "moodle:hw3"], "every role: nothing hidden");
  assert.deepEqual(sourceIds(everything), ["ctftime", "gmail"]);

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["developer"] } })).status, 200);
  const developer = await today();
  assert.deepEqual(ids(developer), ["gmail:lin", "gmail:cht", "gmail:news"], "no school or CTF rows for a developer");
  assert.deepEqual(sourceIds(developer), ["gmail"], "the hidden module's source chip goes too");
  const before = eventsCalls;
  await today();
  assert.equal(eventsCalls, before, "a hidden module's today() is not even called");

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["ctf", "student"] } })).status, 200);
  assert.deepEqual(ids(await today()).sort(), ["ctftime:1", "gmail:cht", "gmail:lin", "gmail:news", "moodle:hw3"], "picking the roles again brings the rows back");
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": [] } })).status, 200);
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:cht", "gmail:news"], "[] keeps only the modules everyone gets");

  // A manual switch wins over the roles, both ways, and needs no sync to take effect.
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "features.overrides": { events: true } } })).status, 200);
  assert.deepEqual(ids(await today()).sort(), ["ctftime:1", "gmail:cht", "gmail:lin", "gmail:news"], "活動 on by hand without CTF 選手");
  assert.deepEqual(sourceIds(await today()), ["ctftime", "gmail"]);
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["student", "developer", "ctf"], "features.overrides": { assignments: false } } })).status, 200);
  assert.deepEqual(ids(await today()).sort(), ["ctftime:1", "gmail:cht", "gmail:lin", "gmail:news"], "學校作業 off by hand with 學生 ticked");
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "features.overrides": {} } })).status, 200);
  assert.ok(ids(await today()).includes("moodle:hw3"), "removing the switch follows the roles again");
});

test("profile.roles without student: no AI assignment proposals in Today; other proposals stay", async (t) => {
  const { server, today, ids, services } = await setup(t, [lmsModule()]);
  const hw = services.suggestions.create({ kind: "assignment", title: "Lab 3", payload: { title: "Lab 3", dueAt: null, detectedBy: "rule" } });
  const todo = services.suggestions.create({ kind: "todo", title: "繳費", payload: { title: "繳中華電信帳單", dueDay: "2026-10-20" } });
  assert.ok(ids(await today()).includes(`ai:${hw.id}`), "every role: the proposal shows");
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["developer"] } })).status, 200);
  const developer = ids(await today());
  assert.equal(developer.includes(`ai:${hw.id}`), false, "the lms module is hidden: no 加入作業 proposal");
  assert.ok(developer.includes(`ai:${todo.id}`), "a todo proposal is for everyone");
  assert.equal(services.suggestions.get(hw.id)?.status, "pending", "hidden, not dismissed");
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["student"] } })).status, 200);
  assert.ok(ids(await today()).includes(`ai:${hw.id}`), "back for a student");
});

test("snooze hides a row until the wake time, refuses past the deadline limit, and undo brings it back", async (t) => {
  const { server, clock, today, ids } = await setup(t, [lmsModule()]);
  await today();
  const tooLate = await server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "snooze", params: { until: taipei("2026-10-12T23:00") } } });
  assert.equal(tooLate.status, 400);
  assert.equal(tooLate.json.error, "會超過截止時間。");
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "snooze", params: {} } })).status, 400);
  const snoozed = await server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "snooze", params: { until: taipei("2026-10-12T20:00") } } });
  assert.equal(snoozed.status, 202);
  assert.equal(snoozed.json.label, "已延後");
  assert.equal(snoozed.json.undoUntil, new Date(Date.parse(taipei("2026-10-12T08:42")) + 6_500).toISOString());
  let payload = await today();
  assert.deepEqual(ids(payload), []);
  assert.deepEqual([payload.counts.open, payload.counts.handled, payload.counts.handledBy.snooze], [0, 1, 1]);
  assert.equal(payload.handled[0].undoable, true);
  clock.now = new Date(taipei("2026-10-12T20:01"));
  payload = await today();
  assert.deepEqual(ids(payload), ["moodle:hw3"], "woke up");
  assert.equal(payload.counts.handled, 0, "an item open again is not also handled");
  clock.now = new Date(taipei("2026-10-12T08:43"));
  const undone = await server.call("DELETE", `/api/actions/${snoozed.json.actionId}`, { body: {} });
  assert.equal(undone.status, 200);
  assert.deepEqual(ids(await today()), ["moodle:hw3"]);
  assert.equal((await server.call("DELETE", `/api/actions/${snoozed.json.actionId}`, { body: {} })).status, 409);
});

test("標為已交 hides the assignment until its fingerprint changes; dismiss is forever; open is only logged", async (t) => {
  let fingerprint = "due-1";
  const lms: FeatureModule = {
    name: "lms",
    setup: () => ({
      today: () => ({
        queue: [
          row("moodle:hw3", "assignment", { dueAt: taipei("2026-10-13T23:59"), hardDeadline: true, fingerprint }, ["open", "submitted", "snooze"]),
          row("ctftime:balsn", "event.decide", { startsAt: taipei("2026-10-17T08:00") }, ["going", "dismiss"]),
        ],
      }),
    }),
  };
  const { server, today, ids, services } = await setup(t, [lms]);
  await today();
  const opened = await server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "open" } });
  assert.equal(opened.status, 202);
  assert.equal(opened.json.undoUntil, taipei("2026-10-12T08:42"), "nothing to undo");
  assert.equal((await server.call("GET", `/api/actions/${opened.json.actionId}`)).json.state, "logged");
  assert.equal((await server.call("DELETE", `/api/actions/${opened.json.actionId}`, { body: {} })).status, 409);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "submitted" } })).status, 202);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "ctftime:balsn", action: "dismiss" } })).status, 202);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "ctftime:balsn", action: "archive" } })).status, 400, "not one of the row's actions");
  let payload = await today();
  assert.deepEqual(ids(payload), []);
  assert.deepEqual(payload.counts.handledBy, { reply: 0, done: 2, snooze: 0, calendar: 0 });
  fingerprint = "due-2"; // the LMS moved the deadline
  payload = await today();
  assert.deepEqual(ids(payload), ["moodle:hw3"]);
  assert.equal(payload.counts.handled, 1);
  assert.equal(services.itemState.get("ctftime:balsn")?.state, "dismissed");
});

test("module actions: apply now, remote after 6.5 s, undo before the commit cancels the write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { server, today, ids } = await setup(t, [mailModule(calls)]);
  await today();
  const archived = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  assert.equal(archived.status, 202, archived.text);
  assert.equal(archived.json.label, "已封存");
  assert.deepEqual(calls.apply, ["gmail:cht"]);
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:news"]);
  assert.equal((await server.call("GET", `/api/actions/${archived.json.actionId}`)).json.state, "pending");
  t.mock.timers.tick(6_000);
  assert.deepEqual(calls.remote, [], "nothing reached the remote within the undo window");
  const undone = await server.call("DELETE", `/api/actions/${archived.json.actionId}`, { body: {} });
  assert.equal(undone.status, 200);
  assert.deepEqual(calls.undo, ["gmail:cht"]);
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.remote, [], "the cancelled write never runs");
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:cht", "gmail:news"]);
  assert.equal((await server.call("GET", `/api/actions/${archived.json.actionId}`)).json.state, "undone");
});

test("after the commit: undo is 409 without a revert, and runs the inverse call with one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { server, today } = await setup(t, [mailModule(calls)]);
  await today();
  const first = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  t.mock.timers.tick(6_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.remote, ["gmail:cht"]);
  assert.equal((await server.call("GET", `/api/actions/${first.json.actionId}`)).json.state, "committed");
  const late = await server.call("DELETE", `/api/actions/${first.json.actionId}`, { body: {} });
  assert.equal(late.status, 409);
  assert.equal(late.json.error, "這個動作已經送出，無法復原。");
  const payload = await today();
  assert.equal(payload.handled[0].undoable, false);
});

test("a committed write with revert() can still be undone; a failed remote restores the row", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  let fail = false;
  const { server, today, ids } = await setup(t, [mailModule(calls, { revert: true, failRemote: () => fail })]);
  await today();
  const archived = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  t.mock.timers.tick(6_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await today()).handled[0].undoable, true);
  assert.equal((await server.call("DELETE", `/api/actions/${archived.json.actionId}`, { body: {} })).status, 200);
  assert.deepEqual(calls.revert, ["gmail:cht"]);
  assert.deepEqual(calls.undo, ["gmail:cht"]);

  fail = true;
  const failing = await server.call("POST", "/api/actions", { body: { itemId: "gmail:news", action: "read" } });
  assert.equal(failing.status, 202);
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:cht"]);
  t.mock.timers.tick(6_500);
  await new Promise((resolve) => setImmediate(resolve));
  const status = await server.call("GET", `/api/actions/${failing.json.actionId}`);
  assert.equal(status.json.state, "failed");
  assert.equal(status.json.error, "Gmail 沒有回應。");
  const payload = await today();
  assert.deepEqual(ids(payload), ["gmail:lin", "gmail:cht", "gmail:news"], "the row reappears");
  assert.equal(payload.counts.handled, 0, "counts revert");
  assert.equal((await server.call("DELETE", `/api/actions/${failing.json.actionId}`, { body: {} })).json.error, "這個動作沒有完成，已經自動還原。");
});

test("shutdown drains pending remote writes immediately", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { server, today } = await setup(t, [mailModule(calls)], { commitMs: 60_000 });
  await today();
  await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  const { today: service } = (await import("../app.js")).appContext(server.app);
  assert.equal(service.actions.pendingCount, 1);
  await service.drain();
  assert.deepEqual(calls.remote, ["gmail:cht"]);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "gmail:lin", action: "archive" } })).status, 503);
});

test("a crash leaves no remote write pending: boot repair marks it failed and restores the row", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { server, today, ids, services } = await setup(t, [mailModule(calls)], { commitMs: 60_000 });
  await today();
  const archived = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:news"]);
  // Simulate the process dying: the timer is gone, the row still says pending.
  (await import("../app.js")).appContext(server.app).today.actions.close();
  assert.equal(repairActionsAfterRestart(services), 1);
  const row = services.itemState.log(archived.json.actionId);
  assert.equal(row?.remote, "failed");
  assert.equal(row?.error, INTERRUPTED_MESSAGE);
  assert.equal(services.itemState.get("gmail:cht"), undefined, "the row is back");
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:cht", "gmail:news"]);
  assert.equal(repairActionsAfterRestart(services), 0);
  assert.deepEqual(calls.remote, []);
});

test("routing: 501 without the owning module, bad ids, unknown actions, 轉待辦 to the tasks module", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const created: string[] = [];
  const tasks: FeatureModule = {
    name: "tasks",
    setup: () => ({
      anySourceActions: {
        todo: (request) => ({
          label: "已轉成待辦",
          apply: () => { created.push(`${request.item?.title}`); return { resultId: "todo-1" }; },
          undo: () => { created.pop(); },
        }),
      },
    }),
  };
  const { server, today, ids } = await setup(t, [mailModule(calls), tasks]);
  await today();
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "nope", action: "open" } })).status, 400);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "gmail:lin", action: "fly" } })).status, 400);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "gmail:lin", action: "reply", extra: 1 } })).status, 400);
  assert.equal((await server.call("DELETE", "/api/actions/does-not-exist", { body: {} })).status, 404);
  const todo = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "todo" } });
  assert.equal(todo.status, 202);
  assert.deepEqual(created, ["title gmail:cht"]);
  const reply = await server.call("POST", "/api/actions", { body: { itemId: "gmail:lin", action: "reply" } });
  assert.equal(reply.status, 202);
  const payload = await today();
  assert.deepEqual(ids(payload), ["gmail:lin", "gmail:news"]);
  assert.equal(payload.queue[0].items[0].replying, true, "回覆 keeps the row, marked 回覆中…");
  assert.deepEqual(payload.counts.handledBy, { reply: 0, done: 1, snooze: 0, calendar: 0 });
  assert.equal((await server.call("DELETE", `/api/actions/${todo.json.actionId}`, { body: {} })).status, 200);
  assert.deepEqual(created, []);

  const bare = await setup(t, [lmsModule()]);
  await bare.today();
  const response = await bare.server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "open" } });
  assert.equal(response.status, 202);
  const noTasks = await setup(t, [mailModule(calls)]);
  await noTasks.today();
  const unsupported = await noTasks.server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "todo" } });
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.json.error, "這類項目目前還不能這樣處理。");
});

test("AI suggestions are core rows: 加入行事曆 goes to the calendar module, 略過 to the core, undo reopens them", async (t) => {
  const accepted: string[] = [];
  const calendar: FeatureModule = {
    name: "calendar",
    setup: () => ({
      suggestionActions: {
        event: (request) => ({
          label: "已加入行事曆",
          apply: () => { accepted.push(request.suggestion!.id); return { resultId: "event-1" }; },
          undo: () => { accepted.pop(); },
        }),
      },
    }),
  };
  const { server, today, ids, services } = await setup(t, [calendar]);
  const event = services.suggestions.create({
    kind: "event", title: "SITCON 秋季交流會",
    payload: { title: "SITCON 秋季交流會", start: taipei("2026-10-25T13:30"), allDay: false, location: "中研院人文館" },
    sourceRef: { source: "gmail", externalId: "m-kktix", url: "https://mail.google.com/mail/u/0/#inbox/m-kktix" },
    origin: "KKTIX 報名成功信",
  });
  const todo = services.suggestions.create({ kind: "todo", title: "繳費", payload: { title: "繳中華電信帳單", dueDay: "2026-10-20" } });
  let payload = await today();
  assert.deepEqual(ids(payload).sort(), [`ai:${event.id}`, `ai:${todo.id}`].sort());
  const eventRow = payload.queue[1].items.find((item: any) => item.id === `ai:${event.id}`);
  assert.equal(eventRow.title, "從信件找到 1 個活動，要加入行事曆嗎？");
  assert.deepEqual(eventRow.meta, ["SITCON 秋季交流會", "10/25（日）13:30", "中研院人文館", "來自 KKTIX 報名成功信"]);
  assert.deepEqual(eventRow.actions.map((action: any) => action.id), ["calendar", "dismiss"]);
  const todoRow = payload.queue[1].items.find((item: any) => item.id === `ai:${todo.id}`);
  assert.deepEqual(todoRow.meta, ["繳中華電信帳單", "10/20 截止"]);

  const add = await server.call("POST", "/api/actions", { body: { itemId: `ai:${event.id}`, action: "calendar" } });
  assert.equal(add.status, 202);
  assert.equal(services.suggestions.get(event.id)?.status, "accepted");
  assert.equal(services.suggestions.get(event.id)?.resultId, "event-1");
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: `ai:${event.id}`, action: "calendar" } })).status, 409);
  const skip = await server.call("POST", "/api/actions", { body: { itemId: `ai:${todo.id}`, action: "dismiss" } });
  assert.equal(skip.status, 202);
  assert.equal(services.suggestions.get(todo.id)?.status, "dismissed");
  payload = await today();
  assert.deepEqual(ids(payload), []);
  assert.deepEqual(payload.counts.handledBy, { reply: 0, done: 1, snooze: 0, calendar: 1 });

  assert.equal((await server.call("DELETE", `/api/actions/${add.json.actionId}`, { body: {} })).status, 200);
  assert.deepEqual(accepted, []);
  assert.equal(services.suggestions.get(event.id)?.status, "pending");
  assert.equal(services.suggestions.get(event.id)?.resultId, undefined);
  assert.deepEqual(ids(await today()), [`ai:${event.id}`]);
});

test("SPEC-mail-assignments: 刪除 closes a mail row, 轉成作業 works on any mail row, 加入作業 only on assignment suggestions", async (t) => {
  const made: string[] = [];
  const mail: FeatureModule = {
    name: "mail",
    setup(ctx) {
      return {
        sources: [new StubSource({ id: "gmail", state: ctx.syncState, now: ctx.now })],
        today: () => ({
          queue: [
            row("gmail:lin", "mail.reply", { important: true, receivedAt: taipei("2026-10-12T08:05") }, ["reply", "todo", "snooze", "archive", "trash"]),
            row("gmail:news", "mail.action", { receivedAt: taipei("2026-10-12T07:00") }, ["read", "todo", "snooze", "archive", "trash"]),
            row("moodle:hw3", "assignment", { dueAt: taipei("2026-10-12T23:59"), hardDeadline: true }, ["open", "submitted"]),
          ],
        }),
        actions: { gmail: (request) => ({ label: request.action === "trash" ? "已移到垃圾桶" : "已封存", remote: async () => {} }) },
      };
    },
  };
  const lms: FeatureModule = {
    name: "lms",
    setup: () => ({
      anySourceActions: {
        assignment: (request) => {
          if (request.source !== "gmail") throw new AppError(400, "這個項目不能轉成作業。");
          return { label: "已加入作業", apply: () => { made.push(request.itemId); return { resultId: "assignment:from-mail" }; }, undo: () => { made.pop(); } };
        },
      },
      suggestionActions: {
        assignment: (request) => ({ label: "已加入作業", apply: () => { made.push(request.itemId); return { resultId: "assignment:suggested" }; }, undo: () => { made.pop(); } }),
      },
    }),
  };
  const { server, today, ids, services } = await setup(t, [mail, lms]);
  const hw5 = services.suggestions.create({
    kind: "assignment", title: "HW5：系統呼叫實作",
    payload: { title: "HW5：系統呼叫實作", courseName: "作業系統", dueAt: taipei("2026-10-16T23:59") },
    sourceRef: { source: "gmail", externalId: "m-hw5", url: "https://mail.google.com/mail/u/0/#inbox/m-hw5" },
    origin: "林志明 教授 信件",
  });
  const ruled = services.suggestions.create({ kind: "assignment", title: "Lab 3", payload: { title: "Lab 3", dueAt: null, detectedBy: "rule" } });
  const broken = services.suggestions.create({ kind: "assignment", title: "壞掉的", payload: { title: "" } });
  const event = services.suggestions.create({ kind: "event", title: "說明會", payload: { title: "說明會", start: taipei("2026-10-20T10:00"), allDay: false } });
  let payload = await today();
  const hw5Row = payload.queue[1].items.find((item: any) => item.id === `ai:${hw5.id}`);
  assert.equal(hw5Row.kind, "suggestion.assignment");
  assert.equal(hw5Row.title, "從信件找到 1 份作業，要加入嗎？");
  assert.equal(hw5Row.subject, "HW5：系統呼叫實作");
  assert.deepEqual(hw5Row.meta, ["HW5：系統呼叫實作", "作業系統", "週五 23:59 截止", "來自 林志明 教授 信件"]);
  assert.deepEqual(hw5Row.actions.map((action: any) => [action.id, action.label, action.key]), [["assignment", "加入作業", "A"], ["dismiss", "略過", "E"]]);
  assert.deepEqual(payload.queue[1].items.find((item: any) => item.id === `ai:${ruled.id}`).meta, ["Lab 3", "沒有寫截止時間", "規則判斷"]);
  assert.equal(ids(payload).includes(`ai:${broken.id}`), false, "a payload that does not parse has no row");
  assert.equal(payload.queue[0].items.find((item: any) => item.id === "gmail:lin").actions.at(-1).key, "#", "the # key passes the payload schema");

  // 刪除 closes the row like 封存.
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "gmail:news", action: "trash" } })).status, 202);
  // 轉成作業 on a mail row that does not list it; refused on other sources and on another suggestion kind.
  const converted = await server.call("POST", "/api/actions", { body: { itemId: "gmail:lin", action: "assignment" } });
  assert.equal(converted.status, 202, converted.text);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "moodle:hw3", action: "assignment" } })).status, 400);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: `ai:${event.id}`, action: "assignment" } })).status, 400);
  assert.equal(services.suggestions.get(event.id)?.status, "pending");
  // 加入作業 accepts the suggestion with the record the lms module made.
  const add = await server.call("POST", "/api/actions", { body: { itemId: `ai:${hw5.id}`, action: "assignment" } });
  assert.equal(add.status, 202);
  assert.equal(services.suggestions.get(hw5.id)?.status, "accepted");
  assert.equal(services.suggestions.get(hw5.id)?.resultId, "assignment:suggested");
  assert.deepEqual(made, ["gmail:lin", `ai:${hw5.id}`]);
  payload = await today();
  assert.deepEqual(ids(payload).filter((id: string) => !id.startsWith("ai:")), ["moodle:hw3"]);
  assert.deepEqual(payload.counts.handledBy, { reply: 0, done: 3, snooze: 0, calendar: 0 });

  assert.equal((await server.call("DELETE", `/api/actions/${add.json.actionId}`, { body: {} })).status, 200);
  assert.equal(services.suggestions.get(hw5.id)?.status, "pending", "復原 reopens the suggestion");
  assert.equal((await server.call("DELETE", `/api/actions/${converted.json.actionId}`, { body: {} })).status, 200);
  assert.deepEqual(made, []);

  // Without the lms module 轉成作業 is not supported yet.
  const bare = await setup(t, [mail]);
  await bare.today();
  assert.equal((await bare.server.call("POST", "/api/actions", { body: { itemId: "gmail:lin", action: "assignment" } })).status, 501);
});

test("modules mark items handled from the source (a sent reply) idempotently", async (t) => {
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { today, ids, services } = await setup(t, [mailModule(calls)]);
  const first = services.itemState.markHandled({ itemId: "gmail:lin", kind: "mail.reply", title: "Re: OS 期末專題題目討論", action: "reply" });
  const again = services.itemState.markHandled({ itemId: "gmail:lin", kind: "mail.reply", title: "Re: OS 期末專題題目討論", action: "reply" });
  assert.equal(first.id, again.id);
  const payload = await today();
  assert.deepEqual(ids(payload), ["gmail:cht", "gmail:news"]);
  assert.deepEqual(payload.counts.handledBy, { reply: 1, done: 0, snooze: 0, calendar: 0 });
  assert.equal(payload.handled[0].undoable, false, "a sync-detected reply is not undoable");
});

test("the dev fixture override serves a file and is refused in production", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "today.json");
  writeFileSync(file, JSON.stringify(JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../fixtures/today-2026-10-12.json", import.meta.url), "utf8"))));
  const { server, today, ids, clock } = await setup(t, [], { env: { BELLPERSONAL_TODAY_FIXTURE: file } });
  const payload = await today();
  assert.equal(payload.date, "2026-10-12");
  const bill = "gmail:18c2e9d0a1b2c3f6";
  assert.ok(ids(payload).includes(bill));

  // Accepted actions are replayed on the file, so the row the browser removed stays removed after its refresh.
  const action = await server.call("POST", "/api/actions", { body: { itemId: bill, action: "archive" } });
  assert.equal(action.status, 202);
  assert.equal(action.json.undoUntil, new Date(clock.now.getTime() + 6_500).toISOString());
  const archived = await today();
  assert.equal(ids(archived).includes(bill), false);
  assert.deepEqual([archived.counts.open, archived.counts.handled, archived.counts.total, archived.counts.inboxUnread], [7, 4, 11, 11]);
  assert.deepEqual([archived.handled[0].itemId, archived.handled[0].actionId, archived.handled[0].undoable], [bill, action.json.actionId, true]);
  assert.equal((await server.call("GET", `/api/actions/${action.json.actionId}`)).json.state, "applied");
  assert.equal((await server.call("DELETE", `/api/actions/${action.json.actionId}`, { body: {} })).status, 200);
  assert.deepEqual(ids(await today()), ids(payload), "復原 brings the row back in place");
  assert.equal((await server.call("GET", `/api/actions/${action.json.actionId}`)).json.state, "undone");
  assert.equal((await server.call("DELETE", `/api/actions/${action.json.actionId}`, { body: {} })).status, 409);

  const reply = await server.call("POST", "/api/actions", { body: { itemId: "gmail:18c2f0a1b2c3d4e5", action: "reply" } });
  assert.equal(reply.status, 202);
  assert.equal((await today()).queue[0].items[0].replying, true);
  clock.now = new Date(clock.now.getTime() + 7_000);
  assert.equal((await server.call("DELETE", `/api/actions/${reply.json.actionId}`, { body: {} })).status, 409, "past the undo window");
  assert.equal((await server.call("GET", "/api/actions/fixture-unknown")).status, 404);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: bill, action: "explode" } })).status, 400);
  writeFileSync(file, JSON.stringify({ date: "nope" }));
  const broken = await server.call("GET", "/api/today");
  assert.equal(broken.status, 500);
  assert.equal(broken.json.error, "Today 示範資料格式不正確。");
  assert.throws(() => readRuntimeConfig({ NODE_ENV: "production", BELLPERSONAL_TAILSCALE_USERS: "a@github", BELLPERSONAL_TODAY_FIXTURE: file }), /正式環境不可設定/);
});

test("the Today fixtures are valid payloads whose counts agree with their rows", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["today-2026-10-12.json", "today-degraded.json", "today-empty.json", "today-cleared.json"]) {
    const payload = JSON.parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
    const parsed = todayPayloadSchema.safeParse(payload);
    assert.ok(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues.slice(0, 3))}`);
    assert.equal(payload.counts.handled, payload.handled.length, name);
    assert.equal(Object.values(payload.counts.handledBy as Record<string, number>).reduce((sum, value) => sum + value, 0), payload.counts.handled, name);
    assert.equal(payload.counts.habitsLeft, payload.habits.filter((habit: { doneToday: boolean; due?: boolean }) => habit.due !== false && !habit.doneToday).length, name);
  }
  const mockup = JSON.parse(await readFile(new URL("../fixtures/today-2026-10-12.json", import.meta.url), "utf8"));
  assert.deepEqual(mockup.queue.map((group: { items: unknown[] }) => group.items.length), [3, 3, 2], "SPEC §13: the mockup queue");
  assert.deepEqual([mockup.counts.open, mockup.counts.handled, mockup.counts.total, mockup.counts.inboxUnread, mockup.paceMinutes], [8, 3, 11, 12, 35]);
});

test("backlog is optional in the payload and in a contribution, and never negative", () => {
  const payload = JSON.parse(readFileSync(new URL("../fixtures/today-2026-10-12.json", import.meta.url), "utf8"));
  assert.ok(todayPayloadSchema.safeParse(payload).success, "fixtures without the field still parse");
  assert.ok(todayPayloadSchema.safeParse({ ...payload, backlog: { undatedTodos: 3 } }).success);
  assert.equal(todayPayloadSchema.safeParse({ ...payload, backlog: { undatedTodos: -1 } }).success, false);
  assert.ok(todayContributionSchema.safeParse({ backlog: { undatedTodos: 3 } }).success);
  assert.ok(todayContributionSchema.safeParse({ backlog: {} }).success);
  assert.equal(todayContributionSchema.safeParse({ backlog: { undatedTodos: 1.5 } }).success, false);
});

test("the module host validates action registries", (t) => {
  const services = testServices(t);
  const handler: ActionHandler = () => ({ label: "x" });
  const make = (name: string, parts: object): FeatureModule => ({ name, setup: () => parts });
  assert.throws(() => new ModuleHost([make("aa", { actions: { gmail: handler } }), make("bb", { actions: { gmail: handler } })], services), /already has a handler/);
  assert.throws(() => new ModuleHost([make("aa", { actions: { ai: handler } })], services), /not a valid key/);
  assert.throws(() => new ModuleHost([make("aa", { anySourceActions: { archive: handler } })], services), /not a valid key/);
  assert.throws(() => new ModuleHost([make("aa", { router: (() => {}) as never, mountPath: "/api/today" })], services), /reserved/);
  const host = new ModuleHost([make("aa", { suggestionActions: { event: handler }, anySourceActions: { schedule: handler } })], services);
  assert.equal(host.suggestionActionHandler("event"), handler);
  assert.equal(host.anySourceActionHandler("schedule"), handler);
  assert.equal(host.actionHandler("ai"), undefined);
});

test("an over-long contribution array is cut to its cap (and logged) instead of dropping the module", () => {
  const rows = Array.from({ length: 120 }, (_, index) => ({ start: new Date(Date.UTC(2026, 9, 13, index)).toISOString(), title: `活動 ${index}`, meta: "" }));
  const { value, capped } = capContribution({ later: { events: rows }, ideas: [], nav: { events: 1 } });
  assert.deepEqual(capped, ["later.events"]);
  const parsed = todayContributionSchema.safeParse(value);
  assert.ok(parsed.success);
  assert.equal(parsed.data.later?.events?.length, 100);
  assert.equal(parsed.data.later?.events?.[0].title, "活動 0", "the first rows (nearest) are kept");
});

test("a second closing action on a row the last snapshot still serves is refused, so the first 復原 still cancels the write", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Calls = { apply: [], remote: [], undo: [], revert: [] };
  const { server, today, ids } = await setup(t, [mailModule(calls)]);
  await today();
  const first = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  assert.equal(first.status, 202, first.text);
  // A retry after a lost 202, or a second tab, before Today is rebuilt.
  const second = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  assert.equal(second.status, 409);
  assert.equal(second.json.error, "這個項目剛剛已經處理過了。");
  assert.deepEqual(calls.apply, ["gmail:cht"], "the second never applied");
  const undone = await server.call("DELETE", `/api/actions/${first.json.actionId}`, { body: {} });
  assert.equal(undone.status, 200, undone.text);
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.remote, [], "nothing reaches Gmail");
  assert.deepEqual(ids(await today()), ["gmail:lin", "gmail:cht", "gmail:news"]);
  // After the commit window a new action stands on its own again.
  const again = await server.call("POST", "/api/actions", { body: { itemId: "gmail:cht", action: "archive" } });
  assert.equal(again.status, 202);
});

test("boot repair of an interrupted GitHub 標為已讀 makes the next notifications poll unconditional", (t) => {
  const services = testServices(t);
  services.syncState.save("github", { state: "ok", cursor: JSON.stringify({ login: "Suzu1Dev", notifications: { lastModified: "Mon, 12 Oct 2026 00:30:00 GMT", pollIntervalSec: 60, fetchedAt: "2026-10-12T00:41:00.000Z" } }) });
  services.itemState.record({ itemId: "github:digest-threads", kind: "digest", action: "read", title: "GitHub 通知", closes: false, remote: "pending", commitAt: "2026-10-12T00:42:06.500Z", state: { state: "handled" } });
  assert.equal(repairActionsAfterRestart(services), 1);
  const cursor = JSON.parse(services.syncState.get("github")!.cursor!);
  assert.deepEqual(cursor, { login: "Suzu1Dev", notifications: { pollIntervalSec: 60 } });
});

test("prune keeps 略過, handled and 標為已交 states however old; it drops woken snoozes, stale 回覆中 and old log rows", (t) => {
  let now = new Date("2026-08-01T00:00:00Z");
  const services = testServices(t, { seams: { now: () => now } });
  const store = services.itemState;
  store.record({ itemId: "moodle:final", kind: "assignment", action: "submitted", title: "期末專題", closes: true, state: { state: "dismissed", fingerprint: "2027-01-10T15:59:00.000Z|not-submitted" } });
  store.record({ itemId: "ctftime:9", kind: "event.decide", action: "dismiss", title: "CTF", closes: true, state: { state: "dismissed" } });
  store.record({ itemId: "gmail:todo", kind: "mail.reply", action: "todo", title: "信", closes: true, state: { state: "handled" } });
  store.record({ itemId: "gmail:snooze", kind: "mail.reply", action: "snooze", title: "信", closes: false, state: { state: "snoozed", until: "2026-08-02T00:00:00.000Z" } });
  store.record({ itemId: "gmail:later", kind: "mail.reply", action: "snooze", title: "信", closes: false, state: { state: "snoozed", until: "2026-12-30T00:00:00.000Z" } });
  store.record({ itemId: "gmail:reply", kind: "mail.reply", action: "reply", title: "信", closes: false, state: { state: "replying" } });
  now = new Date("2026-12-01T00:00:00Z");
  assert.ok(store.prune() > 0);
  assert.equal(store.get("moodle:final")?.action, "submitted", "標為已交 survives: the LMS still lists it as open");
  assert.equal(store.get("ctftime:9")?.state, "dismissed");
  assert.equal(store.get("gmail:todo")?.state, "handled");
  assert.equal(store.get("gmail:snooze"), undefined, "a snooze that woke up long ago");
  assert.equal(store.get("gmail:later")?.state, "snoozed", "a snooze still in the future");
  assert.equal(store.get("gmail:reply"), undefined);
  assert.equal(services.db.personal.db.prepare("SELECT COUNT(*) AS n FROM action_log").get()!.n, 0, "the log is pruned by age");
});
