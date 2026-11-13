import test from "node:test";
import assert from "node:assert/strict";
import type { AiConnectionMethod, AiNotReadyReason } from "../../shared/ai-connections.js";
import type { ModelCatalog } from "../../shared/models.js";
import { AppDatabase } from "../db/database.js";
import { SETTINGS_MIGRATIONS } from "../db/schema.js";
import { AppError } from "../errors.js";
import { keyNotReady, loginError } from "./connection-runtime.js";
import { ProviderService, ProviderSettingsStore } from "./provider-settings.js";

function memoryStore(t: test.TestContext): ProviderSettingsStore {
  const db = new AppDatabase({ path: ":memory:", name: "設定", migrations: SETTINGS_MIGRATIONS });
  t.after(() => db.close());
  return new ProviderSettingsStore(db);
}

const READY_CODEX_CATALOG: ModelCatalog = {
  source: "codex",
  models: [{ id: "gpt-5.5", name: "GPT-5.5", description: "Test model", isDefault: true, reasoningEfforts: ["low", "medium"], defaultReasoningEffort: "low" }],
};

test("ProviderService.update preserves 503 AppError detail from ready() and catalog(), while catalog() exposes structured notReady without top-level detail", async (t) => {
  const store = memoryStore(t);
  let active: AiConnectionMethod | null = "chatgpt";
  const detail = { code: "ai_connection_not_ready", method: "chatgpt", reason: "cli_not_installed" } as const;
  const message = "無法使用 Codex：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。";

  // 1. 503 AppError detail thrown inside catalog() / loadCodexCatalog() exposes notReady on catalog() and preserves detail on update().
  const fromCatalog = new ProviderService(
    store,
    async () => { throw new AppError(503, message, detail); },
    () => active,
  );
  const listed = await fromCatalog.catalog("codex");
  assert.deepEqual(listed, { source: "codex", models: [], error: message, notReady: { method: "chatgpt", reason: "cli_not_installed" } });
  assert.deepEqual(Object.keys(listed).sort(), ["error", "models", "notReady", "source"]);

  await assert.rejects(
    fromCatalog.update({ model: "gpt-5.5" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.message, message);
      assert.deepEqual(error.detail, detail);
      return true;
    },
  );
  assert.equal(store.get().model, "sonnet", "refused update never persists");

  // 2. 503 AppError detail thrown from setReadyCheck() is preserved for static-catalog Claude too, while Claude catalog omits notReady.
  active = "claude";
  const claudeDetail = { code: "ai_connection_not_ready", method: "claude", reason: "not_signed_in" } as const;
  const claudeMessage = "無法使用 Claude Code：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。";
  fromCatalog.setReadyCheck(async () => {
    throw new AppError(503, claudeMessage, claudeDetail);
  });
  const claudeCatalog = await fromCatalog.catalog("claude");
  assert.equal("notReady" in claudeCatalog, false);
  assert.equal(claudeCatalog.error, undefined);
  await assert.rejects(
    fromCatalog.update({ model: "haiku" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.message, claudeMessage);
      assert.deepEqual(error.detail, claudeDetail);
      return true;
    },
  );
  assert.equal(store.get().model, "sonnet");

  // 3. No active connection (null): 503 catalog error stays bare (detail === undefined, notReady omitted).
  active = null;
  const bare = new ProviderService(
    store,
    async () => ({ source: "codex", models: [], error: "尚未登入 Codex。請在伺服器終端機執行 codex login，完成後重新整理。" }),
    () => active,
  );
  const bareCatalog = await bare.catalog("codex");
  assert.equal("notReady" in bareCatalog, false);
  await assert.rejects(
    bare.update({ provider: "codex" }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 503);
      assert.equal(error.detail, undefined);
      return true;
    },
  );
});

test("ModelCatalog.notReady covers chatgpt and openai-key readiness failures across fresh, pending, cached, and invalidated reads", async (t) => {
  const store = memoryStore(t);
  let active: AiConnectionMethod | null = "chatgpt";
  let readyError: unknown = undefined;
  let readyCalls = 0;
  let codexLoads = 0;

  const service = new ProviderService(
    store,
    async () => {
      codexLoads++;
      return structuredClone(READY_CODEX_CATALOG);
    },
    () => active,
    async () => {
      readyCalls++;
      if (readyError) throw readyError;
    },
  );

  const cases: ReadonlyArray<{ method: "chatgpt" | "openai-key"; reason: AiNotReadyReason; error: AppError }> = [
    {
      method: "chatgpt",
      reason: "not_signed_in",
      error: loginError({ provider: "codex", method: "chatgpt", home: "shared", expect: "subscription" }, undefined),
    },
    {
      method: "chatgpt",
      reason: "wrong_login",
      error: loginError({ provider: "codex", method: "chatgpt", home: "shared", expect: "subscription" }, "api_key"),
    },
    {
      method: "chatgpt",
      reason: "cli_not_installed",
      error: new AppError(
        503,
        loginError({ provider: "codex", method: "chatgpt", home: "shared", expect: "subscription" }, undefined).message,
        { code: "ai_connection_not_ready", method: "chatgpt", reason: "cli_not_installed" },
      ),
    },
    {
      method: "openai-key",
      reason: "key_missing",
      error: keyNotReady("openai-key", "key_missing"),
    },
    {
      method: "openai-key",
      reason: "key_unreadable",
      error: keyNotReady("openai-key", "key_unreadable"),
    },
    {
      method: "openai-key",
      reason: "vault_disabled",
      error: keyNotReady("openai-key", "vault_disabled"),
    },
  ];

  for (const { method, reason, error } of cases) {
    active = method;
    readyError = error;
    readyCalls = 0;
    codexLoads = 0;
    service.invalidate();

    // Concurrent fresh + pending reads via catalog() and snapshot() share one load and clone notReady independently.
    const [fresh, pendingCatalog, pendingSnapshot] = await Promise.all([
      service.catalog("codex"),
      service.catalog("codex"),
      service.snapshot(),
    ]);
    assert.equal(readyCalls, 1, `${method}/${reason}: concurrent reads share one ready() check`);
    assert.equal(codexLoads, 0, `${method}/${reason}: loadCodexCatalog never runs when ready() fails`);

    const expected: ModelCatalog = {
      source: "codex",
      models: [],
      error: error.message,
      notReady: { method, reason },
    };
    assert.deepEqual(fresh, expected);
    assert.deepEqual(pendingCatalog, expected);
    assert.deepEqual(pendingSnapshot.catalogs.find((c) => c.source === "codex"), expected);

    // Claude in the same snapshot omits notReady.
    const claudeInSnapshot = pendingSnapshot.catalogs.find((c) => c.source === "claude")!;
    assert.equal("notReady" in claudeInSnapshot, false);

    // Mutating returned notReady objects never mutates the cached entry (structuredClone guard).
    (fresh.notReady as { reason: string }).reason = "pending";
    (pendingCatalog.notReady as { method: string }).method = "claude";

    // Cached reads via catalog() and snapshot() preserve the unmutated notReady without re-running ready().
    const cachedCatalog = await service.catalog("codex");
    const cachedSnapshot = await service.snapshot();
    assert.equal(readyCalls, 1, `${method}/${reason}: cached reads do not re-run ready()`);
    assert.deepEqual(cachedCatalog, expected);
    assert.deepEqual(cachedSnapshot.catalogs.find((c) => c.source === "codex"), expected);
  }

  // invalidate() clears cached notReady so a newly ready Codex connection returns models without notReady.
  active = "openai-key";
  readyError = undefined;
  service.invalidate();
  const recovered = await service.snapshot();
  const codexAfterInvalidate = recovered.catalogs.find((c) => c.source === "codex")!;
  assert.deepEqual(codexAfterInvalidate, READY_CODEX_CATALOG);
  assert.equal("notReady" in codexAfterInvalidate, false);
  assert.equal(codexLoads, 1);
});

test("ModelCatalog omits notReady on claude, ready codex, connection === null, and generic failures", async (t) => {
  const store = memoryStore(t);
  let active: AiConnectionMethod | null = null;
  let readyError: unknown = undefined;
  let loaderResult: () => Promise<ModelCatalog> = async () => structuredClone(READY_CODEX_CATALOG);

  const service = new ProviderService(
    store,
    () => loaderResult(),
    () => active,
    async () => {
      if (readyError) throw readyError;
    },
  );

  // 1. claude and ready codex omit notReady.
  active = "chatgpt";
  const readySnap = await service.snapshot();
  for (const catalog of readySnap.catalogs) {
    assert.equal("notReady" in catalog, false, `${catalog.source} omits notReady when ready`);
    assert.ok(catalog.models.length > 0);
  }

  // 2. connection === null: bare 503 loginError (detail === undefined) omits notReady.
  active = null;
  readyError = loginError({ provider: "codex", method: null, home: "shared" }, undefined);
  service.invalidate();
  const nullReady503 = await service.catalog("codex");
  assert.deepEqual(nullReady503, {
    source: "codex",
    models: [],
    error: "無法使用 Codex：請在伺服器的終端機執行 codex login。",
  });
  assert.equal("notReady" in nullReady503, false);

  // 3. Generic thrown Error omits notReady and uses default zh-TW fallback error.
  active = "chatgpt";
  readyError = undefined;
  loaderResult = async () => { throw new Error("spawn ECONNRESET"); };
  service.invalidate();
  const genericThrown = await service.catalog("codex");
  assert.deepEqual(genericThrown, {
    source: "codex",
    models: [],
    error: "暫時無法讀取 Codex 模型清單。請確認已在伺服器執行 codex login，稍後再重新整理。",
  });
  assert.equal("notReady" in genericThrown, false);

  // 4. Bare 503 AppError (no detail) and non-503 AppError omit notReady.
  loaderResult = async () => { throw new AppError(503, "Codex 暫時忙碌，請稍後再試。"); };
  service.invalidate();
  const bare503 = await service.catalog("codex");
  assert.deepEqual(bare503, { source: "codex", models: [], error: "Codex 暫時忙碌，請稍後再試。" });
  assert.equal("notReady" in bare503, false);

  loaderResult = async () => { throw new AppError(502, "Codex 回傳格式不正確。", { code: "ai_key_invalid" }); };
  service.invalidate();
  const non503 = await service.catalog("codex");
  assert.deepEqual(non503, { source: "codex", models: [], error: "Codex 回傳格式不正確。" });
  assert.equal("notReady" in non503, false);

  // 5. 503 AppError with a non-ai_connection_not_ready detail omits notReady while preserving detail for update().
  loaderResult = async () => { throw new AppError(503, "金鑰無效。", { code: "ai_key_invalid" }); };
  service.invalidate();
  const otherDetail = await service.catalog("codex");
  assert.deepEqual(otherDetail, { source: "codex", models: [], error: "金鑰無效。" });
  assert.equal("notReady" in otherDetail, false);
});
