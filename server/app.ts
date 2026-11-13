import compression from "compression";
import express, { type ErrorRequestHandler, type Express } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { HealthResponse } from "../shared/api.js";
import { REQUEST_BODY_LIMIT } from "../shared/limits.js";
import { createCoreRouter } from "./core-routes.js";
import { createBotRouter, PersonalBotService, type PersonalBotOptions } from "./bot/service.js";
import { AppError } from "./errors.js";
import { logEvent } from "./log.js";
import { ModuleHost, type FeatureModule } from "./modules.js";
import { redact, redactCliOutput } from "./secrets/redact.js";
import { createPrivacyRouter } from "./privacy.js";
import { localhostGuard, tailscaleIdentityGate } from "./security.js";
import type { CoreServices } from "./services.js";
import { createSuiteRouter } from "./suite/router.js";
import { SuiteBridge, type SuiteBridgeOptions } from "./suite/bridge.js";
import { SuiteService, type SuiteOptions } from "./suite/service.js";
import { TodayService, type TodayServiceOptions } from "./today/service.js";

export interface AppOptions {
  /** Feature modules to mount (server/features/index.ts in production). */
  modules?: FeatureModule[];
  /** Built frontend; static serving and the SPA fallback are skipped when index.html is missing. */
  staticDirectory?: string;
  /** Today aggregator and action queue timings (tests shorten them). */
  today?: TodayServiceOptions;
  /** BELL Suite sibling reads: transport, clock, limits and log (tests inject them). */
  suite?: SuiteOptions;
  /** BELL Suite cross-product bridge seams for tests. */
  suiteBridge?: SuiteBridgeOptions;
  /** Personal Bot timeouts/options for tests. */
  bot?: PersonalBotOptions;
}

// Validation messages reach the UI in 400 answers (「mail.retentionDays: 數值過小…」): zod's zh-TW locale, not English.
z.config(z.locales.zhTW());

const version = (() => {
  try { return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string }).version || "unknown"; }
  catch { return "unknown"; }
})();

/**
 * The path as it may be logged: a mail's inline-image Content-ID (which can
 * name the sender's domain, `part1.x@example.com`) is replaced by 「…」, and
 * anything key-shaped by [REDACTED] (an API key typed into the URL instead of
 * the body, e.g. PUT /api/ai/connections/keys/sk-…; the request still gets
 * 400). Query strings are never logged (the image proxy's URL is in one).
 */
export function loggablePath(path: string): string {
  return redactCliOutput(path.replace(/(\/messages\/[^/]+\/inline\/)[^/]+/, "$1…"));
}

/** Typed access to what createApp hangs off app.locals (for shutdown and tests). */
export function appContext(app: Express): { services: CoreServices; modules: ModuleHost; today: TodayService; suite: SuiteService; suiteBridge: SuiteBridge; bot: PersonalBotService } {
  return {
    services: app.locals.services as CoreServices,
    modules: app.locals.modules as ModuleHost,
    today: app.locals.today as TodayService,
    suite: app.locals.suite as SuiteService,
    suiteBridge: app.locals.suiteBridge as SuiteBridge,
    bot: app.locals.bot as PersonalBotService,
  };
}

/**
 * Builds the HTTP app without listening (tests import it directly). Middleware
 * order is part of the security model (brief A3): headers → compression →
 * request log → origin guard → identity gate → JSON body → routes → API 404
 * → static + SPA → error handler.
 */
export function createApp(services: CoreServices, options: AppOptions = {}): Express {
  const { config } = services;
  const host = new ModuleHost(options.modules ?? [], services);
  const today = new TodayService(services, host, options.today);
  services.todayPayload = () => today.build();
  const suiteBridge = new SuiteBridge(config, services.vault, {
    now: options.suite?.now ?? services.now,
    timeoutMs: options.suite?.timeoutMs,
    ...options.suiteBridge,
  });
  const suite = new SuiteService(config.suite, {
    ...options.suite,
    now: options.suite?.now ?? services.now,
    prToken: options.suite?.prToken ?? (() => suiteBridge.prToken()),
  });
  suiteBridge.attachSuite(suite);
  const bot = new PersonalBotService(services, host, today, suiteBridge, options.bot);
  const app = express();
  app.locals.services = services;
  app.locals.modules = host;
  app.locals.today = today;
  app.locals.suite = suite;
  app.locals.suiteBridge = suiteBridge;
  app.locals.bot = bot;

  app.disable("x-powered-by");
  // Streamed NDJSON progress must reach the browser as it is written, so it is never compressed.
  app.use(compression({ filter: (req, res) => !String(res.getHeader("Content-Type") || "").includes("ndjson") && compression.filter(req, res) }));
  // Failures, slow requests and writes are logged; routine polls are not.
  app.use((req, res, next) => {
    const id = randomUUID().slice(0, 8);
    const started = Date.now();
    // Read now: routers strip their mount path from req.path before the response finishes.
    const requestPath = loggablePath(req.path);
    res.locals.requestId = id;
    res.setHeader("X-Request-Id", id);
    res.on("finish", () => {
      const ms = Date.now() - started;
      if (res.statusCode >= 400 || ms >= 2000 || !["GET", "HEAD"].includes(req.method))
        logEvent("http", { id, method: req.method, path: requestPath, status: res.statusCode, ms });
    });
    next();
  });
  app.use(localhostGuard([config.port, config.frontendPort], config.allowedOrigins.join(",")));
  app.use(tailscaleIdentityGate(config.tailscaleUsers));
  app.use(express.json({ limit: REQUEST_BODY_LIMIT, strict: true }));

  const release = (() => { try { return path.basename(realpathSync(process.cwd())); } catch { return "unknown"; } })();
  // Public (exempt from the identity gate): no counts, no personal data.
  app.get("/api/health", (_req, res) => {
    const body: HealthResponse = { status: "ok", version, release, uptimeSeconds: Math.round(process.uptime()) };
    res.json(body);
  });
  // Public like health: the privacy policy Google links to (no personal data).
  app.use(createPrivacyRouter(config.allowedOrigins[0] ?? `http://127.0.0.1:${config.port}`));
  app.use("/api", createCoreRouter(services, host, today));
  // BELL Suite (suite-contract v1): owner-only like the core routes (both gates above), not public, no CORS.
  app.use("/api/suite", createSuiteRouter(suite, suiteBridge));
  app.use("/api/bot", createBotRouter(bot));
  for (const module of host.mounted)
    for (const mount of module.mounts) app.use(mount.path, mount.router);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "找不到 API。" });
  });

  const dist = options.staticDirectory ? path.resolve(options.staticDirectory) : fileURLToPath(new URL("../dist", import.meta.url));
  if (existsSync(path.join(dist, "index.html"))) {
    // Hashed build assets never change; everything else, the HTML included, is revalidated.
    app.use(express.static(dist, {
      index: false,
      setHeaders: (res, file) => res.setHeader("Cache-Control", /[\\/]assets[\\/]/.test(file) ? "public, max-age=31536000, immutable" : "no-cache"),
    }));
    // A hashed chunk that is not in this build (an older tab after a deploy) is a 404, never the HTML page:
    // the route's lazy import then fails at once and the page shows its reload message.
    app.use("/assets", (_req, res) => {
      res.status(404).type("text/plain").set("Cache-Control", "no-store").send("Not found");
    });
    app.get("/{*splat}", (_req, res) => {
      // `root` keeps send's dot-segment check to the file name, so a checkout under a dot directory (.claude/worktrees) still serves.
      res.sendFile("index.html", { root: dist, headers: { "Cache-Control": "no-cache" } });
    });
  }

  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("；") });
      return;
    }
    if (error instanceof AppError) {
      if (error.status >= 500) logEvent("error", { id: res.locals.requestId, method: req.method, path: loggablePath(req.path), errorClass: error.name, status: error.status });
      res.status(error.status).json({ error: redact(error.message), ...error.detail });
      return;
    }
    if (error?.type === "entity.parse.failed") {
      res.status(400).json({ error: "JSON 格式不正確。" });
      return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "請求內容過大。" });
      return;
    }
    // The stack only reaches the local journal; the client gets a generic message.
    logEvent("error", {
      id: res.locals.requestId,
      method: req.method,
      path: loggablePath(req.path),
      errorClass: error instanceof Error ? error.name : typeof error,
      message: redact(error instanceof Error ? error.message : String(error)).slice(0, 300),
      stack: error instanceof Error ? redact(error.stack?.split("\n").slice(0, 8).join("\n") ?? "") : undefined,
    });
    res.status(500).json({ error: "操作未完成；請檢查本機服務記錄。" });
  };
  app.use(errors);
  return app;
}
