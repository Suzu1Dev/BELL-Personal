/**
 * #/tasks grouping and row text (SPEC-ux §3.3 「待辦」): 逾期 · 今天 · 明天 ·
 * 本週 · 之後 · 沒有期限, in the server's day. Pure, so it is unit-tested.
 */
import { addDays, daysBetween, weekdayOf, type DayKey } from "../../../shared/time";
import { todoDeadline, todoDueAt, todoDuration } from "../../../shared/todo-format";
import type { Todo, TodoListResponse, TodoUpdateRequest } from "../../../shared/todos";
import { dateLabel } from "../../components/capture/describe";
import type { OnboardingLocale } from "../../copy/onboarding";
import { tasksCopy } from "../../copy/tasks";

export const TASK_GROUPS = ["overdue", "today", "tomorrow", "week", "later", "someday"] as const;
export type TaskGroupKey = (typeof TASK_GROUPS)[number];

export interface TaskGroup {
  key: TaskGroupKey;
  label: string;
  items: Todo[];
}

/** The last day (Sunday) of the Monday-based week `day` is in. */
export function endOfWeek(day: DayKey): DayKey {
  return addDays(day, (7 - weekdayOf(day)) % 7);
}

export function taskGroup(todo: Pick<Todo, "dueDay" | "dueTime">, today: DayKey, now: Date, timeZone: string): TaskGroupKey {
  if (!todo.dueDay) return "someday";
  if (Date.parse(todoDueAt(todo, timeZone)!) < now.getTime() || todo.dueDay < today) return "overdue";
  if (todo.dueDay === today) return "today";
  if (todo.dueDay === addDays(today, 1)) return "tomorrow";
  if (todo.dueDay <= endOfWeek(today)) return "week";
  return "later";
}

/** Non-empty groups in SPEC order; inside a group by due (time first), then creation. */
export function groupTodos(todos: readonly Todo[], today: DayKey, now: Date, timeZone: string, locale: OnboardingLocale = "zh-TW"): TaskGroup[] {
  const { TASKS } = tasksCopy(locale);
  const buckets = new Map<TaskGroupKey, Todo[]>(TASK_GROUPS.map((key) => [key, []]));
  for (const todo of todos) if (todo.status === "open") buckets.get(taskGroup(todo, today, now, timeZone))!.push(todo);
  const order = (todo: Todo) => (todo.dueDay ? `${todo.dueDay}|${todo.dueTime ?? "99:99"}` : "~");
  return TASK_GROUPS
    .map((key) => ({
      key,
      label: TASKS.groups[key],
      items: buckets.get(key)!.sort((a, b) => order(a).localeCompare(order(b)) || a.createdAt.localeCompare(b.createdAt)),
    }))
    .filter((group) => group.items.length);
}

/** `來源 · 期限` (+ the project or the first line of the notes, the estimate). */
export function taskMeta(
  todo: Todo,
  today: DayKey,
  now: Date,
  timeZone: string,
  projectName?: (id: string) => string | undefined,
  locale: OnboardingLocale = "zh-TW",
): string[] {
  const { TASKS, TODO_ORIGIN_LABELS } = tasksCopy(locale);
  const context = (todo.projectId ? projectName?.(todo.projectId) : undefined) ?? todo.notes?.split("\n")[0].trim().slice(0, 40);
  const deadline = todoDeadline(todo, today, now, timeZone, locale);
  return [
    TODO_ORIGIN_LABELS[todo.origin],
    ...(deadline ? [deadline] : []),
    ...(context ? [context] : []),
    ...(todo.estimateMinutes ? [TASKS.estimate(todoDuration(todo.estimateMinutes, locale))] : []),
  ];
}

/** The todo the 「?focus=<id>」 search link points at. */
export function focusFromHash(hash: string): string | undefined {
  const query = hash.split("?")[1];
  if (!query) return undefined;
  const id = new URLSearchParams(query.split("#")[0]).get("focus");
  return id || undefined;
}

/** The group the 「?group=someday」 link from Today's 還有 N 件待辦沒排日期 points at. */
export function groupFromHash(hash: string): TaskGroupKey | undefined {
  const query = hash.split("?")[1];
  const value = query ? new URLSearchParams(query.split("#")[0]).get("group") : null;
  return TASK_GROUPS.find((key) => key === value);
}

/* ------------------------------------------------------ quick scheduling */

export const SCHEDULE_PRESETS = ["today", "tomorrow", "weekend", "nextMonday"] as const;
export type SchedulePresetId = (typeof SCHEDULE_PRESETS)[number];

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  day: DayKey;
}

/**
 * 今天 · 明天 · 這週末 · 下週一 as local days counted from the server's `today` (never the browser's date).
 * The weekend is the Saturday after today; on a Saturday or Sunday that is the next one, and the label says so.
 * 下週一 is the Monday after today (tomorrow, when today is Sunday).
 */
export function schedulePresets(today: DayKey, locale: OnboardingLocale = "zh-TW"): SchedulePreset[] {
  const { TASKS } = tasksCopy(locale);
  const weekday = weekdayOf(today); // 0 = Sunday … 6 = Saturday
  return [
    { id: "today", label: TASKS.schedule.today, day: today },
    { id: "tomorrow", label: TASKS.schedule.tomorrow, day: addDays(today, 1) },
    { id: "weekend", label: weekday === 0 || weekday === 6 ? TASKS.schedule.nextWeekend : TASKS.schedule.weekend, day: addDays(today, (6 - weekday + 7) % 7 || 7) },
    { id: "nextMonday", label: TASKS.schedule.nextMonday, day: addDays(today, (1 - weekday + 7) % 7 || 7) },
  ];
}

export function scheduleDateLabel(day: DayKey, timeZone: string, locale: OnboardingLocale = "zh-TW"): string {
  if (locale === "zh-TW") return dateLabel(day, timeZone);
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00.000Z`));
}

/** 「今天」 · 「明天」 · 「10/24（六）」: the day in the 已排到… toast. */
export function scheduleWhen(day: DayKey, today: DayKey, timeZone: string, locale: OnboardingLocale = "zh-TW"): string {
  const { schedule } = tasksCopy(locale).TASKS;
  if (day === today) return schedule.todayInSentence;
  if (day === addDays(today, 1)) return schedule.tomorrowInSentence;
  return scheduleDateLabel(day, timeZone, locale);
}

/** Days until due (negative when overdue); undefined without a due day. */
export function daysLeft(todo: Pick<Todo, "dueDay">, today: DayKey): number | undefined {
  return todo.dueDay ? daysBetween(today, todo.dueDay) : undefined;
}

/* ------------------------------------------------------------ local edits */

/**
 * A row the page changed before the server's list shows it: finished (or
 * deleted) rows leave the list at once, reopened ones come back. `settledAt`
 * is set when the server acknowledged the change; until a list fetched after
 * that lands, the edit stays, so a refresh that started earlier (the 30 s
 * poll, window focus) never puts a finished row back.
 */
export interface ClosingTodo {
  todo: Todo;
  /** "done" rows join 今天完成; deleted ones just leave. */
  kind: "done" | "deleted";
  settledAt?: number;
}

export interface ReopenedTodo {
  settledAt?: number;
}

/** A day the page gave a todo (or took back with 復原: null) before the server's list shows it. */
export interface ScheduledTodo {
  dueDay: DayKey | null;
  settledAt?: number;
}

/** Drops the edits a list fetched after their acknowledgement already reflects (same map when nothing changes). */
export function keepUnsettled<V extends { settledAt?: number }>(edits: ReadonlyMap<string, V>, fetchedAt: number): ReadonlyMap<string, V> {
  const kept = [...edits].filter(([, edit]) => edit.settledAt === undefined || edit.settledAt >= fetchedAt);
  return kept.length === edits.size ? edits : new Map(kept);
}

/** The open rows and 今天完成 with the local edits applied; a row is never listed twice. */
export function mergeTodos(
  list: TodoListResponse | undefined,
  closing: ReadonlyMap<string, ClosingTodo>,
  reopened: ReadonlyMap<string, ReopenedTodo>,
  scheduled: ReadonlyMap<string, ScheduledTodo> = new Map(),
): { open: Todo[]; done: Todo[] } {
  const open = (list?.open ?? []).filter((todo) => !closing.has(todo.id));
  const openIds = new Set(open.map((todo) => todo.id));
  const back = (list?.completedToday ?? [])
    .filter((todo) => reopened.has(todo.id) && !closing.has(todo.id) && !openIds.has(todo.id))
    .map((todo) => ({ ...todo, status: "open" as const }));
  const finished = [...closing.values()].filter((entry) => entry.kind === "done").map((entry) => entry.todo);
  const finishedIds = new Set(finished.map((todo) => todo.id));
  const done = [...finished, ...(list?.completedToday ?? []).filter((todo) => !reopened.has(todo.id) && !closing.has(todo.id) && !finishedIds.has(todo.id))];
  return { open: [...open, ...back].map((todo) => withScheduledDay(todo, scheduled.get(todo.id))), done };
}

/** A day set on a todo takes its `dueDay` at once; taking it back also drops the time (a time needs a day). */
function withScheduledDay(todo: Todo, edit: ScheduledTodo | undefined): Todo {
  if (!edit) return todo;
  if (edit.dueDay) return { ...todo, dueDay: edit.dueDay };
  const { dueDay: _dueDay, dueTime: _dueTime, ...rest } = todo;
  return rest;
}

/** What the row editor edits, as its inputs hold it. */
export interface EditorFields {
  title: string;
  dueDay: string;
  dueTime: string;
  notes: string;
  important: boolean;
}

export function editorFields(todo: Pick<Todo, "title" | "dueDay" | "dueTime" | "notes" | "priority">): EditorFields {
  return { title: todo.title, dueDay: todo.dueDay ?? "", dueTime: todo.dueTime ?? "", notes: todo.notes ?? "", important: todo.priority === "high" };
}

const EDITOR_KEYS = ["title", "dueDay", "dueTime", "notes", "important"] as const;

export function sameEditorFields(a: EditorFields, b: EditorFields): boolean {
  return EDITOR_KEYS.every((key) => a[key] === b[key]);
}

/**
 * The open editor after the todo changed underneath it (自動整理 landed, the
 * list refreshed): a field the user has not touched since `base` takes the new
 * value; a field they changed keeps theirs.
 */
export function resyncEditor(base: EditorFields, current: EditorFields, next: EditorFields): EditorFields {
  const out = { ...current };
  for (const key of EDITOR_KEYS) if (current[key] === base[key]) (out as Record<string, unknown>)[key] = next[key];
  return out;
}

/**
 * 儲存 sends only what the user changed since `base`, so it never writes back
 * a title or notes that a tidy replaced meanwhile. Empty: nothing to save.
 */
export function editorPatch(base: EditorFields, current: EditorFields): TodoUpdateRequest {
  const patch: TodoUpdateRequest = {};
  if (current.title.trim() !== base.title.trim()) patch.title = current.title.trim();
  if (current.dueDay !== base.dueDay) patch.dueDay = current.dueDay || null;
  // A cleared day clears its time on the server too.
  if (current.dueTime !== base.dueTime) patch.dueTime = current.dueDay && current.dueTime ? current.dueTime : null;
  if (current.notes.trim() !== base.notes.trim()) patch.notes = current.notes.trim() || null;
  if (current.important !== base.important) patch.priority = current.important ? "high" : "normal";
  return patch;
}
