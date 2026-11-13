import { readFile } from "node:fs/promises";
import { TODAY_MODULE_TIMEOUT_MS } from "../../shared/limits.js";
import { isModuleVisible } from "../../shared/profile.js";
import type { SourceStatus } from "../../shared/sources.js";
import { todayKey } from "../../shared/time.js";
import type { QueueCandidate, TodayContribution, TodayPayload, TodaySource } from "../../shared/today.js";
import { buildToday } from "../../shared/today-logic.js";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";
import type { ModuleHost, RegisteredTodayProvider } from "../modules.js";
import type { CoreServices } from "../services.js";
import { ActionService, type ActionServiceOptions } from "./actions.js";
import { capContribution, todayContributionSchema, todayPayloadSchema } from "./schema.js";
import { suggestionContribution } from "./suggestions.js";

export interface TodayServiceOptions extends ActionServiceOptions {
  /** Per-module deadline for today(); default TODAY_MODULE_TIMEOUT_MS (3 s). */
  moduleTimeoutMs?: number;
}

/** What a failed module's sources say on Today. */
export const MODULE_FAILED_MESSAGE = "今天的資料暫時無法載入，稍後會自動重試。";

class ModuleTimeoutError extends Error {
  constructor() { super("today() timed out"); this.name = "TimeoutError"; }
}

/**
 * GET /api/today: calls every module's today() in parallel with a deadline
 * (Promise.allSettled), validates each contribution, adds the core's own
 * (pending AI suggestions), reads item state and today's action log, maps
 * source statuses, and hands everything to buildToday() (shared/today-logic.ts).
 * Modules whose feature is hidden (profile.roles, features.overrides) are skipped (shared/profile.ts).
 * A module that throws, times out or returns a malformed value is left out and
 * its sources turn to "error": the page never fails because of one module.
 * The last build's open candidates are kept so POST /api/actions can find the
 * row (kind, title, hints) the user acted on.
 */
export class TodayService {
  readonly actions: ActionService;
  private readonly moduleTimeoutMs: number;
  private snapshot = new Map<string, QueueCandidate>();

  constructor(private readonly services: CoreServices, private readonly host: ModuleHost, options: TodayServiceOptions = {}) {
    this.moduleTimeoutMs = options.moduleTimeoutMs ?? TODAY_MODULE_TIMEOUT_MS;
    this.actions = new ActionService(services, host, (itemId) => this.lookup(itemId), options);
  }

  /** Dev only (BELLPERSONAL_TODAY_FIXTURE): serve a fixed payload instead of building one. */
  get fixturePath(): string | null {
    return this.services.config.todayFixture;
  }

  async build(): Promise<TodayPayload> {
    const { services } = this;
    const now = services.now();
    const timeZone = services.config.timeZone;
    const settings = services.settings.get();
    // 設定 › 身分與功能: a module whose feature is hidden adds no rows and no source chips (its data and sync stay).
    const shows = (name: string) => isModuleVisible(name, settings["profile.roles"], settings["features.overrides"]);
    const hiddenSources = new Set<string>(this.host.mounted.filter((item) => !shows(item.name)).flatMap((item) => (item.parts.sources ?? []).map((source) => source.id)));
    const providers = this.host.todayProviders().filter((provider) => shows(provider.name));
    const results = await Promise.allSettled(providers.map((provider) => this.contribution(provider, now, settings)));
    const contributions: TodayContribution[] = [];
    const failed: RegisteredTodayProvider[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") contributions.push(result.value);
      else failed.push(providers[index]);
    });
    try {
      contributions.push(suggestionContribution(services.suggestions, { now, timeZone, assignments: shows("lms") }));
    } catch (error) {
      logEvent("today.core_failed", { part: "suggestions", errorClass: error instanceof Error ? error.name : typeof error });
    }

    const sources = (await this.sources(now, failed)).filter((source) => !hiddenSources.has(source.id));
    const day = todayKey(timeZone, now);
    const { payload, candidates } = buildToday({
      now,
      timeZone,
      contributions,
      states: services.itemState.states(),
      handledLog: services.itemState.handledLog(day, (row) => this.actions.undoable(row)),
      sources,
      ai: { enabled: settings["ai.enabled"], briefTime: settings["brief.autoTime"] },
    });
    this.snapshot = candidates;
    return payload;
  }

  /** The row the user acted on, from the last build (rebuilt once when unknown, e.g. after a restart). */
  async lookup(itemId: string): Promise<QueueCandidate | undefined> {
    if (this.fixturePath) return undefined;
    if (!this.snapshot.has(itemId)) await this.build();
    return this.snapshot.get(itemId);
  }

  /** The dev fixture, validated, re-read on every request so it can be edited live. */
  async fixture(): Promise<TodayPayload> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.fixturePath!, "utf8")); }
    catch { throw new AppError(500, "Today 示範資料無法讀取。"); }
    const parsed = todayPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logEvent("today.fixture_invalid", { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join(".")) });
      throw new AppError(500, "Today 示範資料格式不正確。");
    }
    return parsed.data as TodayPayload;
  }

  /** Shutdown: commit pending remote writes before modules close. */
  drain(): Promise<void> {
    return this.actions.drain();
  }

  private async contribution(provider: RegisteredTodayProvider, now: Date, settings: ReturnType<CoreServices["settings"]["get"]>): Promise<TodayContribution> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ModuleTimeoutError()); }, this.moduleTimeoutMs);
    });
    const started = Date.now();
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => provider.today(this.services, {
          day: todayKey(this.services.config.timeZone, now), now, timeZone: this.services.config.timeZone, settings, signal: controller.signal,
        })),
        deadline,
      ]);
      const { value: cappedValue, capped } = capContribution(value ?? {});
      if (capped.length) logEvent("today.module_truncated", { module: provider.name, fields: capped });
      const parsed = todayContributionSchema.safeParse(cappedValue);
      if (!parsed.success) {
        logEvent("today.module_invalid", { module: provider.name, issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}:${issue.code}`) });
        throw new AppError(502, MODULE_FAILED_MESSAGE);
      }
      return parsed.data as TodayContribution;
    } catch (error) {
      logEvent("today.module_failed", {
        module: provider.name, ms: Date.now() - started,
        reason: error instanceof ModuleTimeoutError ? "timeout" : "error", errorClass: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async sources(now: Date, failed: RegisteredTodayProvider[]): Promise<TodaySource[]> {
    const statuses = await this.host.sourceStatuses();
    const list = statuses.map((status) => todaySource(status, this.host.source(status.id)?.intervalMs ?? 5 * 60_000, now));
    for (const provider of failed) {
      const owned = list.filter((source) => provider.sourceIds.includes(source.id));
      for (const source of owned)
        if (source.state !== "off" && source.state !== "reconnect") Object.assign(source, { state: "error", message: MODULE_FAILED_MESSAGE });
      if (!owned.length) list.push({ id: provider.name, label: provider.label, state: "error", message: MODULE_FAILED_MESSAGE });
    }
    return list;
  }
}

/** SourceStatus → the Today chip state; "stale" means older than twice the source's interval (SPEC §5). */
export function todaySource(status: SourceStatus, intervalMs: number, now: Date): TodaySource {
  const base = { id: status.id, label: status.label, ...(status.lastSyncedAt ? { lastSyncedAt: status.lastSyncedAt } : {}) };
  const message = status.lastError ? { message: status.lastError } : {};
  switch (status.state) {
    case "not_configured":
    case "disabled":
      return { ...base, state: "off" };
    case "needs_reconnect":
      return { ...base, state: "reconnect", ...message };
    case "error":
      return { ...base, state: "error", ...message };
    case "syncing":
      return { ...base, state: "syncing" };
    default: {
      if (!status.lastSyncedAt) return { ...base, state: "syncing" };
      const age = now.getTime() - Date.parse(status.lastSyncedAt);
      return { ...base, state: age > 2 * intervalMs ? "stale" : "ok" };
    }
  }
}
