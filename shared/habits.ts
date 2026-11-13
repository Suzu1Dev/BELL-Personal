import strings from "../src/copy/habits-events-strings.json";
import { addDays, daysBetween, localTime, weekdayOf, type DayKey } from "./time.js";
import type { TodayHabit } from "./today.js";

export type HabitLocale = Exclude<keyof typeof strings, "$meta">;

/** daily: every day. weekdays: Monday–Friday. weekly: any `timesPerWeek` days of the week (Monday or Sunday start, AppSettings.weekStartsMonday). */
export const HABIT_CADENCES = ["daily", "weekdays", "weekly"] as const;
export type HabitCadence = (typeof HABIT_CADENCES)[number];

export interface Habit {
  id: string;
  name: string;
  cadence: HabitCadence;
  /** weekly only: how many days per week count as done. */
  timesPerWeek?: number;
  /** Check-ins per day that complete the day (default 1). */
  targetPerDay: number;
  archived: boolean;
  /** Ascending display order; keys 1–9 follow it. */
  order: number;
  /** A habit filled in automatically from a source, e.g. GitHub contributions. */
  auto?: { source: "github"; metric: "contributions"; threshold: number };
  /** 2–4 characters for the Today chips (「閱讀」). */
  short?: string;
  /** Free-text cadence note shown as 「每天 · 睡前」. */
  hint?: string;
  /** Agenda event titles that check this habit in (健身/重訓/跑步 → 運動). */
  keywords?: string[];
  createdAt: string;
  updatedAt: string;
}

/** One row per habit and local day (relational table habit_logs, primary key habit_id+day). */
export interface HabitLog {
  habitId: string;
  day: DayKey;
  count: number;
  note?: string;
  createdAt: string;
}

export const HABIT_LIMITS = {
  name: 80, note: 500, perDay: 20, active: 30,
  /** The short chip label (SPEC §3.3: 2–4 characters). */
  shortMin: 2, shortMax: 4,
  hint: 40, keywords: 10, keyword: 20,
  timesPerWeekMin: 1, timesPerWeekMax: 7,
  /** Weeks in the #/habits heat strip. */
  heatWeeks: 5,
  /** How far back a check-in may be added or removed (the heat strip's span). */
  editableDays: 35,
} as const;

/**
 * The automatic habit 「GitHub 有貢獻」 (habits.githubAuto): one fixed id, done
 * on days the GitHub contribution calendar counts at least one contribution.
 * It cannot be checked by hand.
 */
export const AUTO_HABIT_ID = "github-auto";

export const isAutoHabit = (habit: { id: string }) => habit.id === AUTO_HABIT_ID;

/** Whether a check-in is expected on that day. Weekly habits are expected every day until the week's goal is met. */
export function habitDueOn(habit: Pick<Habit, "cadence">, day: DayKey): boolean {
  if (habit.cadence === "weekdays") {
    const weekday = weekdayOf(day);
    return weekday >= 1 && weekday <= 5;
  }
  return true;
}

/** The first day of the week containing `day`: Monday, or Sunday when the week starts on Sunday. */
export function weekStartOf(day: DayKey, weekStartsMonday = true): DayKey {
  const weekday = weekdayOf(day);
  return addDays(day, -(weekStartsMonday ? (weekday + 6) % 7 : weekday));
}

/**
 * Consecutive due days completed, counting back from today. Today not yet
 * done does not break the streak; it simply is not counted yet. Weekly
 * habits count completed weeks instead of days (the current week only
 * counts once its goal is met, and never breaks the streak while it runs).
 */
export function habitStreak(
  habit: Pick<Habit, "cadence" | "targetPerDay" | "timesPerWeek">,
  logs: Pick<HabitLog, "day" | "count">[],
  today: DayKey,
  limit = 3660,
  weekStartsMonday = true,
): number {
  const done = doneDays(habit, logs);
  if (habit.cadence === "weekly") {
    const goal = weeklyGoal(habit);
    let start = weekStartOf(today, weekStartsMonday);
    let streak = 0;
    for (let week = 0; week < limit / 7; week++) {
      if (countInWeek(done, start) >= goal) streak++;
      else if (week > 0) break;
      start = addDays(start, -7);
    }
    return streak;
  }
  let streak = 0;
  let day = today;
  for (let index = 0; index < limit; index++, day = addDays(day, -1)) {
    if (!habitDueOn(habit, day)) continue;
    if (done.has(day)) streak++;
    else if (day !== today) break;
  }
  return streak;
}

/* ----------------------------------------------------------------------- */
/* Views: what #/habits and Today show for a habit (computed on the server). */
/* ----------------------------------------------------------------------- */

/** A day of the history: done, missed, not required that day, or outside the habit's life (future, before it existed). */
export type HabitDayState = "y" | "n" | "rest" | "off";

export interface HabitHeatCell {
  day: DayKey;
  state: HabitDayState;
}

/** A row of GET /api/habits: the habit, its Today shape and its 5-week history. */
export interface HabitSummary extends TodayHabit {
  cadenceKind: HabitCadence;
  timesPerWeek?: number;
  hint?: string;
  keywords?: string[];
  order: number;
  archived: boolean;
  /** The automatic 「GitHub 有貢獻」 habit (read-only check-ins). */
  auto: boolean;
  /** ISO time of today's check-in, when there is one (undo restores it). */
  checkedAt?: string;
  /** weekly: days done in the current week. */
  weekDone?: number;
  /** HABIT_LIMITS.heatWeeks full weeks, oldest first; the last week is the current one. */
  heat: HabitHeatCell[];
  createdAt: string;
}

/** GET /api/habits. */
export interface HabitsResponse {
  day: DayKey;
  weekStartsMonday: boolean;
  /** AppSettings habits.githubAuto. */
  githubAuto: boolean;
  /** Contribution days cached from GitHub (0 = GitHub not connected yet). */
  githubDays: number;
  habits: HabitSummary[];
  archived: HabitSummary[];
}

/** POST /api/habits → 201 HabitSummary. Empty strings mean "not set". */
export interface HabitCreateRequest {
  name: string;
  cadence?: HabitCadence;
  /** Required for weekly. */
  timesPerWeek?: number;
  short?: string;
  hint?: string;
  keywords?: string[];
}

/** PATCH /api/habits/:id → HabitSummary. */
export type HabitUpdateRequest = Partial<HabitCreateRequest> & { archived?: boolean };

/** PUT /api/habits/order { ids } → HabitsResponse: the active habits in their new order. */
export interface HabitOrderRequest {
  ids: string[];
}

/** POST /api/habits/:id/check { day?, at? } → HabitSummary; DELETE /api/habits/:id/check { day? } → HabitSummary. */
export interface HabitCheckRequest {
  /** Local day; default today. At most HABIT_LIMITS.editableDays back, never in the future. */
  day?: DayKey;
  /** Undo of an un-check: restores the original check-in time (must fall on `day`). */
  at?: string;
}

/** DELETE /api/habits/:id/check → the summary plus when the removed check-in had been made (the undo sends it back as `at`). */
export type HabitUncheckResponse = HabitSummary & { previousAt?: string };

/** DELETE /api/habits/:id → 200; the undo toast calls POST /api/trash/restore { token }. */
export interface HabitDeleteResponse {
  undoToken?: string;
}

/** Server-composed cadence lines (SPEC §4.7 `.h-cad`). */
export const HABIT_TEXT = {
  doneAt: (time: string) => `今天 ${time} 完成`,
  done: "今天已完成",
  daily: "每天",
  weekdays: "平日",
  weekly: (times: number, done: number) => `每週 ${times} 次 · ${done}/${times}`,
  withHint: (cadence: string, hint: string) => `${cadence} · ${hint}`,
  autoDone: "今天已有 GitHub 貢獻",
  autoPending: "每天 · GitHub 自動打卡",
  autoName: "GitHub 有貢獻",
  autoShort: "貢獻",
} as const;

const habitFormat = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));

export function habitText(locale: HabitLocale = "zh-TW") {
  if (locale === "zh-TW") return HABIT_TEXT;
  const t = strings[locale].habitModel.cadenceText;
  return {
    doneAt: (time: string) => habitFormat(t.doneAt, { time }),
    done: t.done,
    daily: t.daily,
    weekdays: t.weekdays,
    weekly: (times: number, done: number) => habitFormat(times === 1 ? t.weeklyOne : t.weekly, { times, done }),
    withHint: (cadence: string, hint: string) => habitFormat(t.withHint, { cadence, hint }),
    autoDone: t.autoDone,
    autoPending: t.autoPending,
    autoName: t.autoName,
    autoShort: t.autoShort,
  } as const;
}

export function streakUnit(cadence: HabitCadence, streak: number, locale: HabitLocale = "zh-TW"): string {
  if (locale === "zh-TW") return cadence === "weekly" ? "週" : "天";
  const units = strings[locale].habitModel.units;
  return cadence === "weekly" ? (streak === 1 ? units.weekOne : units.week) : (streak === 1 ? units.dayOne : units.day);
}

/** Characters as the user sees them (CJK and emoji-safe), for the 2–4 character rule. */
export const charCount = (text: string) => Array.from(text).length;

/** A default chip label: the first word of the name, cut to 4 characters (「閱讀 20 分鐘」 → 「閱讀」). */
export function defaultShort(name: string): string {
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0] ?? trimmed;
  const chars = Array.from(first.length >= HABIT_LIMITS.shortMin ? first : trimmed.replace(/\s+/g, ""));
  return chars.slice(0, HABIT_LIMITS.shortMax).join("");
}

export interface HabitDoneDay {
  day: DayKey;
  count: number;
  /** When the day's check-in was made (habit_logs.created_at); absent for automatic days. */
  at?: string;
}

export interface HabitViewOptions {
  today: DayKey;
  timeZone: string;
  weekStartsMonday: boolean;
  /** Local day the habit was created: earlier days are "off", never "missed". */
  createdDay: DayKey;
}

const weeklyGoal = (habit: Pick<Habit, "timesPerWeek">) => Math.max(1, habit.timesPerWeek ?? 1);

function doneDays(habit: Pick<Habit, "targetPerDay">, logs: Pick<HabitLog, "day" | "count">[]): Set<DayKey> {
  const target = Math.max(1, habit.targetPerDay);
  return new Set(logs.filter((log) => log.count >= target).map((log) => log.day));
}

function countInWeek(done: ReadonlySet<DayKey>, start: DayKey): number {
  let count = 0;
  for (let offset = 0; offset < 7; offset++) if (done.has(addDays(start, offset))) count++;
  return count;
}

/**
 * One day's state. Weekly habits never "miss" a single day: a day without a
 * check-in is "rest" while its week is still running or once the week met
 * its goal, and "n" only in a past week that fell short. Today without a
 * check-in is "n" (the UI rings it as today) unless nothing is expected.
 */
export function habitDayState(habit: Pick<Habit, "cadence" | "timesPerWeek">, day: DayKey, done: ReadonlySet<DayKey>, options: HabitViewOptions): HabitDayState {
  const { today, weekStartsMonday, createdDay } = options;
  if (day > today) return "off";
  if (done.has(day)) return "y";
  if (day < createdDay) return "off";
  if (habit.cadence === "weekly") {
    const start = weekStartOf(day, weekStartsMonday);
    const current = start === weekStartOf(today, weekStartsMonday);
    const met = countInWeek(done, start) >= weeklyGoal(habit);
    if (met) return "rest";
    if (current) return day === today ? "n" : "rest";
    return "n";
  }
  return habitDueOn(habit, day) ? "n" : "rest";
}

/** The cadence line: 「今天 07:50 完成」 / 「每週 3 次 · 0/3」 / 「每天 · 睡前」. */
export function cadenceText(
  habit: Pick<Habit, "id" | "cadence" | "timesPerWeek" | "hint">,
  state: { doneToday: boolean; checkedAt?: string; weekDone: number; timeZone: string },
  locale: HabitLocale = "zh-TW",
): string {
  const text = habitText(locale);
  if (isAutoHabit(habit)) return state.doneToday ? text.autoDone : text.autoPending;
  if (state.doneToday) return state.checkedAt ? text.doneAt(localTime(state.timeZone, state.checkedAt)) : text.done;
  const base = habit.cadence === "weekly"
    ? text.weekly(weeklyGoal(habit), state.weekDone)
    : habit.cadence === "weekdays" ? text.weekdays : text.daily;
  return habit.hint ? text.withHint(base, habit.hint) : base;
}

/** Everything #/habits and Today show for one habit, from its logs (or its automatic days). */
export function habitSummary(habit: Habit, logs: HabitDoneDay[], options: HabitViewOptions, locale: HabitLocale = "zh-TW"): HabitSummary {
  const { today, timeZone, weekStartsMonday } = options;
  const done = doneDays(habit, logs);
  const doneToday = done.has(today);
  const weekStart = weekStartOf(today, weekStartsMonday);
  const weekDone = countInWeek(done, weekStart);
  const checkedAt = doneToday ? logs.find((log) => log.day === today)?.at : undefined;
  const state = (day: DayKey) => habitDayState(habit, day, done, options);

  const week = Array.from({ length: 7 }, (_, index) => {
    const value = state(addDays(today, index - 6));
    return value === "off" ? "rest" : value;
  });
  const heatStart = addDays(weekStart, -7 * (HABIT_LIMITS.heatWeeks - 1));
  const heat = Array.from({ length: HABIT_LIMITS.heatWeeks * 7 }, (_, index) => {
    const day = addDays(heatStart, index);
    return { day, state: state(day) };
  });
  const due = habit.cadence === "weekly"
    ? doneToday || weekDone < weeklyGoal(habit)
    : habitDueOn(habit, today);
  const streak = habitStreak(habit, logs, today, 3660, weekStartsMonday);

  return {
    id: habit.id,
    name: habit.name,
    short: habit.short || defaultShort(habit.name),
    cadence: cadenceText(habit, { doneToday, checkedAt, weekDone, timeZone }, locale),
    doneToday,
    week,
    streak,
    streakUnit: streakUnit(habit.cadence, streak, locale) as HabitSummary["streakUnit"],
    due,
    cadenceKind: habit.cadence,
    ...(habit.cadence === "weekly" ? { timesPerWeek: weeklyGoal(habit), weekDone } : {}),
    ...(habit.hint ? { hint: habit.hint } : {}),
    ...(habit.keywords?.length ? { keywords: habit.keywords } : {}),
    order: habit.order,
    archived: habit.archived,
    auto: isAutoHabit(habit),
    ...(checkedAt ? { checkedAt } : {}),
    heat,
    createdAt: habit.createdAt,
  };
}

/** The Today shape of a summary (shared/today.ts TodayHabit), without the page-only fields. */
export function todayHabit(summary: HabitSummary): TodayHabit {
  const { id, name, short, cadence, doneToday, week, streak, streakUnit, due } = summary;
  return { id, name, short, cadence, doneToday, week, streak, streakUnit, ...(due === undefined ? {} : { due }) };
}

/**
 * The sidebar streak card (「連續 12 天」): the shortest streak among the daily
 * habits the user checks by hand, so the card never claims more than every
 * daily habit kept. undefined without such a habit.
 */
export function sidebarStreak(summaries: HabitSummary[]): number | undefined {
  const daily = summaries.filter((summary) => !summary.auto && !summary.archived && summary.cadenceKind !== "weekly");
  if (!daily.length) return undefined;
  return Math.min(...daily.map((summary) => summary.streak));
}

/** Whether `day` may be checked or un-checked today (not in the future, at most HABIT_LIMITS.editableDays back). */
export function editableDay(day: DayKey, today: DayKey): boolean {
  const back = daysBetween(day, today);
  return back >= 0 && back < HABIT_LIMITS.editableDays;
}
