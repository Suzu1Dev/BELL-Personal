import { z } from "zod";
import { BRIEF_LIMITS, BRIEF_REF_KINDS, type DailyBrief } from "../../../shared/brief.js";
import type { DayKey } from "../../../shared/time.js";
import { BRIEF_FALLBACK_REASONS } from "../../../shared/today.js";
import type { DocTable } from "../../db/database.js";
import type { ModuleContext } from "../../modules.js";

export type StoredBrief = DailyBrief & { id: DayKey };

/** Persisted shape (personal.sqlite daily_briefs, id = local day). */
const briefSchema: z.ZodType<StoredBrief> = z.object({
  id: z.string(),
  day: z.string(),
  source: z.enum(["ai", "rule"]),
  text: z.string().max(400),
  refs: z.array(z.object({ kind: z.enum(BRIEF_REF_KINDS), id: z.string().max(600) })).max(BRIEF_LIMITS.refs).optional(),
  generatedAt: z.string(),
  modelExecution: z.object({
    provider: z.enum(["claude", "codex"]),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    reported: z.object({ model: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
  failure: z.enum(BRIEF_FALLBACK_REASONS).optional(),
  retryAfter: z.string().optional(),
}) as unknown as z.ZodType<StoredBrief>;

/** One brief per local day: the AI text, or a "rule" marker that records why the AI failed. */
export class BriefStore {
  private readonly table: DocTable<StoredBrief>;
  private readonly db: ModuleContext["db"]["personal"]["db"];

  constructor(ctx: Pick<ModuleContext, "db">) {
    this.db = ctx.db.personal.db;
    this.table = ctx.db.personal.docs<StoredBrief>({
      table: "daily_briefs",
      label: "每日摘要",
      schema: briefSchema,
      columns: (brief) => ({ source: brief.source }),
    });
  }

  get(day: DayKey): StoredBrief | undefined {
    return this.table.get(day);
  }

  put(brief: DailyBrief): StoredBrief {
    return this.table.put({ ...brief, id: brief.day });
  }

  /** Deletes briefs of days before `day` (they summarise mail, so they follow mail.retentionDays). */
  prune(day: DayKey): number {
    return Number(this.db.prepare("DELETE FROM daily_briefs WHERE id < ?").run(day).changes);
  }
}
