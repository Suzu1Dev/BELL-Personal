import type { ApiErrorDetail } from "./api.js";

/** Model work that outlives its request (server/jobs.ts). Kinds are open: features add theirs here. */
export const JOB_KINDS = ["daily-brief", "mail-triage", "mail-process", "quick-capture", "capture-tidy", "event-extract", "idea-tags", "personal-bot"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ["running", "done", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobView {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  /** Latest progress, e.g. 「正在整理今日摘要…（已進行 12 秒）」. */
  stage?: string;
  message?: string;
  /** Optional id of what the job works on or produced (a day, a message id…). */
  ref?: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  errorDetail?: ApiErrorDetail;
}

/**
 * NDJSON lines of GET /api/jobs/:id/events. The first line is always
 * {type:"job"}; the stream ends after "done" or "error".
 */
export type JobEvent =
  | { type: "job"; id: string }
  | { type: "stage"; stage: string; message: string }
  | { type: "done"; result?: unknown }
  | { type: "error"; message: string; detail?: ApiErrorDetail };
