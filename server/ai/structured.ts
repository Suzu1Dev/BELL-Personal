import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MAX_MODEL_INPUT_CHARS, MAX_MODEL_OUTPUT_BYTES } from "../../shared/limits.js";
import type { ModelExecution, ProviderSettings } from "../../shared/models.js";
import { AppError, schemaFailure, TransientAgentError } from "../errors.js";
import { logEvent } from "../log.js";
import { cliBoundary, dataRule, outputRule } from "../prompts/boundary.js";
import { redact, redactCliOutput, secretInPatch } from "../secrets/redact.js";
import { claudeAccount, codexAccount } from "../status.js";
import { agentCommand, agentEventReader, agentLabel, agentLoginCheck, applyReportedModel, retryTransientAuth, type TransientSleep } from "./agent-cli.js";
import type { AgentPriority, AgentSlots } from "./agent-slots.js";
import { agentTimeoutMs, withAgentTimeoutHint, type AgentTimeoutKind } from "./agent-timeouts.js";
import { runCodexTurn, runtimeRefusal, type AiRuntimeErrorDetail, type CodexRpcFactory } from "./codex.js";
export type { AiRuntimeErrorDetail };
import { codexLaunch, keyNotReady, keyProviderOf, keyRejectedMessage, loginError, type AiConnectionPlan, type AiConnectionRuntime, type AiSpawn } from "./connection-runtime.js";
import { resolveModelExecution } from "./models.js";
import { claudeEnvironment, codexEnvironment, command as runCommand, type CommandResult, type CommandRunner } from "./process.js";
import type { ProviderService } from "./provider-settings.js";

export type JsonSchema = Record<string, unknown>;

/** bell-pr's helper: every property required, nothing extra. Strict-compatible with Claude and Codex. */
export const objectSchema = (properties: Record<string, unknown>): JsonSchema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The JSON Schema for --json-schema derived from a zod schema (objects come out with additionalProperties:false). */
export function jsonSchemaFor(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as JsonSchema;
  return rest;
}

/** Keywords kept in a strict-mode output schema; bounds such as maxLength and pattern stay with zod, the final check. */
const STRICT_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "description", "$defs", "$ref"]);

/**
 * The OpenAI strict-mode subset of a JSON schema, for Codex's turn/start
 * outputSchema: structure, types and enums only. Undefined when the schema
 * cannot be strict (an object with an optional property or without
 * additionalProperties:false), so the turn runs without it rather than fail.
 */
export function strictSchemaFor(schema: JsonSchema): JsonSchema | undefined {
  let strict = true;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if (record.type === "object" || record.properties) {
      const keys = Object.keys((record.properties ?? {}) as Record<string, unknown>);
      const required = Array.isArray(record.required) ? record.required : [];
      if (record.additionalProperties !== false || keys.some((key) => !required.includes(key))) strict = false;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!STRICT_KEYWORDS.has(key)) continue;
      out[key] = key === "properties" || key === "$defs"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, walk(child)]))
        : walk(value);
    }
    return out;
  };
  const result = walk(schema) as JsonSchema;
  return strict ? result : undefined;
}

/** Observation metadata only: never model text, partial JSON or account details. */
export interface AiProgress {
  phase: "waiting" | "connecting" | "thinking" | "writing";
  /** A zh-TW line worth showing now (rate limit, retry). */
  notice?: string;
}

export interface StructuredRequest<T> {
  /** zh-TW label used in progress, errors and the gen.call log line, e.g. 「每日摘要」. */
  role: string;
  /** Strict zod schema the answer must pass. */
  schema: z.ZodType<T>;
  /** Sent as --json-schema; defaults to jsonSchemaFor(schema). */
  jsonSchema?: JsonSchema;
  /** Task instructions (what to produce and how). Written by code, never by users. */
  prompt: string;
  /** Untrusted data, sent as JSON after the boundary. Redacted before it leaves the process. */
  data: unknown;
  signal: AbortSignal;
  /** Deadline class; default "standard". */
  timeoutKind?: AgentTimeoutKind;
  /**
   * Overrides the deadline class: milliseconds per attempt, counted from when
   * the CLI starts (after the agent slot is granted), so time spent queued
   * behind other model work does not count.
   */
  timeoutMs?: number;
  /** For the agent slot: "interactive" › "soon" › "background" (the default); see AgentSlots. */
  priority?: AgentPriority;
  onProgress?: (progress: AiProgress) => void;
  /** Overrides the saved provider settings for this call only. */
  settings?: Partial<ProviderSettings>;
}

export interface StructuredResult<T> {
  value: T;
  /** Record it on whatever is persisted from `value` (suggestions, briefs). */
  execution: ModelExecution;
  ms: number;
  usage?: Record<string, number>;
}

export interface AiRunnerOptions {
  provider: ProviderService;
  slots: AgentSlots;
  /** Runs use <dataDir>/ai/run-* as their working directory (0700, removed afterwards). */
  dataDir: string;
  timeoutScale?: number;
  claudePath?: string;
  codexPath?: string;
  /** The active connection (設定 › 連接 AI); without it every job uses the CLI's own login. */
  connections?: AiConnectionRuntime;
  /** Test seams. */
  command?: CommandRunner;
  codexFactory?: CodexRpcFactory;
  sleep?: TransientSleep;
}

/**
 * A successful login check is trusted this long. A login that expires inside
 * the window still fails safely: the CLI's own result event maps to the same
 * 503 (claudeFailure), it just costs one model process instead of a status check.
 */
const LOGIN_CACHE_MS = 10 * 60_000;

/**
 * Untrusted data as JSON text for the prompt: redacted, and with every `<`
 * and `>` escaped (still valid JSON, read back to the same values), so text
 * like `</data>` in a mail subject cannot close the data block early.
 */
export function promptData(data: unknown): { text: string; redacted: boolean } {
  const json = JSON.stringify(data ?? null);
  const safe = redact(json);
  return { text: safe.replace(/</g, "\\u003c").replace(/>/g, "\\u003e"), redacted: safe !== json };
}

/**
 * The single entry point features use for model work (product rule: the result
 * is a suggestion, never an action). One call = one tool-less CLI turn:
 *  1. resolve provider/model/effort from settings and check the CLI login (503 if not);
 *  2. build the prompt: trust boundary + rules + role + task + redacted JSON data;
 *  3. run under an agent slot with a deadline, retrying a lost OAuth refresh race;
 *  4. accept only a JSON object ≤ 120 kB that passes the strict zod schema and
 *     carries no secret shapes.
 */
export class AiRunner {
  private readonly command: CommandRunner;
  private readonly loginOk = new Map<string, number>();

  constructor(private readonly options: AiRunnerOptions) {
    this.command = options.command ?? runCommand;
    if (options.connections) {
      const connections = options.connections;
      options.provider.setReadyCheck(async (cli, signal) => {
        const plan = await connections.plan(cli);
        if (plan.method) await this.checkLogin(plan, signal);
      });
    }
  }

  async runStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const { role, signal } = request;
    signal.throwIfAborted();
    const base = this.options.provider.settings();
    // With an active connection (設定 › 連接 AI) every job runs on its CLI: an override for the other CLI is dropped.
    const override = this.options.connections?.active() && request.settings?.provider && request.settings.provider !== base.provider ? undefined : request.settings;
    const settings = { ...base, ...override } as ProviderSettings;
    let execution: ModelExecution | undefined;
    let plan: AiConnectionPlan | undefined;
    let usage: Record<string, number> | undefined;
    let timeoutMs = 0;
    const done = (outcome: string) =>
      logEvent("gen.call", { provider: execution?.provider ?? settings.provider, model: execution?.reported?.model ?? execution?.model ?? "default", effort: execution?.reasoningEffort ?? "default", role, ms: Date.now() - started, outcome, ...(usage ? { usage } : {}) });
    try {
      const { text: safeData, redacted } = promptData(request.data);
      if (redacted) logEvent("ai.input.redacted", { role });
      const schemaText = JSON.stringify(request.jsonSchema ?? jsonSchemaFor(request.schema));
      const instructions = [cliBoundary, outputRule, `任務角色：${role}`, request.prompt.trim(), dataRule].join("\n\n");
      if (instructions.length + safeData.length + schemaText.length > MAX_MODEL_INPUT_CHARS)
        throw new AppError(413, `${role}的資料量超過單次模型輸入上限，請縮小範圍後再試。`);
      // The connection and its login before the model list: a job that cannot run here never starts `codex app-server`
      // (with a key method and no key here, that would run in the shared CODEX_HOME on whatever login it holds).
      plan = this.options.connections ? await this.options.connections.plan(settings.provider) : { provider: settings.provider, method: null, home: "shared" };
      await this.checkLogin(plan, signal);
      const catalog = await this.options.provider.catalog(settings.provider, false, signal);
      // A catalog that could not load (Codex logged out, app-server down) is "not available", not a bad setting.
      if (catalog.error && !catalog.models.length) {
        throw new AppError(
          503,
          catalog.error,
          catalog.notReady ? { code: "ai_connection_not_ready", method: catalog.notReady.method, reason: catalog.notReady.reason } : undefined,
        );
      }
      execution = resolveModelExecution(settings, catalog);
      timeoutMs = request.timeoutMs ?? agentTimeoutMs(request.timeoutKind ?? "standard", execution, this.options.timeoutScale);
      const answer = execution.provider === "claude"
        ? await this.runClaude(request, execution, plan, `${instructions}\n\n<data>\n${safeData}\n</data>`, timeoutMs, (value) => { usage = value; })
        : await this.runCodex(request, execution, plan, instructions, schemaText, safeData, timeoutMs);
      const value = this.validate(request, answer);
      done("ok");
      return { value, execution, ms: Date.now() - started, ...(usage ? { usage } : {}) };
    } catch (error) {
      done(error instanceof AppError ? `error:${error.status}` : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? error.name : "error");
      // A run that found the CLI signed out (or unavailable) checks the login again next time.
      if (error instanceof AppError && error.status === 503) this.loginOk.clear();
      throw withAgentTimeoutHint(error, agentLabel(execution?.provider ?? settings.provider), timeoutMs);
    }
  }

  /** After 設定 › 連接 AI changed a login, a saved key or the active connection: check the CLI login again on the next job. */
  forgetLogins(): void {
    this.loginOk.clear();
  }

  /**
   * The CLI's own login: `claude auth status` / `codex login status`, trusted
   * for LOGIN_CACHE_MS after a success. A chosen connection also needs the
   * right kind of login (a ChatGPT/Claude plan, or the CLI's own API key), so
   * picking 「ChatGPT」 never bills an API key the CLI happens to hold. A key
   * saved in BELL needs no check here: the provider's answer to the first
   * request maps to its own 503. ProviderService runs it too, before the
   * Codex model list and a model save on a key connection without its key.
   */
  async checkLogin(plan: AiConnectionPlan, signal: AbortSignal): Promise<void> {
    if (plan.home === "bell") {
      // A saved key this server cannot open: no CLI starts (the key itself is read only at spawn time).
      if (plan.keyReason) throw keyNotReady(plan.method!, plan.keyReason);
      return;
    }
    const cacheKey = `${plan.provider}:${plan.method ?? ""}`;
    if ((this.loginOk.get(cacheKey) ?? 0) > Date.now()) return;
    const login = agentLoginCheck(plan.provider, plan.provider === "claude" ? this.options.claudePath : this.options.codexPath);
    let result: CommandResult;
    try {
      result = await this.command(login.executable, login.args, { timeoutMs: 10_000, maxBytes: 20_000, env: plan.provider === "claude" ? claudeEnvironment() : codexEnvironment(), signal });
    } catch (error) {
      signal.throwIfAborted();
      const refused = loginError(plan, undefined);
      if (plan.method && error instanceof AppError && error.status === 503) {
        throw new AppError(503, refused.message, { code: "ai_connection_not_ready", method: plan.method, reason: "cli_not_installed" });
      }
      throw refused;
    }
    if (plan.expect) {
      const found = (plan.provider === "claude" ? claudeAccount(result.stdout) : codexAccount(`${result.stdout}\n${result.stderr}`))?.kind;
      // A CLI that does not say how it is signed in counts as a plan, as on 設定 › 連接 AI.
      if ((found ?? "subscription") !== plan.expect) throw loginError(plan, found);
    }
    this.loginOk.set(cacheKey, Date.now() + LOGIN_CACHE_MS);
  }

  /** The environment for one CLI spawn: built here, right before it, so a saved key is read from the vault only now. */
  private async spawnFor(plan: AiConnectionPlan): Promise<AiSpawn> {
    if (this.options.connections) return this.options.connections.spawn(plan);
    return { env: plan.provider === "claude" ? claudeEnvironment() : codexEnvironment(), cleanup: async () => {} };
  }

  private async runClaude<T>(request: StructuredRequest<T>, execution: ModelExecution, plan: AiConnectionPlan, input: string, timeoutMs: number, onUsage: (usage: Record<string, number>) => void): Promise<string> {
    const { role, signal, onProgress } = request;
    const root = path.join(this.options.dataDir, "ai");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(path.join(root, "run-"));
    let spawned: AiSpawn | undefined;
    try {
      spawned = await this.spawnFor(plan);
      const { env } = spawned;
      const secrets = env.ANTHROPIC_API_KEY ? [env.ANTHROPIC_API_KEY] : [];
      const schemaPath = path.join(cwd, "response-schema.json");
      await writeFile(schemaPath, JSON.stringify(request.jsonSchema ?? jsonSchemaFor(request.schema)), { mode: 0o600 });
      const cli = await agentCommand(execution, { cwd, outputSchema: schemaPath, executable: this.options.claudePath });
      let answer = "";
      let failure: string | undefined;
      let isolation = false;
      let lastRetryable = false;
      await retryTransientAuth(async () => {
        answer = "";
        failure = undefined;
        let retryable = false;
        const read = agentEventReader({ secrets });
        const stop = new AbortController();
        const release = await this.options.slots.acquire(signal, { priority: request.priority });
        try {
          try { onProgress?.({ phase: "connecting" }); } catch { /* A listener cannot fail the run. */ }
          await this.command(cli.executable, cli.args, {
            input,
            cwd,
            env,
            secrets,
            signal: AbortSignal.any([signal, stop.signal]),
            timeoutMs,
            maxBytes: 1_000_000,
            onLine: (line, stream) => {
              if (stream !== "stdout") return;
              let event: unknown;
              try { event = JSON.parse(line); } catch { return; }
              for (const item of read(event)) {
                if (item.kind === "tool" || (item.kind === "error" && item.message.startsWith("isolation:"))) {
                  isolation = true;
                  stop.abort();
                } else if (item.kind === "error") {
                  failure = item.message;
                  retryable = item.retryable === true;
                } else if (item.kind === "message" || item.kind === "final") {
                  answer = item.text;
                  try { onProgress?.({ phase: "writing" }); } catch { /* ignore */ }
                } else if (item.kind === "notice") {
                  try { onProgress?.({ phase: "waiting", notice: item.message }); } catch { /* ignore */ }
                } else if (item.kind === "usage") onUsage(item.usage);
                else if (item.kind === "session") {
                  try { onProgress?.({ phase: "thinking" }); } catch { /* ignore */ }
                }
                applyReportedModel(execution, item);
              }
            },
          }).catch((error: unknown) => {
            if (isolation) throw new AppError(502, `${role}已停止：Claude Code 未套用隔離設定或嘗試使用工具。`);
            // A lost OAuth refresh race exits non-zero after its result event already marked it retryable.
            if (!retryable && !failure) throw cliFailure(role, error, secrets);
          });
        } finally {
          release();
        }
        lastRetryable = retryable;
        return { retryable };
      }, { signal, sleep: this.options.sleep, onRetry: (notice) => { try { onProgress?.({ phase: "waiting", notice }); } catch { /* ignore */ } } });
      if (isolation) throw new AppError(502, `${role}已停止：Claude Code 未套用隔離設定或嘗試使用工具。`);
      if (failure && lastRetryable) throw new TransientAgentError(`${role}未完成：Claude Code 正在更新登入憑證，請稍後再試。`);
      if (failure) throw claudeFailure(role, failure, plan);
      return answer;
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await spawned?.cleanup().catch(() => undefined);
    }
  }

  private async runCodex<T>(request: StructuredRequest<T>, execution: ModelExecution, plan: AiConnectionPlan, instructions: string, schemaText: string, data: string, timeoutMs: number): Promise<string> {
    const factory = this.options.codexFactory;
    if (!factory) throw new AppError(503, "這台伺服器尚未啟用 Codex。");
    const outputSchema = strictSchemaFor(JSON.parse(schemaText) as JsonSchema);
    const release = await this.options.slots.acquire(request.signal, { priority: request.priority });
    try {
      return await runCodexTurn(factory, {
        role: request.role,
        model: execution.model,
        effort: execution.reasoningEffort,
        baseInstructions: cliBoundary,
        developerInstructions: `${instructions.slice(cliBoundary.length).trim()}\n\nJSON schema：${schemaText}`,
        input: data,
        ...(outputSchema ? { outputSchema } : {}),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
        onActivity: (phase) => { try { request.onProgress?.({ phase }); } catch { /* ignore */ } },
        launch: codexLaunch(this.options.connections, plan),
        ...(plan.method ? { method: plan.method } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") throw new AppError(504, `${request.role}等待 Codex 回覆逾時。`);
      throw error;
    } finally {
      release();
    }
  }

  private validate<T>(request: StructuredRequest<T>, answer: string): T {
    const { role } = request;
    if (!answer) throw new AppError(502, `${role}沒有收到模型回覆，請稍後再試。`);
    if (Buffer.byteLength(answer) > MAX_MODEL_OUTPUT_BYTES) throw new AppError(502, `${role}的模型回覆過大，結果未儲存。`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.replace(/^\s*```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, ""));
    } catch {
      throw schemaFailure(role, `${role}的模型回覆不是有效的 JSON，結果未儲存。`, { issues: [{ path: [], code: "invalid_json" }] });
    }
    const result = request.schema.safeParse(parsed);
    if (!result.success) throw schemaFailure(role, `${role}的模型回覆不符合格式，結果未儲存。`, result.error);
    const serialized = JSON.stringify(result.data);
    if (secretInPatch(serialized) || redact(serialized) !== serialized)
      throw new AppError(422, `${role}的模型回覆疑似包含敏感內容，結果未儲存。`);
    return result.data;
  }
}

/**
 * command() failures of the Claude CLI (a non-zero exit without a result
 * event, a crash, output over the cap, a spawn failure) carry the executable
 * path and raw CLI output; the UI gets a fixed zh-TW message and the log a
 * short redacted tail. Cancellation (409) and timeouts (504) pass through.
 */
export function cliFailure(role: string, error: unknown, secrets: readonly string[] = []): unknown {
  if (error instanceof AppError && (error.status === 409 || error.status === 504)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  // stream-json lines on stdout can hold model text: log the tail only when it is plain CLI output,
  // with the run's own key and any shortened key echo masked.
  logEvent("ai.cli_failed", {
    role, status: error instanceof AppError ? error.status : null,
    ...(/"type"\s*:/.test(detail) ? {} : { detail: redactCliOutput(detail.replace(/^\S*claude\S*\s/, ""), secrets).slice(-200) }),
  });
  if (error instanceof AppError && error.status === 503) {
    const message = `${role}未完成：無法啟動 Claude Code，請確認伺服器已安裝 Claude Code 並執行 claude auth login。`;
    return error.detail ? new AppError(503, message, error.detail) : runtimeRefusal(message, { code: "ai_cli_unavailable", provider: "claude" });
  }
  return new AppError(502, `${role}未完成：Claude Code 沒有正常結束，請在伺服器執行 claude update 或檢查本機服務記錄。`);
}

/** Maps a terminal Claude Code error to an actionable zh-TW message; the raw text is never shown. */
export function claudeFailure(role: string, detail: string, plan?: AiConnectionPlan): AppError {
  const method = plan?.method ?? undefined;
  const keyProvider = plan?.home === "bell" ? keyProviderOf(plan.method) : undefined;
  if (keyProvider) {
    if (/invalid api key|x-api-key|authenticat|401|403/i.test(detail)) {
      return runtimeRefusal(keyRejectedMessage(role, keyProvider), {
        code: "ai_key_invalid",
        provider: keyProvider,
        ...(method ? { method } : {}),
      });
    }
    if (/credit balance|billing|quota|402/i.test(detail)) return new AppError(429, `${role}未完成：Anthropic 帳戶額度不足，請到 Anthropic 平台儲值或提高上限。`);
  }
  if (/not logged in|login|authenticat|oauth|401|403/i.test(detail)) {
    return runtimeRefusal(`${role}未完成：Claude Code 登入已失效，請在伺服器執行 claude auth login。`, {
      code: "ai_auth_expired",
      provider: "claude",
      ...(method ? { method } : {}),
    });
  }
  if (/rate.?limit|usage limit|quota|429|overloaded/i.test(detail)) return new AppError(429, `${role}未完成：Claude 帳號用量或速率已達上限，請稍後再試。`);
  if (/or newer is required|claude update/i.test(detail)) return new AppError(502, `${role}未完成：本機 Claude Code 版本過舊，請在伺服器執行 claude update。`);
  return new AppError(502, `${role}未完成：模型沒有完成回覆，請稍後再試。`);
}
