import type { BriefRefreshResult } from "../../../shared/connect.js";
import type { JobEvent, JobView } from "../../../shared/jobs.js";
import type { AppSettings } from "../../../shared/settings.js";
import { addDays, type DayKey } from "../../../shared/time.js";
import type { TodayContribution, TodayPayload } from "../../../shared/today.js";
import { AppError } from "../../errors.js";
import { withGenerationProgress } from "../../generation-progress.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { BRIEF_PROMPT, BRIEF_ROLE, briefAnswerSchema, briefData, checkBriefText, fallbackReason, knownRefs, TRANSIENT_REASONS } from "./generate.js";
import type { BriefStore } from "./store.js";

export type BriefTrigger = "auto" | "first-open" | "manual";

/** After a transient failure (usage limit, dropped connection, timeout), the next open of Today after this long retries once. */
export const BRIEF_RETRY_AFTER_MS = 30 * 60_000;

export interface BriefServiceOptions {
  /** The day's aggregated Today payload; default ctx.todayPayload (set by createApp). */
  aggregate?: () => Promise<TodayPayload>;
}

/**
 * The daily brief's state machine (SPEC §4.2):
 *  off        ai.enabled is false (no model call anywhere);
 *  generating a job for today is running (the core shows the rule brief meanwhile);
 *  ready      today's AI brief is stored;
 *  fallback   no AI brief: with `reason` when today's generation failed.
 * One generation at a time (job kind daily-brief, 429 while busy). It runs at
 * brief.autoTime (BriefScheduler), on the first open of the day when
 * brief.onFirstOpen is on, and on 重新整理 / 重試 (POST /api/brief/refresh).
 */
export class BriefService {
  private running: { day: DayKey; jobId?: string } | null = null;
  /** Days a first-open generation was already tried by this process. */
  private readonly opened = new Set<DayKey>();
  /** Days a transient failure was already retried by this process. */
  private readonly retried = new Set<DayKey>();

  constructor(private readonly ctx: ModuleContext, private readonly store: BriefStore, private readonly options: BriefServiceOptions = {}) {}

  /** today(): the brief part of this module's contribution; may start the first-open generation. */
  contribution(day: DayKey, settings: AppSettings): NonNullable<TodayContribution["brief"]> {
    const state = this.peek(day, settings);
    if (state.state === "fallback" && !state.reason && !this.store.get(day) && settings["brief.onFirstOpen"] && !this.opened.has(day)) {
      this.opened.add(day);
      if (this.start("first-open", { quiet: true })) return { state: "generating" };
    }
    const retryAfter = state.state === "fallback" ? this.store.get(day)?.retryAfter : undefined;
    if (retryAfter && Date.parse(retryAfter) <= this.ctx.now().getTime() && !this.retried.has(day)) {
      this.retried.add(day);
      if (this.start("first-open", { quiet: true })) return { state: "generating" };
    }
    return state;
  }

  /** The state without side effects (GET /api/status modules.brief, the settings 每日摘要 tab). */
  peek(day: DayKey, settings: Pick<AppSettings, "ai.enabled">): NonNullable<TodayContribution["brief"]> {
    if (!settings["ai.enabled"]) return { state: "off" };
    const stored = this.store.get(day);
    if (stored?.source === "ai" && stored.text) return { state: "ready", text: stored.text, generatedAt: stored.generatedAt };
    if (this.running?.day === day) return { state: "generating" };
    if (stored?.failure) return { state: "fallback", reason: stored.failure, generatedAt: stored.generatedAt };
    return { state: "fallback" };
  }

  /** The scheduler's question: does `day` still need its automatic run? */
  needsRun(day: DayKey, at: Date): boolean {
    if (this.running?.day === day) return false;
    const stored = this.store.get(day);
    if (stored?.source === "ai") return false;
    // A failure recorded after the automatic time already answered for today.
    return !(stored?.failure && Date.parse(stored.generatedAt) >= at.getTime());
  }

  /**
   * Starts a generation for today. `quiet` (first open, scheduler) swallows
   * the refusal and returns undefined; otherwise AI off → 503, busy → 429.
   */
  start(trigger: BriefTrigger, { quiet = false } = {}): JobView | undefined {
    if (!this.ctx.settings.value("ai.enabled")) {
      if (quiet) return undefined;
      throw new AppError(503, "已在設定中關閉 AI，今天先顯示規則整理的摘要。");
    }
    const day = this.ctx.today();
    if (this.running) {
      if (quiet) return undefined;
      throw new AppError(429, "今日摘要正在整理中。");
    }
    // Set before the job's first line runs: its Today build calls contribution() again.
    this.running = { day };
    try {
      const job = this.ctx.jobs.start(
        { kind: "daily-brief", title: "今日摘要", ref: day },
        (emit, signal) => this.generate(day, trigger, emit, signal),
        { maxRunning: 1, busyMessage: "今日摘要正在整理中。" },
      );
      if (this.running?.day === day && job.status === "running") this.running.jobId = job.id;
      return job;
    } catch (error) {
      this.running = null;
      if (quiet) return undefined;
      throw error;
    }
  }

  private async generate(day: DayKey, trigger: BriefTrigger, emit: (event: JobEvent) => void, signal: AbortSignal): Promise<BriefRefreshResult> {
    const started = Date.now();
    const { ctx } = this;
    const timeZone = ctx.config.timeZone;
    let payload: TodayPayload | undefined;
    try {
      await Promise.resolve();
      emit({ type: "stage", stage: "collect", message: "正在整理今天的項目…" });
      payload = await this.aggregate();
      signal.throwIfAborted();
      const data = briefData(payload, timeZone);
      const { value, execution } = await withGenerationProgress("整理今日摘要", "brief", emit, signal, (onProgress) => ctx.ai.runStructured({
        role: BRIEF_ROLE,
        schema: briefAnswerSchema,
        prompt: BRIEF_PROMPT,
        data,
        signal,
        timeoutKind: "standard",
        // 重新整理 has someone waiting on it; the 06:30 run and first open do not.
        priority: trigger === "manual" ? "interactive" : "background",
        onProgress,
      }));
      const text = checkBriefText(value.text, payload);
      const refs = knownRefs(value.refs, data);
      this.store.put({ day, source: "ai", text, ...(refs.length ? { refs } : {}), generatedAt: ctx.now().toISOString(), modelExecution: execution });
      this.pruneOld(day);
      logEvent("digest.generated", { source: "ai", trigger, ms: Date.now() - started });
      return { day, source: "ai" };
    } catch (error) {
      this.recordFailure(day, payload, error, trigger, started, signal);
      throw error;
    } finally {
      if (this.running?.day === day) this.running = null;
    }
  }

  /** Keeps a good AI brief; otherwise stores the reason so Today shows the fallback note instead of retrying on every open. */
  private recordFailure(day: DayKey, payload: TodayPayload | undefined, error: unknown, trigger: BriefTrigger, started: number, signal: AbortSignal): void {
    // A cancel or shutdown aborts the job: that is not the model's failure.
    if (signal.aborted) return;
    const reason = fallbackReason(error, this.ctx.provider.settings().provider);
    logEvent("digest.generated", { source: "rule", trigger, reason, ms: Date.now() - started, errorClass: error instanceof Error ? error.name : typeof error });
    try {
      if (this.store.get(day)?.source === "ai") return;
      // A limit or a dropped connection says nothing about today's setup: first open tries once more later.
      const retryAfter = TRANSIENT_REASONS.has(reason) ? new Date(this.ctx.now().getTime() + BRIEF_RETRY_AFTER_MS).toISOString() : undefined;
      this.store.put({ day, source: "rule", text: payload?.brief.source === "rule" ? payload.brief.text : "", generatedAt: this.ctx.now().toISOString(), failure: reason, ...(retryAfter ? { retryAfter } : {}) });
      this.pruneOld(day);
    } catch {
      /* The database may be closing; the next open retries. */
    }
  }

  /** Briefs summarise mail: they are kept as long as cached mail is (mail.retentionDays, /privacy). */
  private pruneOld(day: DayKey): void {
    const removed = this.store.prune(addDays(day, -this.ctx.settings.value("mail.retentionDays")));
    if (removed) logEvent("digest.pruned", { removed });
  }

  private aggregate(): Promise<TodayPayload> {
    const aggregate = this.options.aggregate ?? this.ctx.todayPayload;
    if (!aggregate) throw new AppError(503, "今天的資料還沒準備好，請稍後再試。");
    return aggregate();
  }
}
