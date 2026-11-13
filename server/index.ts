import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pruneAiTempDirs } from "./ai/temp-dirs.js";
import { appContext, createApp } from "./app.js";
import { pruneMigrationCopies } from "./db/migrate.js";
import { featureModules } from "./features/index.js";
import { logEvent } from "./log.js";
import { migrateLegacyOnboarding } from "./onboarding.js";
import { readRuntimeConfig } from "./runtime-config.js";
import { redact } from "./secrets/redact.js";
import { createServices } from "./services.js";
import { repairActionsAfterRestart } from "./today/actions.js";

const MAINTENANCE_INTERVAL_MS = 24 * 3_600_000;

/**
 * Composition root: validate the environment before touching any data, open
 * and migrate the databases, build services and modules, listen, start the
 * source timers, and drain on SIGINT/SIGTERM (bell-explain's shutdown).
 */
async function main() {
  // Happy eyeballs gives each address only 250 ms before trying the next one. Over a long route
  // the IPv4 handshake takes longer than that, and on a host without a working IPv6 route the
  // fallback then fails at once: dual-stack services (the Open-Meteo geocoder) never connected.
  net.setDefaultAutoSelectFamilyAttemptTimeout(2_000);
  // A stray rejection from one background task (a source, a timer) is logged, not fatal: Node would
  // otherwise exit and systemd's start limit would leave the dashboard down until someone intervenes.
  process.on("unhandledRejection", (error) => {
    logEvent("process.unhandled_rejection", { errorClass: error instanceof Error ? error.name : typeof error });
  });
  // Validate deployment settings before opening or creating persistent data.
  const config = readRuntimeConfig();
  const services = createServices(config);
  const repaired = services.syncState.repairAfterRestart();
  if (repaired) logEvent("sync.repaired", { sources: repaired });
  const pruned = services.itemState.prune();
  if (pruned) logEvent("today.pruned", { rows: pruned });
  pruneMigrationCopies(config.dataDir);
  pruneAiTempDirs(config.dataDir);
  const interrupted = repairActionsAfterRestart(services);
  if (interrupted) logEvent("action.repaired", { actions: interrupted });
  // 初次設定 for an install from before it: answered from its connections, once, before any sync writes.
  await migrateLegacyOnboarding(services);
  const app = createApp(services, { modules: featureModules });
  const { modules, today } = appContext(app);
  const server = app.listen(config.port, config.host);
  await once(server, "listening");
  const shown = config.host.includes(":") ? `[${config.host}]` : config.host;
  logEvent("server.listening", { host: config.host, port: config.port, modules: modules.mounted.map((item) => item.name), sources: modules.sources.map((item) => item.id) });
  // Production stdout stays pure JSON lines for `journalctl -o cat | jq`.
  if (!config.production) console.log(`BELL Personal → http://${shown}:${config.port}`);
  modules.start();
  // Housekeeping a long-lived process needs beyond boot: the action log's retention window
  // (it keeps mail subjects as titles), expired trash copies and AI job folders a crash left behind.
  const maintenance = setInterval(() => {
    try {
      const rows = services.itemState.prune();
      if (rows) logEvent("today.pruned", { rows });
      services.trash.prune();
      pruneMigrationCopies(config.dataDir);
      pruneAiTempDirs(config.dataDir);
    } catch (error) {
      logEvent("maintenance.failed", { errorClass: error instanceof Error ? error.name : typeof error });
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      clearInterval(maintenance);
      const { drainSeconds } = config;
      setTimeout(() => process.exit(0), (drainSeconds + 6) * 1000).unref();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      await services.jobs.drain(drainSeconds * 1000);
      // Let followers receive the outcome of a job that just finished before cutting them off.
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
      server.closeAllConnections();
      // Commit queued remote writes (archive, calendar insert…) while module clients are still alive.
      await today.drain();
      // Abort and await every active fetch before the databases close under it.
      await modules.close();
      // Waits for sign-in CLIs that ignore SIGTERM (killed after 1.5 s); exiting first would orphan them.
      await services.close();
      process.exit(0);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(redact(error instanceof Error ? (error.stack ?? error.message) : String(error)));
    process.exitCode = 1;
  });
