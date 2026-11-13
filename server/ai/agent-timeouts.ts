import type { AgentProvider, ReasoningEffort } from "../../shared/models.js";
import { AppError } from "../errors.js";

/**
 * quick: a short parse (quick capture, idea tags). standard: one batch of
 * triage or extraction. long: the daily brief over every source.
 */
export type AgentTimeoutKind = "quick" | "standard" | "long";

/** Seconds per call for Codex without an effort factor (bell-pr's baseline). */
const baseSeconds: Record<AgentTimeoutKind, number> = {
  quick: 120,
  standard: 240,
  long: 480,
};

/** Claude Code with thinking is slower per call than the Codex defaults above. */
const providerFactors: Record<AgentProvider, number> = { codex: 1, claude: 2.5 };
/** Only the two highest efforts stretch a turn enough to matter; others keep ×1. */
const effortFactors: Partial<Record<string, number>> = { xhigh: 1.5, max: 2 };
export const maxAgentTimeoutMs = 2 * 60 * 60 * 1000;
export const defaultAgentTimeoutScale = 1;

/** Base × provider × effort × scale, whole seconds, at most two hours. */
export function agentTimeoutMs(
  kind: AgentTimeoutKind,
  execution: { provider?: AgentProvider; reasoningEffort?: ReasoningEffort },
  scale = defaultAgentTimeoutScale,
): number {
  const provider = providerFactors[execution.provider ?? "claude"];
  const effort = execution.reasoningEffort ? (effortFactors[execution.reasoningEffort] ?? 1) : 1;
  const seconds = Math.round(baseSeconds[kind] * provider * effort * scale);
  return Math.min(seconds * 1000, maxAgentTimeoutMs);
}

/** Whole minutes when exact, otherwise one decimal (37.5). */
function minutes(timeoutMs: number): string {
  return String(Math.round(timeoutMs / 6000) / 10);
}

export function describeAgentTimeout(timeoutMs: number): string {
  return `最多等待 ${minutes(timeoutMs)} 分鐘`;
}

/**
 * Replaces command()'s generic 504 with advice the person can act on; any
 * other error is returned unchanged. No environment variable names: this text
 * reaches the UI.
 */
export function withAgentTimeoutHint(error: unknown, label: string, timeoutMs: number): unknown {
  if (!(error instanceof AppError) || error.status !== 504) return error;
  return new AppError(504, `${label} 執行逾時（已等待 ${minutes(timeoutMs)} 分鐘）。可降低思考強度或改用較快的模型後再試一次。`);
}

/** Parses BELLPERSONAL_AGENT_TIMEOUT_SCALE; an unset variable means the default. */
export function parseAgentTimeoutScale(value: string | undefined): number {
  if (value === undefined) return defaultAgentTimeoutScale;
  const scale = Number(value);
  if (value.trim() === "" || !Number.isFinite(scale) || scale < 0.5 || scale > 10)
    throw new Error("BELLPERSONAL_AGENT_TIMEOUT_SCALE 必須介於 0.5 與 10 之間。");
  return scale;
}
