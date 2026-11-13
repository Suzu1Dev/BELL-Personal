import { Router } from "express";
import { isModuleVisible, MODULE_FEATURES, ROLE_FEATURES, type ProfileRole } from "../shared/profile.js";
import type { SourceStatus } from "../shared/sources.js";
import type { AiSuggestion, SuggestionKind } from "../shared/suggestions.js";
import type { DayKey } from "../shared/time.js";
import { QUEUE_SOURCES, type ActionCreated, type ActionId, type QueueCandidate, type QueueKind, type QueueSource, type TodayContribution, type TodayInput } from "../shared/today.js";
import { SUGGESTION_KINDS } from "../shared/suggestions.js";
import { AppError } from "./errors.js";
import type { CoreServices } from "./services.js";
import type { SourceSync } from "./sync.js";

/** What a feature module receives at setup: every core service, minus shutdown. */
export type ModuleContext = Omit<CoreServices, "close">;

/**
 * Accepting a suggestion: create the real record (todo, manual event…) from
 * suggestion.payload, validated again with zod, and return its id. Runs inside
 * POST /api/suggestions/:id/accept; the core then marks the suggestion accepted.
 */
/** What an acceptor made; `undo` removes it again when the decision cannot be recorded (decided meanwhile). */
export interface SuggestionAcceptOutcome { resultId?: string; result?: unknown; undo?: () => void | Promise<void> }
export type SuggestionAcceptor = (suggestion: AiSuggestion, ctx: ModuleContext, body: unknown) => Promise<SuggestionAcceptOutcome> | SuggestionAcceptOutcome;

/**
 * today(): this module's part of GET /api/today. Read local stores and the
 * source cache only (no network: it runs on every page load and must answer
 * within TODAY_MODULE_TIMEOUT_MS, 3 s); a throw or a timeout drops this
 * module's contribution and marks its sources as failed, the page still renders.
 */
export type TodayProvider = (ctx: ModuleContext, input: TodayInput) => Promise<TodayContribution> | TodayContribution;

/** What an ActionHandler receives (POST /api/actions, after the core validated the body). */
export interface ActionRequest {
  /** The action_log id; also what DELETE /api/actions/:actionId undoes. */
  actionId: string;
  /** `${source}:${sourceId}` */
  itemId: string;
  source: QueueSource;
  /** The part after the first colon: a Gmail message id, an assignment id, a todo id… */
  sourceId: string;
  action: ActionId;
  /** Validate with zod inside the handler; snooze's { until } is already checked by the core. */
  params: Record<string, unknown>;
  /** The row as last served by GET /api/today (with hints), or undefined for targets that are not queue rows (digest bulk actions). */
  item?: QueueCandidate;
  /** ai: items: the pending suggestion. */
  suggestion?: AiSuggestion;
  day: DayKey;
  now: Date;
}

/**
 * What a handler returns. The core records the action, writes the generic
 * item state (handled, snoozed…), runs `apply` before answering 202, defers
 * `remote` by ACTION_COMMIT_MS (6.5 s), and calls `undo`/`revert` on
 * DELETE /api/actions/:actionId. Closures live in memory: after a restart only
 * the core's generic state can be undone.
 */
export interface ActionPlan {
  /** zh-TW past-tense summary for logs and the handled list, e.g. 「已封存」. No message text. */
  label: string;
  /**
   * Local write, done before the 202 (create the todo, set done_at, mark the
   * suggestion's event). Throw AppError(status, zh) to refuse: nothing is
   * recorded then. Return { resultId } to record what was created (ai: items
   * store it on the accepted suggestion).
   */
  apply?: () => void | ActionApplied | Promise<void | ActionApplied>;
  /**
   * The remote write (Gmail modify, Calendar events.insert, GitHub PATCH), run
   * once 6.5 s after the request unless the user undid it first; run
   * immediately when the server shuts down. A throw marks the action failed,
   * calls `undo` and restores the item, so it reappears on the next poll.
   */
  remote?: (signal: AbortSignal) => Promise<void>;
  /** Reverts `apply` (before the commit, within 24 h for local-only actions, and after a failed remote). */
  undo?: () => void | Promise<void>;
  /** The inverse remote call once `remote` has committed (Gmail: add INBOX back). Without it, undo after the commit is a 409. */
  revert?: (signal: AbortSignal) => Promise<void>;
  /**
   * The target when it is not a row Today served (request.item undefined: #/work
   * marks an assignment due in 10 days, or a snoozed review): the core logs this
   * kind and title, and keeps the fingerprint for 標為已交 / 標為已審查 so the item
   * comes back when it changes. Ignored when request.item is set.
   */
  target?: { kind: QueueKind; title: string; fingerprint?: string };
}

/** What `apply` made: its id (stored on an accepted suggestion) and, for the toast, what it is. */
export interface ActionApplied {
  resultId?: string;
  created?: ActionCreated;
}

export type ActionHandler = (request: ActionRequest, ctx: ModuleContext) => ActionPlan | Promise<ActionPlan>;

/**
 * Actions that create a record in another module, whatever the item's source:
 * 轉待辦 (tasks), 排進 (calendar) and 轉成作業 (lms; it refuses items that are not mail).
 */
export const ANY_SOURCE_ACTIONS = ["todo", "schedule", "assignment"] as const;
export type AnySourceAction = (typeof ANY_SOURCE_ACTIONS)[number];

export interface ModuleParts {
  /** Mounted at `mountPath` (default /api/<name>). Routes inside are relative: router.get("/", …). */
  router?: Router;
  mountPath?: string;
  /** Extra mounts outside /api/<name>, e.g. { path: "/oauth/google", router }. */
  routes?: Array<{ path: string; router: Router }>;
  /** Background fetchers; started after the server listens, closed on shutdown. */
  sources?: SourceSync[];
  /** One-tap confirmation for the suggestion kinds this module owns (POST /api/suggestions/:id/accept). */
  acceptSuggestion?: Partial<Record<SuggestionKind, SuggestionAcceptor>>;
  /** Extra fields for GET /api/status under modules[<name>]; no secrets, no message text. */
  status?: () => unknown | Promise<unknown>;
  /** Called on shutdown after sources are closed. */
  close?: () => void | Promise<void>;
  /** This module's part of GET /api/today (shared/today.ts TodayContribution). */
  today?: TodayProvider;
  /** Queue actions on items whose id starts with one of these sources (not "ai"). One module per source. */
  actions?: Partial<Record<Exclude<QueueSource, "ai">, ActionHandler>>;
  /** Queue actions on `ai:<suggestionId>` rows, by suggestion kind (event → calendar, todo → tasks). 略過 is handled by the core. */
  suggestionActions?: Partial<Record<SuggestionKind, ActionHandler>>;
  /** 轉待辦 (todo), 排進 (schedule) and 轉成作業 (assignment) on an item of any source. */
  anySourceActions?: Partial<Record<AnySourceAction, ActionHandler>>;
  /**
   * A feature-gated module (shared/profile.ts MODULE_FEATURES) refuses writes on its
   * mounts with 409 module_hidden while its feature is hidden, and so do its
   * actions and acceptors. These router paths (and below) stay writable: the
   * module's connection, which a hidden module keeps and 設定 manages.
   */
  writableWhenHidden?: string[];
}

/**
 * The feature contract (docs/ARCHITECTURE.md). A module is plain data plus a
 * setup hook; register it in server/features/index.ts:
 *
 *   export const todosModule: FeatureModule = {
 *     name: "todos",
 *     setup(ctx) {
 *       const store = new TodoStore(ctx.db.personal, ctx.trash);
 *       return { router: createTodosRouter(store, ctx) };   // → /api/todos
 *     },
 *   };
 */
export interface FeatureModule {
  /** kebab-case, unique; the default mount path is /api/<name>. */
  name: string;
  /** zh-TW name used when this module's today() fails and it has no source to blame (「待辦」). */
  label?: string;
  setup(ctx: ModuleContext): ModuleParts | void;
}

export interface MountedModule {
  name: string;
  label: string;
  parts: ModuleParts;
  /** Every path this module mounts, router first. */
  mounts: Array<{ path: string; router: Router }>;
}

export interface RegisteredTodayProvider {
  name: string;
  label: string;
  /** Sources this module owns: they turn to "error" when its today() fails. */
  sourceIds: string[];
  today: TodayProvider;
}

const NAME = /^[a-z][a-z0-9-]{1,39}$/;
const MOUNT = /^\/(api|oauth)\/[a-z0-9][a-z0-9/-]{0,79}$/;
/** Paths the core owns; a module may not mount on or under them. */
export const RESERVED_MOUNTS = [
  "/api/health", "/api/status", "/api/settings", "/api/ai", "/api/sync", "/api/jobs", "/api/trash", "/api/suggestions",
  "/api/today", "/api/actions", "/api/export", "/api/suite", "/api/bot",
];
const ACTION_SOURCES = new Set<string>(QUEUE_SOURCES.filter((source) => source !== "ai"));
const ROLE_OWNED = new Set<string>(Object.keys(MODULE_FEATURES));
const ROLE_NAMES: Record<ProfileRole, string> = { student: "學生", developer: "開發者", ctf: "CTF 選手" };
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const SUGGESTION_KIND_SET = new Set<string>(SUGGESTION_KINDS);
const ANY_SOURCE_SET = new Set<string>(ANY_SOURCE_ACTIONS);

/**
 * Runs every module's setup once, validates names, mount paths, source ids and
 * handler registries, and owns the modules' lifecycle (start sources, close
 * everything).
 */
export class ModuleHost {
  readonly mounted: MountedModule[] = [];
  private readonly sourceList: SourceSync[] = [];
  private readonly acceptors = new Map<SuggestionKind, SuggestionAcceptor>();
  private readonly sourceActions = new Map<Exclude<QueueSource, "ai">, ActionHandler>();
  private readonly kindActions = new Map<SuggestionKind, ActionHandler>();
  private readonly anyActions = new Map<AnySourceAction, ActionHandler>();
  /** Which module registered each action handler and acceptor, for assertOwnerVisible(). */
  private readonly owners = new Map<ActionHandler | SuggestionAcceptor, string>();
  private started = false;

  constructor(modules: FeatureModule[], private readonly ctx: ModuleContext) {
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const module of modules) {
      if (!NAME.test(module.name)) throw new Error(`Invalid module name: ${module.name}`);
      if (names.has(module.name)) throw new Error(`Duplicate module name: ${module.name}`);
      names.add(module.name);
      const parts = module.setup(ctx) ?? {};
      const guard = ROLE_OWNED.has(module.name) ? this.writeGuard(module.name, parts.writableWhenHidden ?? []) : undefined;
      const mounts = [
        ...(parts.router ? [{ path: parts.mountPath ?? `/api/${module.name}`, router: parts.router }] : []),
        ...(parts.routes ?? []),
      ].map((mount) => guard ? { path: mount.path, router: Router().use(guard, mount.router) } : mount);
      for (const mount of mounts) {
        if (!MOUNT.test(mount.path) || mount.path.endsWith("/")) throw new Error(`Module ${module.name}: invalid mount path ${mount.path}`);
        if (RESERVED_MOUNTS.some((reserved) => mount.path === reserved || mount.path.startsWith(`${reserved}/`)))
          throw new Error(`Module ${module.name}: ${mount.path} is reserved for the core`);
        if (paths.has(mount.path)) throw new Error(`Module ${module.name}: ${mount.path} is already mounted`);
        paths.add(mount.path);
      }
      for (const source of parts.sources ?? []) {
        if (this.sourceList.some((item) => item.id === source.id)) throw new Error(`Module ${module.name}: duplicate source ${source.id}`);
        this.sourceList.push(source);
      }
      for (const [kind, acceptor] of Object.entries(parts.acceptSuggestion ?? {}) as [SuggestionKind, SuggestionAcceptor][]) {
        if (this.acceptors.has(kind)) throw new Error(`Module ${module.name}: suggestion kind ${kind} already has an acceptor`);
        this.acceptors.set(kind, acceptor);
        this.owners.set(acceptor, module.name);
      }
      register(this.sourceActions, parts.actions, ACTION_SOURCES, module.name, "actions");
      register(this.kindActions, parts.suggestionActions, SUGGESTION_KIND_SET, module.name, "suggestionActions");
      register(this.anyActions, parts.anySourceActions, ANY_SOURCE_SET, module.name, "anySourceActions");
      for (const handler of [parts.actions, parts.suggestionActions, parts.anySourceActions].flatMap((entries) => Object.values(entries ?? {})))
        if (handler) this.owners.set(handler, module.name);
      this.mounted.push({ name: module.name, label: module.label ?? module.name, parts, mounts });
    }
  }

  get sources(): readonly SourceSync[] {
    return this.sourceList;
  }

  source(id: string): SourceSync | undefined {
    return this.sourceList.find((item) => item.id === id);
  }

  acceptor(kind: SuggestionKind): SuggestionAcceptor | undefined {
    return this.acceptors.get(kind);
  }

  /** The handler for actions on items of this source (ModuleParts.actions). */
  actionHandler(source: QueueSource): ActionHandler | undefined {
    return source === "ai" ? undefined : this.sourceActions.get(source);
  }

  suggestionActionHandler(kind: SuggestionKind): ActionHandler | undefined {
    return this.kindActions.get(kind);
  }

  anySourceActionHandler(action: AnySourceAction): ActionHandler | undefined {
    return this.anyActions.get(action);
  }

  /**
   * 409 module_hidden while module `name`'s feature is hidden: by the roles
   * (profile.roles) or switched off by hand (features.overrides). The body
   * names the feature and the roles that turn it on, for the frontend to
   * offer 設定 › 身分與功能. Hiding never removes data: undo, 略過 on a
   * suggestion and the module's connection routes still work.
   */
  assertVisible(name: string): void {
    const settings = this.ctx.settings.get();
    const overrides = settings["features.overrides"];
    if (isModuleVisible(name, settings["profile.roles"], overrides)) return;
    const feature = MODULE_FEATURES[name]!;
    const roles = [...ROLE_FEATURES[feature]];
    const label = this.mounted.find((item) => item.name === name)?.label ?? name;
    const message = overrides[feature] === false
      ? `「${label}」已在 設定 › 身分與功能 手動關閉，打開後就能使用。`
      : `「${label}」目前沒有開啟。到 設定 › 身分與功能 勾選「${roles.map((role) => ROLE_NAMES[role]).join("」或「")}」後就能使用。`;
    throw new AppError(409, message, { code: "module_hidden", module: name, feature, roles });
  }

  /** assertVisible() for the module that registered this action handler or acceptor. */
  assertOwnerVisible(handler: ActionHandler | SuggestionAcceptor): void {
    const owner = this.owners.get(handler);
    if (owner) this.assertVisible(owner);
  }

  /** Middleware for a role-owned module's mounts: reads always pass, writes only while it shows (or on `writable` paths). */
  private writeGuard(name: string, writable: string[]) {
    const open = writable.map((path) => path.toLowerCase().replace(/\/+$/, ""));
    return (req: { method: string; path: string }, _res: unknown, next: () => void) => {
      // Express matches routes case-insensitively and ignores a trailing slash, so compare the same way.
      const path = req.path.toLowerCase().replace(/\/+$/, "");
      if (!READS.has(req.method) && !open.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) this.assertVisible(name);
      next();
    };
  }

  /** Modules with a today(), in registry order. */
  todayProviders(): RegisteredTodayProvider[] {
    return this.mounted.filter((item) => item.parts.today).map((item) => ({
      name: item.name,
      label: item.label,
      sourceIds: (item.parts.sources ?? []).map((source) => source.id),
      today: item.parts.today!,
    }));
  }

  /** Starts every source's interval; call once the server is listening. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const source of this.sourceList) source.start();
  }

  /** One status per source; a source whose status() throws reads as an error instead of failing the list. */
  async sourceStatuses(): Promise<SourceStatus[]> {
    const settled = await Promise.allSettled(this.sourceList.map((source) => source.status()));
    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const source = this.sourceList[index];
      return {
        id: source.id, label: source.label, configured: true, state: "error", lastSyncedAt: null, lastAttemptAt: null,
        lastError: `${source.label} 的狀態暫時無法取得，請檢查本機服務記錄。`, items: null, stale: true,
      };
    });
  }

  async moduleStatuses(): Promise<Record<string, unknown>> {
    const entries = await Promise.all(this.mounted.filter((item) => item.parts.status).map(async (item) => {
      try { return [item.name, await item.parts.status!()] as const; }
      catch { return [item.name, { error: "狀態暫時無法取得。" }] as const; }
    }));
    return Object.fromEntries(entries);
  }

  /** Aborts and awaits active fetches, then runs module close hooks. */
  async close(): Promise<void> {
    await Promise.allSettled(this.sourceList.map((source) => source.close()));
    await Promise.allSettled(this.mounted.map(async (item) => item.parts.close?.()));
  }
}

function register<K extends string>(target: Map<K, ActionHandler>, entries: Partial<Record<K, ActionHandler>> | undefined, allowed: Set<string>, module: string, field: string): void {
  for (const [key, handler] of Object.entries(entries ?? {}) as [K, ActionHandler | undefined][]) {
    if (!handler) continue;
    if (!allowed.has(key)) throw new Error(`Module ${module}: ${field}.${key} is not a valid key`);
    if (target.has(key)) throw new Error(`Module ${module}: ${field}.${key} already has a handler`);
    target.set(key, handler);
  }
}
