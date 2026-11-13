import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { providerLabels, type AgentProvider, type ModelExecution } from "../../shared/models.js";
import { AppError } from "../errors.js";
import { redactCliOutput } from "../secrets/redact.js";
import { modelExecutionSchema, modelId } from "./models.js";

/**
 * Claude Code invocation for structured, tool-less answers (bell-pr's
 * agentCommand with access "none" and an output schema, plus
 * --disable-slash-commands). The prompt always goes on stdin; a shell is never used.
 */
export interface AgentCommandOptions {
  /** The temporary working directory; command() must receive the same cwd. */
  cwd: string;
  /** JSON Schema file the final answer must match; its contents are inlined as --json-schema. */
  outputSchema: string;
  /** CLAUDE_CLI_PATH, default "claude". */
  executable?: string;
}

export const agentLabel = (provider: AgentProvider = "claude") => providerLabels[provider];

export async function agentCommand(
  execution: ModelExecution,
  options: AgentCommandOptions,
): Promise<{ executable: string; args: string[] }> {
  if (execution.provider !== "claude") throw new AppError(500, "Codex 透過 app-server 執行，不使用這個命令。");
  const value = modelExecutionSchema.parse(execution);
  return {
    executable: options.executable ?? "claude",
    args: [
      "-p",
      // Verified on this host with --json-schema (AGENTS.md): skips user hooks, plugins,
      // CLAUDE.md, skills and custom agents while keeping the CLI's own login.
      "--safe-mode",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      // Keeps the user's claude.ai connectors and MCP servers away from a model reading untrusted mail.
      "--strict-mcp-config",
      // Only the user's own settings (its login); no project settings, hooks or memory from the cwd.
      "--setting-sources",
      "user",
      "--disable-slash-commands",
      ...(value.model ? ["--model", value.model] : []),
      ...(value.reasoningEffort ? ["--effort", value.reasoningEffort] : []),
      // access "none": no built-in tools at all, and nothing may ask for permission.
      "--tools",
      "",
      "--permission-mode",
      "dontAsk",
      "--json-schema",
      await readFile(options.outputSchema, "utf8"),
    ],
  };
}

/** Exits successfully only when the CLI is installed and signed in. */
export function agentLoginCheck(provider: AgentProvider = "claude", executable?: string) {
  return provider === "claude"
    ? { executable: executable ?? "claude", args: ["auth", "status"] }
    : { executable: executable ?? "codex", args: ["login", "status"] };
}

export type AgentEvent =
  /** Agent text; the last one is the answer unless a final event follows. */
  | { kind: "message"; text: string }
  /** Claude Code's terminal answer, including validated structured output. */
  | { kind: "final"; text: string }
  /** Recoverable waiting the user may see now; never a failure by itself. */
  | { kind: "notice"; message: string }
  /** Claude Code's system/init: the resolved model and the CLI version. */
  | { kind: "session"; model: string; cliVersion?: string }
  /** Model IDs present in result.modelUsage. */
  | { kind: "usage-by-model"; models: string[] }
  /** Token counts from the result event (finite, non-negative numbers only). */
  | { kind: "usage"; usage: Record<string, number> }
  /** A tool call: with --tools "" this never happens, so the run is stopped. */
  | { kind: "tool"; name: string }
  /** retryable: the invocation lost Claude Code's OAuth refresh lock to another process; a rerun usually succeeds. */
  | { kind: "error"; message: string; terminal: boolean; retryable?: boolean };

/** Claude Code reports this when another process holds ~/.claude/.oauth_refresh.lock while the token is expired. */
const oauthRefreshRace = /Failed to refresh OAuth token/;

type Json = Record<string, any>;
const blocks = (event: Json): Json[] =>
  Array.isArray(event.message?.content)
    ? event.message.content.filter((block: unknown) => !!block && typeof block === "object")
    : [];
const isModelId = (value: unknown): value is string => typeof value === "string" && modelId.safeParse(value).success;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const rateLimitWindows: Record<string, string> = {
  five_hour: "5 小時滾動視窗：用量每 5 小時依開始時間重置",
  seven_day: "7 天滾動視窗：所有模型的每週總量",
  seven_day_opus: "7 天滾動視窗：Opus 的每週用量",
  seven_day_sonnet: "7 天滾動視窗：Sonnet 的每週用量",
  seven_day_overage_included: "7 天滾動視窗：含額外用量的每週總量",
  overage: "額外用量",
};

/** Explains a non-allowed rate_limit_event in one line; a plain "allowed" status is normal and stays silent. */
function rateLimitNotice(info: unknown): string | undefined {
  if (!info || typeof info !== "object") return;
  const value = info as Json;
  if (typeof value.status !== "string" || value.status === "allowed") return;
  const state = value.status === "rejected" ? "已達上限，等待重置中" : value.status === "allowed_warning" ? "接近上限" : `狀態 ${value.status}`;
  const parts = [
    typeof value.rateLimitType === "string" ? (rateLimitWindows[value.rateLimitType] ?? value.rateLimitType) : undefined,
    finite(value.utilization) ? `已用 ${Math.round(value.utilization * 100)}%` : undefined,
    finite(value.resetsAt) ? `預計 ${new Date(value.resetsAt * 1000).toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" })} 重置` : undefined,
  ].filter((part): part is string => !!part);
  return `Claude 額度${state}${parts.length ? `（${parts.join("；")}）` : ""}。`;
}

function retryNotice(value: Json): AgentEvent[] {
  if (value.subtype !== "api_retry") return [];
  const parts = [
    finite(value.attempt) ? `第 ${value.attempt}${finite(value.max_retries) ? `/${value.max_retries}` : ""} 次` : undefined,
    typeof value.error === "string" && value.error ? `原因 ${value.error}` : undefined,
    finite(value.retry_delay_ms) ? `${Math.max(0, Math.round(value.retry_delay_ms / 1000))} 秒後重試` : undefined,
  ].filter((part): part is string => !!part);
  return [{ kind: "notice", message: `Claude Code 重試中${parts.length ? `（${parts.join("，")}）` : ""}。` }];
}

/** --json-schema is delivered through this one built-in tool; it is the only tool a run may show. */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * The isolation check from bell-explain's claude.ts, adjusted to what Claude
 * Code 2.1.292 reports on this host: the init event may list only the
 * StructuredOutput tool, no MCP servers, no skills or slash commands, and only
 * plugins bundled inside the CLI itself. Returns a reason when it does not.
 */
export function claudeInitViolation(event: Json): string | undefined {
  const empty = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
  if (!(Array.isArray(event.tools) ? event.tools : []).every((tool: unknown) => tool === STRUCTURED_OUTPUT_TOOL)) return "tools";
  if (!empty(event.mcp_servers)) return "mcp_servers";
  if (!empty(event.skills)) return "skills";
  if (!empty(event.slash_commands)) return "slash_commands";
  const bundled = (Array.isArray(event.plugins) ? event.plugins : []).every((plugin: unknown) => {
    const item = plugin as { path?: unknown; source?: unknown };
    return item?.path === "builtin" && typeof item.source === "string" && item.source.endsWith("@builtin");
  });
  if (!bundled) return "plugins";
  if (event.permissionMode !== undefined && event.permissionMode !== "dontAsk") return "permissionMode";
  return undefined;
}

/**
 * Maps one parsed Claude Code stream-json event to the events BELL uses
 * (bell-pr's reader, Claude branch). Raw tool output is never returned.
 */
export function agentEventReader(options: { secrets?: readonly string[] } = {}) {
  const read = eventReader();
  // Notices reach the job screen and errors the log: CLI text in either is masked, with the run's own key.
  return (event: unknown): AgentEvent[] =>
    read(event).map((item) =>
      item.kind === "notice" || (item.kind === "error" && !item.message.startsWith("isolation:"))
        ? { ...item, message: redactCliOutput(item.message, options.secrets) }
        : item,
    );
}

function eventReader() {
  // The StructuredOutput call and its acknowledgement are how --json-schema answers; any other tool stops the run.
  const structuredCalls = new Set<string>();
  return (event: unknown): AgentEvent[] => {
    if (!event || typeof event !== "object") return [];
    const value = event as Json;
    if (value.type === "system") {
      if (value.subtype === "init") {
        const events: AgentEvent[] = [];
        if (isModelId(value.model))
          events.push({
            kind: "session",
            model: value.model,
            ...(typeof value.claude_code_version === "string" && value.claude_code_version ? { cliVersion: value.claude_code_version.slice(0, 100) } : {}),
          });
        const violation = claudeInitViolation(value);
        if (violation) events.push({ kind: "error", terminal: true, message: `isolation:${violation}` });
        return events;
      }
      return retryNotice(value);
    }
    if (value.type === "rate_limit_event") {
      const message = rateLimitNotice(value.rate_limit_info);
      return message ? [{ kind: "notice", message }] : [];
    }
    if (value.type === "assistant") {
      const events: AgentEvent[] = [];
      for (const block of blocks(value)) {
        if (block.type === "text" && block.text) events.push({ kind: "message", text: String(block.text) });
        if (block.type === "tool_use") {
          if (block.name === STRUCTURED_OUTPUT_TOOL && typeof block.id === "string") structuredCalls.add(block.id);
          else events.push({ kind: "tool", name: String(block.name ?? "unknown").slice(0, 60) });
        }
      }
      return events;
    }
    if (value.type === "user" && blocks(value).some((block) => block.type === "tool_result" && !structuredCalls.has(block.tool_use_id)))
      return [{ kind: "tool", name: "tool_result" }];
    if (value.type === "result") {
      const events: AgentEvent[] = [];
      if (value.is_error || value.subtype !== "success") {
        const detail = typeof value.result === "string" && value.result ? value.result : Array.isArray(value.errors) ? value.errors.join("；") : "";
        const retryable = (value.is_error === true || value.terminal_reason === "api_error") && oauthRefreshRace.test(detail);
        events.push({
          kind: "error",
          terminal: true,
          message: (detail || `Claude Code 工作回合失敗（${String(value.subtype ?? "unknown")}）。`).slice(0, 4000),
          ...(retryable ? { retryable: true } : {}),
        });
        return events;
      }
      const models = value.modelUsage && typeof value.modelUsage === "object" ? Object.keys(value.modelUsage).filter(isModelId).slice(0, 20) : [];
      if (models.length) events.push({ kind: "usage-by-model", models });
      if (value.usage && typeof value.usage === "object") {
        const usage: Record<string, number> = {};
        for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
          if (finite(value.usage[key]) && value.usage[key] >= 0) usage[key] = value.usage[key];
        if (Object.keys(usage).length) events.push({ kind: "usage", usage });
      }
      const text = value.structured_output !== undefined ? JSON.stringify(value.structured_output) : String(value.result ?? "");
      if (text) events.push({ kind: "final", text });
      return events;
    }
    return [];
  };
}

/**
 * Records what Claude Code reported into execution.reported. Returns true when
 * the main model is new.
 */
export function applyReportedModel(execution: ModelExecution, item: AgentEvent): boolean {
  if (item.kind === "session") {
    const changed = execution.reported?.model !== item.model;
    execution.reported = { ...execution.reported, model: item.model, ...(item.cliVersion ? { cliVersion: item.cliVersion } : {}) };
    return changed;
  }
  if (item.kind === "usage-by-model" && execution.reported) {
    execution.reported.modelsUsed = [...new Set([...(execution.reported.modelsUsed ?? []), ...item.models])].slice(0, 20);
  }
  return false;
}

/** Waits before the second and third attempt of a turn that lost the OAuth refresh race. */
export const transientRetryDelays: readonly number[] = [15_000, 45_000];

export type TransientSleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface TransientRetryOptions {
  signal: AbortSignal;
  /** Receives the Traditional Chinese notice before each wait. */
  onRetry?: (notice: string) => void;
  /** Test seam; the default waits for real and rejects with the 409 cancellation on abort. */
  sleep?: TransientSleep;
}

const waitFor: TransientSleep = async (ms, signal) => {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    throw new AppError(409, "工作已取消。");
  }
};

/**
 * bell-pr's retryTransientAuth: runs one CLI invocation and repeats it while it
 * ends with a retryable terminal error, up to two more times. Every attempt is
 * a separate invocation: the caller acquires and releases its process slot
 * inside attempt(), so nobody is blocked during the wait.
 */
export async function retryTransientAuth<T extends { retryable?: boolean }>(
  attempt: () => Promise<T>,
  options: TransientRetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? waitFor;
  const total = transientRetryDelays.length + 1;
  for (let index = 0; ; index++) {
    const result = await attempt();
    const ms = transientRetryDelays[index];
    if (!result.retryable || ms === undefined || options.signal.aborted) return result;
    options.onRetry?.(`Claude Code 正在更新登入憑證（其他行程持有更新鎖），${Math.round(ms / 1000)} 秒後重試（第 ${index + 2}/${total} 次）。`);
    await sleep(ms, options.signal);
    if (options.signal.aborted) throw new AppError(409, "工作已取消。");
  }
}
