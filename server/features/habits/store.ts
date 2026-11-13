import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContributionDay } from "../../../shared/github.js";
import {
  AUTO_HABIT_ID, HABIT_CADENCES, HABIT_LIMITS, HABIT_TEXT, habitSummary, isAutoHabit,
  type Habit, type HabitCreateRequest, type HabitDoneDay, type HabitSummary, type HabitUpdateRequest,
} from "../../../shared/habits.js";
import { dayKey, type DayKey } from "../../../shared/time.js";
import type { DocTable } from "../../db/database.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";

/** Persisted shape (personal.sqlite habits): every field of the shared type; new fields stay optional. */
export const habitSchema: z.ZodType<Habit> = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(HABIT_LIMITS.name),
  cadence: z.enum(HABIT_CADENCES),
  timesPerWeek: z.number().int().min(HABIT_LIMITS.timesPerWeekMin).max(HABIT_LIMITS.timesPerWeekMax).optional(),
  targetPerDay: z.number().int().min(1).max(HABIT_LIMITS.perDay),
  archived: z.boolean(),
  order: z.number().int(),
  auto: z.object({ source: z.literal("github"), metric: z.literal("contributions"), threshold: z.number().int().min(1) }).optional(),
  short: z.string().max(8).optional(),
  hint: z.string().max(HABIT_LIMITS.hint).optional(),
  keywords: z.array(z.string().max(HABIT_LIMITS.keyword)).max(HABIT_LIMITS.keywords).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** The automatic habit before the user renamed or moved it (nothing is stored until then). */
function defaultAutoHabit(createdAt: string): Habit {
  return {
    id: AUTO_HABIT_ID,
    name: HABIT_TEXT.autoName,
    short: HABIT_TEXT.autoShort,
    cadence: "daily",
    targetPerDay: 1,
    archived: false,
    order: 1000,
    auto: { source: "github", metric: "contributions", threshold: 1 },
    createdAt,
    updatedAt: createdAt,
  };
}

const byOrder = (a: Habit, b: Habit) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * Habits (a DocTable with trash, so 刪除 has an undo token) and their
 * check-ins (habit_logs, relational: one row per habit and local day, written
 * with INSERT … ON CONFLICT). Days are local DayKeys in BELLPERSONAL_TZ.
 */
export class HabitStore {
  readonly table: DocTable<Habit>;

  constructor(private readonly ctx: ModuleContext) {
    this.table = ctx.db.personal.docs<Habit>({
      table: "habits",
      label: "習慣",
      schema: habitSchema,
      columns: (habit) => ({ archived: habit.archived ? 1 : 0, sort_order: habit.order, created_at: habit.createdAt }),
    }, ctx.trash);
  }

  private get githubAuto(): boolean {
    return this.ctx.settings.value("habits.githubAuto");
  }

  /** Every habit in display order; the automatic one only while habits.githubAuto is on. */
  all(): Habit[] {
    const stored = this.table.list({ orderBy: "sort_order, created_at" }).filter((habit) => !isAutoHabit(habit));
    if (!this.githubAuto) return stored.sort(byOrder);
    const auto = this.table.get(AUTO_HABIT_ID) ?? defaultAutoHabit(this.ctx.now().toISOString());
    return [...stored, auto].sort(byOrder);
  }

  get(id: string): Habit {
    const habit = id === AUTO_HABIT_ID
      ? (this.githubAuto ? this.table.get(AUTO_HABIT_ID, { strict: true }) ?? defaultAutoHabit(this.ctx.now().toISOString()) : undefined)
      : this.table.get(id, { strict: true });
    if (!habit) throw new AppError(404, "找不到這個習慣，可能已經刪除。");
    return habit;
  }

  create(input: Required<Pick<HabitCreateRequest, "name">> & Omit<HabitCreateRequest, "name">): Habit {
    const active = this.all().filter((habit) => !habit.archived);
    if (active.length >= HABIT_LIMITS.active) throw new AppError(409, `最多 ${HABIT_LIMITS.active} 個進行中的習慣，先封存一些再新增。`);
    const now = this.ctx.now().toISOString();
    const order = active.reduce((max, habit) => Math.max(max, isAutoHabit(habit) ? -1 : habit.order), -1) + 1;
    return this.table.put({
      id: randomUUID(),
      name: input.name,
      cadence: input.cadence ?? "daily",
      ...(input.cadence === "weekly" ? { timesPerWeek: input.timesPerWeek ?? 1 } : {}),
      targetPerDay: 1,
      archived: false,
      order,
      ...(input.short ? { short: input.short } : {}),
      ...(input.hint ? { hint: input.hint } : {}),
      ...(input.keywords?.length ? { keywords: input.keywords } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  update(id: string, patch: HabitUpdateRequest): Habit {
    const current = this.get(id);
    if (isAutoHabit(current) && (patch.cadence !== undefined || patch.timesPerWeek !== undefined || patch.archived !== undefined))
      throw new AppError(400, "自動習慣只能改名稱和短名稱；要停用請關閉 GitHub 自動打卡。");
    if (current.archived && patch.archived === false && this.all().filter((habit) => !habit.archived).length >= HABIT_LIMITS.active)
      throw new AppError(409, `最多 ${HABIT_LIMITS.active} 個進行中的習慣，先封存一些再還原。`);
    const cadence = patch.cadence ?? current.cadence;
    const next: Habit = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      cadence,
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      updatedAt: this.ctx.now().toISOString(),
    };
    if (cadence === "weekly") next.timesPerWeek = patch.timesPerWeek ?? current.timesPerWeek ?? 1;
    else delete next.timesPerWeek;
    for (const key of ["short", "hint"] as const) {
      if (patch[key] === undefined) continue;
      if (patch[key]) next[key] = patch[key];
      else delete next[key];
    }
    if (patch.keywords !== undefined) {
      if (patch.keywords.length) next.keywords = patch.keywords;
      else delete next.keywords;
    }
    // A restored habit goes to the end of the list.
    if (current.archived && patch.archived === false)
      next.order = this.all().filter((habit) => !habit.archived && !isAutoHabit(habit)).reduce((max, habit) => Math.max(max, habit.order), -1) + 1;
    return this.table.put(next);
  }

  /** Rewrites the order of the active habits; ids not listed keep their relative order after the listed ones. */
  reorder(ids: string[]): void {
    const active = this.all().filter((habit) => !habit.archived);
    const known = new Set(active.map((habit) => habit.id));
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) throw new AppError(404, "找不到這個習慣，可能已經刪除。");
    const ordered = [...ids, ...active.map((habit) => habit.id).filter((id) => !ids.includes(id))];
    const now = this.ctx.now().toISOString();
    const updates = ordered.map((id, order) => ({ ...active.find((habit) => habit.id === id)!, order, updatedAt: now }));
    this.table.putMany(updates);
  }

  delete(id: string): { deleted: boolean; undoToken?: string } {
    const habit = this.get(id);
    if (isAutoHabit(habit)) throw new AppError(400, "自動習慣不能刪除；要停用請關閉 GitHub 自動打卡。");
    // Check-ins stay, so restoring from the trash brings the whole history back.
    return this.table.delete(id);
  }

  /** Done days per habit: habit_logs rows, or GitHub contribution days for the automatic habit. */
  logs(habits: Habit[]): Map<string, HabitDoneDay[]> {
    const result = new Map<string, HabitDoneDay[]>(habits.map((habit) => [habit.id, []]));
    const manual = habits.filter((habit) => !habit.auto).map((habit) => habit.id);
    if (manual.length) {
      const rows = this.ctx.db.personal.db
        .prepare(`SELECT habit_id, day, count, created_at FROM habit_logs WHERE habit_id IN (${manual.map(() => "?").join(", ")}) ORDER BY day`)
        .all(...manual) as Array<{ habit_id: string; day: string; count: number; created_at: string }>;
      for (const row of rows) result.get(row.habit_id)?.push({ day: row.day, count: Number(row.count), at: row.created_at });
    }
    const auto = habits.find((habit) => habit.auto);
    if (auto) {
      const threshold = auto.auto?.threshold ?? 1;
      const days = this.ctx.sourceItems.list<ContributionDay>({ source: "github", kind: "contribution-day" })
        .map((item) => item.value)
        .filter((value) => typeof value?.date === "string" && Number(value.count) >= threshold);
      result.set(auto.id, days.map((value) => ({ day: value.date, count: 1 })).sort((a, b) => a.day.localeCompare(b.day)));
    }
    return result;
  }

  /** Days GitHub contributions are cached for (0 = GitHub not connected yet). */
  githubDays(): number {
    return this.ctx.sourceItems.count("github", "contribution-day");
  }

  /** Marks a day done (idempotent): INSERT … ON CONFLICT(habit_id, day) DO UPDATE. */
  check(habit: Habit, day: DayKey, at: string): void {
    if (habit.auto) throw new AppError(409, "這個習慣會依 GitHub 貢獻自動打卡。");
    const now = this.ctx.now().toISOString();
    this.ctx.db.personal.db.prepare(`INSERT INTO habit_logs (habit_id, day, count, note, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(habit_id, day) DO UPDATE SET count = MAX(habit_logs.count, excluded.count), updated_at = excluded.updated_at`)
      .run(habit.id, day, Math.max(1, habit.targetPerDay), at, now);
  }

  /** Removes a day's check-in and returns when it had been made (for the undo), or undefined when there was none. */
  uncheck(habit: Habit, day: DayKey): string | undefined {
    if (habit.auto) throw new AppError(409, "這個習慣會依 GitHub 貢獻自動打卡。");
    const db = this.ctx.db.personal;
    return db.transaction(() => {
      const row = db.db.prepare("SELECT created_at FROM habit_logs WHERE habit_id = ? AND day = ?").get(habit.id, day);
      if (!row) return undefined;
      db.db.prepare("DELETE FROM habit_logs WHERE habit_id = ? AND day = ?").run(habit.id, day);
      return String(row.created_at);
    });
  }

  /** Summaries for these habits on `today`. */
  summaries(habits: Habit[], today: DayKey, weekStartsMonday: boolean): HabitSummary[] {
    const timeZone = this.ctx.config.timeZone;
    const logs = this.logs(habits);
    return habits.map((habit) => {
      const days = logs.get(habit.id) ?? [];
      // The automatic habit's history is the contribution calendar, older than the habit itself.
      const createdDay = habit.auto ? (days[0]?.day ?? today) : dayKey(timeZone, habit.createdAt);
      return habitSummary(habit, days, { today, timeZone, weekStartsMonday, createdDay: createdDay < today ? createdDay : today });
    });
  }
}

const stores = new WeakMap<object, HabitStore>();

/** The one HabitStore for this context's personal database (the trash accepts one restorer per table). */
export function habitStore(ctx: ModuleContext): HabitStore {
  let store = stores.get(ctx.db.personal);
  if (!store) {
    store = new HabitStore(ctx);
    stores.set(ctx.db.personal, store);
  }
  return store;
}
