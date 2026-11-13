/**
 * Pure view rules for the Today page (SPEC-ux §4): chips and filters, the
 * cursor, which action a key or a touch runs, the hero title, snooze times,
 * the agenda timeline and the small phrases built from the payload. No DOM,
 * no React, no clock of its own: every time is relative to the payload's
 * `now`, in Asia/Taipei, so tests and the fixture override are stable.
 * Counts are never recomputed here; they come from `payload.counts`.
 */
import { DEFAULT_TIME_ZONE, addDays, dayKey, daysBetween, localTime, weekdayOf, zonedTimeToUtc, type DayKey } from "../../../shared/time";
import type {
  QueueAction, QueueActionKey, QueueGroup, QueueItem, QueueKind, TodayAgendaItem, TodayGap, TodayHabit, TodayPayload, TodaySource,
} from "../../../shared/today";
import { hiddenRows } from "../../../shared/today-logic";
import { monthDay, receivedWhen, relativeStart, weekdayChar } from "../../../shared/today-format";
import { extractAssignment } from "../../../shared/assignment-detect";
import { ACTION_TOASTS } from "../../copy/common";
import { LATER, SNOOZE, TIME_WORDS } from "../../copy/today";

/** Every Today time is shown in the app's zone (decisions.md item 15). */
export const TODAY_TZ = DEFAULT_TIME_ZONE;

/* ------------------------------------------------------------------ chips */

export const QUEUE_FILTERS = ["all", "mail", "work", "github", "events", "tasks"] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number];
export type SourceFilter = Exclude<QueueFilter, "all">;

/** Which chip a row belongs to (信件 · 作業 · GitHub · 活動 · 待辦). */
export function filterOfKind(kind: QueueKind): SourceFilter {
  switch (kind) {
    case "mail.reply":
    case "mail.bill":
    case "mail.action":
      return "mail";
    case "assignment":
    case "suggestion.assignment":
      return "work";
    case "review":
    case "pr.changes":
      return "github";
    case "suggestion.event":
    case "event.decide":
      return "events";
    case "todo":
    case "suggestion.todo":
      return "tasks";
  }
}

/** The source ids (TodaySource.id) behind each chip; a broken one turns the chip into `.chip.is-error`. */
export const FILTER_SOURCE_IDS: Record<SourceFilter, readonly string[]> = {
  mail: ["gmail"],
  work: ["moodle", "canvas"],
  github: ["github"],
  events: ["ctftime", "feeds"],
  tasks: [],
};

/** Sources whose failure means queue rows may be missing (SPEC-ux §5 state 03). */
export const QUEUE_SOURCE_IDS: readonly string[] = ["gmail", "moodle", "canvas", "github", "ctftime", "feeds"];
/** Sources the agenda reads. */
export const CALENDAR_SOURCE_IDS: readonly string[] = ["google-calendar", "ics"];
/** Sources that feed 明天與之後. */
export const LATER_EVENT_SOURCE_IDS: readonly string[] = ["google-calendar", "ics", "ctftime", "feeds"];

export const isBroken = (source: TodaySource) => source.state === "reconnect" || source.state === "error";

export interface ChipView {
  value: QueueFilter;
  count?: number;
  /** The disconnected source behind the chip (dashed, no count). */
  broken?: TodaySource;
}

export function allItems(payload: TodayPayload): QueueItem[] {
  return payload.queue.flatMap((group) => group.items);
}

/**
 * 全部 plus one chip per filter that has rows or a broken source (SPEC-ux
 * §4.3 header, state 03). Counts are the rows on screen; held-back new rows
 * (「有 N 件新的」) are not counted until they are shown.
 */
export function queueChips(payload: TodayPayload, held: ReadonlySet<string> = new Set()): ChipView[] {
  const counts = new Map<SourceFilter, number>();
  let total = 0;
  for (const item of allItems(payload)) {
    if (held.has(item.id)) continue;
    total++;
    const filter = filterOfKind(item.kind);
    counts.set(filter, (counts.get(filter) ?? 0) + 1);
  }
  const chips: ChipView[] = [{ value: "all", count: total }];
  for (const value of QUEUE_FILTERS) {
    if (value === "all") continue;
    const broken = payload.sources.find((source) => FILTER_SOURCE_IDS[value].includes(source.id) && isBroken(source));
    const count = counts.get(value) ?? 0;
    if (broken) chips.push({ value, broken });
    else if (count > 0) chips.push({ value, count });
  }
  return chips;
}

export interface GroupView {
  group: QueueGroup;
  /** Every row that matches the filter. */
  items: QueueItem[];
  /** The rows on screen (capped unless expanded). */
  shown: QueueItem[];
  /** Rows behind 「還有 N 件 · 顯示全部」. */
  hidden: number;
  /** Rows beyond the cap whether or not the group is expanded (offers 收合 once expanded). */
  overflow: number;
}

/** The groups as displayed: filter, held-back rows removed, caps applied (SPEC-ux §4.3 "Caps"). Empty groups are dropped. */
export function queueView(
  payload: TodayPayload,
  filter: QueueFilter,
  held: ReadonlySet<string> = new Set(),
  expanded: ReadonlySet<QueueGroup> = new Set(),
): GroupView[] {
  return payload.queue
    .map((group) => {
      const items = group.items.filter((item) => !held.has(item.id) && (filter === "all" || filterOfKind(item.kind) === filter));
      const overflow = hiddenRows(group, items.length);
      const hidden = expanded.has(group.group) ? 0 : overflow;
      return { group: group.group, items, shown: items.slice(0, items.length - hidden), hidden, overflow };
    })
    .filter((group) => group.items.length > 0);
}

/** Row ids in DOM order. */
export function rowOrder(groups: GroupView[]): string[] {
  return groups.flatMap((group) => group.shown.map((item) => item.id));
}

/* ----------------------------------------------------------------- cursor */

/** J/K: the next or previous row; the first row when there is no cursor yet. */
export function moveCursor(order: readonly string[], current: string | undefined, delta: number): string | undefined {
  if (!order.length) return undefined;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return order[0];
  return order[Math.max(0, Math.min(order.length - 1, index + delta))];
}

/** After an action the cursor moves to the next row in DOM order, or the previous one if it was last (SPEC-ux §4.3). */
export function cursorAfterRemoval(order: readonly string[], removed: string): string | undefined {
  const index = order.indexOf(removed);
  if (index < 0) return order[0];
  return order[index + 1] ?? order[index - 1];
}

/**
 * New rows from a refresh (SPEC-ux §6.1): those below the cursor are
 * inserted silently; any that would land above it are held back behind the
 * 「有 N 件新的 · 顯示」 pill so the list never jumps under the user.
 */
export function arrivals(order: readonly string[], known: ReadonlySet<string>, cursor: string | undefined): { silent: string[]; held: string[] } {
  const fresh = order.filter((id) => !known.has(id));
  if (!fresh.length) return { silent: [], held: [] };
  const cursorIndex = cursor ? order.indexOf(cursor) : -1;
  if (cursorIndex < 0) return { silent: fresh, held: [] };
  const silent: string[] = [];
  const held: string[] = [];
  for (const id of fresh) (order.indexOf(id) > cursorIndex ? silent : held).push(id);
  return { silent, held };
}

/* ---------------------------------------------------------------- actions */

/** The action a key runs on a row: ↵ is the row's Enter action or its primary; E/S/T/C match the action's key. */
export function actionForKey(item: QueueItem, key: QueueActionKey): QueueAction | undefined {
  const match = item.actions.find((action) => action.key === key);
  if (match) return match;
  return key === "Enter" ? item.actions[0] : undefined;
}

/** The one visible labelled action on touch (`.q-primary`): assignments offer 已交, everything else its primary (SPEC-ux §4.3 table). */
export function touchPrimary(item: QueueItem): QueueAction | undefined {
  if (item.kind === "assignment") return item.actions.find((action) => action.id === "submitted") ?? item.actions[0];
  return item.actions[0];
}

/**
 * A mail row's hover set (SPEC-mail-assignments §2.2): its primary, then the
 * first 封存 or 移回收件匣, then 刪除; duplicates dropped, at most 3
 * (回覆 · 封存 · 刪除, 標為已讀 · 封存 · 刪除, 封存 · 刪除, 移回收件匣 · 刪除).
 */
export function mailHoverActions(actions: readonly QueueAction[]): QueueAction[] {
  const picked: QueueAction[] = [];
  const add = (action: QueueAction | undefined) => { if (action && !picked.some((entry) => entry.id === action.id)) picked.push(action); };
  add(actions[0]);
  add(actions.find((action) => action.id === "archive" || action.id === "unarchive"));
  add(actions.find((action) => action.id === "trash"));
  return picked.slice(0, 3);
}

export const isMailRow = (item: Pick<QueueItem, "kind">) => item.kind.startsWith("mail.");

/**
 * The toast 轉成作業 (A) shows on a Today mail row until the server answers:
 * the rules' title from the row's subject, without a deadline. The row knows
 * neither the mail's text nor the day it arrived, so a deadline read from its
 * summary (「明天」, 「週五」) could name another day; the answer replaces the
 * text with the saved title and deadline (ActionAccepted.created) a moment later.
 */
export function mailAssignmentToast(item: QueueItem, timeZone = TODAY_TZ): string {
  const draft = extractAssignment({
    subject: item.subject ?? item.title, from: { email: "", ...(item.meta[0] ? { name: item.meta[0] } : {}) },
    text: "", receivedAt: new Date(0).toISOString(),
  }, { schoolDomains: [], timeZone });
  return ACTION_TOASTS.assignment(draft.title);
}

/** Hover actions (`.q-acts`): at most 3; mail rows show their primary, 封存 and 刪除. */
export function hoverActions(item: QueueItem): QueueAction[] {
  return isMailRow(item) ? mailHoverActions(item.actions) : item.actions.slice(0, 3);
}

/** Close-style actions that stay quiet (ghost) next to the primary: 封存, 刪除, 略過. */
export const QUIET_ACTIONS: ReadonlySet<string> = new Set(["archive", "trash", "dismiss"]);

/** Button look inside the expanded row: primary first, archive and skip as ghosts, the rest secondary. */
export function detailVariant(action: QueueAction, index: number): "primary" | "secondary" | "ghost" {
  if (index === 0) return "primary";
  return QUIET_ACTIONS.has(action.id) ? "ghost" : "secondary";
}

export const KEY_LABELS: Record<QueueActionKey, string> = { Enter: "↵", E: "E", S: "S", T: "T", C: "C", "#": "#", A: "A" };

export const isSuggestion = (item: QueueItem) => item.kind === "suggestion.event" || item.kind === "suggestion.todo" || item.kind === "suggestion.assignment";

/** A row whose page is inside the app (an assignment from mail opens `#/inbox/<threadId>`): no new tab. */
export const isInAppUrl = (url: string | undefined): url is string => !!url && url.startsWith("#/");

/** Whether a row has an action that opens the same external page as its `.link.ext` would. */
export function opensExternally(item: QueueItem): boolean {
  return item.actions.some((action) => action.id === "open") && !!item.url;
}

/* ------------------------------------------------------------------- hero */

export type HeroTitle =
  | { kind: "open"; greeting: string; count: number }
  | { kind: "cleared" }
  | { kind: "empty"; greeting: string };

/** SPEC-ux §4.2: rule-generated, never by AI. */
export function heroTitle(payload: Pick<TodayPayload, "greeting" | "counts">): HeroTitle {
  const { open, handled } = payload.counts;
  if (open > 0) return { kind: "open", greeting: payload.greeting, count: open };
  if (handled > 0) return { kind: "cleared" };
  return { kind: "empty", greeting: payload.greeting };
}

/** The rain segment's time, only for ≥ 50 % (SPEC-ux §4.2). */
export function rainTime(weather: TodayPayload["weather"], timeZone = TODAY_TZ): { time: string; pct: number } | undefined {
  const rain = weather?.rain;
  if (!rain || rain.pct < 50) return undefined;
  return { time: localTime(timeZone, rain.from), pct: rain.pct };
}

export const isRainy = (text: string) => /雨|雷/.test(text);

/* ------------------------------------------------------------------ times */

/** 「08:12」 today, 「昨天 22:10」, else 「10/9 22:10」: the stale-note and 上次同步 phrase. */
export function sincePhrase(iso: string, nowIso: string, timeZone = TODAY_TZ): string {
  const days = daysBetween(dayKey(timeZone, iso), dayKey(timeZone, nowIso));
  const time = localTime(timeZone, iso);
  if (days <= 0) return time;
  if (days === 1) return `${TIME_WORDS.yesterday} ${time}`;
  return `${monthDay(timeZone, iso)} ${time}`;
}

/** The oldest successful sync among the given sources in `state`, for the stale note. */
export function oldestSync(sources: TodaySource[], ids: readonly string[], states: TodaySource["state"][] = ["stale"]): string | undefined {
  return sources
    .filter((source) => ids.includes(source.id) && states.includes(source.state) && source.lastSyncedAt)
    .map((source) => source.lastSyncedAt!)
    .sort()[0];
}

/** An idea's age in `.recent`: 「08:05」 today, 「昨天」, 「10/9」. */
export function ideaWhen(at: string, nowIso: string, timeZone = TODAY_TZ): string {
  return receivedWhen(at, new Date(nowIso), timeZone).label;
}

/* ----------------------------------------------------------------- snooze */

export type SnoozeOptionId = "tonight" | "tomorrow" | "saturday" | "nextMonday";

export interface SnoozeOption {
  id: SnoozeOptionId;
  label: string;
  until: string;
  /** past: already gone today. limit: beyond deadline − 2 h (「會超過截止時間」). */
  disabled?: "past" | "limit";
}

/** 今晚 20:00 · 明天 08:00 · 週六 09:00 · 下週一 08:00 (SPEC-ux §6.4), local to Asia/Taipei. */
export function snoozeOptions(nowIso: string, snoozeLimit?: string, timeZone = TODAY_TZ): SnoozeOption[] {
  const now = Date.parse(nowIso);
  const today = dayKey(timeZone, nowIso);
  const weekday = weekdayOf(today);
  const at = (day: DayKey, hour: number, minute = 0) => zonedTimeToUtc(timeZone, day, hour, minute).toISOString();
  const saturday = addDays(today, (6 - weekday + 7) % 7 || 7);
  const monday = addDays(today, (1 - weekday + 7) % 7 || 7);
  const options: SnoozeOption[] = [
    { id: "tonight", label: SNOOZE.tonight, until: at(today, 20) },
    { id: "tomorrow", label: SNOOZE.tomorrow, until: at(addDays(today, 1), 8) },
    { id: "saturday", label: SNOOZE.saturday, until: at(saturday, 9) },
    { id: "nextMonday", label: SNOOZE.nextMonday, until: at(monday, 8) },
  ];
  const limit = snoozeLimit ? Date.parse(snoozeLimit) : Infinity;
  return options.map((option) => {
    const until = Date.parse(option.until);
    if (until <= now) return { ...option, disabled: "past" };
    if (until > limit) return { ...option, disabled: "limit" };
    return option;
  });
}

/** A `datetime-local` value ("2026-10-12T20:00") for an instant, in the app's zone. */
export function toLocalInput(iso: string, timeZone = TODAY_TZ): string {
  return `${dayKey(timeZone, iso)}T${localTime(timeZone, iso)}`;
}

/** 「今天 21:30」 / 「明天 09:00」 / 「10/14 09:00」 for a picked snooze time. */
export function whenLabel(iso: string, nowIso: string, timeZone = TODAY_TZ): string {
  const days = daysBetween(dayKey(timeZone, nowIso), dayKey(timeZone, iso));
  const time = localTime(timeZone, iso);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `明天 ${time}`;
  return SNOOZE.custom(monthDay(timeZone, iso), time);
}

/**
 * 「選擇時間…」: a `datetime-local` value → the snooze instant, or why not
 * (in the past, or past the row's snoozeLimit).
 */
export function customSnooze(
  value: string, nowIso: string, snoozeLimit?: string, timeZone = TODAY_TZ,
): { until: string; label: string } | { error: "invalid" | "past" | "limit" } {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return { error: "invalid" };
  const until = zonedTimeToUtc(timeZone, match[1], Number(match[2]), Number(match[3]));
  if (Number.isNaN(until.getTime())) return { error: "invalid" };
  if (until.getTime() <= Date.parse(nowIso)) return { error: "past" };
  if (snoozeLimit && until.getTime() > Date.parse(snoozeLimit)) return { error: "limit" };
  const iso = until.toISOString();
  return { until: iso, label: whenLabel(iso, nowIso, timeZone) };
}

/* ----------------------------------------------------------------- habits */

/** The `.h-days` header: seven weekday initials ending today (「二 三 四 五 六 日 一」 on a Monday). */
export function weekHeader(date: DayKey): { label: string; today: boolean }[] {
  return Array.from({ length: 7 }, (_, index) => ({ label: weekdayChar(addDays(date, index - 6)), today: index === 6 }));
}

export const CHIP_HABITS = 3;

/** Habits still expected today (the celebration's 「還差 N 個習慣」). */
export function habitsLeft(habits: TodayHabit[]): TodayHabit[] {
  return habits.filter((habit) => habit.due !== false && !habit.doneToday);
}


/* ----------------------------------------------------------------- agenda */

export type TimelineRow =
  | { type: "now"; time: string }
  | { type: "item"; item: TodayAgendaItem; soon?: string }
  | { type: "gap"; gap: TodayGap }
  | { type: "fold"; count: number };

/** Past rows beyond this many fold into 「已結束 N 個 · 顯示」 (SPEC-ux §4.8). */
export const PAST_FOLD_AFTER = 2;

const startOf = (item: TodayAgendaItem) => Date.parse(item.start);

/**
 * The agenda in display order: past rows (folded when more than two, except
 * the ones `keep` says still need a tap, like a habit check-in), the 現在
 * line before the first item that has not started, the free slot at its
 * start time, and 「N 小時 M 分後」 on the next event only.
 */
export function buildTimeline(
  agenda: TodayPayload["agenda"], nowIso: string, showPast: boolean, timeZone = TODAY_TZ, keep: (item: TodayAgendaItem) => boolean = () => false,
): TimelineRow[] {
  const items = [...agenda.items].sort((a, b) => startOf(a) - startOf(b));
  if (!items.length) return [];
  const now = Date.parse(nowIso);
  const nowDate = new Date(nowIso);
  const past = items.filter((item) => item.past);
  const rest = items.filter((item) => !item.past);
  const rows: TimelineRow[] = [];
  const foldable = past.filter((item) => !keep(item));
  if (foldable.length > PAST_FOLD_AFTER && !showPast) {
    rows.push({ type: "fold", count: foldable.length });
    for (const item of past) if (keep(item)) rows.push({ type: "item", item });
  } else {
    for (const item of past) rows.push({ type: "item", item });
  }

  const next = rest.find((item) => item.kind === "event" && !item.allDay && startOf(item) > now);
  let nowPlaced = false;
  let gapPlaced = !agenda.gap;
  for (const item of rest) {
    if (!nowPlaced && startOf(item) > now) {
      rows.push({ type: "now", time: localTime(timeZone, nowIso) });
      nowPlaced = true;
    }
    if (!gapPlaced && agenda.gap && Date.parse(agenda.gap.start) <= startOf(item) && startOf(item) > now) {
      rows.push({ type: "gap", gap: agenda.gap });
      gapPlaced = true;
    }
    rows.push({ type: "item", item, ...(item === next ? { soon: relativeStart(item.start, nowDate, timeZone) } : {}) });
  }
  if (!nowPlaced) rows.push({ type: "now", time: localTime(timeZone, nowIso) });
  if (!gapPlaced && agenda.gap) rows.push({ type: "gap", gap: agenda.gap });
  return rows;
}

/** 「4」, 「1.5」 hours for the free slot. */
export function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

/** 排進 blocks the gap, or the item's estimate when that is shorter (SPEC-ux §4.8). */
export function scheduleWindow(gap: TodayGap): { start: string; end: string } {
  const start = Date.parse(gap.start);
  const end = gap.estimateMinutes !== undefined ? start + gap.estimateMinutes * 60_000 : Date.parse(gap.end ?? gap.start) || start + gap.hours * 3_600_000;
  return { start: gap.start, end: new Date(end).toISOString() };
}

/* ------------------------------------------------------------------ later */

/** The ≤720 `.later-sum` line: 「明天 09:00 計算機網路」 (bold) · 本週還有 3 個活動 · 3 個專案進行中. */
export function laterSummary(payload: TodayPayload): { lead?: string; rest: string[] } {
  const first = payload.later.events[0];
  const projects = payload.sidebar?.projects.length ?? payload.later.projects.filter((project) => !project.pr).length;
  const rest: string[] = [];
  if (payload.later.events.length) rest.push(LATER.sumEvents(payload.later.events.length));
  if (projects) rest.push(LATER.sumProjects(projects));
  return { ...(first ? { lead: LATER.sumFirst(first.label, first.title) } : {}), rest };
}

/* -------------------------------------------------------------- first run */

/**
 * Sources #/setup step 1 lists as needing no setup (keyless or detected:
 * weather, CTFtime, the `gh` login) do not count as "connected", and the
 * queue rows they add on their own (a CTF to decide on, a review request)
 * are not the user's data: CTFtime syncs at boot once it is on (the CTF 選手
 * switch in 初次設定, or kept on by an upgrade), so a first run can already
 * have rows.
 */
const SETUP_FREE_SOURCES: ReadonlySet<string> = new Set(["weather", "ctftime", "github"]);

const itemSource = (itemId: string) => itemId.slice(0, Math.max(0, itemId.indexOf(":")));

/**
 * First run (SPEC-ux §3.4): nothing connected and no native data yet → the
 * page offers #/setup once. Today itself still works at zero sources.
 */
export function isFirstRun(payload: TodayPayload): boolean {
  const connected = payload.sources.some((source) => !SETUP_FREE_SOURCES.has(source.id) && source.state !== "off");
  const native = payload.habits.length > 0 || payload.ideas.length > 0 || (payload.counts.nav?.tasks ?? 0) > 0
    || payload.later.projects.some((project) => !project.pr) || (payload.sidebar?.projects.length ?? 0) > 0;
  const ownRows = allItems(payload).some((item) => !SETUP_FREE_SOURCES.has(item.source));
  const ownHandled = payload.handled
    ? payload.handled.some((entry) => !SETUP_FREE_SOURCES.has(itemSource(entry.itemId)))
    : payload.counts.handled > 0;
  return !connected && !native && !ownRows && !ownHandled && payload.agenda.items.length === 0;
}
