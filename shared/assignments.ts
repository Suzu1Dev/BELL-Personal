import type { SourceStatus } from "./sources.js";
import type { QueueAction } from "./today.js";

/**
 * Where an assignment comes from: an LMS sync (moodle, canvas; cached in
 * source_items) or the owner (mail: announced in a teacher's mail, manual:
 * added on #/work; native records in personal.sqlite local_assignments,
 * SPEC-mail-assignments §5).
 */
export const ASSIGNMENT_ORIGINS = ["moodle", "canvas", "mail", "manual"] as const;
export type AssignmentOrigin = (typeof ASSIGNMENT_ORIGINS)[number];

/** The LMS connections (sources with a token, a sync and a site). */
export const LMS_ORIGINS = ["moodle", "canvas"] as const;
export type LmsOrigin = (typeof LMS_ORIGINS)[number];

/** Native assignments: the owner's own records, editable and deletable on #/work. */
export const NATIVE_ASSIGNMENT_ORIGINS = ["mail", "manual"] as const;
export type NativeAssignmentOrigin = (typeof NATIVE_ASSIGNMENT_ORIGINS)[number];

export const isNativeOrigin = (origin: AssignmentOrigin): origin is NativeAssignmentOrigin => origin === "mail" || origin === "manual";

/** The queue source of native assignments: their Today item id and their `id` are `assignment:<uuid>`. */
export const NATIVE_ASSIGNMENT_SOURCE = "assignment";
export const nativeAssignmentId = (uuid: string) => `${NATIVE_ASSIGNMENT_SOURCE}:${uuid}`;

export const SUBMISSION_STATES = ["not-submitted", "submitted", "graded", "unknown"] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** Which LMS site an assignment came from, for meta lines and buttons. */
export interface AssignmentSite {
  /** Meta label: 「NYCU E3」, 「NTU COOL」, the Moodle site name… */
  label: string;
  /** Button and chip label: 「E3」 (開啟 E3), 「Canvas」. */
  short: string;
}

/** The mail a native assignment came from: 開啟信件 opens `#/inbox/<threadId>`. Ids and a link only, never mail text. */
export interface AssignmentMailRef {
  messageId: string;
  threadId: string;
  /** The Gmail web link of the conversation. */
  url: string;
}

/** A school assignment normalised from Moodle or Canvas, or a native one (mail, manual). */
export interface Assignment {
  /** LMS: "<origin>:<external id>". Native: "assignment:<uuid>", which is also its Today item id. */
  id: string;
  origin: AssignmentOrigin;
  /** LMS: the site's id. Native: the uuid (`:id` in /api/lms/assignments/:id). */
  externalId: string;
  courseId?: string;
  courseName: string;
  title: string;
  /** ISO instant; null when the course gives no deadline. */
  dueAt: string | null;
  url?: string;
  submission: SubmissionState;
  grade?: string;
  /** Plain text, truncated; never HTML. */
  description?: string;
  updatedAt: string;
  /** The site it came from (absent on rows written before the work module existed). */
  site?: AssignmentSite;
  /** Canvas missing_submissions: past due and not handed in. */
  missing?: boolean;
  /* ---- native assignments (origin mail or manual); all optional ---- */
  /** The deadline was given as a date only: dueAt is 23:59 local that day. */
  dueDateOnly?: boolean;
  /** 「上傳到 E3」「紙本交到系辦」. */
  submitHint?: string;
  /** Plain-text notes the owner wrote. */
  notes?: string;
  /** origin mail: the conversation it was announced in. */
  mailRef?: AssignmentMailRef;
  createdAt?: string;
}

/** Site labels for native assignments (meta lines, chips): 「信件」 and 「手動」. */
export const NATIVE_ASSIGNMENT_SITES: Record<NativeAssignmentOrigin, AssignmentSite> = {
  mail: { label: "信件", short: "信件" },
  manual: { label: "手動", short: "手動" },
};

/** Field limits for native assignments (POST/PATCH /api/lms/assignments). */
export const ASSIGNMENT_LIMITS = { title: 200, courseName: 80, submitHint: 120, notes: 2000, url: 2000 } as const;

/** The course of a native assignment nobody named (SPEC-mail-assignments §5.1): its #/work group sorts last. */
export const UNSORTED_COURSE = "未分類";

/**
 * What #/work shows for an assignment (SPEC-ux §3.3 status pills):
 * open 未繳交 · overdue 逾期 · local 已交（本機） (標為已交 while the LMS still
 * says not submitted) · submitted 已繳交 · graded 已評分. A native assignment
 * marked 標為已交 is `submitted` (no LMS can disagree; SPEC-mail-assignments D7).
 */
export const ASSIGNMENT_STATUSES = ["open", "overdue", "local", "submitted", "graded"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

/** GET /api/lms/assignments row. */
export interface AssignmentView extends Assignment {
  /** The Today queue id (`moodle:<id>`, or `assignment:<uuid>` for native rows), for POST /api/actions. */
  itemId: string;
  status: AssignmentStatus;
  /** When 標為已交 was pressed (status local, or submitted for a native row). */
  localSubmittedAt?: string;
  /**
   * Mail rows: who sent the announcement (「林志明 教授」), read from the mail
   * cache while the message is still there; never stored with the assignment.
   * An LMS row a teacher's mail also announced carries that mail's `mailRef`.
   */
  mailSender?: string;
}

/** One LMS connection as #/work and 連線與設定 show it. Never carries the token. */
export interface LmsAccountView {
  source: LmsOrigin;
  connected: boolean;
  /** 「E3」, 「Canvas」. */
  short: string;
  /** 「NYCU E3」. */
  siteLabel: string;
  baseUrl?: string;
  account?: { name?: string; username?: string; siteName?: string };
  connectedAt?: string;
  status: SourceStatus;
}

/** GET /api/lms */
export interface LmsStatusResponse {
  accounts: LmsAccountView[];
}

/** A pending `assignment` suggestion as #/work's 「從信件找到」 card shows it (the same `.q-row.is-ai` as Today). */
export interface AssignmentSuggestionRow {
  /** `ai:<suggestion id>`, for POST /api/actions (加入作業 / 略過). */
  itemId: string;
  title: string;
  meta: string[];
  actions: QueueAction[];
  /** The mail it came from (Gmail link). */
  url?: string;
}

/** GET /api/lms/assignments: LMS and native assignments, due soonest first. */
export interface AssignmentsResponse {
  accounts: LmsAccountView[];
  assignments: AssignmentView[];
  /** Pending assignment suggestions found in mail (absent from servers before SPEC-mail-assignments). */
  suggestions?: AssignmentSuggestionRow[];
}

/** POST /api/lms/assignments (新增作業 on #/work) → 201 AssignmentView (origin manual, or mail with mailRef). */
export interface AssignmentCreateRequest {
  title: string;
  courseName?: string;
  /** ISO instant; null or absent = no deadline. */
  dueAt?: string | null;
  dueDateOnly?: boolean;
  submitHint?: string;
  url?: string;
  notes?: string;
}

/** PATCH /api/lms/assignments/:id (native only; LMS rows answer 409) → AssignmentView. Any subset. */
export type AssignmentUpdateRequest = Partial<AssignmentCreateRequest>;

/** DELETE /api/lms/assignments/:id (native only) → the trash token for 復原 (POST /api/trash/restore). */
export interface AssignmentDeleteResponse {
  deleted: true;
  undoToken?: string;
}
