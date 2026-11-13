import test from "node:test";
import assert from "node:assert/strict";
import type { AiConnection } from "../../../shared/ai-connections";
import { isExpiredPrompt, keyErrorForStatus, loginFailureKind, shouldClearKey } from "./ai-connect-model";

const prompt = { kind: "device_code" as const, url: "https://auth.openai.com/codex/device", code: "K7QF-2M9X", expiresAt: "2026-11-10T00:15:00.000Z" };

test("device-code expiry comes from expiresAt, not an error sentence", () => {
  assert.equal(isExpiredPrompt(prompt, Date.parse("2026-11-10T00:14:59.000Z")), false);
  assert.equal(isExpiredPrompt(prompt, Date.parse("2026-11-10T00:15:00.000Z")), true);
  assert.equal(isExpiredPrompt(undefined), false);
});

test("login failures keep the backend's stable reason, including rejected codes", () => {
  const connection = (failure?: AiConnection["failure"]): AiConnection => ({ method: "claude", cli: "claude", installed: true, state: "failed", failure });
  for (const failure of ["denied", "code_rejected", "timed_out", "cli_error"] as const) {
    assert.equal(loginFailureKind(connection(failure), prompt), failure);
  }
  assert.equal(loginFailureKind(connection(), prompt, Date.parse("2026-11-10T00:15:00.000Z")), "timed_out");
  assert.equal(loginFailureKind(connection(), prompt, Date.parse("2026-11-10T00:14:59.000Z")), "unknown");
  assert.equal(loginFailureKind(undefined, prompt), undefined);
});

test("key failures use fixed codes and readiness reasons, never server text", () => {
  assert.equal(keyErrorForStatus(0), "network");
  assert.equal(keyErrorForStatus(502), "network");
  assert.equal(keyErrorForStatus(400), "invalid");
  assert.equal(keyErrorForStatus(422, "ai_key_invalid"), "invalid");
  assert.equal(keyErrorForStatus(422, "ai_key_no_credit"), "credit");
  assert.equal(keyErrorForStatus(503, undefined, "vault_disabled"), "vault");
  assert.equal(keyErrorForStatus(422, "ai_key_invalid", "vault_disabled"), "vault");
});

test("only network and vault failures clear the key; invalid and credit keep it", () => {
  assert.equal(shouldClearKey("network"), true);
  assert.equal(shouldClearKey("vault"), true);
  assert.equal(shouldClearKey("invalid"), false);
  assert.equal(shouldClearKey("credit"), false);
});
