import { dayKey, daysBetween, type DayKey } from "../../../shared/time.js";
import { todoDueAt, todoWhen } from "../../../shared/todo-format.js";
import type { Todo } from "../../../shared/todos.js";
import type { AgendaContribution, GapCandidate, QueueCandidate, TodayContribution, TodayInput } from "../../../shared/today.js";
import { durationText, queueAction } from "../../../shared/today-format.js";
import { startsWithTodoVerb } from "../../../shared/capture-parse.js";
import type { TodoStore } from "./store.js";

/** Rows due within this many days (or overdue) go to the queue; the core leaves out anything beyond 7 days. */
const QUEUE_HORIZON_DAYS = 7;
const HOUR = 3_600_000;

/**
 * The todos module's part of GET /api/today (docs/ARCHITECTURE.md §10.2):
 *  - queue: open todos due within 7 days or overdue, as `todo` rows
 *    (`native:<id>`, hints.dueAt = due time or 23:59, hardDeadline = high priority);
 *  - agenda: a `due` row for a high-priority todo due at a time today;
 *  - gapCandidates: todos due within 48 h, so the free slot can suggest them;
 *  - nav.tasks: the open todo count (the sidebar 待辦 badge);
 *  - backlog: open todos with no due day that were created before today (`undatedBacklog`).
 * Reads the local table only (no network, no model).
 */
export function todosToday(store: TodoStore, projectNames: () => Map<string, string>, input: Pick<TodayInput, "day" | "now" | "timeZone">): TodayContribution {
  const { day, now, timeZone } = input;
  const open = store.open();
  const queue: QueueCandidate[] = [];
  const agenda: AgendaContribution[] = [];
  const gapCandidates: GapCandidate[] = [];
  let names: Map<string, string> | undefined;
  const projectName = (id: string) => (names ??= projectNames()).get(id);

  for (const todo of open) {
    if (!todo.dueDay || daysBetween(day, todo.dueDay) > QUEUE_HORIZON_DAYS) continue;
    const dueAt = todoDueAt(todo, timeZone)!;
    const hard = todo.priority === "high";
    queue.push({
      id: `native:${todo.id}`,
      kind: "todo",
      source: "native",
      title: todo.title,
      meta: todoMeta(todo, projectName),
      when: todoWhen(todo, day, now, timeZone),
      actions: [
        queueAction("done"),
        queueAction("snooze"),
        ...(todo.sourceRef?.url ? [queueAction("open")] : []),
      ],
      ...(todo.sourceRef?.url ? { url: todo.sourceRef.url } : {}),
      ...(hard ? { snoozeLimit: new Date(Date.parse(dueAt) - 2 * HOUR).toISOString() } : {}),
      hints: { dueAt, ...(hard ? { hardDeadline: true } : {}), fingerprint: `${todo.dueDay}|${todo.dueTime ?? ""}` },
    });
    if (hard && todo.dueTime && todo.dueDay === day) {
      agenda.push({ start: dueAt, title: todo.title, meta: "待辦", kind: "due", itemId: `native:${todo.id}` });
    }
    const ahead = Date.parse(dueAt) - now.getTime();
    if (ahead > 0 && ahead <= 48 * HOUR) {
      gapCandidates.push({
        itemId: `native:${todo.id}`,
        label: gapLabel(todo.title),
        dueAt,
        ...(todo.estimateMinutes ? { estimateMinutes: todo.estimateMinutes } : {}),
      });
    }
  }
  const undated = undatedBacklog(open, day, timeZone);
  return { queue, agenda, gapCandidates, nav: { tasks: open.length }, ...(undated > 0 ? { backlog: { undatedTodos: undated } } : {}) };
}

/**
 * Open todos with no due day that were created before `day` (the local day, so 00:30 in Taipei is already the new
 * day even though the host's UTC date is still the old one). A todo captured today is not counted: it has not had
 * the chance to be scheduled yet, so Today never nags about it.
 */
export function undatedBacklog(todos: readonly Todo[], day: DayKey, timeZone: string): number {
  return todos.filter((todo) => todo.status === "open" && !todo.dueDay && dayKey(timeZone, todo.createdAt) < day).length;
}

/** `待辦 · {context} · 預估 N 分鐘` (SPEC §4.3): the context is the first line of the notes, else the project. */
export function todoMeta(todo: Todo, projectName: (id: string) => string | undefined): string[] {
  const context = todo.notes?.split("\n")[0].trim().slice(0, 40) || (todo.projectId ? projectName(todo.projectId) : undefined);
  return ["待辦", ...(context ? [context] : []), ...(todo.estimateMinutes ? [`預估 ${durationText(todo.estimateMinutes)}`] : [])];
}

/** 「適合準備讀書會簡報」: the free-slot hint names the work (the title up to a colon). */
export function gapLabel(title: string): string {
  const short = title.split(/[：:]/)[0].trim().slice(0, 24) || title.slice(0, 24);
  return startsWithTodoVerb(short) ? `適合${short}` : `適合處理 ${short}`;
}
