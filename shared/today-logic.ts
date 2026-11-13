import { addDays, dayBounds, dayKey, localTime, zonedParts, zonedTimeToUtc } from "./time.js";
import {
  EVENT_DECIDE_LIMIT, QUEUE_GROUP_CAPS, QUEUE_GROUPS, QUEUE_KINDS,
  type ActionId, type DigestCategory, type HandledItem, type HandledKind, type LaterEvent, type LaterProject, type QueueCandidate,
  type QueueGroup, type QueueItem, type QueueKind, type SidebarProject, type TodayAgendaItem, type TodayBrief,
  type TodayContribution, type TodayCounts, type TodayGap, type TodayPayload, type TodaySource,
} from "./today.js";
import { dayLabel, monthDay, monthDayWeek } from "./today-format.js";

/**
 * The pure rules behind GET /api/today (SPEC §4.2–§4.8): grouping, ordering,
 * caps, item state, counts, greeting, pace, next-up, the free slot and the
 * rule brief. The server collects module contributions and persisted state,
 * then calls buildTodayPayload(); nothing here touches I/O or the host clock.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* ----------------------------------------------------------------------- */
/* Actions: what each one does to the queue item (SPEC §6.4).              */
/* ----------------------------------------------------------------------- */

/** The persisted state of a queue item (personal.sqlite item_state). */
export const ITEM_STATES = ["snoozed", "dismissed", "handled", "replying"] as const;
export type ItemStateKind = (typeof ITEM_STATES)[number];

export interface ItemStateView {
  state: ItemStateKind;
  /** snoozed: ISO wake time. */
  until?: string | null;
  /** dismissed / handled: the item's fingerprint at that moment; null = forever. */
  fingerprint?: string | null;
}

/**
 * Who handles an action:
 *  - core: the core applies it (a module handler for the item's source is optional and runs too);
 *  - source: the module owning the item's source (`actions[source]`, or `suggestionActions[kind]` for ai: items);
 *  - any-todo / any-schedule / any-assignment: the module registered in `anySourceActions` (tasks: todo, calendar: schedule,
 *    lms: assignment), whatever the item's source; on ai: items the suggestion kind's handler.
 */
export type ActionRoute = "core" | "source" | "any-todo" | "any-schedule" | "any-assignment";

export interface ActionEffect {
  /** Item state written by the core; "until-change" = dismissed with the current fingerprint. */
  state: "snoozed" | "dismissed" | "until-change" | "handled" | "replying" | null;
  /** Counts as handled today. */
  closes: boolean;
  route: ActionRoute;
  /** Which e-stats bucket it counts in. */
  handledKind?: HandledKind;
}

export const ACTION_EFFECTS: Record<ActionId, ActionEffect> = {
  reply: { state: "replying", closes: false, route: "core", handledKind: "reply" },
  open: { state: null, closes: false, route: "core" },
  archive: { state: "handled", closes: true, route: "source", handledKind: "done" },
  read: { state: "handled", closes: true, route: "source", handledKind: "done" },
  todo: { state: "handled", closes: true, route: "any-todo", handledKind: "done" },
  snooze: { state: "snoozed", closes: true, route: "core", handledKind: "snooze" },
  done: { state: "handled", closes: true, route: "source", handledKind: "done" },
  submitted: { state: "until-change", closes: true, route: "core", handledKind: "done" },
  reviewed: { state: "until-change", closes: true, route: "core", handledKind: "done" },
  calendar: { state: "handled", closes: true, route: "source", handledKind: "calendar" },
  going: { state: "handled", closes: true, route: "source", handledKind: "calendar" },
  dismiss: { state: "dismissed", closes: true, route: "core", handledKind: "done" },
  schedule: { state: null, closes: false, route: "any-schedule" },
  // SPEC-mail-assignments §1.3: 刪除 closes a mail row like 封存; 移回收件匣 touches no queue row;
  // 轉成作業 / 加入作業 closes the row like 轉待辦.
  trash: { state: "handled", closes: true, route: "source", handledKind: "done" },
  unarchive: { state: null, closes: false, route: "source" },
  assignment: { state: "handled", closes: true, route: "any-assignment", handledKind: "done" },
};

/** The rows a group hides behind 「還有 N 件 · 顯示全部」 for a given length (SPEC §4.3 caps). */
export function hiddenRows(group: TodayPayload["queue"][number], length: number): number {
  return Math.max(0, length - (group.cap ?? QUEUE_GROUP_CAPS[group.group]));
}

/**
 * A served payload as it looks right after `action` on `itemId` (SPEC §6.5
 * step 1), following ACTION_EFFECTS: a closing action takes the row out of
 * its group and moves one count from open to handled (its handledBy bucket;
 * 封存, 刪除 and 標為已讀 on mail also lower the unread badge); 回覆 keeps the row,
 * marked 回覆中…; 排進 drops the free slot it filled; 開啟 changes nothing.
 * A no-op when the row is already gone or marked, so it can be re-applied to
 * a fresher payload without counting twice. The browser uses it for its
 * optimistic update; the dev fixture override replays accepted actions with it.
 *
 * The digest strip's bulk targets (`gmail:digest` for 全部標為已讀,
 * `gmail:digest:<category key>` for 逐類看) are not queue rows: 標為已讀 and
 * 封存 take their categories out of the strip and lower the unread badge;
 * they never count as handled (digest mail is never in the queue).
 */
export function applyActionToPayload(payload: TodayPayload, itemId: string, action: ActionId): TodayPayload {
  const digest = DIGEST_TARGET.exec(itemId);
  if (digest) return applyDigestAction(payload, digest[1], action);
  if (action === "schedule") {
    if (payload.agenda.gap?.forItemId !== itemId) return payload;
    const { gap: _gap, ...agenda } = payload.agenda;
    return { ...payload, agenda };
  }
  const groupIndex = payload.queue.findIndex((group) => group.items.some((item) => item.id === itemId));
  if (groupIndex < 0) return payload;
  const target = payload.queue[groupIndex].items.find((item) => item.id === itemId)!;
  const effect = ACTION_EFFECTS[action];

  if (action === "reply") {
    if (target.replying) return payload;
    return {
      ...payload,
      queue: payload.queue.map((group, index) => (index === groupIndex
        ? { ...group, items: group.items.map((item) => (item.id === itemId ? { ...item, replying: true } : item)) }
        : group)),
    };
  }
  if (!effect.closes) return payload;

  const bucket = effect.handledKind ?? "done";
  const { counts } = payload;
  const readsMail = target.kind.startsWith("mail.") && (action === "archive" || action === "read" || action === "trash");
  return {
    ...payload,
    queue: payload.queue.map((group, index) => {
      if (index !== groupIndex) return group;
      const items = group.items.filter((item) => item.id !== itemId);
      return { ...group, items, hidden: hiddenRows(group, items.length) };
    }),
    counts: {
      ...counts,
      open: Math.max(0, counts.open - 1),
      handled: counts.handled + 1,
      handledBy: { ...counts.handledBy, [bucket]: counts.handledBy[bucket] + 1 },
      inboxUnread: readsMail ? Math.max(0, counts.inboxUnread - 1) : counts.inboxUnread,
    },
  };
}

/** `gmail:digest` (every category) or `gmail:digest:<key>` (one category). */
const DIGEST_TARGET = /^gmail:digest(?::(.+))?$/;

function applyDigestAction(payload: TodayPayload, key: string | undefined, action: ActionId): TodayPayload {
  if (!payload.digest || (action !== "read" && action !== "archive")) return payload;
  const removed = payload.digest.categories.filter((category) => key === undefined || category.key === key);
  if (!removed.length) return payload;
  const count = removed.reduce((sum, category) => sum + category.count, 0);
  const categories = payload.digest.categories.filter((category) => !removed.includes(category));
  const { digest: _digest, ...rest } = payload;
  return {
    ...rest,
    ...(categories.length ? { digest: { total: Math.max(0, payload.digest.total - count), categories } } : {}),
    counts: { ...payload.counts, inboxUnread: Math.max(0, payload.counts.inboxUnread - count) },
  };
}

/* ----------------------------------------------------------------------- */
/* Grouping                                                                 */
/* ----------------------------------------------------------------------- */

const within = (dueAt: string | undefined, now: Date, ms: number) =>
  dueAt !== undefined && Date.parse(dueAt) - now.getTime() <= ms;

/**
 * The group a candidate belongs to, or null when it stays out of the queue
 * (deadline beyond 7 days). SPEC §4.3:
 *  最重要: overdue anything; a hard deadline within 24 h; an important mail.reply;
 *          a review request older than 24 h; pr.changes.
 *  今天內: a deadline within 48 h; todos due today; every suggestion; mail.bill and
 *          mail.action; other mail.reply; review requests under 24 h old.
 *  可以等: a deadline within 7 days; event.decide.
 */
export function groupFor(candidate: QueueCandidate, now: Date, timeZone: string): QueueGroup | null {
  const { kind, hints } = candidate;
  const due = hints.dueAt;
  if (due !== undefined && Date.parse(due) < now.getTime()) return "now";
  if (hints.hardDeadline && within(due, now, 24 * HOUR)) return "now";
  switch (kind) {
    case "mail.reply":
      return hints.important ? "now" : "today";
    case "review": {
      const received = hints.receivedAt ? Date.parse(hints.receivedAt) : now.getTime();
      return now.getTime() - received > 24 * HOUR ? "now" : "today";
    }
    case "pr.changes":
      return "now";
    case "suggestion.event":
    case "suggestion.todo":
    case "suggestion.assignment":
    case "mail.bill":
    case "mail.action":
      return "today";
    case "event.decide":
      return "later";
    case "assignment":
    case "todo": {
      if (due === undefined) return null;
      if (within(due, now, 48 * HOUR)) return "today";
      if (Date.parse(due) < Date.parse(dayBounds(timeZone, dayKey(timeZone, now)).end)) return "today";
      if (within(due, now, 7 * 24 * HOUR)) return "later";
      return null;
    }
  }
}

/**
 * Order inside a group: deadline ascending, then AI rank, then received descending (SPEC §4.3),
 * then start time ascending — only an event to decide on has one, so 可以等's two events
 * read soonest first instead of by id.
 */
export function compareInGroup(a: QueueCandidate, b: QueueCandidate): number {
  const dueA = a.hints.dueAt ? Date.parse(a.hints.dueAt) : Infinity;
  const dueB = b.hints.dueAt ? Date.parse(b.hints.dueAt) : Infinity;
  if (dueA !== dueB) return dueA - dueB;
  const rankA = a.hints.rank ?? Infinity;
  const rankB = b.hints.rank ?? Infinity;
  if (rankA !== rankB) return rankA - rankB;
  const receivedA = a.hints.receivedAt ? Date.parse(a.hints.receivedAt) : -Infinity;
  const receivedB = b.hints.receivedAt ? Date.parse(b.hints.receivedAt) : -Infinity;
  if (receivedA !== receivedB) return receivedB - receivedA;
  const startA = a.hints.startsAt ? Date.parse(a.hints.startsAt) : Infinity;
  const startB = b.hints.startsAt ? Date.parse(b.hints.startsAt) : Infinity;
  if (startA !== startB) return startA - startB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Whether persisted state keeps a candidate out of the queue right now. */
export function hiddenByState(candidate: QueueCandidate, state: ItemStateView | undefined, now: Date): boolean {
  if (!state) return false;
  switch (state.state) {
    case "snoozed":
      return !!state.until && Date.parse(state.until) > now.getTime();
    case "dismissed":
    case "handled":
      return state.fingerprint == null || state.fingerprint === (candidate.hints.fingerprint ?? null);
    case "replying":
      return false;
  }
}

export interface QueueBuild {
  queue: TodayPayload["queue"];
  /** Every open item, in display order (group by group). */
  ordered: QueueItem[];
  /** Candidates of the open items by id (with hints), for gap pairing and action lookups. */
  candidates: Map<string, QueueCandidate>;
}

/** Applies state, groups, keeps the two nearest event.decide rows, orders and caps. */
export function buildQueue(candidates: QueueCandidate[], states: ReadonlyMap<string, ItemStateView>, now: Date, timeZone: string): QueueBuild {
  const seen = new Set<string>();
  const grouped: Record<QueueGroup, QueueCandidate[]> = { now: [], today: [], later: [] };
  const decide: QueueCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const state = states.get(candidate.id);
    if (hiddenByState(candidate, state, now)) continue;
    const group = groupFor(candidate, now, timeZone);
    if (!group) continue;
    const visible = state?.state === "replying" ? { ...candidate, replying: true } : candidate;
    if (candidate.kind === "event.decide" && group === "later") decide.push(visible);
    else grouped[group].push(visible);
  }
  const startOf = (item: QueueCandidate) => Date.parse(item.hints.startsAt ?? item.hints.dueAt ?? "") || Infinity;
  grouped.later.push(...decide.sort((a, b) => startOf(a) - startOf(b)).slice(0, EVENT_DECIDE_LIMIT));

  const ordered: QueueItem[] = [];
  const byId = new Map<string, QueueCandidate>();
  const queue = QUEUE_GROUPS.map((group) => {
    const items = grouped[group].sort(compareInGroup).map((candidate) => {
      byId.set(candidate.id, candidate);
      const { hints: _hints, ...item } = candidate;
      return { ...item, group } satisfies QueueItem;
    });
    ordered.push(...items);
    return { group, items, hidden: Math.max(0, items.length - QUEUE_GROUP_CAPS[group]), cap: QUEUE_GROUP_CAPS[group] };
  });
  return { queue, ordered, candidates: byId };
}

/* ----------------------------------------------------------------------- */
/* Counts and pace                                                          */
/* ----------------------------------------------------------------------- */

/** One closing action logged today (action_log, not undone, not failed). */
export interface HandledLogEntry {
  actionId: string;
  itemId: string;
  kind: QueueKind | string;
  title: string;
  action: ActionId;
  at: string;
  undoable: boolean;
  /** Whether this row closed the item; defaults to ACTION_EFFECTS[action].closes. A reply closes only when the mail module saw it sent. */
  closes?: boolean;
}

const QUEUE_KIND_SET = new Set<string>(QUEUE_KINDS);

/**
 * Items closed today: the latest closing action per item, queue kinds only,
 * minus items that are open again (a snooze that already woke up), newest first.
 */
export function handledToday(log: HandledLogEntry[], openIds: ReadonlySet<string>): HandledItem[] {
  const latest = new Map<string, HandledLogEntry>();
  for (const entry of log) {
    if (!QUEUE_KIND_SET.has(entry.kind) || !(entry.closes ?? ACTION_EFFECTS[entry.action]?.closes)) continue;
    const current = latest.get(entry.itemId);
    if (!current || entry.at > current.at) latest.set(entry.itemId, entry);
  }
  return [...latest.values()]
    .filter((entry) => !openIds.has(entry.itemId))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map((entry) => ({ itemId: entry.itemId, kind: entry.kind as QueueKind, title: entry.title, action: entry.action, at: entry.at, actionId: entry.actionId, undoable: entry.undoable }));
}

export function countHandledBy(handled: HandledItem[]): Record<HandledKind, number> {
  const counts: Record<HandledKind, number> = { reply: 0, done: 0, snooze: 0, calendar: 0 };
  for (const item of handled) counts[ACTION_EFFECTS[item.action].handledKind ?? "done"]++;
  return counts;
}

/**
 * 「照這個節奏，約 M 分鐘 清空」: (first → last handled action today ÷ handled) × open,
 * clamped 5–120 and rounded to 5. Only when handled ≥ 3 and something is open.
 */
export function paceMinutes(handledAts: string[], open: number): number | undefined {
  if (handledAts.length < 3 || open <= 0) return undefined;
  const times = handledAts.map((at) => Date.parse(at)).sort((a, b) => a - b);
  const perItem = (times.at(-1)! - times[0]) / MINUTE / handledAts.length;
  const minutes = Math.round((perItem * open) / 5) * 5;
  return Math.min(120, Math.max(5, minutes));
}

/** 05:00–10:59 早安 · 11:00–16:59 午安 · 17:00–04:59 辛苦了 (local time). */
export function greetingFor(now: Date, timeZone: string): TodayPayload["greeting"] {
  const hour = zonedParts(timeZone, now).hour;
  if (hour >= 5 && hour < 11) return "早安";
  if (hour >= 11 && hour < 17) return "午安";
  return "辛苦了";
}

/* ----------------------------------------------------------------------- */
/* Agenda, free slot, next-up                                               */
/* ----------------------------------------------------------------------- */

/** A free slot must be at least this long and end by this local hour (SPEC §4.8). */
export const GAP_MIN_MINUTES = 90;
export const GAP_DAY_END_HOUR = 22;

export function agendaWithPast(items: Omit<TodayAgendaItem, "past">[], now: Date): TodayAgendaItem[] {
  return [...items]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((item) => ({ ...item, past: Date.parse(item.kind === "due" ? item.start : (item.end ?? item.start)) <= now.getTime() }));
}

/** The longest free stretch between now and 22:00 that is at least 90 minutes, or undefined. */
export function largestFreeSlot(agenda: TodayAgendaItem[], now: Date, timeZone: string): { start: Date; end: Date } | undefined {
  const dayEnd = zonedTimeToUtc(timeZone, dayKey(timeZone, now), GAP_DAY_END_HOUR, 0);
  if (now >= dayEnd) return undefined;
  const busy = agenda
    .filter((item) => item.kind === "event" && !item.allDay && item.end && !item.transparent)
    .map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end!) }))
    .filter((item) => item.end > now.getTime() && item.start < dayEnd.getTime())
    .sort((a, b) => a.start - b.start);
  let cursor = now.getTime();
  let best: { start: number; end: number } | undefined;
  const consider = (start: number, end: number) => {
    if (end - start >= GAP_MIN_MINUTES * MINUTE && (!best || end - start > best.end - best.start)) best = { start, end };
  };
  for (const block of busy) {
    if (block.start > cursor) consider(cursor, Math.min(block.start, dayEnd.getTime()));
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < dayEnd.getTime()) consider(cursor, dayEnd.getTime());
  return best && { start: new Date(best.start), end: new Date(best.end) };
}

/** Pairs the free slot with the first open queue item (display order) that has a gap candidate due within 48 h and after the slot starts. */
export function matchGap(
  agenda: TodayAgendaItem[], ordered: QueueItem[], contributions: TodayContribution[], now: Date, timeZone: string,
): TodayGap | undefined {
  const slot = largestFreeSlot(agenda, now, timeZone);
  if (!slot) return undefined;
  const candidates = new Map<string, NonNullable<TodayContribution["gapCandidates"]>[number]>();
  for (const contribution of contributions) for (const candidate of contribution.gapCandidates ?? []) if (!candidates.has(candidate.itemId)) candidates.set(candidate.itemId, candidate);
  for (const item of ordered) {
    const candidate = candidates.get(item.id);
    if (!candidate) continue;
    const due = Date.parse(candidate.dueAt);
    if (due <= now.getTime() || due - now.getTime() > 48 * HOUR || due <= slot.start.getTime()) continue;
    const minutes = Math.round((slot.end.getTime() - slot.start.getTime()) / MINUTE);
    return {
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      hours: Math.floor(minutes / 30) / 2,
      forItemId: item.id,
      label: candidate.label,
      ...(candidate.estimateMinutes !== undefined && candidate.estimateMinutes < minutes ? { estimateMinutes: candidate.estimateMinutes } : {}),
    };
  }
  return undefined;
}

/** The next event that has not started, today or tomorrow. */
export function pickNextUp(candidates: { start: string; title: string }[], now: Date, timeZone: string): { start: string; title: string } | undefined {
  const horizon = Date.parse(dayBounds(timeZone, addDays(dayKey(timeZone, now), 1)).end);
  return candidates
    .filter((item) => Date.parse(item.start) > now.getTime() && Date.parse(item.start) < horizon)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
}

/* ----------------------------------------------------------------------- */
/* Rule brief (SPEC §4.2, state 05b)                                        */
/* ----------------------------------------------------------------------- */

const hoursText = (hours: number) => (Number.isInteger(hours) ? String(hours) : hours.toFixed(1));

export interface RuleBriefInput {
  ordered: QueueItem[];
  candidates: ReadonlyMap<string, QueueCandidate>;
  agenda: TodayAgendaItem[];
  gap?: TodayGap;
  /** Any future event (beyond tomorrow too), for the all-zero sentence. */
  upcoming: { start: string; title: string }[];
  now: Date;
  timeZone: string;
}

/**
 * `{n} 封信待回覆，{n} 項作業今晚 23:59 截止。第一個行程是 10:10 作業系統，15:30 後有 4 小時空檔。`
 * Clauses whose value is 0 are dropped; with nothing at all:
 * `沒有到期的作業，也沒有行程。下一個是 10/19（一）09:00 計算機網路。`
 */
export function ruleBrief(input: RuleBriefInput): string {
  const { now, timeZone } = input;
  const replies = input.ordered.filter((item) => item.kind === "mail.reply").length;
  const due = input.ordered
    .map((item) => input.candidates.get(item.id))
    .filter((candidate): candidate is QueueCandidate => candidate?.kind === "assignment" && !!candidate.hints.dueAt
      && Date.parse(candidate.hints.dueAt) > now.getTime() && Date.parse(candidate.hints.dueAt) - now.getTime() <= 24 * HOUR)
    .map((candidate) => candidate.hints.dueAt!)
    .sort();
  const first: string[] = [];
  if (replies) first.push(`${replies} 封信待回覆`);
  if (due.length) {
    const today = dayKey(timeZone, now) === dayKey(timeZone, due[0]);
    const when = today ? (zonedParts(timeZone, due[0]).hour >= 17 ? "今晚" : "今天") : "明天";
    first.push(`${due.length} 項作業${when} ${localTime(timeZone, due[0])} 截止`);
  }
  const second: string[] = [];
  const todayEnd = Date.parse(dayBounds(timeZone, dayKey(timeZone, now)).end);
  const event = input.agenda.find((item) => item.kind === "event" && !item.allDay && Date.parse(item.start) > now.getTime() && Date.parse(item.start) < todayEnd);
  if (event) second.push(`第一個行程是 ${localTime(timeZone, event.start)} ${event.title}`);
  if (input.gap) second.push(`${localTime(timeZone, input.gap.start)} 後有 ${hoursText(input.gap.hours)} 小時空檔`);
  const sentences = [first, second].filter((clauses) => clauses.length).map((clauses) => `${clauses.join("，")}。`);
  if (sentences.length) return sentences.join("");
  const next = input.upcoming
    .filter((item) => Date.parse(item.start) > now.getTime())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  return `沒有到期的作業，也沒有行程。${next ? `下一個是 ${monthDayWeek(timeZone, next.start)}${localTime(timeZone, next.start)} ${next.title}。` : ""}`;
}

/* ----------------------------------------------------------------------- */
/* Later card and sidebar                                                   */
/* ----------------------------------------------------------------------- */

export const LATER_HORIZON_DAYS = 14;
export const LATER_LIMIT = 3;
export const SIDEBAR_PROJECT_LIMIT = 5;

export function laterEvents(contributions: TodayContribution[], openIds: ReadonlySet<string>, now: Date, timeZone: string): LaterEvent[] {
  const tomorrow = Date.parse(dayBounds(timeZone, addDays(dayKey(timeZone, now), 1)).start);
  const horizon = now.getTime() + LATER_HORIZON_DAYS * 24 * HOUR;
  return contributions
    .flatMap((contribution) => contribution.later?.events ?? [])
    .filter((event) => !(event.itemId && openIds.has(event.itemId)))
    .filter((event) => Date.parse(event.start) >= tomorrow && Date.parse(event.start) < horizon)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, LATER_LIMIT)
    .map((event) => ({ date: monthDay(timeZone, event.start), label: dayLabel(timeZone, event.start, now), title: event.title, meta: event.meta, start: event.start }));
}

/** Projects first (one slot is kept for a waiting PR when there is one), then PRs; at most 3. */
export function laterProjects(contributions: TodayContribution[]): LaterProject[] {
  const all = contributions.flatMap((contribution) => contribution.later?.projects ?? []);
  const prs = all.filter((item) => item.pr);
  const projects = all.filter((item) => !item.pr).slice(0, prs.length ? LATER_LIMIT - 1 : LATER_LIMIT);
  return [...projects, ...prs].slice(0, LATER_LIMIT);
}

/* ----------------------------------------------------------------------- */
/* The whole payload                                                        */
/* ----------------------------------------------------------------------- */

export interface TodayBuildInput {
  now: Date;
  timeZone: string;
  /** Module contributions in registry order; failed modules are simply absent. */
  contributions: TodayContribution[];
  states: ReadonlyMap<string, ItemStateView>;
  /** Today's closing actions (action_log rows of today, not undone, not failed). */
  handledLog: HandledLogEntry[];
  sources: TodaySource[];
  ai: { enabled: boolean; briefTime: string };
}

export interface TodayBuild {
  payload: TodayPayload;
  /** Open candidates by id, with hints (for action lookups). */
  candidates: Map<string, QueueCandidate>;
}

export function buildToday(input: TodayBuildInput): TodayBuild {
  const { now, timeZone, contributions } = input;
  const { queue, ordered, candidates } = buildQueue(contributions.flatMap((item) => item.queue ?? []), input.states, now, timeZone);
  const openIds = new Set(ordered.map((item) => item.id));
  const handled = handledToday(input.handledLog, openIds);
  const handledBy = countHandledBy(handled);

  const agenda = agendaWithPast(contributions.flatMap((item) => item.agenda ?? []), now);
  const gap = matchGap(agenda, ordered, contributions, now, timeZone);
  const eventStarts = agenda.filter((item) => item.kind === "event" && !item.allDay).map((item) => ({ start: item.start, title: item.title }));
  const nextUpCandidates = [...contributions.flatMap((item) => item.nextUp ?? []), ...eventStarts];
  const nextUp = pickNextUp(nextUpCandidates, now, timeZone);

  const digestByKey = new Map<string, DigestCategory>();
  for (const category of contributions.flatMap((item) => item.digest ?? [])) {
    const current = digestByKey.get(category.key);
    if (current) current.count += category.count;
    else digestByKey.set(category.key, { ...category });
  }
  const categories = [...digestByKey.values()].filter((category) => category.count > 0);
  const digestTotal = categories.reduce((sum, category) => sum + category.count, 0);

  const habits = contributions.flatMap((item) => item.habits ?? []);
  const navParts = contributions.map((item) => item.nav).filter((nav): nav is NonNullable<typeof nav> => !!nav);
  const counts: TodayCounts = {
    open: ordered.length,
    handled: handled.length,
    total: ordered.length + handled.length,
    handledBy,
    inboxUnread: contributions.reduce((sum, item) => sum + (item.inboxUnread ?? 0), 0),
    habitsLeft: habits.filter((habit) => habit.due !== false && !habit.doneToday).length,
    ...(navParts.length ? {
      nav: {
        tasks: navParts.reduce((sum, nav) => sum + (nav.tasks ?? 0), 0),
        work: navParts.reduce((sum, nav) => sum + (nav.work ?? 0), 0),
        events: navParts.reduce((sum, nav) => sum + (nav.events ?? 0), 0),
      },
    } : {}),
  };
  const pace = paceMinutes(handled.map((item) => item.at), counts.open);

  const laterEventList = laterEvents(contributions, openIds, now, timeZone);
  const upcoming = [...nextUpCandidates, ...contributions.flatMap((item) => item.later?.events ?? []).map((event) => ({ start: event.start, title: event.title }))];
  const ruleText = ruleBrief({ ordered, candidates, agenda, gap, upcoming, now, timeZone });
  const contributed = contributions.find((item) => item.brief)?.brief;
  const next = input.ai.enabled ? { next: input.ai.briefTime } : {};
  let brief: TodayBrief;
  if (!input.ai.enabled) brief = { state: "off", text: ruleText, source: "rule" };
  else if (contributed?.state === "ready" && contributed.text) brief = { state: "ready", text: contributed.text, source: "ai", ...(contributed.generatedAt ? { generatedAt: contributed.generatedAt } : {}), ...next };
  else if (contributed && contributed.state !== "ready") brief = { state: contributed.state, text: ruleText, source: "rule", ...(contributed.reason ? { reason: contributed.reason } : {}), ...next };
  else brief = { state: "fallback", text: ruleText, source: "rule", ...next };

  const sidebarProjects: SidebarProject[] = contributions.flatMap((item) => item.sidebar?.projects ?? []).slice(0, SIDEBAR_PROJECT_LIMIT);
  const streaks = contributions.map((item) => item.sidebar?.streakDays).filter((value): value is number => typeof value === "number");
  const weather = contributions.find((item) => item.weather)?.weather;
  const undatedTodos = contributions.reduce((sum, item) => sum + (item.backlog?.undatedTodos ?? 0), 0);

  const payload: TodayPayload = {
    date: dayKey(timeZone, now),
    now: now.toISOString(),
    greeting: greetingFor(now, timeZone),
    ...(weather ? { weather } : {}),
    brief,
    counts,
    ...(pace !== undefined ? { paceMinutes: pace } : {}),
    ...(nextUp ? { nextUp } : {}),
    queue,
    ...(digestTotal > 0 ? { digest: { total: digestTotal, categories } } : {}),
    agenda: { items: agenda, ...(gap ? { gap } : {}) },
    habits,
    ideas: contributions.flatMap((item) => item.ideas ?? []).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 2),
    later: { events: laterEventList, projects: laterProjects(contributions) },
    sources: input.sources,
    handled,
    ...(sidebarProjects.length || streaks.length ? { sidebar: { projects: sidebarProjects, ...(streaks.length ? { streakDays: Math.max(...streaks) } : {}) } } : {}),
    ...(undatedTodos > 0 ? { backlog: { undatedTodos } } : {}),
  };
  return { payload, candidates };
}
