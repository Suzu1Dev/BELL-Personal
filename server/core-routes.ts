import { Router } from "express";
import { z } from "zod";
import type { StatusResponse } from "../shared/api.js";
import { REQUEST_BODY_BYTES } from "../shared/limits.js";
import { SOURCE_IDS } from "../shared/sources.js";
import { SUGGESTION_KINDS, SUGGESTION_STATUSES } from "../shared/suggestions.js";
import { createAiConnectionsRouter } from "./ai/connections-router.js";
import { AppError } from "./errors.js";
import { exportData } from "./export.js";
import { googleClientConfig, googleConnected } from "./google/auth.js";
import { createJobsRouter } from "./jobs-router.js";
import { logEvent } from "./log.js";
import type { ModuleHost } from "./modules.js";
import type { CoreServices } from "./services.js";
import { createTodayRouter } from "./today/router.js";
import type { TodayService } from "./today/service.js";

/**
 * Routes the core owns (RESERVED_MOUNTS in modules.ts): status, settings,
 * AI connections (初次設定), sync-on-open, jobs, trash restore, the generic suggestion inbox, Today
 * (today, actions) and the data export.
 * Bodies are parsed inline with strict zod; Express 5 forwards async throws.
 */
export function createCoreRouter(services: CoreServices, host: ModuleHost, today: TodayService): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    const [probe, sources, modules, googleClient, googleLinked, connection] = await Promise.all([
      services.status.probe(), host.sourceStatuses(), host.moduleStatuses(),
      googleClientConfig(services).catch(() => null), googleConnected(services).catch(() => false),
      services.aiConnections.activeStatus(),
    ]);
    const body: StatusResponse = {
      today: services.today(),
      timeZone: services.config.timeZone,
      checkedAt: probe.checkedAt,
      ai: { settings: services.provider.settings(), clis: probe.clis, connection },
      github: probe.github,
      vault: { enabled: services.vault.enabled },
      google: { clientConfigured: googleClient !== null, connected: googleLinked },
      sources,
      modules,
      limits: { maxAgentProcesses: services.config.maxAgentProcesses, requestBodyBytes: REQUEST_BODY_BYTES },
    };
    res.json(body);
  });

  router.get("/settings/provider", async (req, res) => {
    res.json(await services.provider.snapshot(req.query.refresh === "true"));
  });
  router.put("/settings/provider", async (req, res) => {
    res.json(await services.provider.update(req.body));
  });

  router.get("/settings/app", (_req, res) => {
    res.json(services.settings.get());
  });
  // `ai.connection` here is checked like PUT /api/ai/connections/active (409 ai_connection_not_ready when it is not ready).
  router.put("/settings/app", async (req, res) => {
    res.json(await services.aiConnections.updateSettings(req.body));
  });

  router.use("/ai/connections", createAiConnectionsRouter(services.aiConnections));

  // Sync on open: the UI calls this on load and when the window regains focus.
  router.post("/sync", async (req, res) => {
    const input = z.object({
      sources: z.array(z.enum(SOURCE_IDS)).max(SOURCE_IDS.length).optional(),
      force: z.boolean().optional(),
    }).strict().parse(req.body ?? {});
    const targets = input.sources ? host.sources.filter((source) => input.sources!.includes(source.id)) : host.sources;
    const started = await Promise.all(targets.map(async (source) => ((await source.request(input.force === true)) ? source.id : null)));
    res.status(202).json({ started: started.filter(Boolean), sources: await host.sourceStatuses() });
  });

  router.use("/jobs", createJobsRouter(services.jobs));
  router.use(createTodayRouter(today, services.now));

  // 資料與隱私 › 匯出資料: a JSON download of the personal tables and settings (never the vault).
  router.get("/export", (req, res) => {
    const { include } = z.object({ include: z.enum(["sources"]).optional() }).parse(req.query);
    const body = exportData(services, include === "sources");
    logEvent("export", { includeSources: include === "sources" });
    res.setHeader("Content-Disposition", `attachment; filename="bell-personal-export-${services.today()}.json"`);
    res.type("json").send(JSON.stringify(body, null, 2));
  });

  router.post("/trash/restore", (req, res) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).strict().parse(req.body);
    res.json({ restored: services.trash.restore(token) });
  });

  router.get("/suggestions", (req, res) => {
    const filter = z.object({
      status: z.enum(SUGGESTION_STATUSES).optional(),
      kind: z.enum(SUGGESTION_KINDS).optional(),
    }).parse(req.query);
    res.json(services.suggestions.list(filter));
  });
  // One tap: the module that owns the kind creates the real record; the core records the decision.
  // One accept per suggestion at a time: a retry or a second tab must not run the acceptor twice.
  const accepting = new Set<string>();
  router.post("/suggestions/:id/accept", async (req, res) => {
    const suggestion = services.suggestions.get(req.params.id);
    if (!suggestion) throw new AppError(404, "找不到這則建議。");
    if (suggestion.status !== "pending" || accepting.has(suggestion.id)) throw new AppError(409, "這則建議已經處理過了。");
    const acceptor = host.acceptor(suggestion.kind);
    if (!acceptor) throw new AppError(501, "這類建議目前還不能直接採用。");
    host.assertOwnerVisible(acceptor);
    accepting.add(suggestion.id);
    try {
      const outcome = await acceptor(suggestion, services, req.body ?? {});
      let decided;
      try {
        decided = services.suggestions.decide(suggestion.id, "accepted", outcome.resultId);
      } catch (error) {
        // Dismissed (or accepted from Today) while the acceptor ran: take back what it made.
        await Promise.resolve(outcome.undo?.()).catch(() => {});
        throw error;
      }
      res.json({ suggestion: decided, ...(outcome.result !== undefined ? { result: outcome.result } : {}) });
    } finally {
      accepting.delete(suggestion.id);
    }
  });
  router.post("/suggestions/:id/dismiss", (req, res) => {
    res.json({ suggestion: services.suggestions.decide(req.params.id, "dismissed") });
  });

  return router;
}
