import { AI_CONNECTION_CLI, type AiConnectionMethod } from "../../shared/ai-connections.js";
import type { ApiErrorDetail } from "../../shared/api.js";
import { DEFAULT_PROVIDER_SETTINGS, agentProviders, type AgentProvider, type ModelCatalog, type ProviderSettings, type ProviderSnapshot } from "../../shared/models.js";
import { AppError } from "../errors.js";
import type { AppDatabase } from "../db/database.js";
import { claudeModelCatalog, providerSettingsSchema, resolveModelExecution } from "./models.js";

/** The one provider/model/effort row every AI job uses (settings.sqlite, CHECK(id=1)). */
export class ProviderSettingsStore {
  constructor(private readonly database: AppDatabase, private readonly defaults: ProviderSettings = DEFAULT_PROVIDER_SETTINGS) {}

  get(): ProviderSettings {
    const row = this.database.db.prepare("SELECT json FROM provider_settings WHERE id = 1").get();
    if (!row) return { ...this.defaults };
    try {
      return providerSettingsSchema.parse(JSON.parse(String(row.json)));
    } catch {
      throw new AppError(500, "模型設定資料損毀，請從備份還原設定資料庫，或重新選擇模型。");
    }
  }

  save(settings: ProviderSettings): ProviderSettings {
    const parsed = providerSettingsSchema.parse(settings);
    this.database.db.prepare("INSERT INTO provider_settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(JSON.stringify(parsed));
    return parsed;
  }
}

export type CatalogLoader = (provider: AgentProvider, signal: AbortSignal) => Promise<ModelCatalog>;

interface CatalogEntry {
  value: ModelCatalog;
  detail?: ApiErrorDetail;
  expires: number;
}

/**
 * bell-explain's ProviderService: model catalogs cached for 60 s (10 s after a
 * failure), validation of a settings patch against the catalog, and the
 * settings every job runs with.
 *
 * With an active connection (設定 › 連接 AI) the provider is the connection's
 * CLI: a stored row for the other CLI reads as that CLI with its default
 * model, and a patch naming the other CLI is refused. The Codex catalog is
 * cached per connection, since an API key and a ChatGPT plan can list
 * different models.
 *
 * `ready` is the job's own readiness check (AiRunner.checkLogin for an active
 * connection). The Codex list runs it before starting anything, so an active
 * connection never lists through a login the user did not choose: it gets
 * `{models: [], error, notReady}` with the connection's message and reason. A
 * save runs it too and is refused with that 503 while the connection cannot run.
 */
export class ProviderService {
  private readonly cache = new Map<string, CatalogEntry>();
  private readonly loading = new Map<string, Promise<{ value: ModelCatalog; detail?: ApiErrorDetail }>>();
  private generation = 0;

  constructor(
    private readonly store: ProviderSettingsStore,
    private readonly loadCodexCatalog: (signal: AbortSignal) => Promise<ModelCatalog>,
    private readonly connection: () => AiConnectionMethod | null = () => null,
    private ready: (provider: AgentProvider, signal: AbortSignal) => Promise<void> = async () => {},
  ) {}

  /** Sets the connection readiness check run before listing Codex models or saving a model. */
  setReadyCheck(ready: (provider: AgentProvider, signal: AbortSignal) => Promise<void>): void {
    this.ready = ready;
  }

  /** The settings every job runs with: the stored row, on the active connection's CLI. */
  settings(): ProviderSettings {
    const stored = this.store.get();
    const active = this.connection();
    const provider = active ? AI_CONNECTION_CLI[active] : stored.provider;
    return provider === stored.provider ? stored : { ...stored, provider, model: "", reasoningEffort: "" } as ProviderSettings;
  }

  /** Forget cached catalogs (a key was saved or removed, so the next load may sign in differently). */
  invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.loading.clear();
  }

  /** `signal` stops waiting (409) without cancelling the shared load other callers may be waiting on. */
  async catalog(provider: AgentProvider, force = false, signal?: AbortSignal): Promise<ModelCatalog> {
    return (await this.loadCatalog(provider, force, signal)).value;
  }

  private async loadCatalog(provider: AgentProvider, force = false, signal?: AbortSignal): Promise<{ value: ModelCatalog; detail?: ApiErrorDetail }> {
    if (provider === "claude") return { value: structuredClone(claudeModelCatalog) };
    const key = `${provider}:${this.connection() ?? ""}`;
    const cached = this.cache.get(key);
    if (!force && cached && cached.expires > Date.now()) {
      return { value: structuredClone(cached.value), ...(cached.detail ? { detail: structuredClone(cached.detail) } : {}) };
    }
    const pending = this.loading.get(key);
    if (pending) {
      const entry = await untilAborted(pending, signal);
      return { value: structuredClone(entry.value), ...(entry.detail ? { detail: structuredClone(entry.detail) } : {}) };
    }
    const generation = this.generation;
    const timeout = AbortSignal.timeout(25_000);
    const load = this.ready(provider, timeout).then(() => this.loadCodexCatalog(timeout))
      .then(
        (value): { value: ModelCatalog; detail?: ApiErrorDetail } => ({ value }),
        (error): { value: ModelCatalog; detail?: ApiErrorDetail } => {
          const detail = error instanceof AppError && error.status === 503 ? error.detail : undefined;
          const notReady = detail?.code === "ai_connection_not_ready" ? { method: detail.method, reason: detail.reason } : undefined;
          return {
            value: {
              source: provider,
              models: [],
              error: error instanceof AppError ? error.message : "暫時無法讀取 Codex 模型清單。請確認已在伺服器執行 codex login，稍後再重新整理。",
              ...(notReady ? { notReady } : {}),
            },
            ...(detail ? { detail } : {}),
          };
        },
      )
      .then((entry) => {
        if (this.generation === generation) {
          this.cache.set(key, { ...entry, expires: Date.now() + (entry.value.error ? 10_000 : 60_000) });
        }
        return entry;
      })
      .finally(() => {
        if (this.loading.get(key) === load) this.loading.delete(key);
      });
    this.loading.set(key, load);
    const entry = await untilAborted(load, signal);
    return { value: structuredClone(entry.value), ...(entry.detail ? { detail: structuredClone(entry.detail) } : {}) };
  }

  async snapshot(force = false): Promise<ProviderSnapshot> {
    return {
      settings: this.settings(),
      connection: this.connection(),
      catalogs: await Promise.all(agentProviders.map((provider) => this.catalog(provider, force))),
    };
  }

  /** Accepts any subset of {provider, model, reasoningEffort}; switching provider without a model resets to its defaults. */
  async update(patch: unknown): Promise<ProviderSnapshot> {
    const parsed = providerSettingsSchema.partial().strict().safeParse(patch);
    if (!parsed.success || !Object.keys(parsed.data).length) throw new AppError(400, "模型設定格式不正確。");
    const current = this.settings();
    const active = this.connection();
    if (active && parsed.data.provider && parsed.data.provider !== AI_CONNECTION_CLI[active]) {
      throw new AppError(409, "目前選用的 AI 連線只能使用 " + (AI_CONNECTION_CLI[active] === "claude" ? "Claude Code" : "Codex") + "。要換成另一個，請先到 設定 › 連接 AI 改選連線。");
    }
    const switching = parsed.data.provider && parsed.data.provider !== current.provider;
    const merged: ProviderSettings = {
      ...current,
      ...(switching ? { model: "", reasoningEffort: "" } : {}),
      ...parsed.data,
    } as ProviderSettings;
    // An active connection that cannot run here: 503 ai_connection_not_ready, not a model saved for a login that cannot run.
    await this.ready(merged.provider, AbortSignal.timeout(25_000));
    const { value: catalog, detail } = await this.loadCatalog(merged.provider);
    if (catalog.error && !catalog.models.length) throw new AppError(503, catalog.error, detail);
    resolveModelExecution(merged, catalog);
    this.store.save(merged);
    return this.snapshot();
  }
}

/** `promise`, or a 409 as soon as `signal` aborts (the promise keeps running for other waiters). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new AppError(409, "工作已取消。"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AppError(409, "工作已取消。"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
