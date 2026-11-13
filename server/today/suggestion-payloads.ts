import { z } from "zod";
import { ASSIGNMENT_LIMITS } from "../../shared/assignments.js";
import type { AssignmentSuggestion } from "../../shared/suggestions.js";
import { isDayKey } from "../../shared/time.js";

/**
 * Runtime shapes of suggestion payloads that more than one module reads. The
 * core renders the `ai:` row from them and the accepting module parses them
 * again before it creates anything, so an old or malformed row is skipped,
 * never half-accepted.
 */

const iso = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), { message: "時間格式不正確" });

/** `assignment` suggestions (SPEC-mail-assignments §5.3): written by the triage hook and the rule fallback, accepted by lms. */
export const assignmentSuggestionSchema: z.ZodType<AssignmentSuggestion> = z.object({
  title: z.string().trim().min(1).max(ASSIGNMENT_LIMITS.title),
  courseName: z.string().trim().min(1).max(ASSIGNMENT_LIMITS.courseName).optional(),
  dueAt: iso.nullable(),
  dueDay: z.string().refine(isDayKey, { message: "日期格式不正確" }).optional(),
  submitHint: z.string().trim().min(1).max(ASSIGNMENT_LIMITS.submitHint).optional(),
  url: z.string().max(ASSIGNMENT_LIMITS.url).refine((value) => {
    try { return new URL(value).protocol === "https:"; } catch { return false; }
  }, { message: "連結必須是 https:// 開頭的網址" }).optional(),
  notes: z.string().max(ASSIGNMENT_LIMITS.notes).optional(),
  detectedBy: z.enum(["ai", "rule"]).optional(),
});
