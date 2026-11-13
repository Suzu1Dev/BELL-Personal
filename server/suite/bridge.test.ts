import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { appContext } from "../app.js";
import { startTestServer, testServices } from "../test-helpers.js";

interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

async function startFakeSibling(
  t: TestContext,
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<{ origin: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        body,
      });
      handler(req, body, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

test("SuiteBridge pairs with BELL PR, reads authenticated /api/suite/today, and starts/approves runs", async (t) => {
  const repoId = "11111111-2222-4333-8444-555555555555";
  const pr = await startFakeSibling(t, (req, rawBody, res) => {
    if (req.method === "POST" && req.url === "/api/pair") {
      const parsed = JSON.parse(rawBody) as { code?: string };
      if (parsed.code !== "654321") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid code" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ deviceId: "dev-1", token: "pr-secret-token-xyz", name: "BELL Personal" }));
      return;
    }
    if (req.headers.authorization !== "Bearer pr-secret-token-xyz") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/suite/today") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: 1,
        appId: "pr",
        generatedAt: "2026-11-12T10:00:00.000Z",
        counts: { needsYou: 1, waiting: 2 },
        items: [
          {
            sourceApp: "pr",
            type: "run",
            id: "run_alpha_1",
            title: "修復 OAuth PKCE 驗證",
            detail: "等待審核計畫",
            href: "#/runs/run_alpha_1",
            state: "needs-you",
            updatedAt: "2026-11-12T09:50:00.000Z",
          },
        ],
        truncated: false,
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/repos") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ repos: [{ id: repoId, name: "bell-personal", defaultBranch: "main" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        runs: [{ id: "run_alpha_1", repoId, title: "修復 OAuth PKCE 驗證", status: "awaiting_plan_approval", learnByHand: false, createdAt: "2026-11-12T09:50:00.000Z" }],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/runs") {
      const parsed = JSON.parse(rawBody) as { repoId: string; prompt: string; title?: string };
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "run_beta_2", repoId: parsed.repoId, title: parsed.title ?? "新任務", status: "planning" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/runs/run_alpha_1/plan/approve") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run: { id: "run_alpha_1", title: "修復 OAuth PKCE 驗證", status: "executing" } }));
      return;
    }
    res.writeHead(404).end();
  });

  const services = testServices(t, {
    env: {
      BELLPERSONAL_SUITE_LINKS: "pr=http://127.0.0.1:20002",
      BELLPERSONAL_SUITE_FETCH: `pr=${pr.origin}`,
    },
  });
  const server = await startTestServer(t, services);

  // Before pairing, PR status is disconnected and /api/suite/sources reports unsupported (401 without token).
  const initialStatus = await server.call("GET", "/api/suite/pr");
  assert.equal(initialStatus.status, 200);
  assert.equal(initialStatus.json.connected, false);

  // Pair using 6-digit code.
  const paired = await server.call("POST", "/api/suite/pr/pair", { body: { code: "654321" } });
  assert.equal(paired.status, 200);
  assert.equal(paired.json.connected, true);
  assert.equal(paired.json.source, "vault");

  // /api/suite/sources?refresh=1 now authenticates with Bearer token and parses PR's today feed + #/runs/{id} route!
  const sources = await server.call("GET", "/api/suite/sources?refresh=1");
  assert.equal(sources.status, 200);
  const prSource = (sources.json.sources as Array<{ appId: string; status: string; feed?: { counts: Record<string, number> } }>).find((s) => s.appId === "pr");
  assert.equal(prSource?.status, "ready");
  assert.deepEqual(prSource?.feed?.counts, { needsYou: 1, waiting: 2 });

  const { suiteBridge } = appContext(server.app);
  const snapshot = await suiteBridge.readPrSnapshot();
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.repos.length, 1);
  assert.equal(snapshot.runs[0]?.href, "http://127.0.0.1:20002/#/runs/run_alpha_1");

  const created = await suiteBridge.createPrRun({
    repoId,
    title: "補齊單元測試",
    prompt: "為新增的 Personal Bot 模組補齊完整的邊界條件測試",
  });
  assert.equal(created.runId, "run_beta_2");
  assert.equal(created.href, "http://127.0.0.1:20002/#/runs/run_beta_2");

  const approved = await suiteBridge.approvePrPlan({ runId: "run_alpha_1" });
  assert.equal(approved.status, "executing");

  // Token never leaks in status endpoint.
  assert.ok(!JSON.stringify(paired.json).includes("pr-secret-token-xyz"));
});

test("SuiteBridge reads Explain lessons (skipping demos) and triggers NDJSON note generation", async (t) => {
  const explain = await startFakeSibling(t, (req, _rawBody, res) => {
    if (req.method === "GET" && req.url === "/api/suite/today") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        schemaVersion: 1,
        appId: "explain",
        generatedAt: "2026-11-12T10:00:00.000Z",
        counts: { dueCount: 2, newCount: 1 },
        items: [],
        truncated: false,
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/lessons") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([
        { id: "demo-1", title: "示範講義", answer: "demo", isDemo: true, updatedAt: "2026-11-12T10:00:00.000Z" },
        { id: "lesson_1", title: "OAuth 2.0 PKCE 流程", answer: "以 code_verifier 與 S256 保護授權碼交換。", tags: ["security", "oauth"], updatedAt: "2026-11-12T09:00:00.000Z" },
      ]));
      return;
    }
    if (req.method === "POST" && req.url === "/api/generate") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "job", id: "job-explain-99" })}\n`);
      // Keep stream open briefly like real BELL Explain; client should return right after the job header line!
      setTimeout(() => res.end(), 100);
      return;
    }
    res.writeHead(404).end();
  });

  const services = testServices(t, {
    env: {
      BELLPERSONAL_SUITE_LINKS: "explain=http://127.0.0.1:20001",
      BELLPERSONAL_SUITE_FETCH: `explain=${explain.origin}`,
    },
  });
  const server = await startTestServer(t, services);
  const { suiteBridge } = appContext(server.app);

  const snap = await suiteBridge.readExplainSnapshot();
  assert.equal(snap.lessons.length, 1);
  assert.equal(snap.lessons[0]?.title, "OAuth 2.0 PKCE 流程");
  assert.equal(snap.lessons[0]?.href, "http://127.0.0.1:20001/#/note/lesson_1");

  const created = await suiteBridge.createExplainNote({
    question: "什麼是 Permission Broker？",
    content: "說明 Agent 工具呼叫的分級權限與使用者核准機制。",
    depth: "intermediate",
  });
  assert.equal(created.jobId, "job-explain-99");
  assert.equal(created.href, "http://127.0.0.1:20001/#/library");
  const genCall = explain.requests.find((r) => r.url === "/api/generate");
  assert.ok(genCall);
  assert.equal(JSON.parse(genCall.body).kind, "concept");
});
