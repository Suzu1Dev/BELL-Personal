import { tmpdir } from "node:os";
import { join } from "node:path";
import { todayKey, type DayKey } from "../shared/time.js";
import { AgentSlots } from "./ai/agent-slots.js";
import type { TransientSleep } from "./ai/agent-cli.js";
import { codexRpcFactory, discoverCodex, type CodexRpcFactory } from "./ai/codex.js";
import { AiConnectionRuntime, codexLaunch } from "./ai/connection-runtime.js";
import { AiConnectionService, type AiConnectionTimeouts } from "./ai/connections.js";
import { command as runCommand, type CommandRunner } from "./ai/process.js";
import { ProviderService, ProviderSettingsStore } from "./ai/provider-settings.js";
import { AiRunner } from "./ai/structured.js";
import { openDatabases, type Databases } from "./db/database.js";
import { Trash } from "./db/trash.js";
import { JobRegistry } from "./jobs.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { Vault } from "./secrets/vault.js";
import { StatusService } from "./status.js";
import { AppSettingsStore } from "./stores/app-settings.js";
import { SourceItemStore } from "./stores/source-items.js";
import { SuggestionStore } from "./stores/suggestions.js";
import { SyncStateStore } from "./stores/sync-state.js";
import { nodePublicNetwork, type PublicNetwork } from "./public-fetch.js";
import type { FetchLike } from "./sync.js";
import { ItemStateStore } from "./today/item-state.js";
import type { ModelCatalog } from "../shared/models.js";
import type { TodayPayload } from "../shared/today.js";

/**
 * Everything a feature module may use, built once by the composition root
 * (server/index.ts) and by tests. Modules receive it as ModuleContext.
 */
export interface CoreServices {
  config: RuntimeConfig;
  db: Databases;
  /** Soft delete for document tables; POST /api/trash/restore. */
  trash: Trash;
  /** Encrypted credentials (Google refresh token, Moodle/Canvas tokens, secret ICS URLs). */
  vault: Vault;
  /** User-triggered model work that streams progress. */
  jobs: JobRegistry;
  slots: AgentSlots;
  provider: ProviderService;
  /** runStructured(): the only way to call a model. */
  ai: AiRunner;
  /** App preferences (settings.sqlite). */
  settings: AppSettingsStore;
  syncState: SyncStateStore;
  /** Generic cache of fetched items (sources.sqlite). */
  sourceItems: SourceItemStore;
  /** AI output waiting for the user's decision (sources.sqlite). */
  suggestions: SuggestionStore;
  /** Today queue item state and action log (personal.sqlite): markHandled() when a source shows an item was dealt with. */
  itemState: ItemStateStore;
  status: StatusService;
  /** 初次設定 › 連接 AI: sign-in state per method, browser-started CLI sign-ins, saved API keys (GET /api/ai/connections). */
  aiConnections: AiConnectionService;
  /** command() or a test fake; use for gh and other CLIs. */
  command: CommandRunner;
  /** fetch or a test fake; SourceSync subclasses get it through SyncContext.http. */
  fetch: FetchLike;
  /**
   * DNS lookups and IP-pinned HTTP(S) connections for URLs nobody vetted
   * (the mail image proxy): use it only through publicFetch(), which refuses
   * private addresses. Tests replace it; testServices() makes it offline.
   */
  publicNetwork: PublicNetwork;
  now: () => Date;
  /** Today in BELLPERSONAL_TZ (never the host's UTC date). */
  today: () => DayKey;
  /**
   * GET /api/today's payload built in-process (every module's today() plus
   * the core's rules), for model work that summarises the day (the daily
   * brief). Set by createApp once the Today service exists; undefined before.
   * Never call it from a today() provider: that would recurse.
   */
  todayPayload?: () => Promise<TodayPayload>;
  /** Stops sign-in CLIs and waits until they have exited (SIGKILL after 1.5 s), then closes the databases. Safe to call twice. */
  close(): Promise<void>;
}

/** Seams for tests; production passes none. */
export interface ServiceSeams {
  command?: CommandRunner;
  fetch?: FetchLike;
  publicNetwork?: PublicNetwork;
  now?: () => Date;
  codexFactory?: CodexRpcFactory;
  loadCodexCatalog?: (signal: AbortSignal) => Promise<ModelCatalog>;
  sleep?: TransientSleep;
  statusCacheMs?: number;
  aiConnectionTimeouts?: Partial<AiConnectionTimeouts>;
}

/** Opens the databases (migrating them) and wires every core service. Call after readRuntimeConfig(). */
export function createServices(config: RuntimeConfig, seams: ServiceSeams = {}): CoreServices {
  const now = seams.now ?? (() => new Date());
  const command = seams.command ?? runCommand;
  const db = openDatabases(config.dataDir);
  const memory = config.dataDir === ":memory:";
  const trash = new Trash(memory ? null : join(config.dataDir, "trash"), now);
  const vault = new Vault({ directory: config.secretsDir, key: config.masterKey, now });
  const slots = new AgentSlots(config.maxAgentProcesses);
  const codexFactory = seams.codexFactory ?? codexRpcFactory(config.codexPath);
  const settings = new AppSettingsStore(db.settings);
  const aiDataDir = memory ? join(tmpdir(), "bell-personal-memory") : config.dataDir;
  // 設定 › 連接 AI: which CLI and sign-in AI jobs use. Key mode gets a throwaway config home under <dataDir>/ai.
  const connections = new AiConnectionRuntime({ vault, active: () => settings.value("ai.connection"), root: join(aiDataDir, "ai") });
  const provider = new ProviderService(
    new ProviderSettingsStore(db.settings),
    seams.loadCodexCatalog ?? (async (signal) => discoverCodex(codexFactory, signal, codexLaunch(connections, await connections.plan("codex")))),
    () => connections.active(),
    // A key connection with no usable key: the same check a job runs (no CLI starts unless its own API-key login fits).
    async (cli, signal) => {
      const plan = await connections.plan(cli);
      if (plan.keyReason) await ai.checkLogin(plan, signal);
    },
  );
  const ai = new AiRunner({
    provider,
    slots,
    connections,
    dataDir: aiDataDir,
    timeoutScale: config.agentTimeoutScale,
    claudePath: config.claudePath,
    codexPath: config.codexPath,
    command,
    codexFactory,
    sleep: seams.sleep,
  });
  const status = new StatusService({ command, claudePath: config.claudePath, codexPath: config.codexPath, ghPath: config.ghPath, cacheMs: seams.statusCacheMs });
  let closing: Promise<void> | undefined;
  const aiConnections = new AiConnectionService({
    command, status, vault, now, claudePath: config.claudePath, codexPath: config.codexPath, timeouts: seams.aiConnectionTimeouts,
    settings, tmpDir: join(aiDataDir, "ai"),
    // A new login, key or active connection: reload the model list and check the CLI login again.
    onChange: () => { provider.invalidate(); ai.forgetLogins(); },
  });
  return {
    config,
    db,
    trash,
    vault,
    jobs: new JobRegistry(),
    slots,
    provider,
    ai,
    settings,
    syncState: new SyncStateStore(db.sources, now),
    sourceItems: new SourceItemStore(db.sources, now),
    suggestions: new SuggestionStore(db.sources, now),
    itemState: new ItemStateStore(db.personal, config.timeZone, now),
    status,
    aiConnections,
    command,
    fetch: seams.fetch ?? ((input, init) => fetch(input, init)),
    publicNetwork: seams.publicNetwork ?? nodePublicNetwork,
    now,
    today: () => todayKey(config.timeZone, now()),
    close: () => (closing ??= (async () => {
      // A sign-in CLI left running could still finish a login after BELL stopped: wait until it is gone.
      // The databases close at once; ending a sign-in does not touch them.
      const logins = aiConnections.close();
      db.close();
      await logins;
    })()),
  };
}
