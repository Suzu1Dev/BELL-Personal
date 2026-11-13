import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import express, { type ErrorRequestHandler } from "express";
import type { ApiErrorDetail } from "../shared/api.js";
import type { JobEvent } from "../shared/jobs.js";
import { AppError, publicErrorDetail, SchemaValidationError, TransientAgentError } from "./errors.js";
import { createJobsRouter } from "./jobs-router.js";
import { JobRegistry, isCancelled } from "./jobs.js";

const stage = (message: string): JobEvent => ({ type: "stage", stage: "brief", message });

const STRUCTURED_REFUSAL_CASES: ReadonlyArray<{ message: string; detail: ApiErrorDetail }> = [
  {
    message: "目前選用的 AI 連線是 OpenAI API 金鑰，但這台伺服器還沒有保存金鑰。請到 設定 › 連接 AI 輸入金鑰，或改選其他連線。",
    detail: { code: "ai_connection_not_ready", method: "openai-key", reason: "key_missing" },
  },
  {
    message: "無法使用 Codex：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。",
    detail: { code: "ai_connection_not_ready", method: "chatgpt", reason: "wrong_login" },
  },
  {
    message: "每日摘要未完成：OpenAI 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。",
    detail: { code: "ai_key_invalid", provider: "openai", method: "openai-key" },
  },
  {
    message: "每日摘要未完成：Anthropic 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。",
    detail: { code: "ai_key_invalid", provider: "anthropic" },
  },
  {
    message: "OpenAI 不接受這把金鑰（無效或沒有權限）。",
    detail: { code: "ai_key_invalid" },
  },
  {
    message: "帳戶目前沒有可用額度。",
    detail: { code: "ai_key_no_credit" },
  },
  {
    message: "每日摘要未完成：Codex 授權已失效，請在伺服器重新執行 codex login。",
    detail: { code: "ai_auth_expired", provider: "codex", method: "chatgpt" },
  },
  {
    message: "每日摘要未完成：Claude Code 登入已失效，請在伺服器執行 claude auth login。",
    detail: { code: "ai_auth_expired", provider: "claude" },
  },
  {
    message: "每日摘要未完成：無法啟動 Claude Code，請確認伺服器已安裝 Claude Code 並執行 claude auth login。",
    detail: { code: "ai_cli_unavailable", provider: "claude" },
  },
  {
    message: "無法啟動 Codex CLI。請安裝 Codex 並在伺服器執行 codex login。",
    detail: { code: "ai_cli_unavailable", provider: "codex" },
  },
  {
    message: "「課業」目前沒有開啟。到 設定 › 身分與功能 勾選「學生」後就能使用。",
    detail: { code: "module_hidden", module: "lms", feature: "assignments", roles: ["student"] },
  },
];

async function waitUntilAfter(timestampMs: number): Promise<void> {
  while (Date.now() <= timestampMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(2, timestampMs - Date.now() + 2)));
  }
}

async function startJobsHttp(t: TestContext, jobs: JobRegistry) {
  const app = express();
  app.use("/api/jobs", createJobsRouter(jobs));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: error.message, ...error.detail });
      return;
    }
    res.status(500).json({ error: "unexpected" });
  };
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  const get = (path: string, onLine?: (event: JobEvent) => void) =>
    new Promise<{ status: number; contentType: string; text: string; json: any; events: JobEvent[] }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
        const chunks: Buffer[] = [];
        let pending = "";
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          if (!onLine) return;
          pending += chunk.toString("utf8");
          let nl: number;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl).trim();
            pending = pending.slice(nl + 1);
            if (line) onLine(JSON.parse(line) as JobEvent);
          }
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const contentType = String(res.headers["content-type"] ?? "");
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          const events = contentType.includes("application/x-ndjson")
            ? text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as JobEvent)
            : [];
          resolve({ status: res.statusCode!, contentType, text, json, events });
        });
      });
      req.on("error", reject);
      req.end();
    });
  return { port, get };
}

test("a long job keeps its first and last events and stable indexes for resuming", async () => {
  const jobs = new JobRegistry();
  let finish!: () => void;
  const view = jobs.start({ kind: "daily-brief", title: "今日摘要" }, async (emit) => {
    for (let index = 0; index < 450; index++) emit(stage(`step ${index}`));
    await new Promise<void>((resolve) => { finish = resolve; });
    return { day: "2026-10-13" };
  });
  assert.equal(jobs.get(view.id)?.message, "step 449");
  const cursor = jobs.cursor(view.id)!;
  assert.equal(cursor, 450);
  const seen: JobEvent[] = [];
  let ended = false;
  jobs.follow(view.id, 0, (event) => seen.push(event), () => { ended = true; });
  assert.equal((seen[0] as { message: string }).message, "step 0");
  assert.ok(seen.length <= 400);
  const resumed: JobEvent[] = [];
  jobs.follow(view.id, cursor, (event) => resumed.push(event), () => {});
  finish();
  await jobs.settled(view.id);
  assert.deepEqual(resumed, [{ type: "done", result: { day: "2026-10-13" } }]);
  assert.equal(ended, true);
  assert.equal(jobs.get(view.id)?.status, "done");
});

test("failures keep a public message; outcomes outlive their events", async () => {
  const jobs = new JobRegistry(10, 1000);
  const view = jobs.start({ kind: "mail-triage", title: "x" }, async () => { throw new Error("internal detail with /home/user/secret path"); });
  await jobs.settled(view.id);
  assert.equal(jobs.get(view.id)?.status, "failed");
  assert.doesNotMatch(jobs.get(view.id)?.error || "", /secret/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(jobs.get(view.id), undefined);
  assert.equal(jobs.outcome(view.id)?.status, "failed");
});

test("cancel is told apart from shutdown; shutdown refuses new jobs", async () => {
  const jobs = new JobRegistry();
  const waitForAbort = (_emit: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { assert.equal(isCancelled(signal), signal.reason?.name === "AbortError"); reject(signal.reason); }, { once: true }));
  const cancelled = jobs.start({ kind: "daily-brief", title: "a" }, waitForAbort);
  assert.equal(jobs.cancel(cancelled.id), true);
  await jobs.settled(cancelled.id);
  assert.equal(jobs.get(cancelled.id)?.status, "cancelled");
  const stuck = jobs.start({ kind: "daily-brief", title: "b" }, waitForAbort);
  await jobs.drain(20);
  assert.equal(jobs.get(stuck.id)?.status, "failed");
  assert.match(jobs.get(stuck.id)?.error || "", /重新啟動/);
  assert.throws(() => jobs.start({ kind: "daily-brief", title: "c" }, async () => {}), (error: { status?: number }) => error.status === 503);
});

test("maxRunning turns a second job of the same kind into a 429", async () => {
  const jobs = new JobRegistry();
  let finish!: () => void;
  const first = jobs.start({ kind: "daily-brief", title: "a" }, () => new Promise<void>((resolve) => { finish = resolve; }), { maxRunning: 1 });
  assert.throws(() => jobs.start({ kind: "daily-brief", title: "b" }, async () => {}, { maxRunning: 1, busyMessage: "今日摘要正在整理中。" }), (error: { status?: number; message?: string }) => error.status === 429 && error.message === "今日摘要正在整理中。");
  jobs.start({ kind: "mail-triage", title: "other kind" }, async () => {}, { maxRunning: 1 });
  finish();
  await jobs.settled(first.id);
  jobs.start({ kind: "daily-brief", title: "c" }, async () => {}, { maxRunning: 1 });
});

test("publicErrorDetail returns detail only for AppError with structured detail and never leaks secrets", () => {
  const canary = `sk-proj-${"CanaryKeyMaterial7".repeat(3)}`;
  const structuredCases: ApiErrorDetail[] = [
    { code: "ai_connection_not_ready", method: "chatgpt", reason: "not_signed_in" },
    { code: "ai_key_invalid", provider: "openai", method: "openai-key" },
    { code: "ai_key_invalid" },
    { code: "ai_key_no_credit" },
    { code: "ai_auth_expired", provider: "claude", method: "claude" },
    { code: "ai_auth_expired", provider: "codex" },
    { code: "ai_cli_unavailable", provider: "claude" },
    { code: "ai_cli_unavailable", provider: "codex" },
    { code: "module_hidden", module: "lms", feature: "assignments", roles: ["student"] },
  ];
  for (const detail of structuredCases) {
    assert.deepEqual(publicErrorDetail(new AppError(503, "錯誤訊息。", detail)), detail);
  }
  assert.equal(publicErrorDetail(new AppError(503, "沒有結構化欄位的錯誤。")), undefined);
  assert.equal(publicErrorDetail(new TransientAgentError("暫時重試。")), undefined);
  assert.equal(publicErrorDetail(new SchemaValidationError("格式不符。", "每日摘要", [])), undefined);
  assert.equal(publicErrorDetail(new Error(`raw upstream error ${canary}`)), undefined);
  assert.equal(publicErrorDetail(Object.assign(new Error(canary), { detail: { code: "ai_key_invalid", provider: "openai" } })), undefined);
  assert.equal(publicErrorDetail(canary), undefined);
  assert.equal(publicErrorDetail(null), undefined);
});

test("JobRegistry forwards structured error details across live followers, replay, JobView, and pruned outcomes across all codes", async () => {
  // Default retention keeps live/replay/list/immutability checks independent of wall-clock CPU stalls.
  const liveJobs = new JobRegistry();
  for (const { message, detail } of STRUCTURED_REFUSAL_CASES) {
    let rejectRun!: () => void;
    const view = liveJobs.start({ kind: "daily-brief", title: "今日摘要" }, async (emit) => {
      emit(stage("正在整理今日摘要…"));
      await new Promise<void>((resolve) => { rejectRun = resolve; });
      throw new AppError(503, message, detail);
    });
    const stageCursor = liveJobs.cursor(view.id)!;
    assert.equal(stageCursor, 1);

    const live: JobEvent[] = [];
    let liveEnded = false;
    liveJobs.follow(view.id, stageCursor, (event) => live.push(event), () => { liveEnded = true; });

    rejectRun();
    await liveJobs.settled(view.id);

    assert.equal(liveEnded, true);
    assert.deepEqual(live, [{ type: "error", message, detail }]);

    const replayed: JobEvent[] = [];
    let replayEnded = false;
    liveJobs.follow(view.id, 0, (event) => replayed.push(event), () => { replayEnded = true; });
    assert.equal(replayEnded, true);
    assert.deepEqual(replayed, [stage("正在整理今日摘要…"), { type: "error", message, detail }]);

    const current = liveJobs.get(view.id)!;
    assert.equal(current.status, "failed");
    assert.equal(current.error, message);
    assert.deepEqual(current.errorDetail, detail);
    if (current.errorDetail?.code === "module_hidden") current.errorDetail.roles.push("developer");
    assert.deepEqual(liveJobs.get(view.id)?.errorDetail, detail, "caller mutation never leaks into registry state");

    const listed = liveJobs.list().find((item) => item.id === view.id)!;
    assert.deepEqual(listed.errorDetail, detail);
  }

  // Separate short-TTL registry verifies post-retention pruning into outcomes across all 11 cases without racing live checks.
  const retentionMs = 5;
  const prunedJobs = new JobRegistry(retentionMs);
  const ids: Array<{ id: string; message: string; detail: ApiErrorDetail }> = [];
  for (const { message, detail } of STRUCTURED_REFUSAL_CASES) {
    const view = prunedJobs.start({ kind: "daily-brief", title: "今日摘要" }, async () => {
      throw new AppError(503, message, detail);
    });
    ids.push({ id: view.id, message, detail });
  }
  await Promise.all(ids.map(({ id }) => prunedJobs.settled(id)));
  await waitUntilAfter(Date.now() + retentionMs);

  for (const { id, message, detail } of ids) {
    assert.equal(prunedJobs.get(id), undefined);
    const ended = prunedJobs.outcome(id)!;
    assert.equal(ended.status, "failed");
    assert.equal(ended.error, message);
    assert.deepEqual(ended.errorDetail, detail);
    if (ended.errorDetail?.code === "module_hidden") ended.errorDetail.roles.push("ctf");
    assert.deepEqual(prunedJobs.outcome(id)?.errorDetail, detail, "caller mutation never leaks into outcome state");
  }
});

test("JobRegistry omits errorDetail and event.detail on plain errors and cancellations, with zero sk-* canary leakage", async () => {
  const openaiCanary = `sk-proj-${"SecretOpenAiToken9".repeat(3)}`;
  const anthropicCanary = `sk-ant-api03-${"SecretAnthropicToken5".repeat(3)}`;
  const liveJobs = new JobRegistry();

  // 1. Plain Error carrying sk-* canary secrets
  const plain = liveJobs.start({ kind: "mail-triage", title: "信件整理" }, async () => {
    throw new Error(`401 Incorrect API key provided: ${openaiCanary} / ${anthropicCanary}`);
  });
  await liveJobs.settled(plain.id);
  const plainEvents: JobEvent[] = [];
  liveJobs.follow(plain.id, 0, (event) => plainEvents.push(event), () => {});
  const plainView = liveJobs.get(plain.id)!;
  assert.equal(plainView.status, "failed");
  assert.equal(plainView.error, "這次工作沒有完成，請稍後再試。");
  assert.equal("errorDetail" in plainView, false);
  assert.deepEqual(plainEvents, [{ type: "error", message: "這次工作沒有完成，請稍後再試。" }]);
  assert.equal("detail" in plainEvents[0], false);

  // 2. AppError without detail (e.g. 502 / TransientAgentError)
  const bare = liveJobs.start({ kind: "daily-brief", title: "今日摘要" }, async () => {
    throw new TransientAgentError("每日摘要未完成：Claude Code 正在更新登入憑證，請稍後再試。");
  });
  await liveJobs.settled(bare.id);
  const bareEvents: JobEvent[] = [];
  liveJobs.follow(bare.id, 0, (event) => bareEvents.push(event), () => {});
  const bareView = liveJobs.get(bare.id)!;
  assert.equal(bareView.status, "failed");
  assert.equal("errorDetail" in bareView, false);
  assert.deepEqual(bareEvents, [{ type: "error", message: "每日摘要未完成：Claude Code 正在更新登入憑證，請稍後再試。" }]);
  assert.equal("detail" in bareEvents[0], false);

  // 3. Cancelled job omits errorDetail and detail even if the aborted handler throws an AppError with structured detail
  const cancelled = liveJobs.start({ kind: "daily-brief", title: "取消測試" }, (_emit, signal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new AppError(503, `Codex 授權已失效 ${openaiCanary}`, { code: "ai_auth_expired", provider: "codex", method: "chatgpt" }));
      }, { once: true });
    }),
  );
  const cancelLive: JobEvent[] = [];
  liveJobs.follow(cancelled.id, 0, (event) => cancelLive.push(event), () => {});
  assert.equal(liveJobs.cancel(cancelled.id), true);
  await liveJobs.settled(cancelled.id);
  const cancelView = liveJobs.get(cancelled.id)!;
  assert.equal(cancelView.status, "cancelled");
  assert.equal(cancelView.error, "這次工作已取消。");
  assert.equal("errorDetail" in cancelView, false);
  assert.deepEqual(cancelLive, [{ type: "error", message: "這次工作已取消。" }]);
  assert.equal("detail" in cancelLive[0], false);

  // Pruned outcomes on a dedicated short-TTL registry also keep errorDetail omitted and leak zero canary substrings.
  const retentionMs = 5;
  const prunedJobs = new JobRegistry(retentionMs);
  const prunedPlain = prunedJobs.start({ kind: "mail-triage", title: "信件整理" }, async () => {
    throw new Error(`401 Incorrect API key provided: ${openaiCanary} / ${anthropicCanary}`);
  });
  const prunedBare = prunedJobs.start({ kind: "daily-brief", title: "今日摘要" }, async () => {
    throw new TransientAgentError("每日摘要未完成：Claude Code 正在更新登入憑證，請稍後再試。");
  });
  const prunedCancelled = prunedJobs.start({ kind: "daily-brief", title: "取消測試" }, (_emit, signal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new AppError(503, `Codex 授權已失效 ${openaiCanary}`, { code: "ai_auth_expired", provider: "codex", method: "chatgpt" }));
      }, { once: true });
    }),
  );
  assert.equal(prunedJobs.cancel(prunedCancelled.id), true);
  await Promise.all([prunedJobs.settled(prunedPlain.id), prunedJobs.settled(prunedBare.id), prunedJobs.settled(prunedCancelled.id)]);
  await waitUntilAfter(Date.now() + retentionMs);

  for (const id of [prunedPlain.id, prunedBare.id, prunedCancelled.id]) {
    assert.equal(prunedJobs.get(id), undefined);
    const outcome = prunedJobs.outcome(id)!;
    assert.equal("errorDetail" in outcome, false);
    const dumped: string = JSON.stringify({ outcome, plainView, plainEvents, bareView, bareEvents, cancelView, cancelLive });
    for (const piece of [openaiCanary, anthropicCanary, openaiCanary.slice(0, 12), anthropicCanary.slice(0, 14), "sk-proj-", "sk-ant-", "sk-"]) {
      assert.equal(dumped.includes(piece), false, `canary piece leaked: ${piece}`);
    }
  }
});

test("createJobsRouter streams live 503 error detail over NDJSON and serves errorDetail on GET /:id", async (t) => {
  const openaiCanary = `sk-proj-${"RouterLiveSecretToken8".repeat(3)}`;
  const jobs = new JobRegistry();
  const http = await startJobsHttp(t, jobs);

  const message = "每日摘要未完成：OpenAI 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。";
  const detail: ApiErrorDetail = { code: "ai_key_invalid", provider: "openai", method: "openai-key" };

  let releaseFailure!: () => void;
  const view = jobs.start({ kind: "daily-brief", title: "今日摘要" }, async (emit) => {
    emit(stage("正在整理今日摘要…"));
    await new Promise<void>((resolve) => { releaseFailure = resolve; });
    throw Object.assign(new AppError(503, message, detail), {
      cause: new Error(`upstream 401 invalid_api_key ${openaiCanary}`),
    });
  });

  const liveStream = await http.get(`/api/jobs/${view.id}/events`, (event) => {
    if (event.type === "stage") releaseFailure();
  });
  assert.equal(liveStream.status, 200);
  assert.match(liveStream.contentType, /application\/x-ndjson/);
  assert.deepEqual(liveStream.events, [
    { type: "job", id: view.id },
    stage("正在整理今日摘要…"),
    { type: "error", message, detail },
  ]);

  const replayStream = await http.get(`/api/jobs/${view.id}/events?from=1`);
  assert.equal(replayStream.status, 200);
  assert.deepEqual(replayStream.events, [
    { type: "job", id: view.id },
    { type: "error", message, detail },
  ]);

  const jobRes = await http.get(`/api/jobs/${view.id}`);
  assert.equal(jobRes.status, 200);
  assert.equal(jobRes.json.status, "failed");
  assert.equal(jobRes.json.error, message);
  assert.deepEqual(jobRes.json.errorDetail, detail);

  for (const payload of [liveStream.text, replayStream.text, jobRes.text]) {
    assert.equal(payload.includes(openaiCanary), false);
    assert.equal(payload.includes("sk-"), false);
  }
});

test("createJobsRouter forwards post-retention errorDetail on GET /:id/events and GET /:id across structured 503 refusals with zero sk-* leaks", async (t) => {
  const openaiCanary = `sk-proj-${"PostRetentionOpenAiKey3".repeat(3)}`;
  const anthropicCanary = `sk-ant-api03-${"PostRetentionAnthropicKey4".repeat(3)}`;
  const retentionMs = 5;
  const jobs = new JobRegistry(retentionMs);
  const http = await startJobsHttp(t, jobs);

  const started: Array<{ id: string; message: string; detail: ApiErrorDetail }> = [];
  for (const { message, detail } of STRUCTURED_REFUSAL_CASES) {
    const view = jobs.start({ kind: "daily-brief", title: "今日摘要" }, async () => {
      throw Object.assign(new AppError(503, message, detail), {
        cause: new Error(`401 authentication_error ${openaiCanary} / ${anthropicCanary}`),
      });
    });
    started.push({ id: view.id, message, detail });
  }
  await Promise.all(started.map(({ id }) => jobs.settled(id)));
  await waitUntilAfter(Date.now() + retentionMs);

  for (const { id, message, detail } of started) {
    assert.equal(jobs.get(id), undefined, "events must be pruned before exercising post-retention router branch");
    assert.ok(jobs.outcome(id), "outcome must remain retained");

    const eventsRes = await http.get(`/api/jobs/${id}/events`);
    assert.equal(eventsRes.status, 200);
    assert.match(eventsRes.contentType, /application\/x-ndjson/);
    assert.deepEqual(eventsRes.events, [
      { type: "job", id },
      { type: "error", message, detail },
    ]);

    const viewRes = await http.get(`/api/jobs/${id}`);
    assert.equal(viewRes.status, 200);
    assert.equal(viewRes.json.status, "failed");
    assert.equal(viewRes.json.error, message);
    assert.deepEqual(viewRes.json.errorDetail, detail);

    for (const raw of [eventsRes.text, viewRes.text]) {
      for (const piece of [openaiCanary, anthropicCanary, openaiCanary.slice(0, 12), anthropicCanary.slice(0, 14), "sk-proj-", "sk-ant-", "sk-"]) {
        assert.equal(raw.includes(piece), false, `canary piece leaked over HTTP: ${piece}`);
      }
    }
  }
});

test("createJobsRouter omits detail on post-retention plain errors, bare 503 errors, cancellations, and done outcomes", async (t) => {
  const openaiCanary = `sk-proj-${"PlainPostRetentionKey6".repeat(3)}`;
  const anthropicCanary = `sk-ant-api03-${"PlainPostRetentionAntKey2".repeat(3)}`;
  const retentionMs = 5;
  const jobs = new JobRegistry(retentionMs);
  const http = await startJobsHttp(t, jobs);

  const plain = jobs.start({ kind: "mail-triage", title: "信件整理" }, async () => {
    throw new Error(`401 Incorrect API key provided: ${openaiCanary} / ${anthropicCanary}`);
  });
  const bareMessage = "每日摘要未完成：Claude Code 正在更新登入憑證，請稍後再試。";
  const bare = jobs.start({ kind: "daily-brief", title: "今日摘要" }, async () => {
    throw new TransientAgentError(bareMessage);
  });
  const cancelled = jobs.start({ kind: "daily-brief", title: "取消測試" }, (_emit, signal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new AppError(503, `Codex 授權已失效 ${openaiCanary}`, { code: "ai_auth_expired", provider: "codex", method: "chatgpt" }));
      }, { once: true });
    }),
  );
  assert.equal(jobs.cancel(cancelled.id), true);
  const done = jobs.start({ kind: "daily-brief", title: "完成測試" }, async () => ({ day: "2026-10-13" }));

  await Promise.all([jobs.settled(plain.id), jobs.settled(bare.id), jobs.settled(cancelled.id), jobs.settled(done.id)]);
  await waitUntilAfter(Date.now() + retentionMs);

  for (const { id, status, message } of [
    { id: plain.id, status: "failed", message: "這次工作沒有完成，請稍後再試。" },
    { id: bare.id, status: "failed", message: bareMessage },
    { id: cancelled.id, status: "cancelled", message: "這次工作已取消。" },
  ]) {
    assert.equal(jobs.get(id), undefined);

    const eventsRes = await http.get(`/api/jobs/${id}/events`);
    assert.equal(eventsRes.status, 200);
    assert.match(eventsRes.contentType, /application\/x-ndjson/);
    assert.deepEqual(eventsRes.events, [
      { type: "job", id },
      { type: "error", message },
    ]);
    assert.equal("detail" in eventsRes.events[1], false);

    const viewRes = await http.get(`/api/jobs/${id}`);
    assert.equal(viewRes.status, 200);
    assert.equal(viewRes.json.status, status);
    assert.equal(viewRes.json.error, message);
    assert.equal("errorDetail" in viewRes.json, false);

    for (const raw of [eventsRes.text, viewRes.text]) {
      for (const piece of [openaiCanary, anthropicCanary, "sk-proj-", "sk-ant-", "sk-"]) {
        assert.equal(raw.includes(piece), false, `canary piece leaked over HTTP: ${piece}`);
      }
    }
  }

  assert.equal(jobs.get(done.id), undefined);
  const doneEvents = await http.get(`/api/jobs/${done.id}/events`);
  assert.equal(doneEvents.status, 200);
  assert.match(doneEvents.contentType, /application\/x-ndjson/);
  assert.deepEqual(doneEvents.events, [
    { type: "job", id: done.id },
    { type: "done" },
  ]);
  assert.equal("detail" in doneEvents.events[1], false);

  const doneView = await http.get(`/api/jobs/${done.id}`);
  assert.equal(doneView.status, 200);
  assert.equal(doneView.json.status, "done");
  assert.equal("error" in doneView.json, false);
  assert.equal("errorDetail" in doneView.json, false);

  assert.equal((await http.get("/api/jobs/nonexistent/events")).status, 404);
  assert.equal((await http.get("/api/jobs/nonexistent")).status, 404);
});
