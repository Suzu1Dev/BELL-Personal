import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../errors.js";
import { runCodexTurn, turnFailure, type CodexLaunch, type CodexRpc, type CodexRpcFactory, type TurnFailure } from "./codex.js";

const ROLE = "信件整理";
const KEY_MSG = `${ROLE}未完成：OpenAI 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。`;
const AUTH_MSG = `${ROLE}未完成：Codex 授權已失效，請在伺服器重新執行 codex login。`;

test("turnFailure attaches ai_key_invalid or ai_auth_expired on 401/403/unauthorized, preserves zh-TW messages, and never leaks echoed keys", () => {
  const secretKey = `sk-proj-${"SecretKeyFragment9".repeat(3)}`;
  const authShapes: ReadonlyArray<[string, TurnFailure]> = [
    ["string unauthorized", { message: `401 Incorrect API key provided: ${secretKey}`, codexErrorInfo: "unauthorized" }],
    ["stream 401", { message: `Bearer ${secretKey} rejected`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }],
    ["http 403", { message: `key=${secretKey.slice(0, 14)}…${secretKey.slice(-6)}`, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } }],
  ];

  for (const [label, failure] of authShapes) {
    // Saved API key rejected with method omitted / null -> { code: "ai_key_invalid", provider: "openai" }
    for (const method of [undefined, null] as const) {
      const bareKeyErr = turnFailure(ROLE, failure, "failed", true, method);
      assert.ok(bareKeyErr instanceof AppError, label);
      assert.equal(bareKeyErr.status, 503, label);
      assert.equal(bareKeyErr.message, KEY_MSG, label);
      assert.deepEqual(bareKeyErr.detail, { code: "ai_key_invalid", provider: "openai" }, label);
      assert.equal("method" in (bareKeyErr.detail as Record<string, unknown>), false, label);
    }

    // Saved API key rejected with active method -> includes method
    const methodKeyErr = turnFailure(ROLE, failure, "failed", true, "openai-key");
    assert.equal(methodKeyErr.status, 503, label);
    assert.equal(methodKeyErr.message, KEY_MSG, label);
    assert.deepEqual(methodKeyErr.detail, { code: "ai_key_invalid", provider: "openai", method: "openai-key" }, label);

    // CLI login expired at runtime with method omitted / null -> { code: "ai_auth_expired", provider: "codex" }
    for (const method of [undefined, null] as const) {
      const bareAuthErr = turnFailure(ROLE, failure, "failed", false, method);
      assert.equal(bareAuthErr.status, 503, label);
      assert.equal(bareAuthErr.message, AUTH_MSG, label);
      assert.deepEqual(bareAuthErr.detail, { code: "ai_auth_expired", provider: "codex" }, label);
      assert.equal("method" in (bareAuthErr.detail as Record<string, unknown>), false, label);
    }

    // CLI login expired at runtime with active method -> includes method
    for (const method of ["chatgpt", "openai-key"] as const) {
      const methodAuthErr = turnFailure(ROLE, failure, "failed", false, method);
      assert.equal(methodAuthErr.status, 503, label);
      assert.equal(methodAuthErr.message, AUTH_MSG, label);
      assert.deepEqual(methodAuthErr.detail, { code: "ai_auth_expired", provider: "codex", method }, label);
    }

    // Never leak any part of the key in message or detail
    for (const candidate of [
      turnFailure(ROLE, failure, "failed", true, "openai-key"),
      turnFailure(ROLE, failure, "failed", false, "chatgpt"),
    ]) {
      const serialized = JSON.stringify({ message: candidate.message, detail: candidate.detail });
      for (const piece of [secretKey, secretKey.slice(0, 12), secretKey.slice(-6), "sk-proj-"]) {
        assert.equal(serialized.includes(piece), false, `${label} leaked ${piece}`);
      }
    }
  }

  // Non-503 branches remain bare (detail === undefined) and preserve exact zh-TW strings.
  const quotaErr = turnFailure(ROLE, { codexErrorInfo: "usageLimitExceeded" }, "failed", true, "openai-key");
  assert.equal(quotaErr.status, 429);
  assert.equal(quotaErr.message, `${ROLE}未完成：OpenAI 帳戶額度不足或已達上限，請到 OpenAI 平台查看用量。`);
  assert.equal(quotaErr.detail, undefined);

  const streamErr = turnFailure(ROLE, { codexErrorInfo: "httpConnectionFailed" }, "failed", false, "chatgpt");
  assert.equal(streamErr.status, 502);
  assert.equal(streamErr.message, `${ROLE}未完成：Codex 上游連線中斷或重試失敗。`);
  assert.equal(streamErr.detail, undefined);
});

test("runCodexTurn propagates structured 503 details for both terminal error events and failed turn/completed notifications", async () => {
  const secretKey = `sk-proj-${"TurnEchoSecret7".repeat(3)}`;
  const keyLaunch: CodexLaunch = {
    spawn: async () => ({ env: {}, cleanup: async () => {} }),
    config: [],
    modelProvider: "bell_openai",
    apiKey: true,
  };

  const makeFactory = (mode: "error_event" | "turn_completed", httpStatusCode: 401 | 403): CodexRpcFactory => async () => {
    let listener: ((event: { method: string; params?: Record<string, unknown> }) => void) | undefined;
    const rpc: CodexRpc = {
      cwd: "/tmp/codex-turn-test",
      async request<T>(method: string, params: any): Promise<T> {
        if (method === "config/read") return { config: {} } as T;
        if (method === "thread/start") {
          return {
            thread: { id: "th-503" },
            model: params.model || "gpt-test",
            reasoningEffort: "low",
            sandbox: { type: "readOnly", networkAccess: false },
          } as T;
        }
        if (method === "turn/start") {
          queueMicrotask(() => {
            const rawError = {
              message: `Incorrect API key provided: ${secretKey}`,
              codexErrorInfo: { httpConnectionFailed: { httpStatusCode } },
            };
            if (mode === "error_event") {
              listener?.({ method: "error", params: { threadId: "th-503", willRetry: false, error: rawError } });
            } else {
              listener?.({ method: "error", params: { threadId: "th-503", willRetry: true, error: rawError } });
              listener?.({ method: "turn/completed", params: { threadId: "th-503", turn: { status: "failed", error: rawError } } });
            }
          });
          return {} as T;
        }
        return {} as T;
      },
      subscribe(onEvent) {
        listener = onEvent;
        return () => { listener = undefined; };
      },
      async close() {},
    };
    return rpc;
  };

  const baseTurn = {
    role: ROLE,
    model: "gpt-test",
    effort: "low" as const,
    baseInstructions: "boundary",
    developerInstructions: "task",
    input: "{}",
    signal: new AbortController().signal,
  };

  // 1. Terminal error event with saved API key + openai-key method
  await assert.rejects(
    runCodexTurn(makeFactory("error_event", 401), { ...baseTurn, launch: keyLaunch, method: "openai-key" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.message, KEY_MSG);
      assert.deepEqual(error.detail, { code: "ai_key_invalid", provider: "openai", method: "openai-key" });
      assert.equal(JSON.stringify(error.detail).includes("sk-proj-"), false);
      return true;
    },
  );

  // 2. Failed turn/completed after retryable error event with CLI login + chatgpt method
  await assert.rejects(
    runCodexTurn(makeFactory("turn_completed", 403), { ...baseTurn, method: "chatgpt" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.message, AUTH_MSG);
      assert.deepEqual(error.detail, { code: "ai_auth_expired", provider: "codex", method: "chatgpt" });
      return true;
    },
  );

  // 3. No active method selected -> omits method property
  await assert.rejects(
    runCodexTurn(makeFactory("turn_completed", 401), baseTurn),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.message, AUTH_MSG);
      assert.deepEqual(error.detail, { code: "ai_auth_expired", provider: "codex" });
      assert.equal("method" in (error.detail as Record<string, unknown>), false);
      return true;
    },
  );
});
