import type { AiConnection, AiLoginFailure, AiLoginPrompt, AiNotReadyReason } from "../../../shared/ai-connections";
import type { ApiErrorCode } from "../../../shared/api";

export type KeyError = "invalid" | "network" | "credit" | "vault" | null;

export function isExpiredPrompt(prompt: AiLoginPrompt | undefined, now = Date.now()): boolean {
  return !!prompt && Date.parse(prompt.expiresAt) <= now;
}

export function loginFailureKind(connection: AiConnection | undefined, prompt: AiLoginPrompt | undefined, now = Date.now()): AiLoginFailure | "unknown" | undefined {
  if (connection?.state !== "failed") return undefined;
  if (connection.failure) return connection.failure;
  return isExpiredPrompt(prompt, now) ? "timed_out" : "unknown";
}

export function keyErrorForStatus(status: number, code?: ApiErrorCode, reason?: AiNotReadyReason): Exclude<KeyError, null> {
  if (reason === "vault_disabled") return "vault";
  if (code === "ai_key_no_credit") return "credit";
  if (code === "ai_key_invalid" || (status >= 400 && status < 500)) return "invalid";
  return "network";
}

export function shouldClearKey(error: Exclude<KeyError, null>): boolean {
  return error === "network" || error === "vault";
}
