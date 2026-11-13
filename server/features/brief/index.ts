import { Router } from "express";
import { z } from "zod";
import { agentLoginCheck } from "../../ai/agent-cli.js";
import { claudeEnvironment, codexEnvironment } from "../../ai/process.js";
import { AppError } from "../../errors.js";
import { streamJob } from "../../jobs-router.js";
import type { FeatureModule, ModuleContext } from "../../modules.js";
import { BriefScheduler } from "./scheduler.js";
import { BriefService } from "./service.js";
import { BriefStore } from "./store.js";

const LOGIN_OK_MS = 60_000;

/**
 * 每日摘要 module (habits-brief team). Contract: docs/ARCHITECTURE.md §5, §10
 * and docs/design/SPEC-ux.md §4.2.
 *
 * Table: daily_briefs (DailyBrief, id = local day; source "rule" rows record a
 *   failed generation's reason). Job "daily-brief" (runStructured over the
 *   in-process Today payload, ctx.todayPayload): at brief.autoTime (unref'd
 *   timer with catch-up after a restart) and on the first open of the day
 *   (brief.onFirstOpen), only when ai.enabled.
 * Routes (/api/brief): POST /refresh {} → NDJSON job (done.result =
 *   BriefRefreshResult); 503 when AI is off or the CLI is not signed in, 429 busy.
 * Status (GET /api/status modules.brief): { day, state, generatedAt?, reason?, autoTime }.
 * today(): brief { state, text?, generatedAt?, reason? }. The core always
 *   computes the rule brief (shared/today-logic.ts ruleBrief) and shows it
 *   whenever the state is not ready.
 */
export const briefModule: FeatureModule = {
  name: "brief",
  label: "每日摘要",
  setup(ctx) {
    const store = new BriefStore(ctx);
    const service = new BriefService(ctx, store);
    const scheduler = new BriefScheduler({
      now: ctx.now,
      timeZone: ctx.config.timeZone,
      settings: () => ctx.settings.get(),
      needsRun: (day, at) => service.needsRun(day, at),
      run: () => { service.start("auto", { quiet: true }); },
    });
    scheduler.start();
    const loginOk = loginCheck(ctx);

    const router = Router();
    router.post("/refresh", async (req, res) => {
      z.object({}).strict().parse(req.body ?? {});
      if (!ctx.settings.value("ai.enabled")) throw new AppError(503, "已在設定中關閉 AI，今天先顯示規則整理的摘要。");
      await loginOk();
      const job = service.start("manual")!;
      streamJob(res, ctx.jobs, job.id);
    });

    return {
      router,
      today: (_ctx, { day, settings }) => ({ brief: service.contribution(day, settings) }),
      // GET /api/status modules.brief: today's state for the 每日摘要 settings tab (never the text).
      status: () => {
        const settings = ctx.settings.get();
        const { text: _text, ...state } = service.peek(ctx.today(), settings);
        return { day: ctx.today(), ...state, autoTime: settings["brief.autoTime"] };
      },
      close: () => scheduler.close(),
    };
  },
};

function isCliUnavailable(error: unknown): boolean {
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return true;
  return error instanceof AppError && error.status === 503;
}

/** 503 before a stream starts when the active AI connection is unready or the selected CLI is not signed in (cached for a minute after a success). */
function loginCheck(ctx: ModuleContext): () => Promise<void> {
  const okUntil = new Map<string, number>();
  return async () => {
    const activeMethod = ctx.settings.value("ai.connection");
    const active = activeMethod ? await ctx.aiConnections.activeStatus() : null;
    if (active && !active.ready) {
      okUntil.clear();
      throw new AppError(503, active.message, { code: "ai_connection_not_ready", method: active.method, reason: active.reason });
    }
    if (active?.ready && active.source === "bell") return;
    const provider = ctx.provider.settings().provider;
    const now = ctx.now().getTime();
    const cacheKey = `${provider}:${activeMethod ?? ""}`;
    if ((okUntil.get(cacheKey) ?? 0) > now) return;
    const login = agentLoginCheck(provider, provider === "claude" ? ctx.config.claudePath : ctx.config.codexPath);
    try {
      await ctx.command(login.executable, login.args, { timeoutMs: 10_000, maxBytes: 20_000, env: provider === "claude" ? claudeEnvironment() : codexEnvironment() });
    } catch (error) {
      okUntil.delete(cacheKey);
      ctx.status.invalidate();
      const detail = isCliUnavailable(error)
        ? { code: "ai_cli_unavailable" as const, provider }
        : { code: "ai_auth_expired" as const, provider, ...(activeMethod ? { method: activeMethod } : {}) };
      throw new AppError(
        503,
        provider === "claude" ? "Claude 尚未登入：請在伺服器的終端機執行 claude auth login。" : "Codex 尚未登入：請在伺服器的終端機執行 codex login。",
        detail,
      );
    }
    okUntil.set(cacheKey, ctx.now().getTime() + LOGIN_OK_MS);
  };
}
