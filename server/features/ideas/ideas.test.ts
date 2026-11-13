import assert from "node:assert/strict";
import test from "node:test";
import type { Idea, IdeaListResponse, IdeaToTodoResponse } from "../../../shared/ideas.js";
import { TODO_LIMITS, type TodoListResponse } from "../../../shared/todos.js";
import type { TodayPayload } from "../../../shared/today.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices } from "../../test-helpers.js";
import { todosModule } from "../todos/index.js";
import { ideasModule } from "./index.js";
import { todoFieldsFromIdea } from "./to-todo.js";

const taipei = (local: string) => new Date(`${local}:00+08:00`);

/** The recorded Claude Code stream with `answer` as the structured output. */
function claudeStream(answer: unknown): string {
  return claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") { copy.structured_output = answer; copy.result = JSON.stringify(answer); }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
}

function setup(t: test.TestContext, answer?: (input: string) => unknown) {
  let now = taipei("2026-10-12T08:42");
  const fake = fakeCommand((call) => {
    if (call.args.join(" ") === "auth status") return "{}";
    if (call.executable === "claude" && answer) return claudeStream(answer(call.options.input ?? ""));
    return undefined;
  });
  const services = testServices(t, { seams: { now: () => now, command: fake.runner, sleep: async () => {} } });
  return { services, calls: fake.calls, setNow: (next: Date) => { now = next; } };
}

const ndjson = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line));

test("ideas CRUD: create, list newest first with the local day, search, tags, pin, archive", async (t) => {
  const { services, setNow } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule] });
  setNow(taipei("2026-10-09T21:00"));
  const blog = (await server.call("POST", "/api/ideas", { body: { text: "CTF writeup 改寫成部落格系列", tags: ["CTF", "#寫作", "ctf"] } })).json as Idea;
  assert.deepEqual(blog.tags, ["CTF", "寫作"]);
  assert.equal(blog.origin, "manual");
  setNow(taipei("2026-10-12T00:30")); // 00:30 Taipei is still 10/11 in UTC
  const ebpf = (await server.call("POST", "/api/ideas", { body: { text: "用 eBPF 量 CFS 排程延遲，當期末專題", tags: ["OS"] } })).json as Idea;
  setNow(taipei("2026-10-12T08:42"));

  const list = (await server.call("GET", "/api/ideas")).json as IdeaListResponse;
  assert.deepEqual(list.ideas.map((idea) => idea.id), [ebpf.id, blog.id]);
  assert.deepEqual(list.ideas.map((idea) => idea.day), ["2026-10-12", "2026-10-09"]);
  assert.equal(list.today, "2026-10-12");
  assert.equal(list.total, 2);
  assert.equal(list.aiTags, false);
  assert.deepEqual(list.tags, [{ tag: "CTF", count: 1 }, { tag: "OS", count: 1 }, { tag: "寫作", count: 1 }]);
  assert.deepEqual(((await server.call("GET", "/api/ideas?q=ebpf")).json as IdeaListResponse).ideas.map((idea) => idea.id), [ebpf.id]);
  assert.deepEqual(((await server.call("GET", `/api/ideas?q=${encodeURIComponent("#寫作")}`)).json as IdeaListResponse).ideas.map((idea) => idea.id), [blog.id]);
  assert.deepEqual(((await server.call("GET", "/api/ideas?tag=os")).json as IdeaListResponse).ideas.map((idea) => idea.id), [ebpf.id]);

  const pinned = await server.call("PATCH", `/api/ideas/${blog.id}`, { body: { pinned: true, tags: ["CTF", "部落格"] } });
  assert.equal(pinned.json.pinned, true);
  assert.deepEqual(pinned.json.tags, ["CTF", "部落格"]);
  await server.call("PATCH", `/api/ideas/${ebpf.id}`, { body: { archived: true } });
  assert.deepEqual(((await server.call("GET", "/api/ideas")).json as IdeaListResponse).ideas.map((idea) => idea.id), [blog.id]);
  assert.deepEqual(((await server.call("GET", "/api/ideas?archived=1")).json as IdeaListResponse).ideas.map((idea) => idea.id), [ebpf.id]);

  assert.equal((await server.call("POST", "/api/ideas", { body: { text: "   " } })).status, 400);
  assert.equal((await server.call("POST", "/api/ideas", { body: { text: "x", tags: ["有 空白"] } })).status, 400);
  assert.equal((await server.call("PATCH", `/api/ideas/${blog.id}`, { body: { text: "" } })).status, 400);
  assert.equal((await server.call("PATCH", "/api/ideas/missing", { body: { pinned: true } })).status, 404);
});

test("idea delete goes through the trash; 復原 restores it", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule] });
  const idea = (await server.call("POST", "/api/ideas", { body: { text: "習慣頁可以加一個整年的熱度圖" } })).json as Idea;
  const deleted = await server.call("DELETE", `/api/ideas/${idea.id}`, { body: {} });
  assert.equal(deleted.json.deleted, true);
  assert.equal(((await server.call("GET", "/api/ideas")).json as IdeaListResponse).total, 0);
  assert.equal((await server.call("POST", "/api/trash/restore", { body: { token: deleted.json.undoToken } })).status, 200);
  assert.equal(((await server.call("GET", "/api/ideas")).json as IdeaListResponse).ideas[0].text, "習慣頁可以加一個整年的熱度圖");
});

test("today(): the newest ideas reach the Today capture card", async (t) => {
  const { services, setNow } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule] });
  for (const [at, text] of [["2026-10-06T12:20", "習慣頁熱度圖"], ["2026-10-09T21:00", "CTF writeup 部落格"], ["2026-10-11T23:10", "用 eBPF 量 CFS 排程延遲"]] as const) {
    setNow(taipei(at));
    await server.call("POST", "/api/ideas", { body: { text } });
  }
  setNow(taipei("2026-10-12T08:42"));
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.deepEqual(today.ideas.map((idea) => idea.text), ["用 eBPF 量 CFS 排程延遲", "CTF writeup 部落格"]);
});

test("AI tag proposals: one suggestion per tag, confirm by tapping, a dismissed tag is never proposed again", async (t) => {
  const { services, calls } = setup(t, (input) => {
    const ids = [...input.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
    return { ideas: ids.map((id) => ({ id, tags: ["OS", "專題", "eBPF"] })) };
  });
  const server = await startTestServer(t, services, { modules: [ideasModule] });
  const off = await server.call("POST", "/api/ideas/tags/suggest", { body: {} });
  assert.equal(off.status, 503);
  services.settings.update({ "ai.ideaTags": true });

  const idea = (await server.call("POST", "/api/ideas", { body: { text: "用 eBPF 量 CFS 排程延遲，當期末專題", tags: ["OS"] } })).json as Idea;
  // Creating an idea started a background proposal job; wait for it.
  for (const job of services.jobs.list()) await services.jobs.settled(job.id);
  const prompt = calls.find((call) => call.executable === "claude" && call.args.includes("-p"))!.options.input!;
  assert.match(prompt, /任務角色：靈感標籤/);
  assert.match(prompt, /用 eBPF 量 CFS 排程延遲/);

  let list = (await server.call("GET", "/api/ideas")).json as IdeaListResponse;
  assert.equal(list.aiTags, true);
  assert.deepEqual(list.ideas[0].proposals.map((proposal) => proposal.tag), ["eBPF", "專題"]);
  const [ebpf, topic] = list.ideas[0].proposals;
  const accepted = await server.call("POST", `/api/suggestions/${topic.suggestionId}/accept`, { body: {} });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.json.result.tags, ["OS", "專題"]);
  await server.call("POST", `/api/suggestions/${ebpf.suggestionId}/dismiss`, { body: {} });
  list = (await server.call("GET", "/api/ideas")).json as IdeaListResponse;
  assert.deepEqual(list.ideas[0].proposals, []);

  // Asking again for this idea proposes nothing new (dedupe per idea and tag).
  const again = await server.call("POST", "/api/ideas/tags/suggest", { body: { ids: [idea.id] } });
  assert.equal(again.status, 200);
  const events = ndjson(again.text);
  assert.deepEqual(events.at(-1), { type: "done", result: { proposals: 0 } });
  assert.deepEqual(((await server.call("GET", "/api/ideas")).json as IdeaListResponse).ideas[0].proposals, []);
});

test("an idea created while a tag job runs gets its proposal from the next job instead of being skipped", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  const fake = fakeCommand(async (call) => {
    if (call.args.join(" ") === "auth status") return "{}";
    if (call.executable !== "claude") return undefined;
    runs++;
    if (runs === 1) await gate;
    const data = JSON.parse(call.options.input!.slice(call.options.input!.indexOf("<data>\n") + 7, call.options.input!.lastIndexOf("\n</data>"))) as { ideas: Array<{ id: string }> };
    return claudeStream({ ideas: data.ideas.map((idea) => ({ id: idea.id, tags: ["點子"] })) });
  });
  const services = testServices(t, { seams: { now: () => taipei("2026-10-12T08:42"), command: fake.runner, sleep: async () => {} } });
  services.settings.update({ "ai.ideaTags": true });
  const server = await startTestServer(t, services, { modules: [ideasModule] });
  const first = (await server.call("POST", "/api/ideas", { body: { text: "CTF 練習平台" } })).json as Idea;
  const second = (await server.call("POST", "/api/ideas", { body: { text: "習慣頁加熱度圖" } })).json as Idea;
  release();
  for (let round = 0; round < 50 && services.suggestions.list({ kind: "idea-tags" }).length < 2; round++) {
    for (const job of services.jobs.running("idea-tags")) await services.jobs.settled(job.id);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const proposed = services.suggestions.list<{ ideaId: string }>({ kind: "idea-tags" }).map((suggestion) => suggestion.payload.ideaId).sort();
  assert.deepEqual(proposed, [first.id, second.id].sort());
  assert.equal(runs, 2);
});

test("todoFieldsFromIdea: the first non-empty line is the title, the rest goes to the notes", () => {
  assert.deepEqual(todoFieldsFromIdea({ text: "買 USB-C 轉接頭" }), { title: "買 USB-C 轉接頭" });
  assert.deepEqual(todoFieldsFromIdea({ text: "\r\n  整理 OS 筆記  \r\n\r\n第一章\n第二章\n" }), { title: "整理 OS 筆記", notes: "第一章\n第二章" });
  assert.deepEqual(todoFieldsFromIdea({ title: "期末專題", text: "用 eBPF 量 CFS 排程延遲" }), { title: "期末專題", notes: "用 eBPF 量 CFS 排程延遲" });
  const long = todoFieldsFromIdea({ text: `${"字".repeat(TODO_LIMITS.title)}尾巴\n下一行` });
  assert.equal(long.title, "字".repeat(TODO_LIMITS.title));
  assert.equal(long.notes, "尾巴\n下一行", "what did not fit in the title is kept in the notes");
  assert.equal(todoFieldsFromIdea({ text: `標題\n${"長".repeat(TODO_LIMITS.notes + 50)}` }).notes!.length, TODO_LIMITS.notes);
  assert.throws(() => todoFieldsFromIdea({ text: " \n " }), /沒有內容/);
});

test("轉成待辦 makes exactly one todo, archives the idea in the same step, and refuses an archived or missing idea", async (t) => {
  const { services, setNow } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule, todosModule] });
  const idea = (await server.call("POST", "/api/ideas", { body: { text: "寫一篇 eBPF 排程延遲的部落格\n先量測 CFS，再比較 EEVDF", tags: ["OS"], pinned: true } })).json as Idea;
  setNow(taipei("2026-10-12T09:00"));

  const bad = await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: { title: "不能由前端指定" } });
  assert.equal(bad.status, 400);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 0);

  const converted = await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} });
  assert.equal(converted.status, 201);
  const body = converted.json as IdeaToTodoResponse;
  assert.equal(body.todo.title, "寫一篇 eBPF 排程延遲的部落格");
  assert.equal(body.todo.notes, "先量測 CFS，再比較 EEVDF");
  assert.equal(body.todo.origin, "manual");
  assert.equal(body.todo.status, "open");
  assert.equal(body.todo.dueDay, undefined);
  assert.ok(body.undoToken);

  const todos = (await server.call("GET", "/api/todos")).json as TodoListResponse;
  assert.deepEqual(todos.open.map((todo) => todo.id), [body.todo.id]);
  assert.deepEqual(((await server.call("GET", "/api/ideas")).json as IdeaListResponse).ideas, []);
  const archived = ((await server.call("GET", "/api/ideas?archived=1")).json as IdeaListResponse).ideas;
  assert.deepEqual(archived.map((item) => item.id), [idea.id]);
  assert.equal(archived[0].pinned, true, "the idea is only archived, nothing else about it changes");

  const again = await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} });
  assert.equal(again.status, 409);
  assert.match(again.json.error, /已經封存/);
  const missing = await server.call("POST", "/api/ideas/missing/todo", { body: {} });
  assert.equal(missing.status, 404);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 1, "refused requests add no todo");
});

test("轉成待辦 is all or nothing: a failure after the todo was written leaves neither a todo nor an archived idea", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule, todosModule] });
  const idea = (await server.call("POST", "/api/ideas", { body: { text: "做一個靈感轉待辦" } })).json as Idea;
  const put = services.trash.put.bind(services.trash);
  services.trash.put = () => { throw new Error("disk full"); };
  const failed = await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} });
  assert.equal(failed.status, 500);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 0);
  assert.equal(((await server.call("GET", "/api/ideas")).json as IdeaListResponse).ideas.length, 1);

  services.trash.put = put;
  assert.equal((await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} })).status, 201);
});

test("復原 after 轉成待辦 removes the todo and moves the idea back, once", async (t) => {
  const { services } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule, todosModule] });
  const idea = (await server.call("POST", "/api/ideas", { body: { text: "習慣頁加整年熱度圖", tags: ["習慣"] } })).json as Idea;
  const { undoToken } = (await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} })).json as IdeaToTodoResponse;

  const restored = await server.call("POST", "/api/trash/restore", { body: { token: undoToken } });
  assert.equal(restored.status, 200);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 0);
  const list = (await server.call("GET", "/api/ideas")).json as IdeaListResponse;
  assert.deepEqual(list.ideas.map((item) => [item.id, item.archived, item.tags]), [[idea.id, false, ["習慣"]]]);
  assert.equal((await server.call("POST", "/api/trash/restore", { body: { token: undoToken } })).status, 404, "the marker is used up");

  // Converting again after an undo works and gives a new todo.
  assert.equal((await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} })).status, 201);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).open.length, 1);
});

test("復原 after 轉成待辦 never throws away work: a todo that changed since stays, and one that is gone does not block the idea", async (t) => {
  const { services, setNow } = setup(t);
  const server = await startTestServer(t, services, { modules: [ideasModule, todosModule] });
  const convert = async (text: string) => {
    const idea = (await server.call("POST", "/api/ideas", { body: { text } })).json as Idea;
    return { idea, ...((await server.call("POST", `/api/ideas/${idea.id}/todo`, { body: {} })).json as IdeaToTodoResponse) };
  };

  const finished = await convert("已經做完的");
  setNow(taipei("2026-10-12T09:05"));
  await server.call("POST", `/api/todos/${finished.todo.id}/complete`, { body: {} });
  const refused = await server.call("POST", "/api/trash/restore", { body: { token: finished.undoToken } });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /待辦頁/);
  assert.equal(((await server.call("GET", "/api/todos")).json as TodoListResponse).completedToday.length, 1, "the finished todo is untouched");
  assert.equal(((await server.call("GET", `/api/ideas?archived=1`)).json as IdeaListResponse).ideas.length, 1, "and the idea stays archived");

  const deleted = await convert("已經刪掉的");
  await server.call("DELETE", `/api/todos/${deleted.todo.id}`, { body: {} });
  assert.equal((await server.call("POST", "/api/trash/restore", { body: { token: deleted.undoToken } })).status, 200);
  const active = ((await server.call("GET", "/api/ideas")).json as IdeaListResponse).ideas;
  assert.deepEqual(active.map((item) => item.id), [deleted.idea.id]);
});
