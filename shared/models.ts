import type { AiConnectionMethod } from "./ai-connections.js";
/** Model providers and execution records, shared by the server and the settings UI (from bell-pr). */
export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "ultra", "max"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

/** Claude Code is the default provider; Codex is the alternative. */
export const agentProviders = ["claude", "codex"] as const;
export type AgentProvider = (typeof agentProviders)[number];

export const providerLabels: Record<AgentProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** The one model setting every AI job uses (settings.sqlite singleton). */
export interface ProviderSettings {
  provider: AgentProvider;
  /** "" = the catalog default. */
  model: string;
  /** "" = the model default. */
  reasoningEffort: ReasoningEffort | "";
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = { provider: "claude", model: "sonnet", reasoningEffort: "low" };

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface ModelCatalog {
  source: AgentProvider;
  models: ModelOption[];
  /** zh-TW reason the catalog is empty or the CLI unusable. */
  error?: string;
  /** Structured readiness detail when the active AI connection cannot list models here (503 ai_connection_not_ready). */
  notReady?: { method: AiConnectionMethod; reason: import("./ai-connections.js").AiNotReadyReason };
}

/** Settings explicitly sent to the CLI, recorded on everything a model produced. */
export interface ModelExecution {
  provider: AgentProvider;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  source: "selected" | "catalog-default" | "cli-default";
  /** What the CLI itself reported (Claude Code init event). */
  reported?: { model: string; modelsUsed?: string[]; cliVersion?: string };
}

export interface ProviderSnapshot {
  /** The settings jobs run with: with an active connection, always on its CLI. */
  settings: ProviderSettings;
  /** 設定 › 連接 AI's active connection (`ai.connection`); `null` = not chosen, any provider. */
  connection?: AiConnectionMethod | null;
  catalogs: ModelCatalog[];
}
