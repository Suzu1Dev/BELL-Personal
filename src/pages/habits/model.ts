/**
 * Pure helpers behind #/habits and the habit hooks Today shares: optimistic
 * toggles (on the Today payload and on page rows), ordering, the edit form
 * and the heat strip's labels. No React, no I/O (tested in model.test.ts).
 */
import { HABIT_LIMITS, cadenceText, charCount, defaultShort, editableDay, streakUnit, type HabitCadence, type HabitCreateRequest, type HabitHeatCell, type HabitSummary, type HabitsResponse } from "../../../shared/habits";
import { addDays, weekdayOf } from "../../../shared/time";
import type { TodayHabit, TodayPayload } from "../../../shared/today";
import { habitsCopy } from "../../copy/habits";
import { onboardingLocale, type OnboardingLocale } from "../../copy/onboarding";

/** Habits still expected today (the core's counts.habitsLeft rule). */
export function habitsLeft(habits: readonly TodayHabit[]): number {
  return habits.filter((habit) => habit.due !== false && !habit.doneToday).length;
}

/**
 * A habit as it looks right after a toggle: today's dot, and a daily streak
 * one longer or shorter (weekly streaks wait for the server). A no-op when
 * the habit already shows that state.
 */
export function flipHabit<T extends TodayHabit>(habit: T, done: boolean): T {
  if (habit.doneToday === done) return habit;
  const week = [...habit.week];
  week[week.length - 1] = done ? "y" : "n";
  const streak = habit.streakUnit === "天" ? Math.max(0, habit.streak + (done ? 1 : -1)) : habit.streak;
  return { ...habit, doneToday: done, week, streak };
}

/**
 * The Today payload after toggling habit `id`: the flipped habit (or, once
 * the server answered, its own view) and counts.habitsLeft recomputed.
 * Re-applying it to a payload that already reflects the change is a no-op.
 */
export function toggleTodayHabit(payload: TodayPayload, id: string, done: boolean, server?: TodayHabit): TodayPayload {
  const index = payload.habits.findIndex((habit) => habit.id === id);
  if (index < 0) return payload;
  const current = payload.habits[index];
  if (!server && current.doneToday === done) return payload;
  const habits = payload.habits.map((habit, position) => (position === index ? (server ?? flipHabit(habit, done)) : habit));
  return { ...payload, habits, counts: { ...payload.counts, habitsLeft: habitsLeft(habits) } };
}

/** A page row after a toggle of `day` (today): the Today fields plus the heat cell and the week count. */
export function flipSummary(summary: HabitSummary, done: boolean): HabitSummary {
  const flipped = flipHabit(summary, done);
  if (flipped === summary) return summary;
  const today = summary.heat.findLast((cell) => cell.state !== "off")?.day;
  return {
    ...flipped,
    heat: summary.heat.map((cell) => (cell.day === today ? { ...cell, state: done ? "y" : "n" } : cell)),
    ...(summary.weekDone !== undefined ? { weekDone: Math.max(0, summary.weekDone + (done ? 1 : -1)) } : {}),
  };
}

/** The list with one habit replaced by the server's view (moved between active and archived when that changed). */
export function replaceSummary(data: HabitsResponse, summary: HabitSummary): HabitsResponse {
  const without = (list: HabitSummary[]) => list.filter((item) => item.id !== summary.id);
  const inPlace = (list: HabitSummary[]) => list.map((item) => (item.id === summary.id ? summary : item));
  const wasActive = data.habits.some((item) => item.id === summary.id);
  if (summary.archived) return { ...data, habits: without(data.habits), archived: data.archived.some((item) => item.id === summary.id) ? inPlace(data.archived) : [...data.archived, summary] };
  if (wasActive) return { ...data, habits: inPlace(data.habits) };
  return { ...data, habits: [...data.habits, summary], archived: without(data.archived) };
}

export function updateSummary(data: HabitsResponse, id: string, change: (summary: HabitSummary) => HabitSummary): HabitsResponse {
  return { ...data, habits: data.habits.map((item) => (item.id === id ? change(item) : item)) };
}

/** The ids after moving `id` one place up (-1) or down (+1); undefined at either end. */
export function moveHabit(ids: readonly string[], id: string, delta: -1 | 1): string[] | undefined {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return undefined;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Keys 1–9 follow the order; the tenth habit and later have none. */
export const habitKey = (index: number): number | undefined => (index < 9 ? index + 1 : undefined);

/** Weekday initials for the heat strip's columns. */
export function weekdayHeads(weekStartsMonday: boolean, locale: OnboardingLocale = onboardingLocale()): string[] {
  const weekdays = habitsCopy(locale).habitModel.weekdays;
  const monday = [weekdays.mon, weekdays.tue, weekdays.wed, weekdays.thu, weekdays.fri, weekdays.sat, weekdays.sun];
  return weekStartsMonday ? monday : [weekdays.sun, ...monday.slice(0, 6)];
}

export function habitCadence(summary: HabitSummary, locale: OnboardingLocale = onboardingLocale(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return cadenceText({ ...summary, cadence: summary.cadenceKind }, {
    doneToday: summary.doneToday,
    checkedAt: summary.checkedAt,
    weekDone: summary.weekDone ?? 0,
    timeZone,
  }, locale);
}

export function habitStreakUnit(summary: Pick<HabitSummary, "cadenceKind" | "streak">, locale: OnboardingLocale = onboardingLocale()): string {
  return streakUnit(summary.cadenceKind, summary.streak, locale);
}

/** The column of `day` in a week (0–6). */
export function weekColumn(day: string, weekStartsMonday: boolean): number {
  const weekday = weekdayOf(day);
  return weekStartsMonday ? (weekday + 6) % 7 : weekday;
}

/** Days done in the heat strip (for its aria-label). */
export const heatDone = (summary: HabitSummary) => summary.heat.filter((cell) => cell.state === "y").length;

export const yesterdayOf = (day: string) => addDays(day, -1);

/** Whether yesterday is checked, from the 7-day strip (index 5). */
export const doneYesterday = (summary: HabitSummary) => summary.week[5] === "y";

/**
 * What pressing a heat-strip cell does: check that day in, or take its
 * check-in back. Nothing for the automatic habit, for days outside the
 * habit's life (future, before it existed) and for days further back than
 * the server accepts (HABIT_LIMITS.editableDays).
 */
export function heatCellAction(cell: HabitHeatCell, today: string, auto: boolean): "check" | "uncheck" | undefined {
  if (auto || cell.state === "off" || !editableDay(cell.day, today)) return undefined;
  return cell.state === "y" ? "uncheck" : "check";
}

/**
 * Where the focus goes in a heat strip (7 columns, the weeks as rows) on an
 * arrow key, Home or End: ← → one day, ↑ ↓ one week, skipping cells that
 * cannot be pressed; at an edge it stays. Undefined for any other key, so
 * the key does what it did before.
 */
export function heatFocusTarget(cells: readonly HabitHeatCell[], pressable: (cell: HabitHeatCell) => boolean, from: string, key: string): string | undefined {
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  const indexes = cells.flatMap((cell, index) => (pressable(cell) ? [index] : []));
  if (!indexes.length) return undefined;
  if (key === "Home") return cells[indexes[0]].day;
  if (key === "End") return cells[indexes[indexes.length - 1]].day;
  const step = steps[key];
  if (step === undefined) return undefined;
  const start = cells.findIndex((cell) => cell.day === from);
  if (start < 0) return cells[indexes[indexes.length - 1]].day;
  for (let index = start + step; index >= 0 && index < cells.length; index += step) {
    if (pressable(cells[index])) return cells[index].day;
  }
  return from;
}

/** 「11/3」 for a day key. */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${month}/${date}`;
}

/* ------------------------------------------------------------------ form */

export interface HabitForm {
  name: string;
  cadence: HabitCadence;
  timesPerWeek: number;
  short: string;
  hint: string;
  keywords: string;
}

export const emptyHabitForm = (): HabitForm => ({ name: "", cadence: "daily", timesPerWeek: 3, short: "", hint: "", keywords: "" });

export function formFromSummary(summary: HabitSummary, locale: OnboardingLocale = onboardingLocale()): HabitForm {
  return {
    name: summary.name,
    cadence: summary.cadenceKind,
    timesPerWeek: summary.timesPerWeek ?? 3,
    // Show the short label only when it differs from the automatic one.
    short: summary.short === defaultShort(summary.name) ? "" : summary.short,
    hint: summary.hint ?? "",
    keywords: (summary.keywords ?? []).join(habitsCopy(locale).habitModel.keywordsJoiner),
  };
}

/** 「健身、跑步, 重訓」 → ["健身", "跑步", "重訓"]: unique, trimmed, at most 10 of 20 characters. */
export function parseKeywords(text: string): string[] {
  const words = text.split(/[,，、;；\s]+/).map((word) => Array.from(word.trim()).slice(0, HABIT_LIMITS.keyword).join("")).filter(Boolean);
  return [...new Set(words)].slice(0, HABIT_LIMITS.keywords);
}

export interface HabitFormErrors {
  name?: "required";
  short?: "length";
}

export function validateHabitForm(form: HabitForm): HabitFormErrors {
  const errors: HabitFormErrors = {};
  if (!form.name.trim()) errors.name = "required";
  const short = form.short.trim();
  if (short && (charCount(short) < HABIT_LIMITS.shortMin || charCount(short) > HABIT_LIMITS.shortMax)) errors.short = "length";
  return errors;
}

/** The POST / PATCH body. The automatic habit only takes its name and short label. */
export function habitBody(form: HabitForm, auto = false): HabitCreateRequest {
  const name = form.name.trim();
  const short = form.short.trim();
  if (auto) return { name, short };
  return {
    name,
    cadence: form.cadence,
    ...(form.cadence === "weekly" ? { timesPerWeek: form.timesPerWeek } : {}),
    short,
    hint: form.hint.trim(),
    keywords: parseKeywords(form.keywords),
  };
}

/** What the ⋯ menu measures when it opens (px, viewport coordinates). */
export interface MenuRoom {
  buttonTop: number;
  buttonBottom: number;
  menuHeight: number;
  viewportHeight: number;
  /** The sticky topbar's bottom edge (0 when there is none). */
  topEdge?: number;
  /** Where the fixed quickbar starts (≤720), else the viewport bottom. */
  bottomEdge?: number;
}

/** The menu's gap from its button and the room it keeps from an edge. */
const MENU_GAP = 4;
const MENU_MARGIN = 8;

/**
 * Whether the ⋯ menu opens upward: only when it does not fit below the
 * button (above the quickbar on phones) and there is more room above it
 * (below the topbar). A menu that fits below always opens down.
 */
export function menuOpensUp({ buttonTop, buttonBottom, menuHeight, viewportHeight, topEdge = 0, bottomEdge }: MenuRoom): boolean {
  const below = Math.min(bottomEdge ?? viewportHeight, viewportHeight) - buttonBottom - MENU_GAP - MENU_MARGIN;
  if (menuHeight <= below) return false;
  const above = buttonTop - Math.max(topEdge, 0) - MENU_GAP - MENU_MARGIN;
  return above > below;
}
