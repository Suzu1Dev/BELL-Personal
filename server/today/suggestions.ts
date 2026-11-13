import { CAPTURE_ORIGIN, type AiSuggestion, type EventSuggestion, type TodoSuggestion } from "../../shared/suggestions.js";
import { localTime, zonedTimeToUtc } from "../../shared/time.js";
import type { QueueCandidate, TodayContribution, TodayInput } from "../../shared/today.js";
import { metaDeadline, monthDayWeek, queueAction } from "../../shared/today-format.js";
import type { SuggestionStore } from "../stores/suggestions.js";
import { assignmentSuggestionSchema } from "./suggestion-payloads.js";

/** Event and todo proposals Today shows at once; the rest wait their turn (they stay pending where mail and #/events list them). */
export const SUGGESTION_ROWS_MAX = 3;
/** A proposed event further away than this waits on #/events: it is not a decision for today. */
const EVENT_HORIZON_MS = 14 * 86_400_000;
const DAY_MS = 86_400_000;

/**
 * The core's own today() part: pending AI suggestions of kind event, todo or
 * assignment become `suggestion.*` rows (id `ai:<suggestion id>`, group 今天內).
 * Accepting one is routed to the module registered in `suggestionActions` for
 * that kind; 略過 is handled by the core.
 *
 * Proposals are not obligations, so they must not bury the day (a mailing list
 * once filled the queue with 25 lectures and the headline with 「31 件事」):
 *  - one that is moot (the event started, the due day or deadline passed) is not shown;
 *  - an event more than 14 days away is not shown yet;
 *  - of the rest, at most 3 events and todos are shown, the most urgent first (undated last,
 *    then newest); the next one appears as soon as one is decided.
 * Assignment proposals are rare and matter, so they are only checked for being moot.
 * Nothing is dismissed or deleted: the suggestion stays pending for its other homes.
 */
/** `assignments: false` when the lms module is hidden for the user's roles (設定 › 身分): no assignment proposals. */
export function suggestionContribution(store: SuggestionStore, input: Pick<TodayInput, "now" | "timeZone"> & { assignments?: boolean }): TodayContribution {
  // Quick capture's own bookkeeping records were confirmed by the user's Enter: never a row to decide.
  const pending = store.list({ status: "pending", limit: 200 }).filter((suggestion) => suggestion.origin !== CAPTURE_ORIGIN);
  const assignments: QueueCandidate[] = [];
  const proposals: Array<{ at: number; createdAt: string; row: QueueCandidate }> = [];
  for (const suggestion of pending) {
    const row = suggestionRow(suggestion, input);
    if (!row) continue;
    const timing = suggestionTiming(suggestion, input);
    if (timing.moot) continue;
    if (suggestion.kind === "assignment") {
      if (input.assignments !== false) assignments.push(row);
    }
    else if (timing.at - input.now.getTime() <= EVENT_HORIZON_MS || suggestion.kind !== "event") proposals.push({ at: timing.at, createdAt: suggestion.createdAt, row });
  }
  proposals.sort((a, b) => a.at - b.at || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { queue: [...assignments, ...proposals.slice(0, SUGGESTION_ROWS_MAX).map((proposal) => proposal.row)] };
}

/** Whether a proposal is already over (the event started, the due day or deadline passed): there is nothing left to decide. */
export function suggestionIsMoot(suggestion: AiSuggestion, input: Pick<TodayInput, "now" | "timeZone">): boolean {
  return suggestionTiming(suggestion, input).moot;
}

/** When a proposal happens or is due (Infinity when undated) and whether that is already over. */
function suggestionTiming(suggestion: AiSuggestion, { now, timeZone }: Pick<TodayInput, "now" | "timeZone">): { at: number; moot: boolean } {
  const current = now.getTime();
  switch (suggestion.kind) {
    case "event": {
      const event = suggestion.payload as EventSuggestion;
      const start = Date.parse(event.start);
      const end = event.end ? Date.parse(event.end) : event.allDay ? start + DAY_MS : start;
      return { at: start, moot: end <= current };
    }
    case "todo": {
      const todo = suggestion.payload as TodoSuggestion;
      if (!todo.dueDay) return { at: Infinity, moot: false };
      const [hour, minute] = todo.dueTime ? todo.dueTime.split(":").map(Number) : [23, 59];
      try {
        const due = zonedTimeToUtc(timeZone, todo.dueDay, hour, minute).getTime();
        return { at: due, moot: due < current };
      } catch {
        return { at: Infinity, moot: false };
      }
    }
    default: {
      const parsed = assignmentSuggestionSchema.safeParse(suggestion.payload);
      const due = parsed.success && parsed.data.dueAt ? Date.parse(parsed.data.dueAt) : Infinity;
      return { at: due, moot: due < current };
    }
  }
}

/**
 * The `.q-row.is-ai` row of one pending suggestion, or undefined for kinds
 * that have no row (or a payload that no longer parses). The inbox reader and
 * #/work's 「從信件找到」 card render the same row.
 */
export function suggestionRow(suggestion: AiSuggestion, input: Pick<TodayInput, "now" | "timeZone">): QueueCandidate | undefined {
  switch (suggestion.kind) {
    case "event": return eventRow(suggestion as AiSuggestion<EventSuggestion>, input);
    case "todo": return todoRow(suggestion as AiSuggestion<TodoSuggestion>, input);
    case "assignment": return assignmentRow(suggestion, input);
    default: return undefined;
  }
}

const origin = (suggestion: AiSuggestion) => (suggestion.origin ? [`來自 ${suggestion.origin}`] : []);

function eventRow(suggestion: AiSuggestion<EventSuggestion>, { timeZone }: Pick<TodayInput, "timeZone">): QueueCandidate | undefined {
  const event = suggestion.payload;
  if (!event?.title || !event.start || Number.isNaN(Date.parse(event.start))) return undefined;
  const when = event.allDay ? monthDayWeek(timeZone, event.start) : `${monthDayWeek(timeZone, event.start)}${localTime(timeZone, event.start)}`;
  return {
    id: `ai:${suggestion.id}`,
    kind: "suggestion.event",
    source: "ai",
    title: "從信件找到 1 個活動，要加入行事曆嗎？",
    meta: [event.title, when, ...(event.location ? [event.location] : []), ...origin(suggestion)],
    actions: [queueAction("calendar"), queueAction("dismiss")],
    ...(suggestion.sourceRef?.url ? { url: suggestion.sourceRef.url } : {}),
    hints: { receivedAt: suggestion.createdAt, fingerprint: suggestion.id },
  };
}

function todoRow(suggestion: AiSuggestion<TodoSuggestion>, { now, timeZone }: Pick<TodayInput, "now" | "timeZone">): QueueCandidate | undefined {
  const todo = suggestion.payload;
  if (!todo?.title) return undefined;
  let due: string | undefined;
  if (todo.dueDay) {
    const [hour, minute] = todo.dueTime ? todo.dueTime.split(":").map(Number) : [23, 59];
    try { due = zonedTimeToUtc(timeZone, todo.dueDay, hour, minute).toISOString(); } catch { due = undefined; }
  }
  return {
    id: `ai:${suggestion.id}`,
    kind: "suggestion.todo",
    source: "ai",
    title: "從信件找到 1 件待辦，要加入嗎？",
    meta: [todo.title, ...(due ? [metaDeadline(due, now, timeZone, { dateOnly: !todo.dueTime })] : []), ...origin(suggestion)],
    actions: [queueAction("todo", { label: "加入待辦", touchLabel: "加入待辦" }), queueAction("dismiss")],
    ...(suggestion.sourceRef?.url ? { url: suggestion.sourceRef.url } : {}),
    hints: { receivedAt: suggestion.createdAt, fingerprint: suggestion.id },
  };
}

/** 「從信件找到 1 份作業，要加入嗎？」 · HW5：系統呼叫實作 · 作業系統 · 週五 23:59 截止 · 來自 林志明 教授 信件 (SPEC-mail-assignments §5.5). */
function assignmentRow(suggestion: AiSuggestion, { now, timeZone }: Pick<TodayInput, "now" | "timeZone">): QueueCandidate | undefined {
  const parsed = assignmentSuggestionSchema.safeParse(suggestion.payload);
  if (!parsed.success) return undefined;
  const assignment = parsed.data;
  const due = assignment.dueAt
    ? metaDeadline(new Date(assignment.dueAt).toISOString(), now, timeZone, { dateOnly: !!assignment.dueDay })
    : "沒有寫截止時間";
  return {
    id: `ai:${suggestion.id}`,
    kind: "suggestion.assignment",
    source: "ai",
    title: "從信件找到 1 份作業，要加入嗎？",
    subject: assignment.title,
    meta: [
      assignment.title,
      ...(assignment.courseName ? [assignment.courseName] : []),
      due,
      ...origin(suggestion),
      ...(assignment.detectedBy === "rule" ? ["規則判斷"] : []),
    ],
    actions: [queueAction("assignment", { label: "加入作業", touchLabel: "加入作業" }), queueAction("dismiss")],
    ...(suggestion.sourceRef?.url ? { url: suggestion.sourceRef.url } : {}),
    hints: { receivedAt: suggestion.createdAt, fingerprint: suggestion.id },
  };
}
