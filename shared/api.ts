import type { AiActiveStatus, AiConnectionMethod, AiKeyProvider, AiNotReadyReason } from "./ai-connections.js";
import type { AgentProvider, ProviderSettings } from "./models.js";
import type { SourceStatus } from "./sources.js";
import type { FeatureId, ProfileRole } from "./profile.js";
import type { DayKey } from "./time.js";

/** GET /api/health: public (no identity check), so it carries no personal data. */
export interface HealthResponse {
  status: "ok";
  version: string;
  release: string;
  uptimeSeconds: number;
}

export interface CliStatus {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  /**
   * How the CLI is signed in, when it says (`claude auth status` JSON,
   * `codex login status` text): a subscription (Claude Pro/Max, ChatGPT) or
   * an API key. `plan` is Claude's subscription type (pro, max…). Never the
   * account email or organisation.
   */
  account?: { kind: "subscription" | "api_key"; plan?: string };
}

/** GET /api/status: behind the identity gate; CLI probes are cached for 10 s. */
export interface StatusResponse {
  today: DayKey;
  timeZone: string;
  checkedAt: string;
  ai: {
    settings: ProviderSettings;
    clis: Record<AgentProvider, CliStatus>;
    /** 設定 › 連接 AI: the active connection's readiness here (GET /api/ai/connections has the details); `null` = none chosen. */
    connection: AiActiveStatus | null;
  };
  github: { authenticated: boolean; login?: string };
  /** Whether credentialed sources can be connected at all (a master key is configured). */
  vault: { enabled: boolean };
  google: { clientConfigured: boolean; connected?: boolean };
  sources: SourceStatus[];
  /** Per-module extras contributed by feature modules. */
  modules: Record<string, unknown>;
  limits: { maxAgentProcesses: number; requestBodyBytes: number };
}

/**
 * Structured 503 runtime refusal details attached to AppError.detail when an AI
 * CLI preflight or turn fails due to an invalid saved key, an expired CLI
 * login, or an unavailable CLI binary.
 */
export type AiRuntimeErrorDetail =
  | { code: "ai_key_invalid"; provider: AiKeyProvider; method?: AiConnectionMethod }
  | { code: "ai_auth_expired"; provider: AgentProvider; method?: AiConnectionMethod }
  | { code: "ai_cli_unavailable"; provider: AgentProvider };

/**
 * Machine-readable refusals, for errors the UI handles beyond showing `error`:
 * - ai_connection_not_ready (`method`, `reason`): 409 when the connection
 *   asked for cannot be made active (PUT /api/ai/connections/active, or
 *   `ai.connection` in PUT /api/settings/app); 503 when a model save
 *   (PUT /api/settings/provider), brief refresh, or AI job meets an active
 *   connection that cannot run here.
 * - module_hidden (409): a write to a module whose feature is hidden
 *   (`module`, `feature`): by the roles (初次設定 › 你是…; ticking one of
 *   `roles` turns it on) or switched off by hand in `features.overrides`.
 * - ai_key_invalid / ai_key_no_credit (422): the provider refused the key or
 *   accepted it but reported no remaining credit on save; 503 `ai_key_invalid`
 *   carries `provider` (and optional `method`) when a saved key fails at run time.
 * - ai_auth_expired / ai_cli_unavailable (503): CLI login check or runtime turn
 *   found an expired login (`provider`, optional `method`) or missing CLI (`provider`).
 */
export type ApiErrorDetail =
  | { code: "ai_connection_not_ready"; method: AiConnectionMethod; reason: AiNotReadyReason }
  | { code: "module_hidden"; module: string; feature: FeatureId; roles: ProfileRole[] }
  | { code: "ai_key_invalid" | "ai_key_no_credit"; provider?: undefined; method?: undefined }
  | AiRuntimeErrorDetail;
export type ApiErrorCode = ApiErrorDetail["code"];

/** The shape of every error body; `code` and its fields only on the refusals in ApiErrorDetail. */
export type ApiErrorBody = { error: string } & (ApiErrorDetail | { code?: undefined });

/** DELETE responses for reversible deletes: pass the token to POST /api/trash/restore within the undo window. */
export interface UndoToken {
  undoToken: string;
}
