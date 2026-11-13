# BELL Personal architecture and feature contract

This is the contract feature engineers follow. The foundation (server core,
persistence, vault, sync, jobs, AI layer, shared types, deployment) is done;
features plug in as **modules** without editing `server/app.ts` or the
registry: every feature module is registered in `server/features/index.ts`
and implemented in its own folder (`server/features/<name>/`). What works
today, what still needs real credentials and the known gaps are in
`docs/STATUS.md`. Read `AGENTS.md` for the working rules, `docs/design/SPEC-ux.md` for the
binding UX spec and the engineering brief for product decisions. The
cross-module contracts (Today, actions, settings, Google, connect endpoints,
ownership) are in **section 10**.

```
browser ──HTTPS── Tailscale Serve :20003 ──► 127.0.0.1:20003  Express (one process)
                                               │
  helmet-like headers → compression → request log → localhostGuard (Host/Origin/
  Sec-Fetch-Site/JSON-only writes/CSP) → tailscaleIdentityGate → express.json(160kb)
  → /api/health · /privacy · core routes (incl. /api/today, /api/actions, /api/export)
  · /api/suite (BELL Suite, read-only, §10.14) · module routers (/api/<name>, /oauth/google)
  → /api 404 → static dist + SPA → errors
                                               │
     CoreServices (server/services.ts) ── ModuleContext for every module
       db.personal / db.sources / db.settings (node:sqlite, migrated)
       trash · vault · jobs · ai.runStructured · provider · settings
       syncState · sourceItems · suggestions · itemState · status · command · fetch · now · today
                                               │
     TodayService (server/today/) ── every module's today() → buildToday() (shared/today-logic.ts)
       ActionService ── POST /api/actions → core or the module's ActionHandler; remote writes deferred 6.5 s
```

## 1. Layout

| Path | What lives there |
| --- | --- |
| `server/index.ts` | Composition root: `readRuntimeConfig()` → `createServices()` → `createApp()` → listen → `modules.start()`; drain on SIGTERM, then `await services.close()` (it waits for a running sign-in CLI, SIGKILL 1.5 s after SIGTERM) before exit. |
| `server/app.ts` | `createApp(services, { modules, staticDirectory })`; middleware order; error handler. |
| `server/modules.ts` | `FeatureModule`, `ModuleParts`, `ModuleContext`, `ModuleHost`. |
| `server/features/index.ts` | **The registry**: `export const featureModules: FeatureModule[]`. Already lists every module; teams do not edit it. |
| `server/features/<name>/` | One folder per feature module (store, router, sources, prompts, tests). `google/` is the core platform's; the other twelve belong to the feature teams (§10.1). |
| `server/core-routes.ts` | Routes the core owns (status, settings, sync, jobs, trash, suggestions, Today, actions, export). |
| `server/today/` | `service.ts` (TodayService: collects today(), degrades failures, builds the payload), `actions.ts` (ActionService and the deferred remote-write queue), `item-state.ts` (`ItemStateStore`, `ctx.itemState`), `schema.ts` (zod for contributions and payloads), `suggestions.ts` (pending AI suggestions as rows), `router.ts`. |
| `server/google/auth.ts` | Google OAuth flow, `googleClient(ctx)`, `googleConnected`, `googleCapabilities`. |
| `server/privacy.ts`, `server/export.ts` | `GET /privacy` (+ `/privacy.css`) and `GET /api/export`. |
| `server/fixtures/today-*.json` | TodayPayload fixtures for the UI (mockup, degraded, empty, cleared). |
| `scripts/seed-demo.ts` | `npm run seed:demo`: the SPEC §13 mockup day relative to `--now`. |
| `server/db/` | `migrate.ts` (bell-explain verbatim), `schema.ts` (all DDL), `database.ts` (`AppDatabase`, `DocTable`), `trash.ts`. |
| `server/stores/` | Core stores: app settings, sync state, source items, suggestions. |
| `server/secrets/` | `redact.ts` (bell-pr secrets + Google shapes; `redactCliOutput(text, secrets)` also masks an OpenAI/Anthropic key's prefix, suffix and shortened echoes, §5), `vault.ts`. |
| `server/sync.ts` | `SourceSync` base class, `safeFetch`, `expectOk`, `ReconnectRequiredError`. |
| `server/public-fetch.ts` | `publicFetch` for URLs nobody vetted (the mail image proxy): public addresses only, IP-pinned connections, re-checked redirects, caps (§10.11); `PublicNetwork` seam (`ctx.publicNetwork`). |
| `server/jobs.ts`, `jobs-router.ts`, `generation-progress.ts` | In-memory jobs with NDJSON streaming and heartbeats. |
| `server/ai/` | `process.ts` (`command()`, env allow-lists), `agent-cli.ts`, `agent-slots.ts`, `agent-timeouts.ts`, `models.ts`, `codex.ts`, `provider-settings.ts`, `structured.ts` (`runStructured`). |
| `server/prompts/boundary.ts` | Trust boundary text and `untrustedBlock()`. |
| `shared/` | Types, `as const` enums, limits and pure helpers used by both sides. No Node APIs. `today.ts` (the Today contract), `today-logic.ts` (grouping, counts, rule brief), `today-format.ts` (SPEC §10 time phrases, action presets), `settings.ts`, `connect.ts` (connect endpoint bodies). |
| `src/` | React 19 + Vite 7. `api.ts`, `app/` (shell), `components/`, `copy/`, `lib/` (router, today/status stores, keys, shortcuts, usePoll), `pages/`, `styles/tokens.css`, `styles/base.css`, and the C presentation layer in `styles/precise*.css` (see `docs/design/SPEC-ux-c-precise.md`). One folder and one CSS file per page/component; see `docs/FRONTEND.md`. |

Imports: server files use the `.js` suffix (`import { x } from "./y.js"`);
`src/` imports shared code without a suffix (`from "../shared/todos"`).

## 2. The module contract

```ts
// server/modules.ts
export type ModuleContext = Omit<CoreServices, "close">;

export interface FeatureModule {
  /** kebab-case, unique; the default mount path is /api/<name>. */
  name: string;
  /** zh-TW name shown when this module's today() fails and it owns no source (「待辦」). */
  label?: string;
  setup(ctx: ModuleContext): ModuleParts | void;
}

export interface ModuleParts {
  /** Mounted at `mountPath` (default /api/<name>). Routes inside are relative. */
  router?: Router;
  mountPath?: string;
  /** Extra mounts, e.g. { path: "/oauth/google", router }. Must start with /api/ or /oauth/. */
  routes?: Array<{ path: string; router: Router }>;
  /** Background fetchers; started after the server listens, closed on shutdown. */
  sources?: SourceSync[];
  /** One-tap confirmation for the suggestion kinds this module owns. */
  acceptSuggestion?: Partial<Record<SuggestionKind, SuggestionAcceptor>>;
  /** Extra fields for GET /api/status under modules[<name>]; no secrets, no message text. */
  status?: () => unknown | Promise<unknown>;
  /** Called on shutdown after sources are closed. */
  close?: () => void | Promise<void>;
  /** This module's part of GET /api/today (§10.2). */
  today?: TodayProvider;
  /** Queue actions on items whose id starts with one of these sources (§10.3). Not "ai". */
  actions?: Partial<Record<Exclude<QueueSource, "ai">, ActionHandler>>;
  /** Queue actions on `ai:<suggestionId>` rows, by suggestion kind (§10.3). */
  suggestionActions?: Partial<Record<SuggestionKind, ActionHandler>>;
  /** 轉待辦 ("todo", tasks team) and 排進 ("schedule", calendar team) on an item of any source. */
  anySourceActions?: Partial<Record<"todo" | "schedule", ActionHandler>>;
  /** Role-owned modules only: router paths that stay writable while the module is hidden (its connection). */
  writableWhenHidden?: string[];
}

export type SuggestionAcceptor = (suggestion: AiSuggestion, ctx: ModuleContext, body: unknown)
  => Promise<{ resultId?: string; result?: unknown }> | { resultId?: string; result?: unknown };

export type TodayProvider = (ctx: ModuleContext, input: TodayInput) => Promise<TodayContribution> | TodayContribution;
export type ActionHandler = (request: ActionRequest, ctx: ModuleContext) => ActionPlan | Promise<ActionPlan>;
```

`ModuleHost` (created inside `createApp`) runs every `setup()` once, then
rejects: invalid or duplicate names, mount paths outside `/api/…` or
`/oauth/…`, paths on or under the core's reserved prefixes (`/api/health`,
`/api/status`, `/api/settings`, `/api/ai`, `/api/sync`, `/api/jobs`, `/api/trash`,
`/api/suggestions`, `/api/today`, `/api/actions`, `/api/export`, `/api/suite`), two modules
on one path, two sources with one id, two acceptors for one suggestion kind,
and two action handlers for one key (or a key that is not a valid source,
suggestion kind or any-source action). It is reachable as
`appContext(app).modules`; the Today service as `appContext(app).today`.

`CoreServices` (what `ctx` contains):

```ts
interface CoreServices {
  config: RuntimeConfig;            // validated env (ports, tz, dataDir, google client, …)
  db: Databases;                    // { personal, sources, settings: AppDatabase; close() }
  trash: Trash;                     // soft delete + undo tokens
  vault: Vault;                     // encrypted credentials
  jobs: JobRegistry;                // streaming model work
  slots: AgentSlots;                // CLI process limit (default 1)
  provider: ProviderService;        // provider/model/effort settings + catalogs
  ai: AiRunner;                     // ai.runStructured(...)
  settings: AppSettingsStore;       // app preferences (flat keys)
  syncState: SyncStateStore;        // per-source cursor/status rows
  sourceItems: SourceItemStore;     // generic cache of fetched items
  suggestions: SuggestionStore;     // AI output awaiting the user's decision
  itemState: ItemStateStore;        // Today queue state + action log (§10.3): markHandled(), clear()
  status: StatusService;            // cached CLI probes
  command: CommandRunner;           // command() or a test fake — use it for gh
  fetch: FetchLike;                 // fetch or a test fake
  publicNetwork: PublicNetwork;     // DNS + IP-pinned HTTP(S) for publicFetch() only; testServices() makes it offline
  now: () => Date;
  today: () => DayKey;              // today in BELLPERSONAL_TZ, never the host's UTC date
  todayPayload?: () => Promise<TodayPayload>;   // GET /api/today built in-process (set by createApp; the brief job reads it; never call it from a today())
  close(): void;
}
```

### Adding a feature, step by step

1. **Shared types** — put the entity, its enums (`as const` arrays) and limits
   in `shared/<domain>.ts`. Most are already there: `Todo`, `Project`/`Milestone`,
   `Habit`/`HabitLog`, `Idea`, `CalendarEvent`/`ManualEvent`, `MailMessage`/
   `MailTriage`, `Assignment`, `GitHubItem`/`ContributionDay`, `ExternalEvent`/
   `FeedSubscription`, `AiSuggestion` + payloads, `DailyBrief`, `SourceStatus`,
   `Weather`. New fields are optional. Never duplicate a type in `src/`.
2. **Schema** — the v1 tables already exist (section 4). If you need a change,
   append a step to the right array in `server/db/schema.ts` (see AGENTS.md
   for the compatibility rules) and extend the persisted zod schema.
3. **Store** — wrap your table in a `DocTable` with a zod schema and derived
   index columns, attach `ctx.trash` for undoable deletes. Keep SQL in the store.
4. **Routes** — an Express `Router`; parse every body inline with
   `z.object({...}).strict().parse(req.body)`; throw `AppError(status, zhMessage)`.
   Express 5 forwards async throws: no try/catch per route. List endpoints
   return summaries (`items.map(summarizeX)`), detail endpoints the full record.
5. **Sources** (optional) — subclass `SourceSync` (section 6), write normalised
   shared types into `ctx.sourceItems`, and return them from `ModuleParts.sources`.
6. **AI** (optional) — call `ctx.ai.runStructured()` (section 5) inside a job,
   store the result with `ctx.suggestions.create()`, and register an
   `acceptSuggestion` handler that turns an accepted suggestion into a record.
7. **Register** — nothing to do: your module is already in
   `server/features/index.ts`. Implement `setup()` in your folder's
   `index.ts`, keep the exported name (`todosModule`…), and read the comment
   at the top of the stub: it lists what your team owns. Return `today()`
   (§10.2) so the module has its compact form on `#/today`, and register
   `actions` / `suggestionActions` / `anySourceActions` (§10.3) for the queue
   buttons your rows offer.
8. **Frontend** — every SPEC-ux §3.1 route already exists in
   `src/lib/router.ts` with a placeholder page: replace
   `src/pages/<dir>/<Name>Page.tsx` (own CSS), read Today data through
   `useToday()`, other data through `api()`/`send()` and `usePoll()`, and
   strings from `src/copy/<domain>.ts`. See `docs/FRONTEND.md`.
9. **Tests** — colocated `*.test.ts`; HTTP tests use `startTestServer(t,
   testServices(t), { modules: [yourModule] })` from `server/test-helpers.ts`.
   `server/integration.test.ts` runs every registered module together on the
   seeded demo day (Today rows, action handlers, acceptors, capture, habits ↔
   GitHub); extend it when a contract between modules changes.

### Example module

```ts
// server/features/todos/index.ts
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SOURCE_IDS } from "../../../shared/sources.js";
import { TODO_PRIORITIES, TODO_STATUSES, TODO_ORIGINS, TODO_LIMITS, type Todo } from "../../../shared/todos.js";
import { AppError } from "../../errors.js";
import type { FeatureModule } from "../../modules.js";

const todoSchema: z.ZodType<Todo> = z.object({
  id: z.string(), title: z.string().max(TODO_LIMITS.title), notes: z.string().max(TODO_LIMITS.notes).optional(),
  status: z.enum(TODO_STATUSES), priority: z.enum(TODO_PRIORITIES), dueDay: z.string().optional(),
  dueTime: z.string().optional(), projectId: z.string().optional(), origin: z.enum(TODO_ORIGINS),
  sourceRef: z.object({ source: z.enum(SOURCE_IDS), externalId: z.string(), url: z.string().optional() }).optional(),
  createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(),
});   // every field of the shared type: zod strips unknown keys on put()

export const todosModule: FeatureModule = {
  name: "todos",
  setup(ctx) {
    const todos = ctx.db.personal.docs<Todo>({
      table: "todos", label: "待辦", schema: todoSchema,
      columns: (todo) => ({ status: todo.status, due_day: todo.dueDay ?? null, project_id: todo.projectId ?? null, created_at: todo.createdAt }),
    }, ctx.trash);
    const router = Router();
    router.get("/", (_req, res) => { res.json(todos.list({ where: "status = ?", params: ["open"], orderBy: "due_day IS NULL, due_day, created_at" })); });
    router.post("/", (req, res) => {
      const input = z.object({ title: z.string().trim().min(1).max(TODO_LIMITS.title), dueDay: z.string().optional() }).strict().parse(req.body);
      const now = ctx.now().toISOString();
      res.status(201).json(todos.put({ id: randomUUID(), title: input.title, status: "open", priority: "normal", origin: "manual", ...(input.dueDay ? { dueDay: input.dueDay } : {}), createdAt: now, updatedAt: now }));
    });
    router.delete("/:id", (req, res) => {
      const result = todos.delete(req.params.id);
      if (!result.deleted) throw new AppError(404, "找不到這項待辦。");
      res.json({ undoToken: result.undoToken });           // the 6 s undo toast calls POST /api/trash/restore
    });
    return {
      router,                                               // → /api/todos
      acceptSuggestion: {
        todo: (suggestion, context) => {
          const payload = z.object({ title: z.string().min(1).max(TODO_LIMITS.title), dueDay: z.string().optional() }).parse(suggestion.payload);
          const now = context.now().toISOString();
          const todo = todos.put({ id: randomUUID(), title: payload.title, status: "open", priority: "normal", origin: "suggestion",
            ...(payload.dueDay ? { dueDay: payload.dueDay } : {}), ...(suggestion.sourceRef ? { sourceRef: suggestion.sourceRef } : {}), createdAt: now, updatedAt: now });
          return { resultId: todo.id, result: todo };
        },
      },
    };
  },
};
```

## 3. Core HTTP API

| Route | Notes |
| --- | --- |
| `GET /api/health` | Public (identity gate exempt): `{status, version, release, uptimeSeconds}`. No personal data. |
| `GET /api/status` | `StatusResponse` (`shared/api.ts`): today, timeZone, AI settings + CLI probes (cached 10 s; `account: {kind: subscription\|api_key, plan?}` when signed in, never the email), GitHub login, vault/google configured, every `SourceStatus`, module status extras, limits. |
| `GET /api/settings/provider` | `{settings, catalogs}`; `?refresh=true` reloads catalogs. |
| `PUT /api/settings/provider` | Any subset of `{provider, model, reasoningEffort}`, validated against the catalog (400/503). Switching provider without a model resets to that provider's defaults. While the active key connection cannot run here (no usable key and no CLI key login), 503 `{code: "ai_connection_not_ready", method, reason}` and nothing is saved; the Codex catalog in `GET` is then `{models: [], error}` with the same words, and no Codex process is started (the check is the job's own `AiRunner.checkLogin`). |
| `GET /api/settings/app` | `AppSettings` with defaults (`shared/settings.ts`). |
| `PUT /api/settings/app` | Any subset of known keys; unknown keys or invalid values → 400. Add keys in `shared/settings.ts` **and** `server/stores/app-settings.ts`. A patch that changes `ai.connection` gets the readiness check of `PUT /api/ai/connections/active` (409 `ai_connection_not_ready`, and nothing in the patch is written); the current value again, or `null`, passes. |
| `GET /api/ai/connections[?refresh=true]` | 初次設定 › 連接 AI (`server/ai/connections.ts`, `shared/ai-connections.ts`): `{connections: AiConnection[], active, activeStatus, vault: {enabled}, checkedAt}` (`active` = app setting `ai.connection`, §10.4; `activeStatus` = `null` \| `{method, ready: true, source}` \| `{method, ready: false, reason, message}`, also on `GET /api/status` as `ai.connection`; `source` as on the method's row, so `openai-key` / `anthropic-key` with `source: cli` = no key saved here, jobs use the CLI's own API-key login, §5.1), one row per method `chatgpt` (Codex + ChatGPT plan), `claude` (Claude Code + Pro/Max), `openai-key`, `anthropic-key`, each `detected` (`source: cli` = the CLI's own login on the server, `bell` = a key saved here, + `savedKey: {provider, hint, verifiedAt}`: `hint` = 「••••」 and the key's last 4 characters, `null` for a key shorter than 8; `verifiedAt` = ISO time BELL's check of this key passed, `null` for a key saved before BELL kept it) / `not_set` / `pending` (+ `prompt` while a sign-in waits) / `failed` (+ zh-TW `message`; a failed browser sign-in also carries `failure` = `denied` \| `code_rejected` \| `timed_out` \| `cli_error`, `AI_LOGIN_FAILURES`, for the frontend's own copy, §5.1); every state but `detected` carries `reason` (`AiNotReadyReason`: `cli_not_installed`, `pending`, `not_signed_in`, `wrong_login`, `key_missing`, `key_unreadable`, `vault_disabled`). `no-store`; never a key (beyond `savedKey.hint`), email or raw CLI output. |
| `POST /api/ai/connections/:method/login` | `chatgpt` \| `claude`, body `{}` (no options: fixed argv) → `AiConnection` once the CLI shows its link. ChatGPT runs `codex login --device-auth` → `prompt {kind: device_code, url, code, expiresAt}` (15 min; poll `GET`). Claude runs `claude auth login --claudeai` → `prompt {kind: paste_code, url, expiresAt}`. Only https links on the provider's sign-in hosts are passed on. A second call rejoins the running sign-in; only one sign-in runs at a time, so starting the other method while one waits is 409 「… 的登入還在進行中…」. 409 while that CLI is already signed in (switching accounts stays a terminal `logout`), 503 CLI missing, 502 no link within 30 s. |
| `DELETE /api/ai/connections/:method/login` | `{}` → 204; stops that sign-in (not recorded as a failure) and clears the method's last failed attempt, so its row goes back to `not_set`. |
| `POST /api/ai/connections/claude/login/code` | `{code}` (the code Claude's page shows; 10–1000 of `[A-Za-z0-9._~#+/=:-]`) → written to the waiting CLI's stdin, never an argv → `AiConnection` (`detected`) or 422 with the failed row's message (「這組代碼沒有被接受…」 `code_rejected`, 「確認代碼逾時…」 `timed_out` after 30 s, …; the row's `failure` says which, §5.1); 409 no sign-in waiting. |
| `PUT /api/ai/connections/keys/:provider` | `openai` \| `anthropic`, `{key}` → shape check (400 with a fixed message, including the other provider's prefix), then one tiny turn of that CLI with the key only in its environment and a throwaway config home (deleted afterwards): `codex exec --ephemeral --ignore-user-config …` with BELL's own model provider (`-c model_provider="bell_openai"`, `env_key` `BELL_OPENAI_API_KEY`; codex app-server ignores `OPENAI_API_KEY`/`CODEX_API_KEY`), `claude -p --model haiku --tools "" …` with `ANTHROPIC_API_KEY`; homes are `<dataDir>/ai/keycheck-*`. The fixed one-token `codex exec` prompt is the accepted cost of the check (no HTTP client of our own). Only a key that answers is saved, in the vault as `ai.key.openai` / `ai.key.anthropic` `{key, verifiedAt}`, then `ai.keymeta.<provider>` `{hint, verifiedAt}` (what `savedKey` shows, so listing never opens the key; the old one's is removed before the key is replaced). The answer is the method's `AiConnection` with the new `savedKey`; a refused key changes nothing, the old key and its `savedKey` stay. 422 `{code: "ai_key_invalid"}` when rejected or `{code: "ai_key_no_credit"}` when the account has no credit, 502 provider unreachable, 503 no master key or CLI missing, 409 a check for that provider is running. Logs `ai.key_check {provider, outcome}` only. |
| `DELETE /api/ai/connections/keys/:provider` | `{}` → 204; removes the saved key and its `ai.keymeta.<provider>`. |
| `PUT /api/ai/connections/active` | `{method: AiConnectionMethod \| null}` → `AiConnectionsResponse`; the connection every AI job uses (`ai.connection`). 409 `{code: "ai_connection_not_ready", method, reason}` unless that method is `detected`; `null` = back to whatever the selected CLI is signed in with. Logs `ai.connection {method}`. How jobs honour it: §5.1. |
| `POST /api/sync` | `{sources?: SourceId[], force?: boolean}` → 202 `{started, sources}`. Schedules every stale (or forced) configured source. The UI calls it on load and on window focus. |
| `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/events?from=N`, `DELETE /api/jobs/:id` | Job list, view or outcome, NDJSON replay/follow, cancel. |
| `POST /api/trash/restore` | `{token}` → `{restored: {table, id, value}}`; 404 once used or expired, 409 if the record exists again. |
| `GET /api/suggestions?status=&kind=` | Suggestion inbox. |
| `POST /api/suggestions/:id/accept` | Runs the owning module's acceptor, then records `accepted` + `resultId`; 409 if already decided or an accept of it is in flight (an acceptor's `undo` removes its record when the decision lost a race), 501 if no module accepts that kind. |
| `POST /api/suggestions/:id/dismiss` | Records `dismissed`. |
| `GET /api/today` | `TodayPayload` (`shared/today.ts`, §10.2). Counts are the single source of truth for the H1, nav badges, quickbar, progress and queue footer. |
| `POST /api/actions` | `{itemId, action, params?}` → 202 `ActionAccepted {actionId, undoUntil, label, created?}` (§10.3; `created` names the record 轉成作業 / 加入作業 made or reused, for the toast). 400 invalid/not an action of that row/snooze past `snoozeLimit`, 404 unknown suggestion, 409 suggestion already decided or the same action closed the item within the commit window (「這個項目剛剛已經處理過了。」; a different closing action, such as 刪除 right after 轉成作業, goes ahead and takes over the item state), 501 no module handles it, 503 shutting down. |
| `GET /api/actions/:actionId` | `ActionStatus {state: applied\|pending\|committed\|undone\|failed\|logged, error?}`; poll once after `undoUntil` to learn whether a remote write failed. |
| `DELETE /api/actions/:actionId` | `{}` → 200 `{undone, actionId}`. Before the commit: cancels the remote write and runs `undo`. After it: runs `revert` if the handler has one, else 409. Local-only actions: within 24 h. 409 when already undone, failed, logged-only (`open`) or the item changed since. |
| `GET /api/export` | JSON download (`Content-Disposition: attachment`) of every personal table and the effective settings; `?include=sources` adds `source_items`, `sync_state` and `ai_suggestions`. Never the vault. |
| `GET /api/suite/manifest` | BELL Suite manifest (§10.14): `{schemaVersion:1, appId:"personal", displayName, summary, capabilities, links}`; `links` holds only the validated sibling browser origins. `no-store`. |
| `GET /api/suite/sources[?refresh=1]` | `{schemaVersion:1, sources:[{appId, status, lastSuccessAt?, feed?}]}` for `explain` and `pr` (§10.14); `refresh=1` re-reads now (joined with a read in flight). `no-store`. |
| `GET /privacy`, `GET /privacy.css` | Static privacy policy (decisions.md item 16); public like `/api/health`. |
| `GET/PUT/POST/DELETE /api/google…`, `GET /oauth/google/…` | Google connection (core platform module `google`, §10.5). |

Every write (POST/PUT/PATCH/DELETE) must carry `Content-Type: application/json`
**and a body** (the guard answers 415 otherwise; use `send("DELETE")` on the
client, which sends `{}`). Unknown `/api/*` paths are a JSON 404.

## 4. Persistence

### Databases (all in `BELLPERSONAL_DATA_DIR`, directory 0700, files 0600, WAL, `synchronous=FULL`, `busy_timeout=5000`)

| File / `AppDatabase` | v1 tables | Owner |
| --- | --- | --- |
| `personal.sqlite` / `ctx.db.personal` | v1: `todos` (+`status, due_day, project_id, created_at`), `projects` (+`status, created_at`; milestones inside the JSON), `habits` (+`archived, sort_order, created_at`), `habit_logs` (relational: `habit_id, day, count, note, created_at, updated_at`, PK `(habit_id, day)`), `ideas` (+`archived, pinned, created_at`), `manual_events` (+`starts_at, ends_at, created_at`), `daily_briefs` (`id` = day, +`source`). v2: `item_state` (`item_id` PK, `state, until, day, fingerprint, action, action_id, at`) and `action_log` (`id, day, item_id, kind, action, title, params, at, undone, closes, remote, commit_at, error, previous, actor, updated_at`). v3: `event_feeds` (+`enabled, target, created_at`; FeedSubscription). v4: `local_assignments` (+`origin, due_at, source_message_id, created_at`; native `Assignment`s from mail or added by hand) | tasks, projects, habits, ideas, calendar/events, brief modules; v2 tables: core (`ctx.itemState`); v3: events module; v4: lms module |
| `sources.sqlite` / `ctx.db.sources` (`secure_delete=ON`) | `source_items`, `sync_state`, `ai_suggestions` | core stores (`sourceItems`, `syncState`, `suggestions`) |
| `settings.sqlite` / `ctx.db.settings` | `provider_settings` (singleton `CHECK(id=1)`), `app_settings` (`key, json, updated_at`; v2 renamed `brief.time` → `brief.autoTime`, `events.ctftime` → `ctftime.enabled`) | core stores |

Document tables all have `id TEXT PRIMARY KEY, json TEXT NOT NULL,
updated_at TEXT NOT NULL` plus the listed index columns. Migrations:
`server/db/schema.ts` exports `PERSONAL_MIGRATIONS`, `SOURCES_MIGRATIONS`,
`SETTINGS_MIGRATIONS`; `migrate()` runs each step in `BEGIN IMMEDIATE`,
records `PRAGMA user_version`, writes `<file>.before-v<N>` before changing
existing data, and refuses a database newer than the code.

### Helpers

```ts
class AppDatabase {
  readonly db: DatabaseSync;                 // raw node:sqlite for anything else
  readonly path: string; readonly name: string; readonly version: number;
  transaction<T>(fn: () => T): T;            // BEGIN IMMEDIATE … COMMIT; nested calls join; fn must be synchronous
  docs<T extends { id: string }>(options: DocTableOptions<T>, trash?: Trash): DocTable<T>;
  close(): void;
}
interface DocTableOptions<T> {
  table: string;                             // a v1 (or later) document table
  label: string;                             // zh noun for messages: 「待辦」
  schema: z.ZodType<T>;                      // persisted shape; new fields optional
  columns?: (doc: T) => Record<string, SQLInputValue>;   // derived index columns
}
class DocTable<T extends { id: string }> {
  get(id: string, options?: { strict?: boolean }): T | undefined;
  list(query?: { where?: string; params?: SQLInputValue[]; orderBy?: string; limit?: number; offset?: number; strict?: boolean }): T[];
  count(where?: string, params?: SQLInputValue[]): number;
  put(doc: T): T;                            // zod-validated upsert; updated_at from doc.updatedAt or now
  putMany(docs: T[]): void;                  // one transaction
  delete(id: string): { deleted: boolean; undoToken?: string };   // trash copy first when a Trash is attached
}
function openDatabases(dataDir: string /* or ":memory:" */): Databases;

class Trash {                                // data/trash/<token>.json, 0600, never overwritten, pruned after 30 days
  register(table: string, restorer: (record: TrashRecord) => unknown): void;   // DocTable does this
  put(table: string, id: string, json: string): string;                        // → undo token
  restore(token: string): { table: string; id: string; value: unknown };       // POST /api/trash/restore
}
```

Reads are defensive (bell-explain): a lenient read skips a row that fails its
schema and logs `store.unreadable`; a strict read throws 500. **Use strict
reads on any path that deletes, syncs or overwrites based on what it read.**
`where`/`orderBy` are code-written SQL; user input goes in `params` only.
`habit_logs` has no DocTable: use prepared statements on `ctx.db.personal.db`
with `INSERT … ON CONFLICT(habit_id, day) DO UPDATE`.

Core stores:

```ts
class SourceItemStore {                      // sources.sqlite source_items, PK (source, external_id)
  upsert<T>(source: SourceId, items: SourceItemInput<T>[]): number;
  replace<T>(source: SourceId, kind: SourceItemKind, items: SourceItemInput<T>[]): { upserted: number; removed: number };  // full fetch
  get<T>(source: SourceId, externalId: string): SourceItem<T> | undefined;
  list<T>(query?: { source?; kind?; window?: { field: "startsAt" | "dueAt"; from?: string; to?: string }; limit?; order? }): SourceItem<T>[];
  count(source: SourceId, kind?: SourceItemKind): number;
  remove(source: SourceId, externalIds: string[]): number;
  pruneFetchedBefore(source: SourceId, before: string): number;   // retention (mail: 30 days setting)
  clear(source: SourceId): number;                                // on disconnect
}
interface SourceItemInput<T> { kind: SourceItemKind; externalId: string; value: T; startsAt?: string | null; dueAt?: string | null; updatedAt?: string }

class SuggestionStore {                      // sources.sqlite ai_suggestions
  create<P>(input: { kind; title; payload: P; sourceRef?; dedupeKey?; modelExecution? }): AiSuggestion<P>;  // same dedupeKey → existing
  get<P>(id: string): AiSuggestion<P> | undefined;
  list<P>(filter?: { status?; kind?; limit? }): AiSuggestion<P>[];
  decide(id: string, status: "accepted" | "dismissed", resultId?: string): AiSuggestion;   // 404 / 409
}

class AppSettingsStore { get(): AppSettings; value<K>(key: K): AppSettings[K]; update(patch: unknown): AppSettings }
class SyncStateStore { get(source); all(); save(source, patch); reset(source); repairAfterRestart(): number }

class ItemStateStore {                       // personal.sqlite item_state + action_log (ctx.itemState)
  get(itemId: string): ItemStateRow | undefined;
  /** The source shows the item was dealt with elsewhere (a sent reply, LMS submitted): logs a closing action for today. Idempotent per item and day. */
  markHandled(input: { itemId; kind; title; action: ActionId; fingerprint?: string | null }): ActionLogRow;
  /** Forget an item's state (the source deleted it). */
  clear(itemId: string): void;
  // core only: record(), undo(), setRemote(), states(), handledLog(day), prune()
}
```

Kinds per source (`shared/sources.ts`): `gmail`→`mail` (`MailMessage`),
`google-calendar`→`calendar-event` (`CalendarEvent`, `startsAt`),
`ics`→`calendar-event` or `external-event`, `moodle`/`canvas`→`assignment`
(`Assignment`, `dueAt`; assignments from mail or added by hand are not source
items but rows of `local_assignments`, §10.10), `github`→`github-item` and `contribution-day`,
`ctftime`/`feeds`→`external-event` (`ExternalEvent`, `startsAt`),
`weather`→`weather`.

### Time

Instants are ISO UTC strings. Days are local `DayKey` strings. Never use
`Date#getDate()` or `toISOString().slice(0, 10)` for a day: use
`shared/time.ts` — `todayKey(tz, now)`, `dayKey(tz, instant)`,
`dayBounds(tz, day) → {start, end}` (UTC instants, DST-correct),
`zonedTimeToUtc(tz, day, h, m)`, `addDays`, `daysBetween`, `weekdayOf`,
`localTime`. On the server `ctx.today()` and `ctx.config.timeZone`.

## 5. Model calls: `runStructured`

```ts
ctx.ai.runStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;

interface StructuredRequest<T> {
  role: string;                     // zh-TW label for progress, errors and the gen.call log: 「每日摘要」
  schema: z.ZodType<T>;             // strict zod schema the answer must pass
  jsonSchema?: JsonSchema;          // sent as --json-schema; default jsonSchemaFor(schema)
  prompt: string;                   // task instructions, written by code
  data: unknown;                    // untrusted data, JSON-serialised and redacted
  signal: AbortSignal;              // the job's signal
  timeoutKind?: "quick" | "standard" | "long";   // 120/240/480 s base × claude 2.5 × effort × scale
  timeoutMs?: number;               // overrides timeoutKind: per attempt, counted from when the CLI starts (after the slot)
  priority?: "interactive" | "soon" | "background"; // slot order: interactive (someone watches) › soon (自動整理) › background (default)
  onProgress?: (progress: AiProgress) => void;    // { phase: "waiting"|"connecting"|"thinking"|"writing"; notice? }
  settings?: Partial<ProviderSettings>;            // per-call override
}
interface StructuredResult<T> { value: T; execution: ModelExecution; ms: number; usage?: Record<string, number> }

objectSchema(properties): JsonSchema;      // bell-pr helper: all required, additionalProperties false
jsonSchemaFor(schema: z.ZodType): JsonSchema;
untrustedBlock("email" | "event" | "note" | "item", text, max = 4000): string;  // wrap long untrusted text
```

What it does, in order: resolve provider/model/effort from settings and the
catalog (a catalog that could not load → 503 with its reason) → build the
prompt (zh-TW trust boundary, `Return a single JSON object…`, `任務角色：<role>`,
your prompt, the untrusted-data rule, then `<data>{redacted JSON}</data>`, with
every `<` and `>` in the JSON escaped as `\u003c`/`\u003e` so data cannot close
the block; over 100 000 chars → 413) → check `claude auth status` / `codex
login status` (trusted 10 min after a success; 503 `請在伺服器的終端機執行 claude
auth login。`) → acquire an agent slot per attempt → run Claude Code with the verified
argv (`-p --safe-mode --output-format stream-json --verbose
--no-session-persistence --strict-mcp-config --setting-sources user
--disable-slash-commands [--model] [--effort] --tools "" --permission-mode
dontAsk --json-schema …`, prompt on stdin, cwd `<data>/ai/run-*` removed
afterwards, env allow-list) or the Codex app-server fallback (with the
schema's strict-mode subset as `turn/start` `outputSchema`) → verify the init
event (only `StructuredOutput`, no MCP, skills or user plugins; any tool use
stops the run, 502; a CLI that exits without a result event is a fixed 502
「…Claude Code 沒有正常結束…」, its output only in the log) → retry a lost OAuth refresh race after 15 s and 45 s →
accept only ≤ 120 kB JSON that passes the strict zod schema
(`SchemaValidationError` 502 with field paths, never values) and contains no
secret shapes (422) → log `gen.call`.

Rules for callers:

- Use it inside a job so the user sees progress and can cancel:

  ```ts
  router.post("/refresh", (_req, res) => {
    const job = ctx.jobs.start({ kind: "daily-brief", title: "今日摘要", ref: ctx.today() }, async (emit, signal) => {
      const { value, execution } = await withGenerationProgress("整理今日摘要", "brief", emit, signal,
        (onProgress) => ctx.ai.runStructured({ role: "每日摘要", schema: briefSchema, prompt, data, signal, timeoutKind: "long", onProgress }));
      store.put({ ...value, day: ctx.today(), source: "ai", generatedAt: ctx.now().toISOString(), modelExecution: execution });
      return { day: ctx.today() };
    }, { maxRunning: 1, busyMessage: "今日摘要正在整理中。" });
    streamJob(res, ctx.jobs, job.id);
  });
  ```
- Model output is a **suggestion**: store it with `ctx.suggestions.create()`
  (with a `dedupeKey`) or as a clearly AI-sourced record the user confirms;
  never archive, send or create anything automatically. The one bounded
  exception is capture's 自動整理 (§10.6.1), which the owner asked for: it
  rewrites the record the user just created, reversibly, behind a setting.
- Drop source items where `secretInPatch(text)` is true before sending them;
  truncate mail bodies and wrap them with `untrustedBlock("email", …)`.
- Parse untrusted text in linear time and cut it before parsing (see
  `server/html.ts`, the Gmail and feed parsers): these run on the event loop.
- Model date-times without an offset are wall-clock time in
  `BELLPERSONAL_TZ` (`modelInstant()` in the mail triage), never `Date.parse`.
- Always keep a rule-based fallback where the page depends on the result
  (the daily brief has `source: "rule"`).
- Tests inject `command` (replay `server/fixtures/claude-structured-output.jsonl`
  with your answer swapped in) — see `server/ai/structured.test.ts`.

### 5.1 Which connection a job uses

`server/ai/connection-runtime.ts`. The app setting `ai.connection` (§10.4)
pins the job provider to that connection's CLI (`ProviderService.settings()`;
a patch naming the other CLI is refused, the Codex catalog is cached per
connection). `runStructured` and the Codex model-list load ask
`AiConnectionRuntime.plan(provider)` once per job and `spawn(plan)` right
before each process. `runStructured` checks the plan and the CLI login
(`codex login status` / `claude auth status`, read-only) before it reads the
model list, so a job that cannot run never starts `codex app-server`:

| Active connection | How the CLI runs |
| --- | --- |
| `null` | The CLI's own login and home (`~/.codex`, `~/.claude`), as before. |
| `chatgpt`, `claude` | The CLI's own login; a login of the wrong kind (an API key where a plan was chosen) is a 503 that says which connection to pick. |
| `openai-key`, `anthropic-key` with a key saved in BELL | The key is read from the vault at spawn time into that process's environment only (`BELL_OPENAI_API_KEY` with BELL's `bell_openai` model provider for Codex; `ANTHROPIC_API_KEY` for Claude), with a throwaway `CODEX_HOME` / `CLAUDE_CONFIG_DIR` under `<dataDir>/ai/<provider>-home-*` that is removed afterwards. Inherited `OPENAI_API_KEY`, `CODEX_API_KEY` and the shared home are dropped; the shared login is never read, written or logged out. A refused key is a 503 「…不接受目前保存的 API 金鑰…」. |
| `openai-key`, `anthropic-key` without a saved key | The CLI's own API-key login (`codex login --with-api-key`, Claude Code's own key) in its shared home, kept on purpose so a terminal key login keeps working; reported as `source: cli` on the method's row and on `activeStatus` / `GET /api/status` `ai.connection`. A plan login (ChatGPT, Claude subscription) is never used instead: without a CLI key login the job is 503 `key_missing` 「…還沒有保存金鑰…」, or `vault_disabled` 「…尚未設定主金鑰…」 on a server without a master key. |
| `openai-key`, `anthropic-key` with a key this server cannot read (another master key, or a secrets file that does not parse) | 503 `key_unreadable` 「…主金鑰解不開已保存的金鑰…」 before any CLI starts; never the CLI's own login instead. |

`ai.connection` syncs with the other settings but the vault does not, so a
key connection picked on one device may have no key (`key_missing`), a key
sealed with another master key (`key_unreadable`, e.g. a copied secrets
file) or no vault at all (`vault_disabled`) on another. That is reported as
`activeStatus` / `GET /api/status` `ai.connection` `{ready: false, reason,
message}` for the frontend to show, and jobs answer 503 with the same
reason in words (and, on a request that runs the model itself, as
`{code: "ai_connection_not_ready", method, reason}`; a background job keeps
the words only, `JobView.error`): a not-ready connection never falls back to
another one.

Every job folder under `<dataDir>/ai` (`<provider>-home-*`, `keycheck-*`,
Claude's `run-*` cwd) is removed when its job ends; `pruneAiTempDirs`
(`server/ai/temp-dirs.ts`) deletes those a crash left behind at boot and in
the daily maintenance once they are 3 h old (the longest job is 2 h). Only
direct children with those exact mkdtemp names, real directories, never
through a symlink, and only when `ai` resolves inside the data directory.
The Codex app-server's own cwd (`$TMPDIR/bell-personal-codex-*`) is not
under the data directory and is left to the OS.

The key never reaches argv, a response, an error, an export or a log. CLI
text that can surface (the `command()` 422, Claude's `cli_failed` log, agent
notices and errors, key-check failures) goes through
`redactCliOutput(text, [activeKey])`; the Codex app-server's stderr is
drained and its errors and failed turns become fixed zh-TW messages, so none
of its text surfaces. `redactCliOutput` masks the
key itself, any 8-character piece of it, prefix/suffix fragments and
shortened echoes (`sk-proj-abcd…wxyz`), as well as key shapes when no key is
known. A login check is cached for 10 minutes per `provider:method` and
forgotten when the connection, a key or a sign-in changes, or on
`GET /api/ai/connections?refresh=true`.

**How a browser sign-in ends** (`chatgpt`, `claude`;
`AiConnectionService.finish()` with `loginFailure()` and `loginSignal()` in
`server/ai/connections.ts`). 取消 in BELL (`DELETE …/login`) and shutdown are
not failures: the row goes back to `not_set` with no `failure`. 取消 after a
sign-in already failed (a rejected Claude code, for one) clears that failure
too, so reopening the sign-in never shows the old error. Any other
ending that is not a sign-in becomes a `failed` row with a zh-TW `message`
and a stable `failure` code. The code is read first from how BELL stopped the
CLI and from the runner's status, then from what the CLI printed. Every
printed line (both streams, before and after the link) is matched against
the strings codex-cli 0.167 and Claude Code 2.1 print, and only the last
matching signal word is kept on the login: `network`, `denied`, `code`,
`expired` or `timeout`. The line itself is never stored, returned or logged.
The patterns do not match the sign-in prompts, such as Codex's 「(expires in
15 minutes)」 or 「…gave you this code, cancel.」.

| `failure` | When | `message` |
| --- | --- | --- |
| `denied` | The CLI says the sign-in was denied, declined, cancelled or interrupted (`access_denied`, 「OAuth login cancelled」, 「OAuth authorization was denied or failed」, 「Login interrupted.」). | 「登入被取消或拒絕了…」 |
| `code_rejected` | Claude was given the pasted code and exits non-zero: it says nothing, says the code is invalid, from another sign-in, already used or expired, or the token exchange failed. | 「這組代碼沒有被接受…」 |
| `timed_out` | BELL's limit for the sign-in (ChatGPT 15 min, Claude 10 min; runner 504); the CLI's own limit (「device auth timed out after 15 minutes」, 「Authentication timeout」, `expired_token` before a code); Claude not answering a pasted code within 30 s. | 「登入逾時…」, or 「確認代碼逾時…」 for the 30 s |
| `cli_error` | The CLI did not start (503 「伺服器上沒有安裝…」), showed no link within 30 s (「沒有取得登入連結…」), could not reach the provider (`ENOTFOUND`, 「error sending request」, 「fetch failed」…, also after a code), or exited non-zero with no recognised reason before a code was sent (a crash, 「device auth failed with status …」). | 「<CLI> 的登入程式出錯…請確認伺服器連得上網路。」 |

The `ai.login` `failed` log event carries `{method, failure, reason, status}`,
where `reason` is BELL's own ending or the signal word, never CLI text.
Compatibility: `denied` and `code_rejected` keep their meaning. A non-zero
exit that says nothing used to be reported as `denied` and is now
`cli_error`. A pasted code that Claude does not answer within 30 s was
`code_rejected` and is now `timed_out`.

## 6. Background sources: `SourceSync`

```ts
abstract class SourceSync {
  constructor(options: {
    id: SourceId; label?: string; state: SyncStateStore;
    intervalMs?: number;      // default 5 min
    staleAfterMs?: number;    // POST /api/sync refetches only older data; default min(interval, 60 s)
    fetch?: FetchLike; now?: () => Date;   // test seams (pass ctx.fetch, ctx.now)
  });
  abstract configured(): boolean | Promise<boolean>;            // credentials/settings present?
  protected abstract run(context: SyncContext): Promise<SyncOutcome>;
  start(): void;            // called by ModuleHost after listen: unref'd interval + one kick
  schedule(): void;         // fire and forget; skipped while needs_reconnect
  request(force?: boolean): Promise<boolean>;   // POST /api/sync; unforced: dueForFetch()
  dueForFetch(): boolean;   // stale, and a failed attempt is at least staleAfterMs old (no refetch on every focus)
  sync(): Promise<SourceStatus>;                // single-flight; never rejects
  status(): Promise<SourceStatus>;              // never rejects
  reset(): void;            // forget cursor/status (after disconnect)
  close(): Promise<void>;   // stop timer, abort the active fetch, await it
}
interface SyncContext { signal: AbortSignal; cursor: string | null; now: Date;
  http(url: string | URL, init?: HttpRequestInit): Promise<HttpResponse> }   // safeFetch bound to signal
interface SyncOutcome { items?: number; cursor?: string | null }            // undefined keeps, null clears the cursor
```

- **Every outbound request goes through `context.http`**: HTTPS only, no
  credentials in URLs, `redirect: "error"`, 15 s deadline combined with the
  shutdown signal, 5 MB body cap (`ResponseTooLargeError` past it), `User-Agent: bell-personal/0.1
  (+self-hosted)`. It returns non-2xx responses (304/404/410 carry meaning);
  call `expectOk(response, label)` when any failure should stop the sync
  (401 → `ReconnectRequiredError`, 429 → retry later).
- CLIs (`gh`) go through `ctx.command` with `ghEnvironment()` and a timeout;
  redact their output.
- Throw `AppError(status, zhMessage)` for expected failures; anything else is
  stored as 「同步 <來源> 時發生問題，稍後會自動重試。」. Messages are redacted.
- Credential death — Google `invalid_grant`, a `VaultKeyError`, or
  `ReconnectRequiredError` — becomes `needs_reconnect` (需要重新連線) and
  background retries stop until the user reconnects; call `source.sync()`
  after storing the new credential. A `configured()` that throws (a vault
  record sealed with another key, a corrupt secrets file) is handled the
  same way as a failed run: it never rejects `sync()`, `status()` or
  `ModuleHost.sourceStatuses()`, and the process logs a stray rejection
  (`process.unhandled_rejection`) instead of exiting.
- Persisted per run: `state`, `lastAttemptAt`, `lastSyncedAt`, `lastError`,
  `items`, `cursor`; logged as `fetch.<id> {ms, items, outcome}`. A run
  interrupted by a restart is repaired to `error` at boot.
- Work that must survive a restart (e.g. a mail-triage queue) needs a
  DB-backed queue: add a table, flip `running` back to `queued` at boot, and
  process one item at a time. `JobRegistry` is in memory only.

## 7. Credentials: the vault

```ts
class Vault {                                   // ctx.vault
  readonly enabled: boolean;                    // false without BELLPERSONAL_MASTER_KEY: every call → 503
  get<T = unknown>(name: string): Promise<T | undefined>;
  has(name: string): Promise<boolean>;
  set(name: string, value: unknown): Promise<void>;     // JSON value; serialised writes; atomic + fsync
  delete(name: string): Promise<boolean>;
  list(): Promise<Array<{ name: string; updatedAt: string; kid: string }>>;   // never values
  rotate(): Promise<number>;                    // re-seal with the current key (constructor previousKeys)
}
class VaultKeyError extends AppError {}         // 503; a record that no longer opens → needs_reconnect
```

File `$BELLPERSONAL_SECRETS_DIR/secrets.enc.json` (0600 in a 0700 directory,
outside backups). Each record: AES-256-GCM, random 12-byte IV, auth tag, AAD
`bell-personal:vault:v1:<name>`, `kid` = first 12 hex of SHA-256(key). Names
match `^[a-z0-9][a-z0-9._:-]{0,99}$`; use `<source>.<what>`:
`google.oauth` (refresh token, granted scopes), `google.client` (client id and
secret entered in settings), `moodle.token`, `canvas.token`, `ics.<feedId>`
(secret iCal URLs), `ai.key.<provider>` (a checked API key) and `ai.keymeta.<provider>` (its hint and verifiedAt, §3). `google.client` is `{clientId, clientSecret, kind: "web"|"desktop", savedAt}`;
`google.oauth` is `{refreshToken, scopes, email?, clientId, connectedAt, accessToken?, expiryDate?}`
(only `server/google/auth.ts` reads it; modules call `googleClient(ctx)`). A source's `configured()` is usually
`ctx.vault.enabled && await ctx.vault.has("<name>")`. Moodle passwords are
exchanged once and never stored. Tokens never reach the browser: the UI shows
only 「已連線為 … · 上次同步 08:12」.

## 8. Jobs

```ts
ctx.jobs.start(meta: { kind: JobKind; title: string; ref?: string }, run: (emit, signal) => Promise<unknown>,
               options?: { maxRunning?: number; busyMessage?: string }): JobView;   // 429 when busy, 503 while stopping
streamJob(res, ctx.jobs, job.id, from?, { cancelOnDisconnect? }): void;   // NDJSON: {type:"job"} → {type:"stage"}… → {type:"done", result} | {type:"error"}
withGenerationProgress(label, stage, emit, signal, (onProgress) => task, intervalMs = 5000): Promise<T>;
taskDeadline(parent, timeoutMs, zhMessage): { signal; dispose() };
```

Jobs survive a dropped connection (the browser resumes with
`GET /api/jobs/:id/events?from=N`) unless the route passes
`cancelOnDisconnect` (the capture parse: only its own request reads it, so an
aborted request, even one still in flight, stops the job), keep 400 events and 15 minutes of replay,
then a 24-hour outcome. Shutdown waits `BELLPERSONAL_DRAIN_SECONDS` and fails
the rest with 「伺服器正在重新啟動…」. Add new kinds to `JOB_KINDS` in
`shared/jobs.ts`. Keep `result` small (ids, counts); the client refetches.

## 9. Conventions

- **Errors**: `AppError(status, message)` (status first), message in zh-TW,
  safe to show. Status codes: 201 created, 202 job/sync started, 400 invalid
  input (ZodError → `path: message；…`), 404, 409 duplicate/already
  decided/cancelled, 413 too large, 415 write without JSON, 422 refused model
  output, 429 busy/rate limited, 501 not supported, 502 upstream/model
  failure, 503 not configured/not logged in/stopping, 504 timeout. Unknown
  errors → 500 「操作未完成；請檢查本機服務記錄。」 with the redacted stack in the log only.
  The body is `{error}`; a refusal the frontend acts on also carries a
  `code` and its fields (`ApiErrorBody` in `shared/api.ts`, from
  `AppError(status, message, detail)`): `ai_connection_not_ready
  {method, reason}` (409 when the connection cannot be made active; 503 from
  an AI request whose key connection cannot run here: `key_missing`,
  `key_unreadable`, `vault_disabled`; also from `PUT /api/settings/provider`),
  409 `module_hidden {module, feature, roles}` (the feature that hides it and
  the roles that turn it on; the message says when it was switched off by hand),
  and 422 `ai_key_invalid` / `ai_key_no_credit` from the key check (so the
  frontend can use its approved copy instead of inspecting the server message).
- **Logging**: `logEvent(event, fields)` JSON lines. Never log request bodies,
  mail subjects/senders/bodies, event titles, tokens or model output. New
  events: `fetch.<source>`, `digest.generated`, `habit.logged`,
  `oauth.connected {provider, scopes}`, `oauth.disconnected`,
  `oauth.callback_failed {reason}`, `action {action, source, kind, remote}`,
  `action.committed`, `action.failed {errorClass}`, `action.undone`,
  `today.module_failed {module, reason, ms}`, `today.module_invalid`, `export`,
  `capture.created {type, ai, explicitType, tidy}`, `capture.tidied {kind, applied, reason, auto, ms}`,
  `capture.tidy_rejected {kind, check}`, `capture.tidy_undone {kind, via: "toast"|"record"}`,
  `gmail.body {outcome, reason?, ms, chars, remote, trackers, inline, attachments, shown, trusted}`,
  `gmail.processed {messages, found, added, pending, ms}`, `gmail.process_failed {cancelled, errorClass, status?, ms}`,
  `gmail.body_unstable {chars}`, `mail.image {source, outcome, ms, bytes?}` (never a URL, host or
  Content-ID; the request log writes an inline image's Content-ID as 「…」 and runs `redactCliOutput` over the path, so a key pasted into a URL logs as `[REDACTED]`, `loggablePath`).
- **Security**: never weaken the middleware order. Only
  `GET /oauth/google/callback` without an Origin may arrive cross-site (it
  verifies a single-use state bound to the Tailscale login, plus PKCE). Mount
  OAuth routes with `routes: [{ path: "/oauth/google", router }]`. The
  identity gate admits only `PUBLIC_PATHS` (`/api/health`, `/privacy`,
  `/privacy.css`, `/favicon.svg`) without a login.
- **Untrusted HTML** (mail) is shown only through `sanitizeMailHtml` + `mailDocument`
  (`server/features/gmail/sanitize.ts`) inside `<iframe sandbox="allow-same-origin
  allow-popups allow-popups-to-escape-sandbox" srcdoc>` — never with `allow-scripts`,
  never in the app's DOM. **Untrusted URLs** are fetched only with `publicFetch(ctx.publicNetwork, …)`
  (`server/public-fetch.ts`), never with `ctx.fetch` or `safeFetch`. Images served to the
  browser are raster only, recognised by magic bytes, with a decoded size the reader can
  afford (`acceptableRaster`, `sendImage`). Anything that scans untrusted text (mail CSS,
  attributes) is linear: no backtracking regex reads a number, and the sanitizer has a
  wall-clock budget. See §10.11 and `docs/design/SPEC-mail-html.md`.
- **Child processes**: only `command()`/`ctx.command` with an environment
  allow-list (`baseEnvironment`, `claudeEnvironment`, `codexEnvironment`,
  `ghEnvironment`); never a shell; never `process.env`.
- **Frontend data**: `api<T>(path, init)` + `send(method, body)` (always JSON,
  `ApiError(message, status)`), `usePoll(fetcher, ms | null)` → `{data, state:
  "loading"|"ready"|"stale"|"error", error, updatedAt, refresh}` with
  `POLL_INTERVALS` (mail 60 s, calendar 5 min, tasks 30 s, sync status 10 s;
  `null` = no timer, for data that follows another poll, like #/inbox
  following Today); `refresh()` during a request runs once more after it, and
  local optimistic edits stay until a fetch that started after their
  acknowledgement lands (`settledAt`),
  `followJob(id, onEvent, signal, from)`. localStorage keys are
  `bell-personal.*` and every access is wrapped in try/catch.
- **Design**: tokens only (`src/styles/tokens.css`, never hard-coded hex), no
  readable text below 12 px, lucide icons with `aria-hidden`, native
  `<dialog>`, zh `aria-label`s. See brief section B.

## 10. Cross-module contracts

Six feature teams build against this section in parallel. The types are the
source of truth (`shared/today.ts`, `shared/connect.ts`, `shared/settings.ts`,
`server/modules.ts`); this section explains how they fit together.

### 10.1 Ownership

| Module (`server/features/<name>`) | Team | Sources (`SourceSync` ids) | Action handlers | Routes |
| --- | --- | --- | --- | --- |
| `google` | core platform (done) | — | — | `/api/google`, `/oauth/google` |
| `gmail` | mail | `gmail` | `actions.gmail` (封存, 標為已讀, 刪除, 移回收件匣) | `/api/gmail` |
| `calendar` | calendar-events | `google-calendar`, `ics` | `suggestionActions.event`, `anySourceActions.schedule`, `acceptSuggestion.event` | `/api/calendar` |
| `events` | calendar-events | `ctftime`, `feeds` | `actions.ctftime`, `actions.feed` | `/api/events` |
| `lms` | work (assignments from mail: assignments team, §10.10) | `moodle`, `canvas` | `actions.moodle`, `actions.canvas` (optional), `actions.assignment`, `anySourceActions.assignment`, `suggestionActions.assignment`, `acceptSuggestion.assignment` | `/api/lms` |
| `github` | work | `github` | `actions.github` (optional) | `/api/github` |
| `projects` | work | — | — | `/api/projects` |
| `todos` | tasks | — | `actions.native`, `anySourceActions.todo`, `suggestionActions.todo`, `acceptSuggestion.todo` | `/api/todos` |
| `ideas` | tasks | — | — | `/api/ideas` |
| `capture` | tasks | — | — | `/api/capture` |
| `habits` | habits-brief | — | — | `/api/habits` |
| `weather` | habits-brief | `weather` | — | `/api/weather` |
| `brief` | habits-brief | — | — | `/api/brief` |
| Today, Settings, Setup, Guide UI (`src/`) | today-settings | — | — | — |
| Today aggregator, actions, item state, `ai:` rows, settings, export, privacy | core platform | — | core | `/api/today`, `/api/actions`, `/api/settings`, `/api/export`, `/privacy` |

Each module's header comment lists what its team owns. A team
changes only its own folder, its `shared/<domain>.ts` types (new fields
optional) and, when it needs a table, one appended migration step.

### 10.2 Today: `today()` contributions

```ts
// server/modules.ts
today?: (ctx: ModuleContext, input: TodayInput) => Promise<TodayContribution> | TodayContribution;

// shared/today.ts
interface TodayInput { day: DayKey; now: Date; timeZone: string; settings: AppSettings; signal: AbortSignal }

interface TodayContribution {          // every field optional
  queue?: QueueCandidate[];            // rows WITHOUT a group, plus hints; the core groups them
  agenda?: AgendaContribution[];       // today's rows; the core sorts them and sets `past`
  gapCandidates?: GapCandidate[];      // work that may fill the free slot: { itemId, label: "適合寫 HW3", dueAt, estimateMinutes? }
  digest?: { key; label; count; action: ActionId }[];   // merged by key
  inboxUnread?: number;
  habits?: TodayHabit[];
  ideas?: { id; text; at }[];
  later?: { events?: LaterEventContribution[]; projects?: LaterProject[] };
  weather?: TodayPayload["weather"];
  brief?: { state: "ready" | "generating" | "fallback" | "off"; text?; generatedAt?; reason? };
  nextUp?: { start; title }[];         // events today or tomorrow (agenda events count too)
  sidebar?: { projects?: SidebarProject[]; streakDays?: number };
  nav?: { tasks?: number; work?: number; events?: number };
}

interface QueueCandidate extends Omit<QueueItem, "group"> {
  hints: {
    dueAt?: string;          // ISO deadline (end of day for date-only)
    hardDeadline?: boolean;  // assignments, bills, high-priority todos
    receivedAt?: string;     // mail received, review requested
    important?: boolean;     // mail.reply: triage high, or IMPORTANT and not automated
    rank?: number;           // AI rank inside the group
    startsAt?: string;       // event.decide
    fingerprint?: string;    // changes when the source item meaningfully changes
  };
}
```

**Rules for a module's today():**

- Read local stores and `ctx.sourceItems` only. No network, no model calls:
  it runs on every page load with a **3 s deadline** (`input.signal` aborts).
  Render what is cached even when the source is stale or needs reconnecting;
  the UI reads `sources[]` to say so.
- A throw, a timeout or a value that fails `todayContributionSchema`
  (`server/today/schema.ts`) drops the whole contribution and turns the
  module's sources (or, without sources, an entry named after the module)
  to `state: "error"`. The rest of the page still renders.
- Row ids are `${source}:${sourceId}` with `source` from `QUEUE_SOURCES`
  (`gmail, moodle, canvas, github, native, ctftime, feed, ai, assignment`) and must be
  stable across syncs: item state and undo are keyed by them.
- Build rows with `shared/today-format.ts`: `queueAction("open", { label:
  "開啟 E3" })`, `deadlineWhen()`, `timeWhen()`, `receivedWhen()`,
  `metaDeadline()`, `monthDayWeek()`, `relativeStart()`, `durationText()`.
  `actions[0]` is the primary action (SPEC §4.3 table); set `snoozeLimit` to
  deadline − 2 h for rows with a hard deadline.
- Never set a group, a count or a cap. The core decides them
  (`shared/today-logic.ts`, SPEC §4.3):

| Group | When |
| --- | --- |
| `now` 最重要 | `dueAt` passed; `hardDeadline` within 24 h; `mail.reply` with `important`; `review` requested more than 24 h ago; `pr.changes` |
| `today` 今天內 | a deadline within 48 h or before the end of today; every `suggestion.*`; `mail.bill`, `mail.action`, other `mail.reply`; reviews under 24 h |
| `later` 可以等 | a deadline within 7 days; `event.decide` (the 2 nearest by `startsAt`) |
| left out | assignments and todos without a deadline or due beyond 7 days |

  Order inside a group: `dueAt` ascending, then `rank`, then `receivedAt`
  descending, then `startsAt` ascending (only `event.decide` rows carry it),
  then id. Display caps: 5 / 5 / 3; `items` is complete and `hidden` says
  how many rows sit behind 「還有 N 件 · 顯示全部」.
- Item state hides rows: snoozed until a future time; dismissed (略過) forever;
  標為已交 / 標為已審查 / handled until `hints.fingerprint` differs from the
  one stored at that moment. Give LMS and GitHub rows a fingerprint (due date +
  submission state, review request time) so they come back when they change.
- `counts` (open, handled, total, handledBy, inboxUnread, habitsLeft, nav) are
  computed once by the core. `habitsLeft` counts habits with `due !== false`
  and not `doneToday`. Module badges go in `nav` (tasks: open todos; work: due
  ≤ 7 d + review requests; events: whatever #/events calls new).
- The free slot is the longest gap of ≥ 90 min between now and 22:00 among
  agenda events, paired with the first open row (display order) that has a
  gap candidate due within 48 h.
- The brief: the core always computes the rule brief (SPEC §4.2 template) and
  uses it unless the brief module returns `state: "ready"` with `text`. With
  `ai.enabled` off the state is `off`. `next` carries `brief.autoTime`.
- Merging: lists concatenate in registry order (first id wins), `weather` and
  `brief` take the first contribution, numbers sum, `later.events` keeps the
  next 3 from tomorrow within 14 days that are not open in the queue,
  `later.projects` keeps 3 with one slot for a waiting PR, `ideas` the newest 2,
  `sidebar.projects` the first 5.
- The core contributes pending AI suggestions of kind `event`, `todo` and
  `assignment` as `ai:<suggestionId>` rows (title 「從信件找到 1 個活動，要加入行事曆嗎？」 /
  「從信件找到 1 份作業，要加入嗎？」, meta with the suggestion's `origin`;
  `suggestionRow()` in `server/today/suggestions.ts` builds them for any page).
  Feature modules create suggestions; they never render them.

**Example** (the lms module):

```ts
today: (ctx, { now, timeZone }) => {
  const rows = ctx.sourceItems.list<Assignment>({ source: "moodle", kind: "assignment" })
    .map((item) => item.value).filter((a) => a.dueAt && a.submission === "not-submitted");
  return {
    queue: rows.map((a) => ({
      id: `moodle:${a.externalId}`, kind: "assignment", source: "moodle",
      title: `${a.courseName} ${a.title}`,
      meta: ["NYCU E3", a.courseName, metaDeadline(a.dueAt!, now, timeZone), "尚未繳交"],
      when: deadlineWhen(a.dueAt!, now, timeZone),
      actions: [queueAction("open", { label: "開啟 E3" }), queueAction("submitted"), queueAction("snooze")],
      url: a.url,
      snoozeLimit: new Date(Date.parse(a.dueAt!) - 2 * 3_600_000).toISOString(),
      hints: { dueAt: a.dueAt!, hardDeadline: true, fingerprint: `${a.dueAt}|${a.submission}` },
    })),
    gapCandidates: rows.map((a) => ({ itemId: `moodle:${a.externalId}`, label: `適合寫 ${a.title.split("：")[0]}`, dueAt: a.dueAt! })),
    nav: { work: rows.filter((a) => Date.parse(a.dueAt!) - now.getTime() <= 7 * 86_400_000).length },
  };
},
```

### 10.3 Actions

```ts
// POST /api/actions { itemId, action: ActionId, params? } → 202 { actionId, undoUntil, label }
interface ActionRequest {
  actionId: string; itemId: string; source: QueueSource; sourceId: string;
  action: ActionId; params: Record<string, unknown>;   // validate with zod in the handler
  item?: QueueCandidate;      // the row as last served (with hints); undefined for non-row targets
  suggestion?: AiSuggestion;  // ai: rows
  day: DayKey; now: Date;
}
interface ActionPlan {
  label: string;                                         // 「已封存」; no message text
  apply?: () => void | ActionApplied | Promise<void | ActionApplied>;  // local write before the 202 ({resultId?, created?}); throw AppError to refuse
  remote?: (signal: AbortSignal) => Promise<void>;       // deferred ACTION_COMMIT_MS (6.5 s); flushed on shutdown
  undo?: () => void | Promise<void>;                     // reverts apply (undo, failed remote)
  revert?: (signal: AbortSignal) => Promise<void>;       // inverse remote call after the commit
  target?: { kind: QueueKind; title: string; fingerprint?: string };  // only when request.item is undefined (a row Today did not serve)
}
type ActionHandler = (request: ActionRequest, ctx: ModuleContext) => ActionPlan | Promise<ActionPlan>;
```

What each action does and who handles it (`ACTION_EFFECTS` in
`shared/today-logic.ts`):

| Action | Core item state | Counts as | Handler |
| --- | --- | --- | --- |
| `snooze` (`params.until`, ≤ `snoozeLimit`, ≤ 60 days) | snoozed until | snooze | core (source handler optional) |
| `dismiss` 略過 | dismissed forever; `ai:` → suggestion dismissed | done | core |
| `submitted` 標為已交, `reviewed` 標為已審查 | dismissed until the fingerprint changes | done | core (source handler optional) |
| `open` | none (logged only, not undoable) | — | core |
| `reply` 回覆 | replying (row stays, `replying: true`) | — until the mail module calls `markHandled(…, "reply")` | core (gmail handler optional) |
| `archive`, `read`, `done` | handled | done | **required**: `actions[source]` |
| `calendar` 加入行事曆, `going` 要參加 | handled; `ai:` → suggestion accepted with `resultId` | calendar | **required**: `actions[source]`, or `suggestionActions[kind]` for `ai:` rows |
| `todo` 轉待辦 / 加入待辦 | handled | done | **required**: `anySourceActions.todo` (tasks); `suggestionActions.todo` for `ai:` rows |
| `schedule` 排進 (`params.start/end`) | none | — | **required**: `anySourceActions.schedule` (calendar) |
| `trash` 刪除 (Gmail trash, never permanent) | handled | done | **required**: `actions[source]` (gmail) |
| `unarchive` 移回收件匣 | none | — | **required**: `actions[source]` (gmail) |
| `assignment` 轉成作業 / 加入作業 | handled; `ai:` → suggestion accepted with `resultId` | done | **required**: `anySourceActions.assignment` (lms; refuses non-mail items); `suggestionActions.assignment` for `ai:` rows (only on `assignment` suggestions) |

A required handler that no module registered answers 501. The order of a
request: validate the body and the row (the action must be one of the row's
`actions`, except `open`, `schedule`, and `assignment` on a non-`ai:` row) → resolve the handler → `plan = handler(…)` →
`await plan.apply()` → record `action_log` + `item_state` (a failure here
calls `plan.undo`) → schedule `plan.remote` → 202. `undoUntil` is the commit
time (request + 6.5 s); for `open` it is the request time.

A page other than Today may act on an item Today did not serve (#/work marks
an assignment due in 10 days 已交, or 標為已審查 on a snoozed review): the core
then has no row, so `request.item` is undefined and the state would be stored
without a fingerprint (hidden forever). The owning handler returns
`plan.target {kind, title, fingerprint}` describing the item; the core logs
that kind and title and keeps the fingerprint, so the item returns when its
source changes. `target` is ignored when the row was served.

Undo (`DELETE /api/actions/:actionId`): before the commit the timer is
cancelled (nothing reaches Gmail, Calendar or the forge) and `undo` runs;
after the commit `revert` + `undo` run if the plan has `revert`, otherwise
409; local actions stay undoable for 24 h (the footer's 復原 list,
`handled[].undoable`). Plans live in memory: after a restart only
core-generic actions can be undone. A `remote` that throws marks the action
`failed`, runs `undo`, restores the item state and reopens an `ai:`
suggestion, so the row reappears on the next poll; the UI learns it from
`GET /api/actions/:actionId` (`state: "failed"`, `error`) and shows the error
toast. Shutdown commits pending writes early; after a crash, boot marks any
write still `pending` as failed (「伺服器在送出前中斷…」) and restores its row.

**Example** (gmail archive and mark-read):

```ts
actions: {
  gmail: (request, ctx) => {
    if (request.action !== "archive" && request.action !== "read") throw new AppError(400, "這封信不能這樣處理。");
    const label = request.action === "archive" ? "INBOX" : "UNREAD";
    const modify = (add: string[], remove: string[]) => async (signal: AbortSignal) => {
      const api = gmail({ version: "v1", auth: await googleClient(ctx) });
      await api.users.messages.modify({ userId: "me", id: request.sourceId, requestBody: { addLabelIds: add, removeLabelIds: remove } }, { signal });
    };
    return { label: request.action === "archive" ? "已封存" : "已標為已讀", remote: modify([], [label]), revert: modify([label], []) };
  },
},
```

Modules that see an item closed at its source call
`ctx.itemState.markHandled({ itemId, kind, title, action, fingerprint })`
(e.g. the mail sync finding a sent reply closes 回覆中… and counts as 回覆).

**Gmail targets** (`server/features/gmail/actions.ts`). Besides
`gmail:<message id>` rows (one per conversation, its newest inbox message),
`actions.gmail` accepts bulk ids that are not queue rows, so they never count
as handled:

| Item id | Actions | What it changes |
| --- | --- | --- |
| `gmail:<message id>` | `archive`, `read`, `trash`, `unarchive` (+ the core's `reply`, `open`, `snooze`) | the whole conversation: `threads.modify` remove `INBOX` / `UNREAD`, `threads.trash`, or `threads.modify` add `INBOX`. 標為已讀 and 刪除 read the conversation with one `threads.get(format=minimal)` just before their write, so revert restores exactly what they changed: `UNREAD` on the messages that were unread, `messages.untrash` on the messages that were outside the trash (never `threads.untrash`, which would also restore a message the owner had deleted) and `INBOX` (`batchModify`) on the ones that had it; 封存 / 移回收件匣 revert adds or removes `INBOX`. A message outside the cache is resolved with one `messages.get(format=minimal)` and changes only in Gmail |
| `gmail:digest` | `read` | 全部標為已讀 on the Today digest: every unread digest conversation (`messages.batchModify`); the label is 「已將 N 封標為已讀」 |
| `gmail:digest:<key>` | the category's `action` (`read`, or `archive` for `promo`; `open` is logged only) | one digest category (`newsletter`, `school`, `github`, `notification`, `promo`, `other`) |
| `gmail:category:<InboxCategory>` | `read` | the #/inbox category header's 全部標為已讀 |

封存 and 標為已讀 change the local cache before the 202 (so the inbox, the
unread badge and the digest move at once) and answer 503 when Gmail is not
connected. 轉待辦 on a mail row goes to `anySourceActions.todo` like any row.

### 10.4 App settings

`GET/PUT /api/settings/app` (any subset, validated by
`server/stores/app-settings.ts`); on the server `ctx.settings.value(key)`.

| Key | Default | Meaning | Read by |
| --- | --- | --- | --- |
| `theme` | `"system"` | 跟隨系統 / 淺色 / 深色 (`system`, `light`, `dark`); cached in localStorage `bell-personal.theme` for the first paint | today-settings |
| `singleKeyShortcuts` | `true` | 單鍵快捷鍵 (SPEC §6.2 guard); ⌘K always works | today-settings |
| `weekStartsMonday` | `true` | 一週從星期一開始 | today-settings, calendar-events |
| `ai.enabled` | `true` | 使用 AI master switch: off = no model call anywhere, brief state `off` | every AI feature |
| `ai.mailTriage` | `true` | AI triage after each mail sync | mail |
| `ai.ideaTags` | `false` | AI tag suggestions for ideas | tasks |
| `ai.connection` | `null` | 設定 › 連接 AI: the connection every AI job uses, `chatgpt`, `claude`, `openai-key` or `anthropic-key`; set through `PUT /api/ai/connections/active` (which checks it is ready). `null` = whatever the selected CLI is signed in with (as before). Pins the job provider to that connection's CLI (§5.1) | every AI feature |
| `ai.captureTidy` | `true` | 自動整理快速記下的內容: AI rewrites a captured todo's or event's title and notes in the background, reversibly (§10.6.1) | tasks |
| `brief.autoTime` | `"06:30"` | automatic brief time (local HH:MM) | habits-brief |
| `brief.onFirstOpen` | `true` | also generate on the first open of the day | habits-brief |
| `mail.retentionDays` | `30` | cached mail retention (1–365) | mail |
| `mail.schoolDomains` | `["nycu.edu.tw"]` | rule-fallback 學校公告 domains | mail |
| `mail.bodyView` | `"original"` | the reader's 原始版面 / 純文字 (also switched and remembered in the reader; browser cache `bell-personal.mail.view`) | mail |
| `mail.trustedImageSenders` | `[]` | 信任的寄件者: addresses or domains (≤ 200, lower-cased) whose remote images load through the proxy without asking | mail |
| `weather.enabled` | `true` | weather on/off | habits-brief |
| `weather.location` | 台北 `{name, latitude, longitude, timezone}` | city from geocoding | habits-brief |
| `ctftime.enabled` | `true` | CTFtime source on/off | calendar-events |
| `ctftime.minWeight` | `25` | CTFs below this weight stay out of the queue | calendar-events |
| `events.addToGoogle` | `true` | 要參加 also adds to Google Calendar | calendar-events |
| `calendar.addToGoogle` | `true` | new events (capture, 排進) go to Google Calendar | calendar-events, tasks |
| `habits.githubAuto` | `false` | automatic habit 「GitHub 有貢獻」 | habits-brief |
| `sidebar.projectIds` | `[]` | up to 5 pinned sidebar projects (empty = first active) | work, today-settings |
| `profile.roles` | `[]` | 初次設定 › 你是…: any of `student`, `developer`, `ctf` (deduplicated, canonical order); `[]` = only the features everyone gets. Which features a role turns on: `ROLE_FEATURES` in `shared/profile.ts` (design 01 身分對應的功能): student → `assignments`, `timetable`, `projects`; developer → `projects`, `github`; ctf → `events`. Modules are gated by `MODULE_FEATURES` (`lms` → assignments, `projects`, `github`, `events`; 課表 has no module, the browser alone shows it) and sidebar sections by `SECTION_FEATURES` (`work`: assignments, projects or github; `events`). The one rule, server and browser: `visibleFeatures(roles, overrides)` / `isModuleVisible` / `isSectionVisible`. Visibility only: Today drops a hidden module's rows and source chips (so does the brief, built from the Today payload); with `lms` hidden there are no AI assignment proposals in Today and no 轉成作業 action or assignment suggestion in Gmail (inbox, reader, search, Today rows); with `projects` hidden ⌘K search (`/api/capture/search`) offers no projects. Data, connection and sync stay; pending suggestions are kept, only not shown; turning a feature on again shows its rows at once, without a sync. While hidden a module also refuses to act, with 409 `module_hidden {module, feature, roles}`: its queue actions (including 轉成作業 on mail, owned by `lms`), suggestion accepts, and writes on its routes except `writableWhenHidden` (lms: `/moodle`, `/canvas`; events: `/feeds`). Reads, undo, 略過 and dismissing a suggestion still work. `null` is refused by the schema; the shared functions still take `null` as "settings not loaded yet" (everything shows). | today-settings (Today, sidebar), every role-owned module |
| `features.overrides` | `{}` | 設定 › 身分與功能: a feature switched on or off by hand, `Partial<Record<FeatureId, boolean>>` with `FeatureId` = `assignments`, `timetable`, `projects`, `github`, `events` (strict: unknown keys → 400; the object is saved whole). An entry wins over the roles both ways and keeps winning when the roles change; removing it follows the roles again. | today-settings, every role-owned module |
| `onboarding.completedAt` | `null` | When 初次設定 was finished (ISO 8601 with offset), or `null`: the browser runs 初次設定 while it is `null`. The row is also the run-once marker of the legacy migration (below). | today-settings |

**Legacy migration** (`server/onboarding.ts`, run by `server/index.ts` at
startup before the server listens or any source syncs): if there is no
`onboarding.completedAt` row, it decides once. No user data (no setting,
provider row, vault record or row in todos, projects, habits, ideas,
manual events, event feeds, local assignments, item state or the action
log; rows a server writes on its own, like the weather sync or a rule brief,
do not count) → writes `null`, a new install. Otherwise it is a build from
before 初次設定: it ticks the roles the connections imply (an LMS token in
the vault, Moodle/Canvas items or typed-in assignments → student; a GitHub
login in the sync cursor or GitHub items → developer; `ctftime.enabled`
saved as `true`, or a CTF row the user acted on → ctf, since CTFtime is on by
default), keeps roles or overrides an older build already saved (a `null`
roles row counts as unanswered), and adds an "on" override for every
feature that was shown before (unanswered roles showed them all) and that the
inferred roles would hide, so the upgrade shows exactly what it showed
before (an install with only todos gets all five on; one whose roles own
every feature gets none). Then it sets
`completedAt` to the migration time, so the user skips 初次設定. Saved
roles keep what they showed, so a run over what an earlier one saved adds
nothing. A vault it
cannot read counts as no LMS token; it never stops the server. Logs
`onboarding.fresh` or `onboarding.migrated {roles, overrides, keptRoles}`.

Event feed subscriptions are **not** settings: they have their own table
(the events team adds the migration) and secret URLs live in the vault.

### 10.5 Google

- **Connect:** the guide saves the client with `PUT /api/google/client
  {clientId, clientSecret, kind?}` (`kind: "desktop"` for the fallback), then
  navigates the browser to `GET /oauth/google/start` (or `?mode=paste`). The
  callback redirects to `/#/settings/sources?google=connected[&missing=gmail.modify,…]`
  or `?google=error&reason=vault|client|state|denied|exchange|no-refresh-token|no-scopes`
  (`GOOGLE_ERROR_REASONS`). The paste fallback posts the address-bar URL to
  `POST /api/google/paste {url}`. After `connected`, the UI calls
  `POST /api/sync {sources: ["gmail","google-calendar"], force: true}`.
- **Redirect URIs:** `BELLPERSONAL_ALLOWED_ORIGINS[0] + /oauth/google/callback`
  (production: `https://box.tailone.ts.net:20003/oauth/google/callback`);
  without allowed origins and for desktop clients
  `http://127.0.0.1:<BELLPERSONAL_PORT>/oauth/google/callback`. `GET /api/google`
  returns both for the guide's 複製 field.
- **Scopes:** `openid email gmail.modify calendar.readonly calendar.events`
  (`GOOGLE_SCOPES`). Partial consent still connects when Gmail or a Calendar
  scope was granted; `GET /api/google` reports `missingScopes` and
  `capabilities {gmail, calendarRead, calendarWrite}`. `calendarRead` needs
  `calendar.readonly` (calendarList.list does not accept `calendar.events`);
  with `calendar.events` alone the calendar sync reads the primary calendar only.
  Inserted events carry an id derived from the local event (`googleEventIdFor`),
  so a retried insert answers 409 and reuses the first copy.
- **Security:** PKCE S256; the state is random, single-use, expires after
  10 min and must come back with the same Tailscale login; only the callback
  may arrive cross-site. The refresh token is in the vault only.
- **In a module:**

  ```ts
  import { googleCapabilities, googleClient, googleConnected } from "../../google/auth.js";
  class GmailSource extends SourceSync {
    async configured() { return (await googleConnected(this.ctx)) && (await googleCapabilities(this.ctx)).gmail; }
    protected async run({ signal }: SyncContext) {
      const api = gmail({ version: "v1", auth: await googleClient(this.ctx) });   // HTTP via ctx.fetch
      // …
    }
  }
  ```

  `googleClient()` persists refreshed tokens and throws
  `ReconnectRequiredError` for a dead grant (`invalid_grant`), a missing token or
  a changed client, which `SourceSync` turns into 需要重新連線. Tests inject
  `seams.fetch` and answer `https://oauth2.googleapis.com/token`
  (see `server/google/auth.test.ts`).
- **Disconnect:** `DELETE /api/google` revokes best-effort, deletes the token,
  clears `gmail` and `google-calendar` items and their sync state; the client
  stays.

### 10.6 Endpoint table

Bodies and responses for connect endpoints are in `shared/connect.ts`. Every
write is JSON (`send("DELETE")` sends `{}`); errors are `{error}` in zh-TW.

| Endpoint | Body → response | Owner |
| --- | --- | --- |
| `GET /api/today` | → `TodayPayload` | core (done) |
| `POST /api/actions`, `GET` and `DELETE /api/actions/:id` | `ActionRequestBody` → `ActionAccepted`; → `ActionStatus`; `{}` → `{undone, actionId}` | core (done) |
| `GET /api/export[?include=sources]` | → JSON file | core (done) |
| `GET` and `PUT /api/settings/app` | `Partial<AppSettings>` → `AppSettings` | core (done) |
| `GET /api/ai/connections`, `PUT /api/ai/connections/active`, `POST` and `DELETE /api/ai/connections/:method/login`, `POST /api/ai/connections/claude/login/code`, `PUT` and `DELETE /api/ai/connections/keys/:provider` | → `AiConnectionsResponse`; `{method}` → `AiConnectionsResponse`; `{}` → `AiConnection`; `{}` → 204; `{code}` → `AiConnection`; `{key}` → `AiConnection`; `{}` → 204 | core (prototype) |
| `GET /api/google`, `PUT /api/google/client`, `POST /api/google/paste`, `DELETE /api/google` | → `GoogleStatus`; `GoogleClientRequest` → `GoogleStatus`; `GooglePasteRequest` → `GoogleConnectResponse`; `{}` → `GoogleDisconnectResponse` | core (done) |
| `GET /oauth/google/start[?mode=paste]`, `GET /oauth/google/callback` | browser navigations (302) | core (done) |
| `GET /privacy` | static HTML | core (done) |
| `POST /api/lms/moodle/connect`, `DELETE /api/lms/moodle` | `MoodleConnectRequest` → 201 `LmsConnectResponse`; `{}` → `DisconnectResponse` | work |
| `POST /api/lms/canvas/connect`, `DELETE /api/lms/canvas` | `CanvasConnectRequest` → 201 `LmsConnectResponse`; `{}` → `DisconnectResponse` | work |
| `GET /api/lms`, `GET /api/lms/assignments` | → `LmsStatusResponse` (both connections, never a token); → `AssignmentsResponse` (`shared/assignments.ts`, each row with `itemId` and `status`) | work |
| `GET /api/github` | → `GitHubOverview` (`shared/github.ts`): reviews (with `localReviewed`), my PRs, assigned issues, unread threads, contributions | work |
| `GET /api/projects[?archived=include]`, `POST /api/projects`, `GET`/`PATCH`/`DELETE /api/projects/:id`, `POST /api/projects/:id/milestones`, `PATCH`/`DELETE /api/projects/:id/milestones/:mid` | `ProjectListResponse`; `ProjectCreateRequest` → 201 `Project`; `ProjectDetail` / `ProjectUpdateRequest` → `Project` / → `ProjectDeleteResponse` (trash token); `MilestoneCreateRequest` → 201 `Project`; `MilestoneUpdateRequest` → `Project` (`shared/projects.ts`) | work |
| `GET /api/events/feeds`, `POST /api/events/feeds`, `DELETE /api/events/feeds/:id` | → `FeedListResponse`; `FeedCreateRequest` → 201 `FeedSummary` (fetched once first: 400 not a feed / bad URL, 409 duplicate or 50 feeds, 502 unreachable, 503 secret URL without a master key); `{}` → `FeedDeleteResponse` | calendar-events |
| `GET /api/events` | → `EventsResponse` (`shared/events.ts`): CTFs and feed events (dismissed left out, `going` from the calendar), pending event suggestions, source states | calendar-events |
| `GET /api/calendar?view=day\|week&day=YYYY-MM-DD` | → `CalendarResponse` (`shared/calendar.ts`): days with items (events, local events, assignment deadlines), free slots, source states | calendar-events |
| `POST /api/calendar/events`, `DELETE /api/calendar/events/:id` | `CalendarEventCreateRequest` → 201 `CalendarEventCreateResponse` (Google copy inserted after 6.5 s unless deleted first); `{}` → `CalendarEventDeleteResponse` (trash `undoToken`) | calendar-events |
| `POST` / `DELETE /api/calendar/events/:id/google` | `{}` → 202 `CalendarGoogleInsertResponse` (deferred insert of a local event); `{}` → `{removed}` | calendar-events |
| CTFtime on/off and minimum weight | `PUT /api/settings/app {"ctftime.enabled", "ctftime.minWeight"}` | calendar-events (reads), core (route) |
| `GET /api/weather/geocode?q=` | → `GeocodeResponse` (Open-Meteo, `language=zh`); save with `PUT /api/settings/app {"weather.location"}`, then `POST /api/sync {sources:["weather"], force:true}` | habits-brief |
| `GET /api/habits`, `POST /api/habits`, `PATCH /api/habits/:id`, `PUT /api/habits/order`, `DELETE /api/habits/:id` | → `HabitsResponse`; `HabitCreateRequest` → 201 `HabitSummary`; `HabitUpdateRequest` → `HabitSummary`; `HabitOrderRequest` → `HabitsResponse`; `{}` → `HabitDeleteResponse` (undo with `POST /api/trash/restore`) | habits-brief |
| `POST` and `DELETE /api/habits/:id/check` | `HabitCheckRequest {day?, at?}` → `HabitSummary`; `{day?}` → `HabitUncheckResponse` (`previousAt` for the undo); 409 for the automatic GitHub habit | habits-brief |
| `POST /api/gmail/purge` | `{}` → `GmailPurgeResponse` | mail |
| `GET /api/gmail/threads`, `GET /api/gmail/threads/:threadId` | → `InboxListResponse`; → `InboxThreadResponse` (`shared/mail.ts`, #/inbox; the reader reads a conversation outside the cache live, §10.10) | mail |
| `POST /api/gmail/threads/:threadId/process` | `{}` → 202 `MailProcessStart {jobId, threadId}` (job `mail-process`, follow `GET /api/jobs/:jobId/events`, `done.result: MailProcessResult {found, added, pending}`); 503 AI off, 404 not cached, 422 secret shapes, 429 two running; one job per conversation (§10.12) | mail |
| `GET /api/gmail/search?view=inbox\|archive\|all&q=&pageToken=` | → `MailSearchResponse` (封存, 全部 and search; live, never cached on disk; §10.10) | mail |
| `GET /api/gmail/messages/:messageId/body[?images=1]` | → `MailBodyResponse` (`shared/mail.ts`): the message's sanitized HTML as a page for `<iframe sandbox srcdoc>`, or `kind: "text"` with a reason; read live, memory only (§10.11) | mail |
| `GET /api/gmail/messages/:messageId/inline/:contentId`, `GET /api/gmail/messages/:messageId/attachments/:partId` | → a raster image from Gmail (magic bytes checked; 404, 415, 503) | mail |
| `GET /api/mail-images/proxy?m=&u=&s=` | → a remote image fetched by the server (HMAC-signed per message; public addresses only; 403, 413, 415, 429, 502, 504) | mail |
| `GET /api/lms/assignments` (merged), `POST /api/lms/assignments`, `PATCH`/`DELETE /api/lms/assignments/:id` | → `AssignmentsResponse` (LMS + native rows, `suggestions`); `AssignmentCreateRequest` → 201 `AssignmentView`; `AssignmentUpdateRequest` → `AssignmentView`; `{}` → `AssignmentDeleteResponse` (`shared/assignments.ts`; native rows only, §10.10) | assignments |
| `POST /api/brief/refresh` | `{}` → NDJSON job (`done.result: BriefRefreshResult`); 429 busy, 503 AI off or not logged in; `GET /api/status` `modules.brief` = `{day, state, generatedAt?, reason?, autoTime}` | habits-brief |
| `GET /api/todos[?q=]`, `POST /api/todos`, `GET`/`PATCH`/`DELETE /api/todos/:id`, `POST /api/todos/:id/complete`, `…/uncomplete` | → `TodoListResponse` (open + finished today); `TodoCreateRequest` → 201 `Todo`; `TodoUpdateRequest` → `Todo`; `{}` → `TodoDeleteResponse` (復原 = `POST /api/trash/restore`); `{}` → `Todo` (uncomplete also clears the row's queue state) | tasks |
| `GET /api/ideas[?q=&tag=&archived=1]`, `POST /api/ideas`, `GET`/`PATCH`/`DELETE /api/ideas/:id`, `POST /api/ideas/tags/suggest` | → `IdeaListResponse`; `IdeaCreateRequest` → 201 `Idea`; `IdeaUpdateRequest` → `Idea`; `{}` → `IdeaDeleteResponse`; `{ids?}` → NDJSON job `idea-tags` (503 unless `ai.enabled` and `ai.ideaTags`) | tasks |
| `POST /api/capture`, `POST /api/capture/parse`, `GET /api/capture/search?q=` | `CaptureRequest` (+ `suggestionId` to confirm an AI parse) → 201 `CaptureResponse` (+ `tidy: CaptureTidyStart` when 自動整理 started); `{text}` → NDJSON job `quick-capture` (45 s once the CLI runs, `done.result: CaptureParseResult`, 503 with AI off); → `CaptureSearchResponse` | tasks |
| `POST /api/capture/tidy`, `POST /api/capture/tidy/undo`, `POST /api/capture/tidy/revert` | `CaptureTidyRequest {kind: "todo"\|"event", id}` → 202 `CaptureTidyStart {jobId, kind, id}` (job `capture-tidy`, follow `GET /api/jobs/:jobId/events`, `done.result: CaptureTidyResult`; 503 AI off, 404, 409 event in Google or on its way, 429 four running; one job per record); undo `{token}` → `CaptureTidyUndoResponse` (404 used/expired, 409 title/notes/place changed since, or in Google); revert `CaptureTidyRequest` → `CaptureTidyUndoResponse` (409 no `pretidy` or in Google) | tasks |
| `POST /api/sync` | `{sources?, force?}` → 202 | core (done) |

### 10.6.1 Tasks, ideas and quick capture (tasks team)

- **Rule parser:** `shared/capture-parse.ts` (`parseCapture`, `retypeCapture`,
  `setCaptureMoment`) runs in the browser on every keystroke and again on the
  server when `POST /api/capture` arrives without a `type`. Golden table:
  `shared/capture-parse.test.ts` (with a second table for deadline
  scaffolding: 要在/最晚/為止/before/by … go with their date, and a removed
  token leaves no hole in the title). Days are read in `BELLPERSONAL_TZ`.
- **Events from capture** go through the calendar module's
  `acceptSuggestion.event` (the documented one-tap path): the capture module
  creates an `event` suggestion (`origin: "快速記下"`, payload
  `EventSuggestion`), calls the acceptor in-process with the body
  `{ via: "capture" }` and records it accepted with the acceptor's `resultId`.
  With `via: "capture"` the calendar acceptor defers the Google insert by
  the 6.5 s undo window (like `POST /api/calendar/events`) and returns that
  route as `undoPath`; records with origin 快速記下 (`CAPTURE_ORIGIN`) are
  never shown as pending rows, even if the process dies before the decision. Without an acceptor the capture is
  a 501 (「行事曆還不能新增行程，先記成待辦吧。」) and nothing is stored. 復原 calls
  the acceptor's `result.undoPath` when it returns one (a string under
  `/api/`), else `DELETE /api/calendar/events/:resultId`; the calendar team
  provides one of the two.
- **AI parse:** `POST /api/capture/parse` stores a pending `quick-capture`
  suggestion and returns it as `CaptureParseResult`; the browser confirms it
  with `POST /api/capture {…option, suggestionId}` (decided `accepted`) and
  dismisses it when the user picks the rule reading. Unpicked ones are
  dismissed after an hour. It runs at interactive priority (ahead of queued
  triage), a newer parse cancels an older one, and its 45 s deadline, counted
  from when the CLI starts, reports 「產生逾時」.
- **Todos on Today:** queue rows `native:<id>` (kind `todo`) for open todos
  due within 7 days or overdue, `hints.dueAt` = due time or 23:59,
  `hardDeadline` when priority is high (then `snoozeLimit` = due − 2 h and a
  `due` agenda row when it has a time today), `gapCandidates` within 48 h,
  `nav.tasks` = open todos. #/tasks completes through
  `POST /api/actions {itemId: "native:<id>", action: "done"}` so Today's counts
  and 復原 stay in one place. Phrasing: `shared/todo-format.ts`.
- **Ideas on Today:** the newest two (`today().ideas`). AI tags: one
  `idea-tags` suggestion per proposed tag (dedupe key per idea and tag, so a
  dismissed tag never returns); `acceptSuggestion["idea-tags"]` adds it.
- **Status:** `GET /api/status` → `modules.capture` is `CaptureStatus`
  (`aiParse`, `eventTarget: "google" | "local"`) for the capture UI.
- **自動整理** (`server/features/capture/tidy.ts`, SPEC-ux §6.6.1). The
  owner asked for captures to be tidied automatically, so this is the one
  exception to "AI proposes, the user decides", bounded as follows: it only
  rewrites the todo or local event the user just captured (or asked to
  整理), never creates, sends or archives, keeps the typed sentence in
  `originalText` and what it replaced in `pretidy` (`{title, notes?,
  location?}`; + `tidiedAt`; all optional JSON fields, no migration), never
  moves a date, shows 「已整理成「…」· {when}」 [復原] (the capture toast's
  when-part, `whenPhrase`), and `ai.captureTidy` turns it off. Only text
  the owner typed is ever sent: todos with origin `manual`/`quick-capture`
  and local events with origin `capture` (`TIDY_TODO_ORIGINS`,
  `TIDY_EVENT_ORIGINS`; `CalendarItem.typed` marks those rows); anything
  derived from mail, LMS, GitHub, feeds or suggestions is refused with 409.
  `createCapture` starts it (job `capture-tidy`, slot priority `"soon"`:
  behind an AI 解析 the user is watching, ahead of queued mail triage; 60 s
  once the CLI runs) for todos and events whose rule title is longer than
  16 characters or has joining punctuation, unless the capture confirmed an
  AI parse or the last status probe (`StatusService.peek()`, never awaited
  on the save) found the selected CLI signed out; a busy registry or AI off
  just leaves the rule result. **Checks** (`judgeTidy`, every failure
  refuses the whole answer): `low` confidence; a `dueDay`/`dueTime` that is
  not the rule parse of the original text (read on its creation day) or the
  saved value; a title longer than 60 characters, with no key term of the
  text (a Latin word or Han bigram that is not filler, a label or a date
  word: 「生出來」, 「主題是」, 「要在」 fail), or with a word or Han
  character the text does not have (「Windows 更新」; 的/與/和 may join;
  周/週 and full-width forms compare equal); a note line whose date words
  the text does not name (「截止：10/25」) or whose value after its label
  invents words. A place is added only to an event without one and only
  when it is in the text; the model layer refuses secret shapes (422). On
  events the moved lines go before 「來自 快速記下」, so the agenda meta
  (first note line) shows them. The record must still have the fingerprint
  (user-edited fields) it had when the job started: PATCH, DELETE and
  complete on `/api/todos/:id` cancel its tidy (`cancelTidy`), any other
  change (完成 through the queue) is caught at apply. **Text it reads:**
  `originalText`, or the title and notes once the user rewrote the title
  (`TodoStore.update` drops `originalText` then). **Undo:** 復原 =
  `POST /api/capture/tidy/undo {token}` (tokens in memory for an hour) and
  復原整理 = `POST /api/capture/tidy/revert {kind, id}` (any time) both put
  `pretidy`'s title, notes and place back and keep everything else (重要,
  完成, dates); the token needs the fields to still read as the tidy wrote
  them, and a user edit of the title or notes drops `pretidy` (409 「這一項沒有
  可以復原的整理。」). Logs: `capture.tidied {kind, applied, reason, auto,
  ms}`, `capture.tidy_rejected {kind, check}` (`nouns`, `invented`,
  `dates`, `notes`, `length`, `empty`), `capture.tidy_undone {kind, via}` —
  never text. **Events and Google (decided):** there is no Google update
  path, so the tidy never patches Google. While a captured event's tidy
  runs, its pending deferred insert is postponed (`CalendarService.reschedule(id,
  120 s)`) and afterwards gets a fresh 6.5 s window, so Google receives the
  tidied event once; an event already in Google (`googleEventId`) or whose
  insert is in flight (`isInserting(id)`) is not tidied, and neither 復原
  nor 復原整理 rewrites it (409, no 整理 button), like 刪除 on #/calendar,
  so BELL and Google never disagree.

### 10.6.2 Calendar and events (calendar-events team)

- **Local events have one owner.** `calendarService(ctx)`
  (`server/features/calendar/store.ts`) owns the `manual_events` DocTable and
  its trash restorer; a second DocTable with `ctx.trash` on that table would
  throw at boot. Other modules create events through it:
  `calendarService(ctx).create({ title, start, end?, allDay?, location?, notes?, url?, origin: "capture" })`
  and, for the Google copy, `deferPush(id)` (inserted after 6.5 s; flushed on
  shutdown; `DELETE /api/calendar/events/:id` cancels it). `reschedule(id,
  delayMs?)` moves a waiting insert (capture's 自動整理 postpones it, then
  gives it a fresh window); `isPending(id)` tells whether one waits and
  `isInserting(id)` whether its insert is on its way (no googleEventId yet;
  agenda rows count both as `inGoogle`). The
  `event` acceptor with `{ via: "capture", originalText }` stores the typed
  sentence on the event. Quick capture may
  also simply call `POST /api/calendar/events` and return its `undoPath`.
  `ManualEvent.origin` (`capture | going | suggestion | schedule`) and
  `itemId` (the queue row it came from) are optional fields.
- **Google settings:** 加入行事曆 on mail suggestions, quick capture and 排進
  follow `calendar.addToGoogle`; 要參加 follows `events.addToGoogle`; both
  need `capabilities.calendarWrite`. A local event inserted into Google shows
  once (the Google copy with the local flags).
- **Queue ids:** `ctftime:<CTFtime id>` and `feed:<feed id>:<key>` (the
  ExternalEvent id without its `feed:`/`ics:` origin). `event.decide` rows are
  CTFs at or above `ctftime.minWeight` and feed events starting within 7 days
  (`EVENT_DECIDE_DAYS`); 要參加 is `actions.ctftime`/`actions.feed`, 略過 is the
  core's dismiss. Their title is the question 「{name}，要參加嗎？」 and
  `subject` the event name, which the toasts and the handled list quote (the
  handler's `target` names it for rows Today did not serve). `nav.events`
  counts pending event suggestions from mail.
- **Feeds:** RSS/Atom/iCal subscriptions in `event_feeds`. iCal feeds with
  `target: "calendar"` (detected for Google/Outlook/iCloud private addresses,
  or set in `FeedCreateRequest.target`) sync as the `ics` source onto the
  agenda; everything else is the `feeds` source on #/events. URLs with a
  query, a private path or a token-like segment are stored only in the vault
  (`ics.<feed id>`); the row and every response keep the host. One broken feed
  keeps its cached items and its own `lastError`.
- **CTFtime and feeds are cached at least an hour:** the interval is 3 h and
  background runs (including the boot kick) skip a fresh cache.
- **排進** (`schedule`) targets the free slot paired with a row, so
  `POST /api/actions` accepts it on a row whose `actions` do not list it
  (like 開啟). Params `{ start, end, title? }`.

### 10.7 Fixtures, demo data and the fixture override

- `server/fixtures/today-2026-10-12.json` is the mockup (SPEC §13, rows in the
  mockup's order) and the 1440×900 fold-check fixture.
  `today-degraded.json` is the same morning with Google Calendar needing
  reconnection (stale agenda) and the AI brief failed (`Claude 尚未登入`).
  `today-empty.json` is state 01 (Saturday, nothing due, AI off).
  `today-cleared.json` is state 02 (21:40, all 11 handled, two habits left).
  All four pass `todayPayloadSchema` in tests.
- `BELLPERSONAL_TODAY_FIXTURE=server/fixtures/today-2026-10-12.json npm run dev`
  makes `GET /api/today` serve that file (re-read on every request) and makes
  `POST`/`GET`/`DELETE /api/actions` work in memory without touching data
  (`server/today/fixture.ts`): accepted actions are replayed on the file
  with `applyActionToPayload` (`shared/today-logic.ts`, the rule the browser
  applies optimistically), so an acted-on row stays gone after the refresh,
  its count moves to handled and it heads `handled[]`; `DELETE` within
  `undoUntil` brings it back; `GET` answers `applied`/`logged`/`undone`
  (never `failed`). Restarting forgets them, and the file's own `handled[]`
  rows cannot be undone (404). `/api/status`, the sync chip and every other
  endpoint stay real. Refused at boot with `NODE_ENV=production`.
- `npm run seed:demo -- --data-dir ./data [--now 2026-10-12T08:42:00+08:00]`
  writes the mockup day relative to `--now` (default today 08:42 in
  `BELLPERSONAL_TZ`) into `source_items` (Gmail with triage, Calendar, Moodle,
  GitHub items and contributions, CTFtime and feeds, weather) and the two demo feed subscriptions (`event_feeds`), the native
  tables (todos, habits and logs with 12/4/27 streaks, ideas, projects with
  milestones, today's brief), the SITCON suggestion, three items handled this
  morning and `ok` sync state. Re-running moves the same rows to the new day.
  Feature today() implementations should reproduce the mockup from this data.

### 10.8 Spec notes (decided here; raise if wrong)

- **Order inside a group** follows the SPEC rule (deadline, then AI rank,
  then received), which differs from the mockup's hand-placed order (the
  mockup puts the professor's mail above HW3). The mockup fixture keeps the
  mockup order for visual comparison; the server produces the rule order.
- **明天與之後** uses the SPEC 14-day horizon; the mockup's 10/30 row (18 days
  ahead) only appears in the fixture.
- 10/25/2026 is a Sunday: the SITCON meta reads 「10/25（日）」, not （六）.
- `weather.location` keeps `{name, latitude, longitude, timezone?}` (the
  existing `WeatherLocation` and the Open-Meteo parameter names).
- `nav.events` (the 活動 badge) belongs to the events module; the core does
  not count pending suggestions there.
- **Capture AI parse deadline:** SPEC §6.6 says 8 s, but one Claude Code turn
  takes 3.5–7 s on this host before any queueing, so an 8 s kill threw away
  answers whose tokens were spent. The palette already shows the rule result
  first and the AI result as a separate option, so the server gives the CLI
  45 s from its start; typing on or closing the palette cancels it.
- A non-important `mail.reply` lands in 今天內 (the SPEC lists only the
  important ones). The free slot needs 90 minutes and ends at 22:00 (SPEC
  §4.8), not the 1 hour of the original task note.

### 10.9 Work team notes (lms, github, projects)

- **Moodle** (`server/features/lms/moodle.ts`): `POST {base}/login/token.php`
  (`service=moodle_mobile_app`, form body) exchanges the password once; the
  vault keeps `moodle.token` = `{token, baseUrl, userId, username, fullName,
  siteName, connectedAt}` (no password, no private token). Web-service calls
  are `POST {base}/webservice/rest/server.php` with the token in the body:
  `core_webservice_get_site_info` (connect only),
  `core_course_get_enrolled_courses_by_timeline_classification`
  (`inprogress`), `core_calendar_get_action_events_by_timesort` (−14 d…+90 d),
  `mod_assign_get_assignments`, then `mod_assign_get_submission_status` per
  assignment in the window (at most 40, 4 at a time). `invalidtoken` →
  需要重新連線. Every 30 min; `POST /api/sync` refetches after 10 min.
- **Canvas** (`canvas.ts`): Bearer token; `GET /api/v1/users/self` on connect,
  then `/api/v1/planner/items` and `/api/v1/users/self/missing_submissions`
  (Link `rel=next`, same origin only, ≤ 5 pages). Vault `canvas.token` =
  `{token, baseUrl, userId, name, connectedAt}`.
- **Assignments** keep `site {label: 「NYCU E3」, short: 「E3」}` for meta lines
  and 「開啟 E3」. The Today row id is `moodle:<cmid>` / `canvas:<type>-<id>`;
  fingerprint `dueAt|submission`. A sync that sees an assignment submitted
  or graded clears the local 標為已交 mark (`ctx.itemState.clear`), so a
  reopened submission comes back instead of matching the old fingerprint.
  #/work marks rows Today did not serve through `ActionPlan.target` (§10.3).
- **GitHub** (`server/features/github/sync.ts`): `configured()` is
  `gh auth status --hostname github.com`, cached 10 min; only a definite
  answer (exit 1, gh missing) is 尚未設定, a probe that times out counts as
  configured for a minute, and a known answer is served while it refreshes.
  One `gh api graphql` call (`GITHUB_QUERY`, validated on this host at cost 1;
  gh exits 1 when the answer has `errors`, so usable `data` is kept) every 5 min, plus
  `gh api --include notifications?per_page=50` with `If-Modified-Since`
  (gh exits 1 on a 304; the status line on stdout decides) and GitHub's
  `X-Poll-Interval` honoured; the cursor JSON keeps `login`,
  `lastModified`, `pollIntervalSec`, `fetchedAt`. CLI output is parsed,
  never shown: failures become zh-TW messages, auth failures 需要重新連線.
  Items: `review-request:<node>`, `pr:<node>`, `issue:<node>`,
  `notification:<thread id>`; Today ids are `github:<node>`. Contribution
  days are stored as `contribution-day` rows for the habits team.
- **標為已讀 on threads** is `POST /api/actions {itemId: "github:digest-…",
  action: "read", params: {threads: ["<id>", …]}}` (1–50 numeric ids): the
  cache flips at once, `gh api --method PATCH notifications/threads/<id>`
  runs after the 6.5 s window, and 復原 before then sends nothing (GitHub
  has no "mark unread", so there is no `revert`).
- **Projects** live in `personal.sqlite projects` (v1). `repos` (new,
  optional) holds the linked repositories; `repo` mirrors the first for
  older readers. Linked todos are read from the tasks module's `todos`
  table by `project_id` (read-only). Sidebar order: `sidebar.projectIds`
  when set, else active projects by next milestone; the later card uses the
  same order (so it can differ from the mockup's hand-placed order).

### 10.10 Mail actions, archive, search and assignments from mail (2026-10-15)

The UX contract is `docs/design/SPEC-mail-assignments.md` (an addendum to
SPEC-ux). Two teams build it in parallel on the contracts below; each change
stays inside its owner's files.

**Ownership.**

| Team | Files |
| --- | --- |
| MAIL | `server/features/gmail/**` except `triage-assignments.ts` and its test; `src/pages/inbox/**`; `src/copy/inbox.ts`; mail-row changes in `src/pages/today/**` (hover set, swipe tray, `#` / Delete / `A` keys) and their strings in `src/copy/today.ts`; `src/components/command-palette/mailSearchSection.tsx`; `server/privacy.ts` wording (SPEC-mail-assignments §8); `scripts/seed-demo-mail.ts`; `server/integration-mail.test.ts`; the STATUS subsection 「Mail actions, archive and search」 |
| ASSIGNMENTS | `server/features/lms/**` (+ the `local_assignments` DocTable with `ctx.trash`); `server/features/gmail/triage-assignments.ts` (+ test); `shared/assignment-detect.ts` (+ test); `shared/assignments.ts` additions; `src/pages/work/**`; `src/copy/work.ts`; the `deadlineItems` change in `server/features/calendar/agenda.ts` (native rows through an lms export); `scripts/seed-demo-assignments.ts`; `server/integration-assignments.test.ts`; the STATUS subsection 「Assignments from mail」 |
| Lead (done) | `shared/today.ts`, `shared/today-format.ts`, `shared/today-logic.ts`, `shared/suggestions.ts`, `shared/mail.ts` types, `server/modules.ts`, `server/today/**`, migration v4, `src/lib/**` (router `view`/`q`, shortcuts, today store), `src/copy/common.ts`, the palette registration, icons, the seed split (`scripts/seed-demo-kit.ts`) |

**Shared types (source of truth).**

- `ACTION_IDS` += `trash` (刪除 #), `unarchive` (移回收件匣 E), `assignment`
  (轉成作業 / 加入作業 A); `QUEUE_ACTION_KEYS` = `Enter E S T C # A`;
  `QUEUE_KINDS` += `suggestion.assignment`; `QUEUE_SOURCES` += `assignment`
  (lms: native assignments, item id = `Assignment.id` = `assignment:<uuid>`);
  `ANY_SOURCE_ACTIONS` += `assignment`; `ActionRoute` += `any-assignment`.
- `SUGGESTION_KINDS` += `assignment` with `AssignmentSuggestion {title,
  courseName?, dueAt: ISO | null, dueDay?, submitHint?, url?, notes?,
  detectedBy?: "ai" | "rule"}`; runtime schema `assignmentSuggestionSchema`
  in `server/today/suggestion-payloads.ts` (the core row and the lms acceptor
  both parse it). Dedupe key `mail-assignment:<messageId>`.
- `ASSIGNMENT_ORIGINS` = `moodle, canvas, mail, manual`; `LMS_ORIGINS`,
  `NATIVE_ASSIGNMENT_ORIGINS`, `isNativeOrigin`, `NATIVE_ASSIGNMENT_SITES`
  (「信件」, 「手動」), `ASSIGNMENT_LIMITS`; `Assignment` += optional
  `dueDateOnly, submitHint, notes, mailRef {messageId, threadId, url},
  createdAt`; `LmsAccountView.source` is an `LmsOrigin`;
  `AssignmentsResponse.suggestions?`; `AssignmentCreateRequest`,
  `AssignmentUpdateRequest`, `AssignmentDeleteResponse`.
- `MAIL_VIEWS` (`inbox, archive, all`), `MailLocation`,
  `MAIL_SEARCH_LIMITS`; `InboxThread` += optional `location`, `live`,
  `trashed` (a conversation in Gmail's trash, which only a reader opened by
  a link shows, e.g. an assignment's 開啟信件);
  `InboxSuggestion.kind` += `suggestion.assignment`; `MailSearchResponse`.
- Route `{ name: "inbox"; threadId?; view?: MailView; q? }`
  (`#/inbox/<id>?view=archive&q=…`); same `pageKey`.

**Endpoints and actions.**

| Contract | Body → response | Owner |
| --- | --- | --- |
| `POST /api/actions {itemId: "gmail:<messageId>", action: "trash"}` | → `ActionAccepted`. Local: the cache drops INBOX and adds TRASH at once. Remote after 6.5 s: `threads.get(format=minimal)` (what is about to move), then `threads.trash`. Revert: `messages.untrash` on the messages that were outside the trash, then `messages.batchModify` add `INBOX` on the ones that had it. 503 without Gmail; 409 「這封信已經在垃圾桶了。」 | MAIL |
| `POST /api/actions {itemId: "gmail:<messageId>", action: "unarchive"}` | → `ActionAccepted`. Remote: `threads.modify` add `INBOX`; revert removes it. A conversation in the trash (`trashed`): locally INBOX in and TRASH out, remotely `threads.untrash` then add `INBOX`; revert `threads.trash`. 409 「這封信已經在收件匣了。」. The core accepts it on a `gmail:` id even when the Today row it last served (from before the 封存) does not list it | MAIL (core exemption: lead) |
| `gmail:<messageId>` of a conversation outside the cache | the gmail handler resolves the thread with one `messages.get(format=minimal)` and plans the same writes; it never returns a `target` with the subject (the action log keeps the label) | MAIL |
| `GET /api/gmail/search?view=&q=&pageToken=` | → `MailSearchResponse`. `messages.list` with `gmailViewQuery(view, q)` (`server/features/gmail/views.ts`), `maxResults=25`, rows grouped per thread; uncached conversations read whole with `threads.get(format=metadata)`, 4 at a time (a row is placed and named by its whole conversation with the reader's rule, `liveConversation`: in the inbox when any visible message has INBOX, so an archived thread with a newer inbox reply or my own newest reply is not 已封存; one too big for the 5 MB cap falls back to its listed message); 5-minute in-memory cache (≤ 200 conversations), never `source_items`; `origin: "cache"` fallback; 400 「搜尋文字太長了，請少於 200 個字。」 / 「搜尋結果已經過期，請重新搜尋。」; 429 「Gmail 暫時限制讀取次數，請過一分鐘再試。」; logs `gmail.search {view, ms, rows, hasQuery, origin, page}` only (never the query). Page one falls back to the cache with `error` when Gmail fails (429 included); 載入更多 (`pageToken`) answers the failure (429 / 502). The 封存 view drops a conversation the cache shows in the inbox (or waiting for its 移回 / 刪除 to commit) | MAIL |
| `GET /api/gmail/threads/:threadId` (outside the cache) | → `InboxThreadResponse` with `thread.live: true`, read with `threads.get(format=full)` (over the 5 MB cap: `threads.get(format=minimal)`, then the newest 20 messages one by one, a message over the cap as headers only), plain text only, 5 minutes in memory. A conversation in the trash opens with `trashed: true` (移回收件匣, no 刪除); spam only is a 404 「這封信在垃圾郵件裡，請到 Gmail 查看。」 | MAIL |
| `findMailMessage(ctx, messageId)` (`server/features/gmail/lookup.ts`) | → `MailMessage \| undefined`: cache first, then a live read (not stored). The one way other modules read mail by id. The live read is `messages.get(format=full)` (a message over the 5 MB cap: `format=metadata`, no excerpt), held 5 minutes with the archive and search reads (`server/features/gmail/live.ts`); undefined without Gmail; 429 / 502 AppErrors in zh-TW. Callers keep only what they derive from it (ids, fields), never the message, so nothing outlives the 5 minutes | MAIL (used by ASSIGNMENTS) |
| Triage `assignments` array (`assignmentAnswerShape`), prompt line (`assignmentPromptLine`), hooks `assignmentSuggestionsFromTriage()` (returns the message ids that got one; triage.ts skips their todo) and `ruleAssignmentSuggestions()` (after every sync) | `server/features/gmail/triage-assignments.ts`: one suggestion per mail (`mail-assignment:<id>`), none for a mail already converted, an assignment an LMS lists (`sameAssignment`), or one the owner already has or was offered (a native record or any assignment suggestion: the same code in the same conversation, or `sameNativeAssignment`: replies, the TA's follow-up, reminders); the model's `url` is kept only when the cited mail carries it, and a `url` / `submit` of any length passes the answer schema (the model is still told 500 / 120, `TRIAGE_JSON_SCHEMA`) and is dropped when too long; the rules cover inbox mail of the last 14 days the model will not read (AI off, failed, outside the triage window, pending over 30 min, or triaged before `MAIL_TRIAGE_VERSION` 2 asked for assignments) | ASSIGNMENTS |
| `detectAssignment()`, `extractAssignment()`, `cleanSubject()` | `shared/assignment-detect.ts`, pure (golden table in its test); also `sameAssignment()` (both courses known and `sameCourse`: whole words, never a bare substring) / `sameNativeAssignment()` / `assignmentKey()` / `courseKey()` / `sameCourse()` for merging with LMS rows and deduplicating mail | ASSIGNMENTS |
| `POST /api/actions {itemId: "gmail:<messageId>", action: "assignment"}` | → `ActionAccepted` with `created {title, dueAt, dueDateOnly?}`. `anySourceActions.assignment`: `findMailMessage` → `extractAssignment` → create in `apply()` (origin mail, `mailRef`; a pending suggestion for that mail, else for another mail of the conversation, supplies the fields and is accepted with the others of that conversation for the same assignment), delete in `undo()`; the assignment the owner already has (the same conversation and code, or `sameNativeAssignment`) is reused, not made twice; 409 「這封信已經轉成作業了。」; 400 「這個項目不能轉成作業。」 for non-mail items | ASSIGNMENTS |
| `POST /api/actions {itemId: "ai:<id>", action: "assignment"}`, `POST /api/suggestions/:id/accept` | `suggestionActions.assignment`, `acceptSuggestion.assignment`: create from the payload (or reuse the owner's matching one), `resultId` = `assignment:<uuid>`, `created` for the toast | ASSIGNMENTS |
| `actions.assignment` | `assignment:<uuid>` rows: 開啟 (core), 標為已交 (core, until-change with `assignmentFingerprint`), 延後, 略過; `target` for rows Today did not serve | ASSIGNMENTS |
| `GET /api/lms/assignments` | LMS + native rows (native 標為已交 → status `submitted`), plus `suggestions` (pending assignment suggestions as rows). A mail assignment an LMS also lists (same code or title, the same course on both sides, deadline within 36 h) shows once, as the LMS row carrying the mail's `mailRef`; a mail assignment without a course is never merged; `mailSender` is read from the mail cache | ASSIGNMENTS |
| `POST /api/lms/assignments`, `PATCH`/`DELETE /api/lms/assignments/:id` | see §10.6; `:id` is the native uuid; LMS rows 409 「學校系統的作業不能在這裡修改。」; 400 「作業名稱不能是空白。」 | ASSIGNMENTS |
| lms `today()` | native rows like LMS ones: id `assignment:<uuid>`, source `assignment`, meta 「信件」/「手動」, primary 開啟信件 with `url` `#/inbox/<threadId>` (Today navigates in-app for `#/` urls), agenda, later, gap candidates, `nav.work` | ASSIGNMENTS |

**Persistence.** `PERSONAL_MIGRATIONS` v4 creates `local_assignments (id,
json, updated_at, origin, due_at, source_message_id, created_at)` with
indexes on `due_at` and `source_message_id`; `personal.v1.sql` upgrades
through it (database and export tests). Native assignments are the owner's
records: mail retention, purge and disconnect do not delete them (they keep
only ids and the Gmail link of the mail); pending assignment suggestions go
with their mail like every suggestion (`forgetMailDerivedData`).

**Seed.** `scripts/seed-demo.ts` builds the Gmail cache once; each team adds
rows through its own file (`seed-demo-mail.ts`: `demoArchivedMail(kit)`;
`seed-demo-assignments.ts`: `demoAssignmentMail(kit)`,
`seedLocalAssignments(databases, kit)`) with the shared `SeedKit` helpers
(`scripts/seed-demo-kit.ts`): three archived conversations, the HW5 mail and
its pending suggestion, Lab 3 already added from its mail, and the manual
專題提案書.

**Inbox rows of converted mail.** `InboxThread.converted`: a native
assignment was made from the conversation (`mailRef.threadId`, by 轉成作業 or
加入作業); the row and the reader say 已轉成作業 and no longer offer 轉成作業.
The reader also hides 轉成作業 while its own 加入作業 suggestion is shown, so A
means one thing.

**Client edits.** #/inbox layers optimistic edits on the cached list and on
the 封存 / 全部 / search pages. 封存 and 移回收件匣 are one `moved` edit that
every list reads by view (`applyThreadEdits(threads, edits, view)`: the row
leaves 收件匣 and 封存, and changes sides in 全部), so a conversation moved in
one view is right in the others for the rest of the session. 復原 on the toast
drops the page's edits through `ActOptions.onUndo` (`src/lib/today.tsx`), and
so does a deferred write that failed after the 202 (`ActOptions.onFailed`);
移回收件匣 has the undo toast too (`offersUndo`). The 轉成作業 / 加入作業 toast is
rewritten from `ActionAccepted.created` once the POST answers
(`toast.update`), so it names what was saved, not the page's guess.

**Checked together** (`server/integration.test.ts`, fake Gmail, every
module): 封存 / 刪除 on Today and inbox rows with 復原 inside the window (no
Gmail call) and after it (untrash + INBOX, unarchive); the 封存 view, its
reader and 移回收件匣; search per scope; 轉成作業 from a Today mail row (the
rules' 轉成作業 A hint) and from a live archived mail, 加入作業 on the AI
suggestion, the Today queue, agenda and `nav.work` agreeing with #/work.

### 10.11 A mail's original layout and its images (2026-10-15)

The UX and security contract is `docs/design/SPEC-mail-html.md` (decisions D1–D18,
threat model §9). The mail module owns all of it; the core gained one seam.

| Part | Contract |
| --- | --- |
| `ctx.publicNetwork` (`server/services.ts`, seam `publicNetwork`) | `{ lookup(hostname, signal?) → addresses, request(pinned target) → response }`. Production: `resolverLookup()` — a c-ares `dns.promises.Resolver` per lookup (`resolve4` + `resolve6`, 2 s, one try, `cancel()` when the fetch aborts; never `dns.lookup`/getaddrinfo, which holds libuv threadpool threads past any deadline and would starve every other outbound lookup of the server) — and node:http/https with a `lookup` that returns the checked address only (`pinnedRequest`). `testServices()` installs `offlineNetwork`; tests and the scratch launcher inject `demoPublicNetwork()` (`server/features/gmail/fixtures/html-mail.ts`). Use it only through `publicFetch`. |
| `publicFetch(network, url, {maxBytes, timeoutMs, maxRedirects, accept, signal?, checkUrl?})` | `checkUrl` judges every hop (the first URL and each redirect) before anything is sent to it (`refused-url`); http/https, no credentials, default ports; private names refused before lookup (`localhost`, `.local`, `.internal`, `.lan`, `.arpa`, `.ts.net`, single labels, `.test`, `.example`, `.invalid`, `.onion`…); every resolved address public (`isPublicAddress`: RFC 1918, loopback, link-local and metadata, **100.64/10 (tailnet)**, ULA, multicast, documentation, NAT64, 6to4, Teredo, mapped forms); the request is pinned to the checked address; ≤ `maxRedirects` hops, each re-checked; one deadline; byte cap on received bytes (`Accept-Encoding: identity`); no cookies, no Referer, `User-Agent: Mozilla/5.0`. Throws `PublicFetchError {reason}`. |
| `GET /api/gmail/messages/:messageId/body[?images=1]` | `readMailBody` (`mail-body.ts`): `messages.get(format=full)` live (5 MB cap → headers only, `too-large`), the first inline `text/html` part (or one `attachments.get`), decoded with `decodeBytes` (the plain-text charset rules), ≤ 1,000,000 characters; held in `LiveMail` (5 min, LRU, 12 MB of bodies). `sanitizeMailHtml` (sanitize-html 2.18.0 allowlist, CSS rebuilt by `mail-css.ts` with linear scans only, URL policy, tracking pixels removed, fixpoint check, a 3 s wall-clock budget → `too-large`) → `mailDocument` (frame CSP first; the mail's `<html dir lang>` on the wrapper). Remote images become `/api/mail-images/proxy?…` only with `images=1` or a sender on `mail.trustedImageSenders` (`trustedSender()`, `shared/mail.ts`); such a body starts `ImageProxy.prefetch` of every remote image in it (log `mail.prefetch`). Answers `MailBodyResponse {kind: "html" \| "text", reason?: no-html \| too-large \| unsafe \| not-connected, document?, images {remote, shown, trusted, trackers}, sender, attachments[]}`; 404 「這封信已經不在 Gmail…」, 429/502 like the live reader. |
| `GET …/inline/:contentId`, `GET …/attachments/:partId` | the part by Content-ID (exact, then case-insensitive) or MIME part id; bytes from the answer or `attachments.get` (a stale id is re-read once); raster by magic bytes with a sane decoded size (`acceptableRaster`: both sides named, each ≤ 16,384, ≤ 40 Mpx; GIF frames and AVIF `ispe` count) or 415; ≤ 10 MB; `sendImage` headers (sniffed type, nosniff, `CSP: default-src 'none'; sandbox`, `Content-Disposition: inline; filename=…` with the sniffed extension, `Cache-Control: private, max-age=300`, `CORP: same-origin`); held in `LiveMail` (32 MB of images). 503 without Gmail. |
| `GET /api/mail-images/proxy?m=&u=&s=` (`routes: [{path: "/api/mail-images"}]`) | `ImageSigner` (HMAC-SHA-256 over `messageId\nurl`, random per-process key, `timingSafeEqual`) → 403 when wrong; `ImageProxy.serve`: only what the body's prefetch got — the held image, a held refusal or the fetch in flight; a URL nobody prefetched (or no longer held) is 410 and is **never** fetched for the browser. `ImageProxy.fetch` (prefetch only): one fetch per URL at a time, ≤ 6 at once and ≤ 4 per message, ≤ 30 s waiting for a slot (`timeout`), ≤ 150 per message and 600 overall per 5 min (429; a refused fetch gives its global share back), `publicFetch` (3 redirects, a redirect into a known tracker not followed → transparent GIF, 10 s, 10 MB), raster check (415) with a sane decoded size (413), ≤ 1×1 → our transparent GIF; refusals held 5 min and dropped with `LiveMail.clear()` (`generation`). |
| `LiveMail` | gains `body/putBody/forgetBody` and `image/putImage` (byte budgets); `forgetThread` and `clear` drop them (actions, 清除快取的信件, disconnect); `generation` changes on every `clear` (the proxy's held refusals go with it). |
| Frontend | `src/pages/inbox/MailBody.tsx` (states, notice, failed-image note with 重試, focus to the note after 顯示圖片, attachments; a refused thumbnail becomes a quiet tile), `MailFrame.tsx` (the sandboxed frame, auto height from the content box, zoom-to-fit, key forwarding without Enter/Space on links), `useMailBody.ts` (page-session cache — answers with proxied images expire after 5 minutes —, `attempt` retries, `peekMailBody`, `mailBodyLoading`, `forgetMailBodies`), `mail-frame.ts` (pure rules: `fitZoom`, `contentHeight`, `forwardsKey`, `HeightGuard`); the reader's bottom note mentions the frame only when a message answered `html` (`framed`); `useMailView()` / `chooseMailView()` in `src/lib/preferences.ts`; `I` = `SHORTCUTS` id `images`; 資料與隱私 › `MailDisplayCard`. |
| Logs | `gmail.body`, `gmail.body_unstable`, `gmail.body_slow`, `mail.image` (outcomes incl. `tracker`, `too-large`, `expired`), `mail.prefetch {urls, images, pixels, refused, ms}` — counts and outcomes only (§9). |

`GET /api/gmail/threads/:threadId` is unchanged: plain text only (§10.10).

### 10.12 用 AI 處理 in the reader (2026-10-15)

The owner opens a conversation in #/inbox and taps 用 AI 處理: the model
decides what in it belongs in the calendar, the todos or the assignments.
The mail module owns it (`server/features/gmail/process.ts`,
`src/pages/inbox/useMailProcess.ts`); it reuses the triage's pieces and the
existing suggestion flow, so "AI proposes, the user decides" holds: every
item is a pending suggestion, added only by its one-tap 加入行事曆 / 加入待辦
/ 加入作業 under 從這封信找到 (or its `ai:` row on Today).

| Part | Contract |
| --- | --- |
| What is read | Cached mail only (a live or trashed conversation has no button; the server answers 404), so the retention window removes the suggestions with the mail (/privacy §03). The newest `PROCESS_MESSAGES` (4) visible messages of the conversation, oldest first, each with `from`, `mine`, subject, local `receivedAt` and its excerpt in `untrustedBlock("email", …)` (4000 characters for the newest, 1500 for the others), plus `today`, `weekday`, `timeZone`. A message whose text has a secret shape is left out; none left → 422. |
| The call | `ctx.ai.runStructured({ role: "信件處理", schema: processAnswerSchema, jsonSchema, timeoutKind: "quick", priority: "interactive" })` inside the job (`withGenerationProgress`, stage `process`). Answer: `events` (`title, start, end, location`), `todos` (`title, due`), `assignments` (the triage's item without `sourceId`; `submit` / `url` checked leniently like the triage), at most 8 each; strict, every field required. |
| Suggestions | On the conversation's row message (`threadView().latest`: the newest not sent by the owner), origin `suggestionOrigin()`. Events through the triage's `toEvent` (past ones dropped), dedupe key `mail-event:<messageId>:<hash of start>`; todos `mail-todo:<messageId>:<hash of title>`; the assignment through `assignmentSuggestionsFromTriage` (one per message, `mail-assignment:<messageId>`, nothing the owner already has). At most 5 events and 5 todos. Nothing the conversation already has a suggestion for, in any status, is suggested again (an event at the same instant, or the same title on the same day; a todo with the same title, ignoring spacing and punctuation), so a second run never brings back what the owner dismissed, and a todo named like this answer's event or assignment is left out. A conversation purged or pruned while the model ran gets nothing (404). |
| Result | `MailProcessResult {threadId, found, added, pending}`: usable items found (including ones suggested before), pending suggestions added, pending suggestions of the conversation now. The toast says what was added (「AI 找到 2 個項目，請在下方「從這封信找到」確認要不要加入。」) or why nothing was; the reader and Today refresh. |
| Status | `GET /api/status` → `modules.gmail` is `MailModuleStatus`; `aiProcess` = `ai.enabled` and the selected CLI signed in (the shared 10 s probe). The reader shows the button only then. |
| UI | `.q-actions` gains 用 AI 處理 (Sparkles, secondary, no key) before 在 Gmail 開啟; while the job runs it reads 處理中… (`aria-disabled`, `aria-busy`, never `disabled`) and a `.mr-state.is-processing` line shows the server's progress, with one fixed `role="status"` sentence for screen readers. Moving to another conversation and back keeps the progress; leaving #/inbox stops following, not the job. |

### 10.13 Student polish: backlog line, idea → todo, weekly events (2026-10-23)

| Part | Contract |
| --- | --- |
| Backlog | `TodayContribution.backlog?: { undatedTodos? }` is summed by the core into `TodayPayload.backlog?: { undatedTodos }` (absent at 0; optional in `server/today/schema.ts`). The todos module counts open todos with no `dueDay` created before today's local day (`undatedBacklog()`). It never feeds `counts` or `nav`. UI: `BacklogNote` under the queue; its link is `#/tasks?group=someday`. |
| 排日期 | `PATCH /api/todos/:id { dueDay }` from `SchedulePopover` (#/tasks, key `S`, presets 1–5 from the server's `TodoListResponse.day`). Nothing new on the server. |
| Idea → todo | `POST /api/ideas/:id/todo {}` → 201 `IdeaToTodoResponse { todo, undoToken }`; one transaction creates a `manual` todo (title = first non-empty line, rest in notes) and archives the idea; 404 gone, 409 archived. `POST /api/trash/restore` accepts the token: the trash row is the pseudo table `idea_todo`, whose restorer removes the todo and unarchives the idea in one transaction (409 if the todo was completed or edited since; if it is already gone the idea still comes back). |
| Weekly events | `ManualEvent.repeat?: { freq: "weekly"; until?: DayKey; skip?: DayKey[] }` (JSON only, no migration; `skip` ≤ 200 days). The weekday and wall-clock time come from `start`; `until` is inclusive; one occurrence belongs to the local day it starts on. `CalendarService.series(from, to)` finds series that began before the window (`json_type(json,'$.repeat')`), `between()` returns one-off events only, `repeat.ts` expands at most `REPEAT_LIMITS.occurrencesPerRead` (500) per read. `collectItems` emits one `CalendarItem` per occurrence: `id = manual:<id>:<local day>`, `manualId` = the series, `repeat: { freq, day }`, meta ends 「每週X」; Today's agenda, `nextUp`, free slots and habit links all read it. `later.events` counts a weekly class once. |
| Weekly routes | `POST /api/calendar/events` and `POST /api/capture` accept `repeat` (an `until` before the first day → 400). `POST /api/calendar/events/:id/skip {day}` and `DELETE /api/calendar/events/:id/skip/:day` (idempotent; 復原 = the DELETE `undoPath`). `DELETE /api/calendar/events/:id` removes the whole series through the trash. A series is never inserted into Google: `google: "none"`, no `deferPush`, `POST …/google` → 409. |
| Parser | `shared/capture-parse.ts`: 每週X / 每個禮拜X / 每星期X (+ time or a range) → `CaptureParse.repeat`, first occurrence = the next such weekday (today counts until a minute after its time). Not repeats: 每週報告, 每次開會, 每週一次, 每週三堂, 每週一、三, 每天. `withRepeat()` re-applies it when Tab changes the type. When the palette sends its own `start`, its `repeat` is authoritative. |
| Defaults | `ctftime.enabled` defaults to `false`; settings migration v3 keeps it on where a `ctftime.*` row exists. |
| Edit a local event | `PATCH /api/calendar/events/:id` (strict; any of `title`, `start`, `end` (`null` = none), `allDay`, `location`/`notes`/`repeat` (`null` clears), 404, 409 when the event is in Google or its insert is pending: 「請到 Google 行事曆修改」). Create and edit share `resolveTimes`. Editing a series edits every week; stale `skip` days are dropped when the weekday changes; a changed title, place or note drops `originalText`/`pretidy` and cancels a running tidy. 復原 = PATCH the previous values. `CalendarItem.repeat` is `{ freq, day, first, until?, skip? }`. UI: `EventEditor` (popover, bottom sheet ≤720) from a pencil on day rows or a click on a week-grid block. |
| Proposals on Today | `suggestionContribution` (server/today/suggestions.ts) shows no proposal that is moot (`suggestionIsMoot`: the event started, the due day or deadline passed), no event more than 14 days away, and at most `SUGGESTION_ROWS_MAX` (3) event and todo proposals, most urgent first (undated last, then newest); assignment proposals are exempt from the cap. Nothing is dismissed: the rest stay pending for the reader, #/events and the next free place. #/events and `nav.events` leave moot ones out too. |

### 10.14 BELL Suite: manifest, sibling feeds, handoffs (2026-11-08)

Shared contract: `bell-suite/contracts/` (suite-contract v1, rev. d; `reference.mjs` and fixtures are the executable definition). Personal keeps its own copy (`shared/suite.ts`, `server/suite/`, `src/suite/`); there is no cross-repo import, so a rule change goes into both.

| Part | Contract |
|---|---|
| Settings | `BELLPERSONAL_SUITE_LINKS` (browser origins: `<a href>` and `location` only, never `connect-src`, CORS, Host or Origin; loopback http/https, otherwise https `*.ts.net` in Personal's own tailnet) and `BELLPERSONAL_SUITE_FETCH` (server reads: http on an IP-literal loopback only) are separate, read once at boot (`server/suite/config.ts`). Credentials, paths, queries, fragments, wildcards, port 0, duplicate apps and Personal's own origins or ports refuse to start, naming the variable. |
| Mount | `/api/suite` (reserved) sits after `localhostGuard` and `tailscaleIdentityGate`, next to the core routes. GET only, `no-store`. Nothing in it writes, and no sibling can write Personal. |
| Manifest | `GET /api/suite/manifest` → `SuiteManifest`: capabilities `tasks.draft` (accept-handoff `#/tasks`, 2000 chars), `todo.open`, `event.open`, `idea.open`; `links` = the validated LINKS only (absent = 未連結). |
| Sources | `GET /api/suite/sources[?refresh=1]` → `{schemaVersion:1, sources:[explain, pr]}`, status `ready` / `stale` / `unavailable` / `unconfigured` / `unsupported`. Read with `node:http` and its own non-keep-alive agent: only `Accept: application/json` is sent (no cookie, identity or auth header), 3 s total, 64 KiB streamed cap, status 200 and `application/json` only, no redirects, strict zod (`server/suite/feed.ts`: unknown keys, one bad item, a schemaVersion ≠ 1 or an href outside the sender's allowed routes reject the whole feed). Memory cache per sibling: a read within 60 s answers from the cache, concurrent reads and `refresh=1` join the read in flight, a failure within 30 min of the last success is `stale` with the old feed, later it is `unavailable` and the feed is dropped. PR is `unsupported` (linked or fetch-configured; no feed in v1) or `unconfigured`, and is never read. Logs carry the app, a failure class and ms, never a body. |
| Routes (§5.1) | `allowedSuiteRoute` in `shared/suite.ts`: Explain `#/`, `#/library`, `#/graph`, `#/favorites`, `#/repositories`, `#/review`, `#/note/{id}`; Personal `#/today`, `#/tasks[/{id}]`, `#/events[/{id}]`, `#/ideas[/{id}]`, `#/inbox[/{id}]`; PR none. `{id}` is one raw `[A-Za-z0-9._:-]{1,128}` segment, never `.` or `..`. The same rule checks a feed item `href` and a handoff `back`. |
| Receive a to-do draft | `#/tasks?draft=…&from=explain&back=…`: AppShell captures it before paint and on every hashchange. Any reserved key (`text`, `title`, `draft`, `from`, `back`) on `#/tasks` is an attempt (contract rev. d): it deletes any older draft and `replaceState`s to `#/tasks` at once; a repeated reserved key (D9), no `draft` or nothing left after cleaning is refused with a notice; otherwise it validates once the manifest is in (`from` must be linked and not Personal; `back` must be an allowed route of `from`, else dropped and the draft kept). Without a reserved key the stored draft stays. The draft lives under `sessionStorage["bell.suite.handoff.tasks"]` (`{v:1,text,from,backUrl?,receivedAt,truncated?}`), whole, never merged. Nothing is created until 建立待辦 (one in flight; the draft is removed before the POST and put back if it fails); 捨棄草稿 deletes it. |
| 解釋這個 | Tasks, events, ideas and the mail reader link to `<explain>/#/explain?text=…&title=…&from=personal&back=…` when Explain is linked (`src/suite/ExplainThis.tsx`). Text ≤ 2000 and title ≤ 120 code points; `back` is the current page as an allowed Personal route with the raw id (`personalBackRoute`), else its list page, else left out. Opening the link starts no AI on either side. |
| Today | The Explain card (`src/suite/`) shows counts only from a `ready` or `stale` feed (「—」 otherwise, never 0), lessons as plain-text links, 重試 and 來源詳情 (side panel on desktop, full-width dialog on phones). Refetched on visit when older than 60 s and every 5 min while the page is visible. |
