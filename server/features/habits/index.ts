import { sidebarStreak, todayHabit, type Habit } from "../../../shared/habits.js";
import type { FeatureModule, ModuleContext } from "../../modules.js";
import { createHabitsRouter } from "./router.js";
import { habitSchema, habitStore } from "./store.js";

/**
 * 習慣 module (habits-brief team). Contract: docs/ARCHITECTURE.md (§2 module
 * contract, §10 cross-module contracts) and docs/design/SPEC-ux.md §3.3, §4.7.
 *
 * Tables: habits (DocTable, trash-backed delete) and habit_logs (one row per
 *   habit and local day, INSERT … ON CONFLICT(habit_id, day)).
 * Routes (/api/habits): GET / (HabitsResponse), POST /, PATCH /:id,
 *   PUT /order, DELETE /:id (undo token), POST and DELETE /:id/check {day?, at?}.
 * today(): habits (TodayHabit: 7-day week, streak in 天 or 週, due) and
 *   sidebar.streakDays (the shortest daily streak).
 * The automatic 「GitHub 有貢獻」 habit (id github-auto) reads the github
 * module's contribution-day items while habits.githubAuto is on.
 */
export const habitsModule: FeatureModule = {
  name: "habits",
  label: "習慣",
  setup(ctx) {
    const store = habitStore(ctx);
    return {
      router: createHabitsRouter(ctx, store),
      today: (_ctx, { day, settings }) => {
        const summaries = store.summaries(store.all().filter((habit) => !habit.archived), day, settings.weekStartsMonday);
        const streakDays = sidebarStreak(summaries);
        return {
          habits: summaries.map(todayHabit),
          ...(streakDays !== undefined ? { sidebar: { streakDays } } : {}),
        };
      },
    };
  },
};

/**
 * Active habits with agenda keywords, for the calendar module's event-linked
 * check-in (an agenda event titled 「健身」 → habitLink 「運動」, habitId).
 * Read-only; safe to call from any module's today().
 */
export function habitKeywordLinks(ctx: Pick<ModuleContext, "db">): Array<{ habitId: string; name: string; keywords: string[] }> {
  const habits = ctx.db.personal.docs<Habit>({ table: "habits", label: "習慣", schema: habitSchema });
  return habits.list({ where: "archived = 0", orderBy: "sort_order, created_at" })
    .filter((habit) => habit.keywords?.length)
    .map((habit) => ({ habitId: habit.id, name: habit.name, keywords: habit.keywords! }));
}
