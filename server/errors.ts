import type { ApiErrorDetail } from "../shared/api.js";
import { logEvent } from "./log.js";

/**
 * A failure whose message is safe to show the user (Traditional Chinese, no
 * secrets, no paths). `detail` (fixed codes and names only) is added to the
 * error body for refusals the UI handles itself (shared/api.ts ApiErrorDetail).
 */
export class AppError extends Error {
  constructor(public status: number, message: string, readonly detail?: ApiErrorDetail) { super(message); this.name = "AppError"; }
}
/** A model call that could not run right now for a reason that clears by itself (a CLI refreshing its login): 503, but not "not logged in". */
export class TransientAgentError extends AppError {
  constructor(message: string) { super(503, message); this.name = "TransientAgentError"; }
}
export interface ValidationIssue { path: string; code: string; }
/** A model reply that failed validation. Issues keep field paths and codes only, never values. */
export class SchemaValidationError extends AppError {
  constructor(message: string, readonly stage: string, readonly issues: ValidationIssue[]) { super(502, message); this.name = "SchemaValidationError"; }
}
export function schemaFailure(stage: string, message: string, error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }> }): SchemaValidationError {
  const issues = error.issues.slice(0, 20).map(issue => ({ path: issue.path.map(String).join("."), code: issue.code }));
  logEvent("schema.invalid", { stage, issues, total: error.issues.length });
  return new SchemaValidationError(message, stage, issues);
}
/** The message a client may see for any thrown value. */
export function publicError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "這次工作已取消。";
  if (error instanceof Error && error.name === "TimeoutError") return "等待來源或模型回應超過時間，請稍後重試。";
  return "這次工作沒有完成，請稍後再試。";
}
/** Structured refusal detail a client may see for a thrown AppError (fixed codes/enums only, never raw text or secrets). */
export function publicErrorDetail(error: unknown): ApiErrorDetail | undefined {
  return error instanceof AppError && error.detail !== undefined ? error.detail : undefined;
}
