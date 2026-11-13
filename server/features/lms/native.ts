import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ASSIGNMENT_LIMITS, ASSIGNMENT_ORIGINS, NATIVE_ASSIGNMENT_SITES, SUBMISSION_STATES, UNSORTED_COURSE, nativeAssignmentId,
  type Assignment, type AssignmentMailRef, type NativeAssignmentOrigin,
} from "../../../shared/assignments.js";
import { sameAssignment } from "../../../shared/assignment-detect.js";
import type { SQLInputValue } from "node:sqlite";
import type { DocTable } from "../../db/database.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import { cachedAssignments, locallySubmitted } from "./lms.js";

/**
 * Native assignments (SPEC-mail-assignments §5.1, D5): the owner's own
 * records in personal.sqlite `local_assignments`, announced in a teacher's
 * mail (origin mail, with `mailRef`) or added on #/work (origin manual). Id
 * and Today item id `assignment:<uuid>`; `externalId` is the uuid. Deletes go
 * through the trash (刪除作業 has 復原). Mail retention, purge and disconnect
 * never touch them: they keep only ids and the Gmail link of their mail.
 */

const iso = z.string().max(40).refine((value) => !Number.isNaN(Date.parse(value)), { message: "時間格式不正確" });
const httpsUrl = z.string().max(ASSIGNMENT_LIMITS.url).refine((value) => {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}, { message: "連結必須是 https:// 開頭的網址。" });

/** The persisted record: every field of the shared Assignment (zod strips unknown keys on put); new fields stay optional. */
export const nativeAssignmentSchema: z.ZodType<Assignment> = z.object({
  id: z.string().min(1).max(100),
  origin: z.enum(ASSIGNMENT_ORIGINS),
  externalId: z.string().min(1).max(100),
  courseId: z.string().max(100).optional(),
  courseName: z.string().max(ASSIGNMENT_LIMITS.courseName),
  title: z.string().max(ASSIGNMENT_LIMITS.title),
  dueAt: iso.nullable(),
  url: httpsUrl.optional(),
  submission: z.enum(SUBMISSION_STATES),
  grade: z.string().max(100).optional(),
  description: z.string().max(2000).optional(),
  updatedAt: z.string(),
  site: z.object({ label: z.string().max(80), short: z.string().max(40) }).optional(),
  missing: z.boolean().optional(),
  dueDateOnly: z.boolean().optional(),
  submitHint: z.string().max(ASSIGNMENT_LIMITS.submitHint).optional(),
  notes: z.string().max(ASSIGNMENT_LIMITS.notes).optional(),
  mailRef: z.object({ messageId: z.string().max(200), threadId: z.string().max(200), url: z.string().max(2000) }).optional(),
  createdAt: z.string().optional(),
});

/** Index columns of `local_assignments` (migration v4). */
export function nativeColumns(assignment: Assignment): Record<string, SQLInputValue> {
  return {
    origin: assignment.origin,
    due_at: assignment.dueAt,
    source_message_id: assignment.mailRef?.messageId ?? null,
    created_at: assignment.createdAt ?? assignment.updatedAt,
  };
}

/** What a new native assignment needs; the store fills ids, site, submission and times. */
export interface NewNativeAssignment {
  origin: NativeAssignmentOrigin;
  title: string;
  courseName?: string;
  dueAt: string | null;
  dueDateOnly?: boolean;
  submitHint?: string;
  url?: string;
  notes?: string;
  mailRef?: AssignmentMailRef;
}

/** Field edits; `null` (or an empty string) clears an optional field; a cleared course is 「未分類」. */
export interface NativeAssignmentPatch {
  title?: string;
  courseName?: string | null;
  dueAt?: string | null;
  dueDateOnly?: boolean;
  submitHint?: string | null;
  url?: string | null;
  notes?: string | null;
}

const clean = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, max) : undefined;
};

/** The uuid of `assignment:<uuid>` or a bare uuid; undefined for anything else (LMS ids, junk). */
export function nativeUuid(id: string): string | undefined {
  const bare = id.startsWith("assignment:") ? id.slice("assignment:".length) : id;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bare) ? bare.toLowerCase() : undefined;
}

export class LocalAssignmentStore {
  readonly table: DocTable<Assignment>;

  constructor(private readonly ctx: Pick<ModuleContext, "db" | "trash" | "now">) {
    this.table = ctx.db.personal.docs<Assignment>({
      table: "local_assignments", label: "作業", schema: nativeAssignmentSchema, columns: nativeColumns,
    }, ctx.trash);
  }

  /** Every native assignment, due soonest first (undated last). */
  list(): Assignment[] {
    return this.table.list({ orderBy: "due_at IS NULL, due_at, created_at" });
  }

  /** By `assignment:<uuid>` or the bare uuid. */
  get(id: string, strict = false): Assignment | undefined {
    const uuid = nativeUuid(id);
    return uuid ? this.table.get(nativeAssignmentId(uuid), { strict }) : undefined;
  }

  /** Strict read for a path that writes: a missing one is a 404. */
  require(id: string): Assignment {
    const found = this.get(id, true);
    if (!found) throw new AppError(404, "找不到這份作業。");
    return found;
  }

  /** The assignment made from this Gmail message (轉成作業 makes one per mail). */
  byMessage(messageId: string): Assignment | undefined {
    return this.table.list({ where: "source_message_id = ?", params: [messageId], limit: 1 })[0];
  }

  /** Message ids that already became an assignment. */
  messageIds(): Set<string> {
    const rows = this.ctx.db.personal.db.prepare("SELECT source_message_id AS id FROM local_assignments WHERE source_message_id IS NOT NULL").all();
    return new Set(rows.map((row) => String(row.id)));
  }

  create(input: NewNativeAssignment): Assignment {
    const title = clean(input.title, ASSIGNMENT_LIMITS.title);
    if (!title) throw new AppError(400, "作業名稱不能是空白。");
    const uuid = randomUUID();
    const now = this.ctx.now().toISOString();
    const submitHint = clean(input.submitHint, ASSIGNMENT_LIMITS.submitHint);
    const notes = input.notes?.trim() ? input.notes.trim().slice(0, ASSIGNMENT_LIMITS.notes) : undefined;
    return this.table.put({
      id: nativeAssignmentId(uuid),
      origin: input.origin,
      externalId: uuid,
      courseName: clean(input.courseName, ASSIGNMENT_LIMITS.courseName) ?? UNSORTED_COURSE,
      title,
      dueAt: input.dueAt ? new Date(input.dueAt).toISOString() : null,
      submission: "not-submitted",
      site: NATIVE_ASSIGNMENT_SITES[input.origin],
      ...(input.dueAt && input.dueDateOnly ? { dueDateOnly: true } : {}),
      ...(submitHint ? { submitHint } : {}),
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      ...(notes ? { notes } : {}),
      ...(input.mailRef ? { mailRef: input.mailRef } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  update(id: string, patch: NativeAssignmentPatch): Assignment {
    const current = this.require(id);
    const next: Assignment = { ...current, updatedAt: this.ctx.now().toISOString() };
    if (patch.title !== undefined) {
      const title = clean(patch.title, ASSIGNMENT_LIMITS.title);
      if (!title) throw new AppError(400, "作業名稱不能是空白。");
      next.title = title;
    }
    if (patch.courseName !== undefined) next.courseName = clean(patch.courseName, ASSIGNMENT_LIMITS.courseName) ?? UNSORTED_COURSE;
    if (patch.dueAt !== undefined) next.dueAt = patch.dueAt ? new Date(patch.dueAt).toISOString() : null;
    if (patch.dueDateOnly !== undefined || patch.dueAt !== undefined) {
      const dateOnly = patch.dueDateOnly ?? (patch.dueAt === undefined ? current.dueDateOnly : false);
      if (next.dueAt && dateOnly) next.dueDateOnly = true;
      else delete next.dueDateOnly;
    }
    assign(next, "submitHint", patch.submitHint === undefined ? undefined : clean(patch.submitHint, ASSIGNMENT_LIMITS.submitHint) ?? null);
    assign(next, "url", patch.url === undefined ? undefined : patch.url?.trim() || null);
    assign(next, "notes", patch.notes === undefined ? undefined : patch.notes?.trim() ? patch.notes.trim().slice(0, ASSIGNMENT_LIMITS.notes) : null);
    return this.table.put(next);
  }

  /** 刪除作業: through the trash, so 復原 (POST /api/trash/restore) brings it back. */
  delete(id: string): { deleted: boolean; undoToken?: string } {
    const current = this.require(id);
    return this.table.delete(current.id);
  }

  /** Removes one an action created, without a trash copy (undo of 轉成作業 / 加入作業). */
  discard(id: string): void {
    this.ctx.db.personal.db.prepare("DELETE FROM local_assignments WHERE id = ?").run(id);
  }
}

function assign<K extends "submitHint" | "url" | "notes">(record: Assignment, key: K, value: Assignment[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null) delete record[key];
  else record[key] = value;
}

const stores = new WeakMap<object, LocalAssignmentStore>();

/** The one store for this context's personal database (the trash accepts one restorer per table). */
export function localAssignments(ctx: Pick<ModuleContext, "db" | "trash" | "now">): LocalAssignmentStore {
  let store = stores.get(ctx.db.personal);
  if (!store) {
    store = new LocalAssignmentStore(ctx);
    stores.set(ctx.db.personal, store);
  }
  return store;
}

/**
 * Native and LMS assignments together. A mail assignment that an LMS also
 * lists (same code or title, course and deadline; shared/assignment-detect
 * sameAssignment) is shown once, as the LMS row, which knows the real
 * submission state; the LMS row keeps the mail's link (`duplicates`).
 */
export interface MergedAssignments {
  lms: Assignment[];
  /** Native assignments that are not an LMS row's duplicate. */
  native: Assignment[];
  /** LMS row id → the mail assignment it stands for. */
  duplicates: Map<string, Assignment>;
}

export function mergeAssignments(lms: Assignment[], natives: Assignment[]): MergedAssignments {
  const duplicates = new Map<string, Assignment>();
  const native: Assignment[] = [];
  for (const assignment of natives) {
    const twin = assignment.origin === "mail"
      ? lms.find((row) => !duplicates.has(row.id) && sameAssignment(nativeForMatch(assignment), row))
      : undefined;
    if (twin) duplicates.set(twin.id, assignment);
    else native.push(assignment);
  }
  return { lms, native, duplicates };
}

/** A native record as the matcher reads it (「未分類」 is no course). */
const nativeForMatch = (assignment: Assignment) => ({
  title: assignment.title, dueAt: assignment.dueAt, ...(assignment.courseName !== UNSORTED_COURSE ? { courseName: assignment.courseName } : {}),
});

/** Every assignment the owner has: LMS rows from the cache plus native ones, merged. */
export function allAssignments(ctx: Pick<ModuleContext, "db" | "trash" | "now" | "sourceItems">): MergedAssignments {
  return mergeAssignments(cachedAssignments(ctx), localAssignments(ctx).list());
}

/** Whether an LMS already lists the assignment a mail announces (no suggestion then: the LMS row is enough). */
export function lmsHasAssignment(lms: Assignment[], draft: { title: string; courseName?: string; dueAt: string | null }): boolean {
  return lms.some((row) => sameAssignment(draft, row));
}

/**
 * Deadlines of native assignments in [from, to) that are still to hand in,
 * for #/calendar (agenda deadline rows): the merged list, so a mail
 * assignment E3 also lists shows once; marked 已交 ones leave.
 */
export function nativeDeadlines(ctx: Pick<ModuleContext, "db" | "trash" | "now" | "sourceItems" | "itemState">, from: string, to: string): Assignment[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  return allAssignments(ctx).native.filter((assignment) => {
    const due = assignment.dueAt ? Date.parse(assignment.dueAt) : Number.NaN;
    return due >= start && due < end && !locallySubmitted(ctx.itemState.get(assignment.id), assignment);
  });
}

/** Course names the owner already has (LMS and native), for the rule extraction's course guess. */
export function knownCourses(ctx: Pick<ModuleContext, "db" | "trash" | "now" | "sourceItems">): string[] {
  const names = new Set<string>();
  for (const assignment of [...cachedAssignments(ctx), ...localAssignments(ctx).list()])
    if (assignment.courseName && assignment.courseName !== UNSORTED_COURSE) names.add(assignment.courseName);
  return [...names];
}
