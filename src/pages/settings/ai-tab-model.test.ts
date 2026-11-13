import assert from "node:assert/strict";
import test from "node:test";
import { AI_NOT_READY_REASONS, type AiConnection, type AiConnectionMethod, type AiNotReadyReason } from "../../../shared/ai-connections";
import { onboardingCopy } from "../../copy/onboarding";
import { connectionAction, connectionMeta, connectionReason, effortDefaultLabel, modelSelectionDisabled, nextRadioIndex, savedKeyMeta } from "./ai-tab-model";

const copy = onboardingCopy();
const row = (method: AiConnectionMethod, reason: AiNotReadyReason): AiConnection => ({ method, cli: method === "claude" || method === "anthropic-key" ? "claude" : "codex", installed: reason !== "cli_not_installed", state: "failed", reason, message: "SERVER TEXT MUST NOT WIN" });

test("every not-ready reason has local copy and a safe recovery action", () => {
  const cases: Array<[AiConnectionMethod, AiNotReadyReason, string, string | null]> = [
    ["chatgpt", "cli_not_installed", "這台電腦還沒有安裝 Codex", null],
    ["chatgpt", "pending", copy.settings.pending, null],
    ["chatgpt", "not_signed_in", copy.settings.notSignedIn, copy.settings.signIn],
    ["chatgpt", "wrong_login", copy.settings.wrongLogin, copy.settings.signIn],
    ["openai-key", "key_missing", copy.settings.keyNone, copy.settings.add],
    ["openai-key", "key_unreadable", copy.settings.keyUnreadable, copy.settings.replace],
    ["openai-key", "vault_disabled", copy.settings.vaultDisabled, null],
  ];
  assert.deepEqual(cases.map(([, reason]) => reason), [...AI_NOT_READY_REASONS]);
  for (const [method, reason, meta, action] of cases) {
    const connection = row(method, reason);
    assert.equal(connectionMeta(copy, connection, reason), meta);
    assert.equal(connectionAction(copy, connection, reason)?.label ?? null, action);
    assert.ok(!connectionMeta(copy, connection, reason).includes("SERVER TEXT"));
  }
});

test("the active /api/status reason overrides a stale row reason", () => {
  const connection = row("openai-key", "key_missing");
  const active = { method: "openai-key" as const, ready: false as const, reason: "key_unreadable" as const, message: "ignored" };
  assert.equal(connectionReason(connection, active), "key_unreadable");
  assert.equal(connectionAction(copy, connection, connectionReason(connection, active))?.label, copy.settings.replace);
});

test("saved-key rows show only the masked hint and verification date", () => {
  const savedKey = { provider: "openai" as const, hint: "••••Xq7M", verifiedAt: "2026-11-09T12:00:00.000Z" };
  const meta = savedKeyMeta(copy, savedKey);
  assert.ok(meta.includes("••••Xq7M"));
  assert.ok(meta.includes("驗證"));
  assert.equal(savedKeyMeta(copy, savedKey, "zh-TW"), "••••Xq7M · 11月9日 驗證");
  assert.equal(savedKeyMeta(copy, savedKey, "en"), "••••Xq7M · Nov 9 驗證");
  assert.equal(savedKeyMeta(copy, { provider: "openai", hint: "••••Xq7M", verifiedAt: null }), "••••Xq7M");
  assert.equal(savedKeyMeta(copy, { provider: "openai", hint: null, verifiedAt: null }), copy.ai.signedIn);
});

test("Settings radios wrap in both directions and support Home and End", () => {
  assert.equal(nextRadioIndex(4, 3, "ArrowDown"), 0);
  assert.equal(nextRadioIndex(4, 0, "ArrowUp"), 3);
  assert.equal(nextRadioIndex(4, 1, "ArrowRight"), 2);
  assert.equal(nextRadioIndex(4, 1, "ArrowLeft"), 0);
  assert.equal(nextRadioIndex(4, 1, "Home"), 0);
  assert.equal(nextRadioIndex(4, 1, "End"), 3);
  assert.equal(nextRadioIndex(4, 1, "Enter"), -1);
});

test("model selection requires an actually ready active connection", () => {
  assert.equal(modelSelectionDisabled({ method: "chatgpt", ready: true, source: "cli" }), false);
  assert.equal(modelSelectionDisabled(null), true);
  assert.equal(modelSelectionDisabled(undefined), true);
  for (const reason of AI_NOT_READY_REASONS) assert.equal(modelSelectionDisabled({ method: "openai-key", ready: false, reason, message: "ignored" }), true);
});

test("default effort labels use the model level once, with a neutral fallback", () => {
  assert.equal(effortDefaultLabel(copy, "low"), "低（預設）");
  assert.equal(effortDefaultLabel(copy, "medium"), "中（預設）");
  assert.equal(effortDefaultLabel(copy), "預設");
});
