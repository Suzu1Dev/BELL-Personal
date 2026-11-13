import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { BotOperationResponse, BotSendResponse, BotSessionResponse } from "../../shared/bot.js";
import { jsonSchemaFor, strictSchemaFor } from "../ai/structured.js";
import { appContext } from "../app.js";
import { habitsModule } from "../features/habits/index.js";
import { habitStore } from "../features/habits/store.js";
import { ideasModule } from "../features/ideas/index.js";
import { ideaStore } from "../features/ideas/store.js";
import { todosModule } from "../features/todos/index.js";
import { todoStore } from "../features/todos/store.js";
import { claudeFixtureEvents, fakeCommand, startTestServer, testServices } from "../test-helpers.js";
import { botModelTurnSchema, type BotModelTurn, type BotProposedOp } from "./executor.js";

const NOW = new Date("2026-11-12T09:30:00+08:00");

function emptyOp(overrides: Partial<BotProposedOp> & Pick<BotProposedOp, "kind">): BotProposedOp {
  return {
    title: null,
    text: null,
    notes: null,
    targetId: null,
    dueDay: null,
    dueTime: null,
    priority: null,
    start: null,
    end: null,
    allDay: null,
    location: null,
    tags: null,
    until: null,
    depth: null,
    learnByHand: null,
    ...overrides,
  };
}

function claudeStream(answer: BotModelTurn): string {
  return claudeFixtureEvents().map((event) => {
    const copy = structuredClone(event);
    if (copy.type === "result") {
      copy.structured_output = answer;
      copy.result = JSON.stringify(answer);
    }
    if (copy.type === "assistant") copy.message.content[0].input = answer;
    return JSON.stringify(copy);
  }).join("\n");
}

async function waitForJob(call: Awaited<ReturnType<typeof startTestServer>>["call"], jobId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const res = await call("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    if (res.json?.status === "done" || res.json?.status === "failed" || res.json?.status === "cancelled") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Job ${jobId} did not settle in time`);
}

async function startSiblingServer(
  t: TestContext,
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<string> {
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  t.after(() => {
    srv.closeAllConnections();
    return new Promise<void>((resolve) => srv.close(() => resolve()));
  });
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

test("botModelTurnSchema compiles cleanly to a strict JSON schema for both Claude and Codex", () => {
  const schema = jsonSchemaFor(botModelTurnSchema);
  const strict = strictSchemaFor(schema);
  assert.ok(strict !== undefined, "strictSchemaFor must accept every object in botModelTurnSchema");
});

test("Personal Bot in balanced mode executes safe local actions with Undo and gates cross-suite writes via Permission Broker", async (t) => {
  const repoId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  let explainGenerated = 0;
  let prRunsCreated = 0;

  const explainOrigin = await startSiblingServer(t, (req, _body, res) => {
    if (req.url === "/api/suite/today") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, appId: "explain", generatedAt: NOW.toISOString(), counts: { dueCount: 3, newCount: 1 }, items: [], truncated: false }));
      return;
    }
    if (req.url === "/api/lessons") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "les-raft", title: "Raft 共識演算法", answer: "Leader 選舉與日誌複製。", updatedAt: NOW.toISOString() }]));
      return;
    }
    if (req.method === "POST" && req.url === "/api/generate") {
      explainGenerated++;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ type: "job", id: "exp-job-1" })}\n`);
      return;
    }
    res.writeHead(404).end();
  });

  const prOrigin = await startSiblingServer(t, (req, body, res) => {
    if (req.headers.authorization !== "Bearer suite-pr-token") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url === "/api/suite/today") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, appId: "pr", generatedAt: NOW.toISOString(), counts: { needsYou: 1, waiting: 0 }, items: [], truncated: false }));
      return;
    }
    if (req.url === "/api/repos") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ repos: [{ id: repoId, name: "bell-personal", defaultBranch: "main" }] }));
      return;
    }
    if (req.url === "/api/runs" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runs: [{ id: "run_existing", repoId, title: "重構認證流程", status: "awaiting_review" }] }));
      return;
    }
    if (req.url === "/api/runs" && req.method === "POST") {
      prRunsCreated++;
      const parsed = JSON.parse(body) as { title?: string };
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "run_from_bot", repoId, title: parsed.title ?? "Bot Run", status: "planning" } }));
      return;
    }
    res.writeHead(404).end();
  });

  let nextTurn: BotModelTurn = {
    reply: "已幫你建立待辦與習慣打卡；Explain 筆記與 PR 任務已準備好，請確認後執行。",
    operations: [],
    followUps: ["查看今天的行程空檔"],
  };
  const promptsSeen: string[] = [];

  const fake = fakeCommand((call) => {
    if (call.args.join(" ") === "auth status") return "{}";
    if (call.executable === "claude") {
      promptsSeen.push(`${call.args.join(" ")}\n${call.options.input ?? ""}`);
      return claudeStream(nextTurn);
    }
    return undefined;
  });

  const services = testServices(t, {
    env: {
      BELLPERSONAL_SUITE_LINKS: "explain=http://127.0.0.1:20001,pr=http://127.0.0.1:20002",
      BELLPERSONAL_SUITE_FETCH: `explain=${explainOrigin},pr=${prOrigin}`,
      BELLPERSONAL_SUITE_PR_TOKEN: "suite-pr-token",
    },
    seams: { now: () => NOW, command: fake.runner, sleep: async () => {} },
  });

  const server = await startTestServer(t, services, {
    modules: [todosModule, ideasModule, habitsModule],
  });

  const habit = habitStore(services).create({ name: "晨間閱讀" });
  const existingTodo = todoStore(services).create({ title: "舊待辦", origin: "manual" });

  nextTurn = {
    reply: "已為你新增待辦、完成晨間閱讀打卡，並準備好 Explain 筆記與 PR 任務請你確認。",
    operations: [
      emptyOp({ kind: "todo.create", title: "複習作業系統講義", dueDay: "2026-11-12", dueTime: "15:00", priority: "high" }),
      emptyOp({ kind: "idea.create", text: "把 OpenMausBot 的分級權限整理成團隊規範", tags: ["agent", "suite"] }),
      emptyOp({ kind: "habit.check", targetId: habit.id }),
      emptyOp({ kind: "todo.delete", targetId: existingTodo.id }),
      emptyOp({ kind: "explain.create_note", title: "Raft Leader Election", text: "整理 Raft 任期與選舉安全條件", depth: "intermediate" }),
      emptyOp({ kind: "pr.create_run", targetId: "bell-personal", title: "新增 Bot 整合測試", text: "為首頁 Personal Bot 增加完整的端對端測試" }),
    ],
    followUps: ["幫我排進下午空檔"],
  };

  const sent = await server.call("POST", "/api/bot/messages", {
    body: { text: "幫我整理今天進度、打卡晨間閱讀，並建立 Raft 筆記與 PR 測試任務" },
  });
  assert.equal(sent.status, 202);
  const sendBody = sent.json as BotSendResponse;
  assert.ok(sendBody.jobId);
  await waitForJob(server.call, sendBody.jobId);

  // Verify cross-suite context reached the model prompt!
  assert.equal(promptsSeen.length, 1);
  assert.ok(promptsSeen[0].includes("Raft 共識演算法"), "Explain lesson digest is included in prompt data");
  assert.ok(promptsSeen[0].includes("重構認證流程"), "BELL PR run digest is included in prompt data");

  const sessionRes = (await server.call("GET", "/api/bot/session")).json as BotSessionResponse;
  assert.equal(sessionRes.session.messages.length, 2);
  const assistant = sessionRes.session.messages[1];
  assert.equal(assistant.operations?.length, 6);

  const byKind = new Map(assistant.operations!.map((op) => [op.kind, op]));
  // Safe ops ran immediately!
  assert.equal(byKind.get("todo.create")?.status, "executed");
  assert.equal(byKind.get("todo.create")?.undoable, true);
  assert.equal(byKind.get("idea.create")?.status, "executed");
  assert.equal(byKind.get("habit.check")?.status, "executed");
  assert.equal(todoStore(services).open().some((item) => item.title === "複習作業系統講義"), true);
  assert.equal(ideaStore(services).latest(5).length, 1);

  // Sensitive & cross-product ops waited for approval!
  assert.equal(byKind.get("todo.delete")?.status, "pending_approval");
  assert.equal(byKind.get("explain.create_note")?.status, "pending_approval");
  assert.equal(byKind.get("pr.create_run")?.status, "pending_approval");
  assert.equal(explainGenerated, 0);
  assert.equal(prRunsCreated, 0);
  assert.ok(todoStore(services).get(existingTodo.id), "existingTodo not deleted before approval");

  // Approve Explain note, PR run, and todo.delete; dismiss nothing yet.
  const approvedExplain = (await server.call("POST", `/api/bot/operations/${byKind.get("explain.create_note")!.id}/approve`, { body: {} })).json as BotOperationResponse;
  assert.equal(approvedExplain.operation.status, "executed");
  assert.equal(approvedExplain.operation.resultHref, "http://127.0.0.1:20001/#/library");
  assert.equal(explainGenerated, 1);

  const approvedPr = (await server.call("POST", `/api/bot/operations/${byKind.get("pr.create_run")!.id}/approve`, { body: {} })).json as BotOperationResponse;
  assert.equal(approvedPr.operation.status, "executed");
  assert.equal(approvedPr.operation.resultHref, "http://127.0.0.1:20002/#/runs/run_from_bot");
  assert.equal(prRunsCreated, 1);

  const approvedDelete = (await server.call("POST", `/api/bot/operations/${byKind.get("todo.delete")!.id}/approve`, { body: {} })).json as BotOperationResponse;
  assert.equal(approvedDelete.operation.status, "executed");
  assert.equal(approvedDelete.operation.undoable, true);
  assert.equal(todoStore(services).get(existingTodo.id), undefined);

  // Undo todo.delete (restores from Trash!) and undo todo.create (discards created todo!).
  const undoneDelete = (await server.call("POST", `/api/bot/operations/${byKind.get("todo.delete")!.id}/undo`, { body: {} })).json as BotOperationResponse;
  assert.equal(undoneDelete.operation.status, "undone");
  assert.equal(todoStore(services).get(existingTodo.id)?.title, "舊待辦");

  const undoneCreate = (await server.call("POST", `/api/bot/operations/${byKind.get("todo.create")!.id}/undo`, { body: {} })).json as BotOperationResponse;
  assert.equal(undoneCreate.operation.status, "undone");
  assert.equal(todoStore(services).open().some((item) => item.title === "複習作業系統講義"), false);
});

test("Personal Bot respects cautious and auto autonomy settings and supports dismiss + reset", async (t) => {
  let turn: BotModelTurn = {
    reply: "好的。",
    operations: [emptyOp({ kind: "todo.create", title: "買咖啡豆" })],
    followUps: [],
  };
  const fake = fakeCommand((call) => {
    if (call.args.join(" ") === "auth status") return "{}";
    if (call.executable === "claude") return claudeStream(turn);
    return undefined;
  });
  const services = testServices(t, { seams: { now: () => NOW, command: fake.runner, sleep: async () => {} } });
  const server = await startTestServer(t, services, { modules: [todosModule] });

  // Cautious mode: even safe todo.create requires approval!
  services.settings.update({ "bot.autonomy": "cautious" });
  const cautiousRes = (await server.call("POST", "/api/bot/messages", { body: { text: "提醒我買咖啡豆" } })).json as BotSendResponse;
  await waitForJob(server.call, cautiousRes.jobId!);

  const afterCautious = (await server.call("GET", "/api/bot/session")).json as BotSessionResponse;
  const pendingTodoOp = afterCautious.session.messages[1]?.operations?.[0];
  assert.equal(pendingTodoOp?.status, "pending_approval");
  assert.equal(todoStore(services).open().length, 0);

  // Dismiss marks it dismissed without creating the todo.
  const dismissed = (await server.call("POST", `/api/bot/operations/${pendingTodoOp!.id}/dismiss`, { body: {} })).json as BotOperationResponse;
  assert.equal(dismissed.operation.status, "dismissed");
  assert.equal(todoStore(services).open().length, 0);

  // Auto mode: even sensitive todo.delete runs immediately without approval!
  const target = todoStore(services).create({ title: "過期的草稿", origin: "manual" });
  services.settings.update({ "bot.autonomy": "auto" });
  turn = {
    reply: "已直接刪除過期草稿。",
    operations: [emptyOp({ kind: "todo.delete", targetId: target.id })],
    followUps: [],
  };
  const autoRes = (await server.call("POST", "/api/bot/messages", { body: { text: "刪掉過期的草稿" } })).json as BotSendResponse;
  await waitForJob(server.call, autoRes.jobId!);
  assert.equal(todoStore(services).get(target.id), undefined);

  // Reset starts a fresh empty session while preserving archived history in SQLite.
  const reset = (await server.call("POST", "/api/bot/reset", { body: {} })).json as BotSessionResponse;
  assert.equal(reset.session.messages.length, 0);
  assert.equal(appContext(server.app).bot.store.table.count(), 2);
  assert.equal(reset.sessions?.length, 1, "archived session with messages is returned in history list");

  const firstHistoryId = reset.sessions![0]!.id;
  assert.equal(reset.sessions![0]!.folder, "tasks", "auto-tagged into tasks folder");

  // Patch folder tag & pin status on the saved session.
  const patched = (await server.call("PATCH", `/api/bot/sessions/${firstHistoryId}`, {
    body: { folder: "suite", pinned: true, title: "咖啡與草稿整理" },
  })).json as BotSessionResponse;
  assert.equal(patched.sessions?.[0]?.folder, "suite");
  assert.equal(patched.sessions?.[0]?.pinned, true);
  assert.equal(patched.sessions?.[0]?.title, "咖啡與草稿整理");

  // Select switches active session back to the archived conversation (cleaning up unused empty session).
  const selected = (await server.call("POST", `/api/bot/sessions/${firstHistoryId}/select`, { body: {} })).json as BotSessionResponse;
  assert.equal(selected.session.id, firstHistoryId);
  assert.ok(selected.session.messages.length >= 2);

  // Delete removes the session and leaves a clean empty session ready.
  const deleted = (await server.call("DELETE", `/api/bot/sessions/${firstHistoryId}`, { body: {} })).json as BotSessionResponse;
  assert.equal(deleted.sessions?.length, 0);
  assert.equal(deleted.session.messages.length, 0);
});
