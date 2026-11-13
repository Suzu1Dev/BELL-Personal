/**
 * Habit check-ins shared by #/habits and Today (SPEC-ux §4.7, §6.2, §6.4):
 *
 *   const toggle = useHabitToggle();      // .hcheck buttons, chips, 「打卡「運動」」
 *   useHabitKeys(habits, toggle);         // keys 1–9 toggle habit n for today
 *   useTodayHabitKeys();                  // both, over useToday().data.habits
 *
 * A toggle is optimistic on the Today store (the habit, its dot and
 * counts.habitsLeft move at once), then POST or DELETE
 * /api/habits/:id/check; the server's view replaces the guess and Today
 * refreshes. Checking in shows no toast; un-checking shows the undo toast
 * 「已取消「閱讀」的打卡」 whose 復原 restores the original check-in time.
 * A failure reverts and shows 「打卡沒有存到，請再試一次。」 with 重試. The
 * automatic 「GitHub 有貢獻」 habit is never toggled by hand.
 */
import { useCallback, useMemo, useRef } from "react";
import { AUTO_HABIT_ID, todayHabit, type HabitSummary, type HabitUncheckResponse } from "../../../shared/habits";
import type { TodayHabit } from "../../../shared/today";
import { api, send } from "../../api";
import { HABIT_ERRORS, HABIT_TOASTS } from "../../copy/habits";
import { useToast } from "../../components/toast/ToastProvider";
import { useShortcuts } from "../../lib/shortcuts";
import { useToday } from "../../lib/today";
import { toggleTodayHabit } from "./model";

export interface HabitToggleTarget {
  id: string;
  name: string;
  doneToday: boolean;
}

export interface HabitToggleOptions {
  /** A page's own copy of the row: flipped at once (done = the new state). */
  onLocal?: (id: string, done: boolean) => void;
  /** The server's view after the change. */
  onServer?: (summary: HabitSummary) => void;
  /** The change failed: put the row back (done = the state before). */
  onRevert?: (id: string, done: boolean) => void;
}

export type HabitToggle = (habit: HabitToggleTarget) => Promise<boolean>;

/** Toggles today's check-in for a habit; resolves true when the server saved it. */
export function useHabitToggle(options: HabitToggleOptions = {}): HabitToggle {
  const { optimistic, refresh } = useToday();
  const toast = useToast();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const run = useCallback(async function toggle(habit: HabitToggleTarget, restoreAt?: string): Promise<boolean> {
    if (habit.id === AUTO_HABIT_ID) {
      toast.success(HABIT_TOASTS.autoNote);
      return false;
    }
    const done = !habit.doneToday;
    const box: { server?: TodayHabit } = {};
    const overlay = optimistic((payload) => toggleTodayHabit(payload, habit.id, done, box.server));
    optionsRef.current.onLocal?.(habit.id, done);
    try {
      const result = await api<HabitUncheckResponse>(
        `/habits/${encodeURIComponent(habit.id)}/check`,
        send(done ? "POST" : "DELETE", done && restoreAt ? { at: restoreAt } : {}),
      );
      box.server = todayHabit(result);
      overlay.settle();
      optionsRef.current.onServer?.(result);
      void refresh();
      if (!done) {
        toast.undo(HABIT_TOASTS.todayUnchecked(habit.name), () => {
          void toggle({ ...habit, doneToday: false }, result.previousAt);
        });
      }
      return true;
    } catch {
      overlay.revert();
      optionsRef.current.onRevert?.(habit.id, habit.doneToday);
      toast.error(HABIT_ERRORS.toggle, () => { void toggle(habit, restoreAt); });
      return false;
    }
  }, [optimistic, refresh, toast]);

  return useCallback((habit: HabitToggleTarget) => run(habit), [run]);
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * Keys 1–9 toggle the first nine habits in order (SPEC-ux §6.2). The shared
 * guard already ignores them while typing, composing, in a dialog or with
 * 單鍵快捷鍵 off. A digit without a habit passes through.
 */
export function useHabitKeys(habits: readonly HabitToggleTarget[] | undefined, toggle: HabitToggle, enabled = true): void {
  const habitsRef = useRef(habits);
  habitsRef.current = habits;
  const map = useMemo(() => Object.fromEntries(DIGITS.map((digit, index) => [digit, () => {
    const habit = habitsRef.current?.[index];
    if (!habit) return false;
    void toggle(habit);
    return true;
  }])), [toggle]);
  useShortcuts(map, enabled);
}

/** Today's habits with keys 1–9 wired; returns the toggle for the Today habit buttons and chips. */
export function useTodayHabitKeys(enabled = true): HabitToggle {
  const { data } = useToday();
  const toggle = useHabitToggle();
  useHabitKeys(data?.habits, toggle, enabled);
  return toggle;
}
