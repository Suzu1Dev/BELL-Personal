import { Router } from "express";
import { z } from "zod";
import {
  HABIT_CADENCES, HABIT_LIMITS, charCount, editableDay,
  type HabitDeleteResponse, type HabitSummary, type HabitsResponse, type HabitUncheckResponse,
} from "../../../shared/habits.js";
import { dayKey, isDayKey } from "../../../shared/time.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import type { HabitStore } from "./store.js";

/** "" and whitespace mean "not set" for the optional text fields. */
const optionalText = (max: number, message: string) =>
  z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().max(max, { message })).optional();

const shortLabel = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.string().refine((value) => value === "" || (charCount(value) >= HABIT_LIMITS.shortMin && charCount(value) <= HABIT_LIMITS.shortMax), {
    message: `短名稱請用 ${HABIT_LIMITS.shortMin}–${HABIT_LIMITS.shortMax} 個字。`,
  }),
).optional();

const habitFields = {
  name: z.string().trim().min(1, { message: "請輸入習慣名稱。" }).max(HABIT_LIMITS.name, { message: `名稱最多 ${HABIT_LIMITS.name} 個字。` }),
  cadence: z.enum(HABIT_CADENCES).optional(),
  timesPerWeek: z.number().int().min(HABIT_LIMITS.timesPerWeekMin).max(HABIT_LIMITS.timesPerWeekMax, { message: `每週次數請介於 ${HABIT_LIMITS.timesPerWeekMin} 到 ${HABIT_LIMITS.timesPerWeekMax}。` }).optional(),
  short: shortLabel,
  hint: optionalText(HABIT_LIMITS.hint, `備註最多 ${HABIT_LIMITS.hint} 個字。`),
  keywords: z.array(z.string().trim().min(1).max(HABIT_LIMITS.keyword)).max(HABIT_LIMITS.keywords, { message: `關鍵字最多 ${HABIT_LIMITS.keywords} 個。` }).optional(),
};

const createSchema = z.object(habitFields).strict()
  .refine((input) => input.cadence !== "weekly" || input.timesPerWeek !== undefined, { message: "每週的習慣請選擇一週幾次。", path: ["timesPerWeek"] });
const updateSchema = z.object({ ...habitFields, name: habitFields.name.optional(), archived: z.boolean().optional() }).strict()
  .refine((input) => Object.keys(input).length > 0, { message: "沒有要更新的欄位。" });
const orderSchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(HABIT_LIMITS.active + 1) }).strict()
  .refine((input) => new Set(input.ids).size === input.ids.length, { message: "順序裡有重複的習慣。" });
const checkSchema = z.object({
  day: z.string().refine(isDayKey, { message: "日期格式不正確。" }).optional(),
  at: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "時間格式不正確。" }).optional(),
}).strict();

/** /api/habits: list, create, edit, reorder, delete (undo via trash), and day check-ins. */
export function createHabitsRouter(ctx: ModuleContext, store: HabitStore): Router {
  const router = Router();
  const weekStartsMonday = () => ctx.settings.value("weekStartsMonday");
  const summary = (id: string): HabitSummary => store.summaries([store.get(id)], ctx.today(), weekStartsMonday())[0];
  const list = (): HabitsResponse => {
    const today = ctx.today();
    const summaries = store.summaries(store.all(), today, weekStartsMonday());
    return {
      day: today,
      weekStartsMonday: weekStartsMonday(),
      githubAuto: ctx.settings.value("habits.githubAuto"),
      githubDays: store.githubDays(),
      habits: summaries.filter((item) => !item.archived),
      archived: summaries.filter((item) => item.archived),
    };
  };
  /** The day a check-in targets: today by default, never in the future, at most 35 days back. */
  const targetDay = (day: string | undefined) => {
    const today = ctx.today();
    const target = day ?? today;
    if (!editableDay(target, today)) throw new AppError(400, `只能打卡今天和過去 ${HABIT_LIMITS.editableDays} 天內的日子。`);
    return target;
  };

  router.get("/", (_req, res) => {
    res.json(list());
  });

  router.post("/", (req, res) => {
    const input = createSchema.parse(req.body);
    const habit = store.create({ ...input, cadence: input.cadence ?? "daily" });
    res.status(201).json(summary(habit.id));
  });

  router.put("/order", (req, res) => {
    const { ids } = orderSchema.parse(req.body);
    store.reorder(ids);
    res.json(list());
  });

  router.patch("/:id", (req, res) => {
    const patch = updateSchema.parse(req.body);
    if (patch.cadence === "weekly" && patch.timesPerWeek === undefined && store.get(req.params.id).cadence !== "weekly")
      throw new AppError(400, "每週的習慣請選擇一週幾次。");
    store.update(req.params.id, patch);
    res.json(summary(req.params.id));
  });

  router.delete("/:id", (req, res) => {
    const result = store.delete(req.params.id);
    if (!result.deleted) throw new AppError(404, "找不到這個習慣，可能已經刪除。");
    const body: HabitDeleteResponse = result.undoToken ? { undoToken: result.undoToken } : {};
    res.json(body);
  });

  router.post("/:id/check", (req, res) => {
    const input = checkSchema.parse(req.body ?? {});
    const habit = store.get(req.params.id);
    const day = targetDay(input.day);
    const now = ctx.now();
    let at = now.toISOString();
    if (input.at) {
      // Undo of an un-check: put the original time back, as long as it is on that day and not in the future.
      if (Date.parse(input.at) > now.getTime() || dayKey(ctx.config.timeZone, input.at) !== day) throw new AppError(400, "打卡時間和日期不一致。");
      at = new Date(input.at).toISOString();
    }
    store.check(habit, day, at);
    logEvent("habit.logged", { action: "check", backfill: day !== ctx.today() });
    res.json(summary(habit.id));
  });

  router.delete("/:id/check", (req, res) => {
    const input = checkSchema.omit({ at: true }).parse(req.body ?? {});
    const habit = store.get(req.params.id);
    const day = targetDay(input.day);
    const previousAt = store.uncheck(habit, day);
    logEvent("habit.logged", { action: "uncheck", backfill: day !== ctx.today() });
    const body: HabitUncheckResponse = { ...summary(habit.id), ...(previousAt ? { previousAt } : {}) };
    res.json(body);
  });

  return router;
}
