import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SOURCE_IDS } from "../../../shared/sources.js";
import { dayBounds, isDayKey, isLocalTime, type DayKey } from "../../../shared/time.js";
import {
  TODO_ESTIMATE_MAX_MINUTES, TODO_LIMITS, TODO_ORIGINS, TODO_PRIORITIES, TODO_STATUSES, type Todo, type TodoOrigin, type TodoPriority,
} from "../../../shared/todos.js";
import type { SourceRef } from "../../../shared/sources.js";
import type { DocTable } from "../../db/database.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";

const dayKeySchema = z.string().refine(isDayKey, { message: "日期格式不正確" });
const timeSchema = z.string().refine(isLocalTime, { message: "時間格式不正確" });

/** The persisted Todo: every field of the shared type (zod strips unknown keys on put). New fields stay optional. */
export const todoSchema: z.ZodType<Todo> = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(TODO_LIMITS.title),
  notes: z.string().max(TODO_LIMITS.notes).optional(),
  status: z.enum(TODO_STATUSES),
  priority: z.enum(TODO_PRIORITIES),
  dueDay: dayKeySchema.optional(),
  dueTime: timeSchema.optional(),
  projectId: z.string().max(100).optional(),
  estimateMinutes: z.number().int().positive().max(TODO_ESTIMATE_MAX_MINUTES).optional(),
  origin: z.enum(TODO_ORIGINS),
  sourceRef: z.object({ source: z.enum(SOURCE_IDS), externalId: z.string().max(500), url: z.string().max(2000).optional() }).optional(),
  originalText: z.string().max(TODO_LIMITS.originalText).optional(),
  tidiedAt: z.string().optional(),
  pretidy: z.object({ title: z.string().max(TODO_LIMITS.title), notes: z.string().max(TODO_LIMITS.notes).optional() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

export interface NewTodo {
  title: string;
  notes?: string;
  dueDay?: DayKey;
  dueTime?: string;
  priority?: TodoPriority;
  projectId?: string;
  estimateMinutes?: number;
  origin: TodoOrigin;
  sourceRef?: SourceRef;
  /** Quick capture: the sentence the title was read from. */
  originalText?: string;
}

/** Field edits; `null` clears an optional field. */
export interface TodoPatch {
  title?: string;
  notes?: string | null;
  dueDay?: DayKey | null;
  dueTime?: string | null;
  priority?: TodoPriority;
  projectId?: string | null;
  estimateMinutes?: number | null;
}

/**
 * personal.sqlite `todos`. One instance per database (the todos and capture
 * modules share it through `todoStore(ctx)`: the trash accepts one restorer
 * per table). Deletes go through the trash so 復原 can bring a todo back.
 */
export class TodoStore {
  readonly table: DocTable<Todo>;

  constructor(private readonly ctx: Pick<ModuleContext, "db" | "trash" | "now" | "config">) {
    this.table = ctx.db.personal.docs<Todo>({
      table: "todos",
      label: "待辦",
      schema: todoSchema,
      columns: (todo) => ({ status: todo.status, due_day: todo.dueDay ?? null, project_id: todo.projectId ?? null, created_at: todo.createdAt }),
    }, ctx.trash);
  }

  get(id: string, strict = false): Todo | undefined {
    return this.table.get(id, { strict });
  }

  /** Strict read for a path that writes: a missing todo is a 404. */
  require(id: string): Todo {
    const todo = this.table.get(id, { strict: true });
    if (!todo) throw new AppError(404, "找不到這項待辦，可能已經刪除了。");
    return todo;
  }

  /** Open todos: dated ones by day and time, then the undated ones, oldest first. */
  open(): Todo[] {
    return sortTodos(this.table.list({ where: "status = ?", params: ["open"], orderBy: "created_at" }));
  }

  /** Finished on `day` (local), newest first. */
  completedOn(day: DayKey): Todo[] {
    const { start, end } = dayBounds(this.ctx.config.timeZone, day);
    return this.table.list({ where: "status = ?", params: ["done"], orderBy: "updated_at DESC", limit: 500 })
      .filter((todo) => todo.completedAt !== undefined && todo.completedAt >= start && todo.completedAt < end)
      .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  }

  /** Every todo whose title or notes contain `query` (case-insensitive), open first. */
  search(query: string, limit: number): Todo[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.table.list({ orderBy: "status = 'done', updated_at DESC", limit: 2000 })
      .filter((todo) => todo.title.toLowerCase().includes(needle) || (todo.notes ?? "").toLowerCase().includes(needle))
      .slice(0, limit);
  }

  /** The open todo already made from this source item (轉待辦 twice makes one todo). */
  findBySource(ref: SourceRef): Todo | undefined {
    return this.table.list({ where: "status = ?", params: ["open"], limit: 2000 })
      .find((todo) => todo.sourceRef?.source === ref.source && todo.sourceRef.externalId === ref.externalId);
  }

  create(input: NewTodo): Todo {
    if (input.dueTime && !input.dueDay) throw new AppError(400, "有時間的待辦也需要日期。");
    const now = this.ctx.now().toISOString();
    return this.table.put(validDue({
      id: randomUUID(),
      title: input.title.trim().slice(0, TODO_LIMITS.title),
      status: "open",
      priority: input.priority ?? "normal",
      origin: input.origin,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.dueDay ? { dueDay: input.dueDay } : {}),
      ...(input.dueDay && input.dueTime ? { dueTime: input.dueTime } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.estimateMinutes ? { estimateMinutes: input.estimateMinutes } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.originalText ? { originalText: input.originalText.slice(0, TODO_LIMITS.originalText) } : {}),
      createdAt: now,
      updatedAt: now,
    }));
  }

  update(id: string, patch: TodoPatch): Todo {
    const current = this.require(id);
    const next: Todo = { ...current, updatedAt: this.ctx.now().toISOString() };
    if (patch.title !== undefined) next.title = patch.title.trim();
    // The user's own wording wins over 自動整理: a new title makes the typed sentence stale (整理 then reads
    // the title and notes), and a new title or notes ends 復原整理 (it would overwrite the edit).
    if (next.title !== current.title) delete next.originalText;
    if (next.title !== current.title || (patch.notes !== undefined && (patch.notes || undefined) !== current.notes)) delete next.pretidy;
    if (patch.priority !== undefined) next.priority = patch.priority;
    assignOptional(next, "notes", patch.notes);
    assignOptional(next, "dueDay", patch.dueDay);
    assignOptional(next, "dueTime", patch.dueTime);
    assignOptional(next, "projectId", patch.projectId);
    assignOptional(next, "estimateMinutes", patch.estimateMinutes);
    if (!next.dueDay) delete next.dueTime;
    return this.table.put(validDue(next));
  }

  complete(id: string): Todo {
    const current = this.require(id);
    if (current.status === "done") return current;
    const now = this.ctx.now().toISOString();
    return this.table.put({ ...current, status: "done", completedAt: now, updatedAt: now });
  }

  reopen(id: string): Todo {
    const current = this.require(id);
    if (current.status === "open") return current;
    const { completedAt: _completedAt, ...rest } = current;
    return this.table.put({ ...rest, status: "open", updatedAt: this.ctx.now().toISOString() });
  }

  delete(id: string): { deleted: boolean; undoToken?: string } {
    this.require(id);
    return this.table.delete(id);
  }

  /** Removes a todo an action created, without a trash copy (undo of 轉待辦 / 加入待辦 / a capture). */
  discard(id: string): void {
    this.ctx.db.personal.db.prepare("DELETE FROM todos WHERE id = ?").run(id);
  }
}

function assignOptional<K extends "notes" | "dueDay" | "dueTime" | "projectId" | "estimateMinutes">(todo: Todo, key: K, value: Todo[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") delete todo[key];
  else todo[key] = value;
}

function validDue(todo: Todo): Todo {
  if (todo.dueTime && !todo.dueDay) throw new AppError(400, "有時間的待辦也需要日期。");
  return todo;
}

/** Dated first (day, then time; a day without a time sorts after that day's timed ones), then undated by creation. */
export function sortTodos(todos: Todo[]): Todo[] {
  const key = (todo: Todo) => (todo.dueDay ? `0|${todo.dueDay}|${todo.dueTime ?? "99:99"}` : "1");
  return [...todos].sort((a, b) => key(a).localeCompare(key(b)) || a.createdAt.localeCompare(b.createdAt));
}

const stores = new WeakMap<object, TodoStore>();

/** The one TodoStore for this context's personal database. */
export function todoStore(ctx: Pick<ModuleContext, "db" | "trash" | "now" | "config">): TodoStore {
  let store = stores.get(ctx.db.personal);
  if (!store) {
    store = new TodoStore(ctx);
    stores.set(ctx.db.personal, store);
  }
  return store;
}
