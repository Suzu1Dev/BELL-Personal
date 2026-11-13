import type { DayKey } from "./time.js";
import type { SourceRef } from "./sources.js";

export const TODO_STATUSES = ["open", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_PRIORITIES = ["normal", "high"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

/** Where a todo came from; AI-derived todos exist only after the user confirmed a suggestion. */
export const TODO_ORIGINS = ["manual", "quick-capture", "mail", "assignment", "github", "suggestion"] as const;
export type TodoOrigin = (typeof TODO_ORIGINS)[number];

export interface Todo {
  id: string;
  title: string;
  notes?: string;
  status: TodoStatus;
  priority: TodoPriority;
  /** Local due day; absent means "someday". */
  dueDay?: DayKey;
  /** Local "HH:MM" on dueDay. */
  dueTime?: string;
  projectId?: string;
  /** 「預估 40 分鐘」; also bounds the 排進 block. */
  estimateMinutes?: number;
  origin: TodoOrigin;
  sourceRef?: SourceRef;
  /** What the user typed in quick capture, when the title is not the whole sentence (kept by 自動整理). */
  originalText?: string;
  /** When 自動整理 (or 整理) last rewrote the title or notes. */
  tidiedAt?: string;
  /** The title and notes before that rewrite, for 復原整理; dropped once the user edits the title or notes. */
  pretidy?: TodoPretidy;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** What 自動整理 replaced on a todo. */
export interface TodoPretidy {
  title: string;
  notes?: string;
}

export const TODO_LIMITS = { title: 200, notes: 4000, originalText: 500 } as const;
export const TODO_ESTIMATE_MAX_MINUTES = 24 * 60;

/** POST /api/todos → 201 Todo. */
export interface TodoCreateRequest {
  title: string;
  notes?: string;
  dueDay?: DayKey;
  dueTime?: string;
  priority?: TodoPriority;
  projectId?: string;
  estimateMinutes?: number;
}

/** PATCH /api/todos/:id → Todo. `null` clears an optional field. */
export interface TodoUpdateRequest {
  title?: string;
  notes?: string | null;
  dueDay?: DayKey | null;
  dueTime?: string | null;
  priority?: TodoPriority;
  projectId?: string | null;
  estimateMinutes?: number | null;
}

/** GET /api/todos: every open todo and the ones finished today. */
export interface TodoListResponse {
  /** Today in BELLPERSONAL_TZ, so the page groups by the server's day. */
  day: DayKey;
  open: Todo[];
  /** Finished today, newest first (the 「今天完成 N 件」 fold). */
  completedToday: Todo[];
}

/** DELETE /api/todos/:id → 200; 復原 = POST /api/trash/restore { token: undoToken }. */
export interface TodoDeleteResponse {
  deleted: true;
  undoToken?: string;
}
