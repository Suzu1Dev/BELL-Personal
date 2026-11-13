import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiConnectionMethod } from "../../shared/ai-connections.js";
import type { AiRuntimeErrorDetail } from "../../shared/api.js";
import { reasoningEfforts, type ModelCatalog, type ModelOption, type ReasoningEffort } from "../../shared/models.js";
import { AppError } from "../errors.js";
import { codexEnvironment } from "./process.js";
export type { AiRuntimeErrorDetail };

/**
 * Codex fallback, ported from bell-explain's codex.ts: `codex app-server` over
 * stdio with every tool feature switched off before startup, a read-only
 * sandbox without network, and checks that the thread really uses the
 * requested model and isolation. Not `codex exec`: it cannot turn off its shell.
 * One accepted exception (review of 2026-11-09): the OpenAI key check in
 * connections.ts runs one `codex exec` turn with a fixed prompt and no
 * untrusted input, in a read-only sandbox and a throwaway CODEX_HOME. It
 * costs one short turn on the user's key and needs no HTTP client.
 * The answer is plain text that must be one JSON object; the caller validates it.
 */
interface RpcNotification { method: string; params?: Record<string, unknown>; }
export interface CodexRpc {
  cwd: string;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  subscribe(listener: (event: RpcNotification) => void, onError: (error: Error) => void): () => void;
  close(): Promise<void>;
}
/**
 * How one app-server starts. Without a launch it uses the CLI's own login
 * (CODEX_HOME or ~/.codex), as always; a saved OpenAI key comes as a launch
 * from connection-runtime.ts: its environment (with the key) is built right
 * before the spawn, and its config home is removed when the connection closes.
 */
export interface CodexLaunch {
  spawn(): Promise<{ env: NodeJS.ProcessEnv; cleanup(): Promise<void> }>;
  /** -c overrides appended to codexArguments (constants). */
  config: readonly string[];
  /** thread/start modelProvider. */
  modelProvider: string;
  /** The key is the credential: account/read reports no account and that is expected. */
  apiKey: boolean;
}
export type CodexRpcFactory = (signal: AbortSignal, launch?: CodexLaunch) => Promise<CodexRpc>;
interface RuntimeModel {
  model: string; displayName: string; description: string; hidden?: boolean; isDefault?: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  availableAccessPrograms?: { cyber?: string[] } | null;
}
interface Account { account?: { type: string } | null; requiresOpenaiAuth: boolean; }
interface ModelPage { data: RuntimeModel[]; nextCursor?: string | null; }
interface EffectiveConfig { config: { mcp_servers?: Record<string, unknown> }; }

// These settings apply before startup, so hooks, plugins and tools cannot start
// while examining untrusted mail. Codex keeps its own login; BELL never reads it.
const disabledFeatures = [
  "shell_tool", "unified_exec", "code_mode", "code_mode_host", "apps", "plugins", "hooks",
  "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external", "computer_use",
  "image_generation", "view_image", "workspace_dependencies", "goals", "sleep_tool",
  "memories", "skill_search", "tool_suggest", "remote_plugin", "request_permissions_tool",
];
export const codexArguments = [
  "app-server", "--listen", "stdio://",
  "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
  "-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false",
  "-c", "features.skip_host_skill_discovery=true", "-c", "allow_login_shell=false",
  "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"',
  "-c", "include_apps_instructions=false", "-c", "include_collaboration_mode_instructions=false",
  ...disabledFeatures.flatMap((feature) => ["-c", `features.${feature}=false`]),
];

class StdioRpc implements CodexRpc {
  private id = 0;
  private buffer = "";
  private closed = false;
  private failure?: Error;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<{ event: (event: RpcNotification) => void; error: (error: Error) => void }>();
  private readonly abort: () => void;
  constructor(private child: ChildProcessWithoutNullStreams, public cwd: string, private signal: AbortSignal, private cleanup: () => Promise<void> = async () => {}) {
    this.abort = () => this.fail(signal.reason instanceof Error ? signal.reason : new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", this.abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stdin.on("error", () => this.fail(new AppError(502, "Codex 輸入連線已關閉。")));
    child.stdout.on("error", () => this.fail(new AppError(502, "Codex 輸出連線已關閉。")));
    // stderr may contain paths or server diagnostics. Drain, never expose it.
    child.stderr.resume();
    child.on("error", () => this.fail(new AppError(503, "無法啟動 Codex CLI。請安裝 Codex 並在伺服器執行 codex login。")));
    child.on("exit", () => { if (!this.closed) this.fail(new AppError(502, "Codex 連線已中斷，請重試。")); });
    if (signal.aborted) this.abort();
  }
  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener.error(error);
    this.child.kill("SIGTERM");
  }
  private receive(chunk: string): void {
    if (this.closed || this.failure) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 2_000_000) { this.fail(new AppError(502, "Codex 回覆過大。")); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { code?: number } };
      try { message = JSON.parse(line); } catch { this.fail(new AppError(502, "Codex 通訊格式不正確。")); return; }
      // No approval, interactive input, or dynamic tool request is ever accepted.
      if (message.method && message.id !== undefined) {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "BELL is a text-only client; tool actions are disabled." } }) + "\n");
        this.fail(new AppError(502, "Codex 嘗試呼叫工具，工作已停止。")); return;
      }
      if (message.id !== undefined) {
        const item = this.pending.get(message.id); if (!item) continue;
        clearTimeout(item.timer); this.pending.delete(message.id);
        if (message.error) item.reject(new AppError(502, "Codex 拒絕本次請求。請確認模型權限與思考強度，並檢查 Codex 登入狀態。"));
        else item.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener.event({ method: message.method, params: message.params });
      }
    }
  }
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new AppError(502, "Codex 連線已關閉。"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError(504, "Codex 連線逾時。")); }, 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => { if (error) this.fail(new AppError(502, "無法寫入 Codex 連線。")); });
    });
  }
  subscribe(event: (event: RpcNotification) => void, error: (error: Error) => void): () => void {
    const listener = { event, error }; this.listeners.add(listener);
    if (this.failure) queueMicrotask(() => error(this.failure!));
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    this.signal.removeEventListener("abort", this.abort);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new AppError(502, "Codex 連線已關閉。")); }
    this.pending.clear(); this.listeners.clear();
    const child = this.child;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 1500);
        child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
      });
    }
    await rm(this.cwd, { recursive: true, force: true });
    await this.cleanup().catch(() => undefined);
  }
}

export function codexRpcFactory(path = "codex"): CodexRpcFactory {
  return async (signal, launch) => {
    signal.throwIfAborted();
    const prepared = launch ? await launch.spawn() : { env: codexEnvironment(), cleanup: async () => {} };
    let cwd: string;
    let child: ChildProcessWithoutNullStreams;
    try {
      cwd = await mkdtemp(join(tmpdir(), "bell-personal-codex-"));
      child = spawn(path, [...codexArguments, ...(launch?.config ?? [])], { cwd, env: prepared.env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      await prepared.cleanup().catch(() => undefined);
      throw error;
    }
    const rpc = new StdioRpc(child, cwd, signal, prepared.cleanup);
    try {
      await rpc.request("initialize", { clientInfo: { name: "bell_personal", title: "BELL Personal", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      return rpc;
    } catch (error) { await rpc.close(); throw error; }
  };
}

const knownEfforts = new Set<string>(reasoningEfforts);
export function normalizeCodexModel(model: RuntimeModel): ModelOption {
  const efforts = [...new Set(model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter((id) => knownEfforts.has(id)))] as ReasoningEffort[];
  return {
    id: model.model,
    name: model.displayName || model.model,
    description: model.description || "",
    isDefault: !!model.isDefault,
    reasoningEfforts: efforts,
    ...(efforts.includes(model.defaultReasoningEffort as ReasoningEffort) ? { defaultReasoningEffort: model.defaultReasoningEffort as ReasoningEffort } : {}),
  };
}

/** Account and model list through app-server; never starts a thread. */
export async function discoverCodex(factory: CodexRpcFactory, signal: AbortSignal, launch?: CodexLaunch): Promise<ModelCatalog> {
  const rpc = await factory(signal, launch);
  try {
    const account = await rpc.request<Account>("account/read", {});
    if (!account.account && !launch?.apiKey) return { source: "codex", models: [], error: "尚未登入 Codex。請在伺服器終端機執行 codex login，完成後重新整理。" };
    const models: RuntimeModel[] = []; let cursor: string | undefined;
    do {
      const page = await rpc.request<ModelPage>("model/list", { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) });
      models.push(...page.data); cursor = page.nextCursor || undefined;
      if (models.length > 500) throw new AppError(502, "Codex 模型清單超過限制。");
    } while (cursor);
    // Specialized access-program-only models need a separate explicit workflow.
    const visible = models.filter((model) => !model.hidden && (!model.availableAccessPrograms?.cyber?.length || model.availableAccessPrograms.cyber.includes("standard")));
    return { source: "codex", models: visible.map(normalizeCodexModel), ...(visible.length ? {} : { error: "Codex 尚未回傳可用的模型。" }) };
  } finally { await rpc.close(); }
}

function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("這次工作已取消。", "AbortError");
}
function withSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(cancellationReason(signal)); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancellationReason(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
export function runtimeRefusal(message: string, detail: AiRuntimeErrorDetail): AppError {
  return new AppError(503, message, detail);
}

export interface TurnFailure { codexErrorInfo?: string | Record<string, unknown> | null; message?: string; }
/**
 * A failed turn as a fixed zh-TW message. The notification's own text is never
 * used: with an API key it quotes part of the key ("Incorrect API key
 * provided: sk-…"). A 401 arrives either as `unauthorized` or as a stream or
 * HTTP failure carrying httpStatusCode 401 (codex-cli 0.167).
 */
export function turnFailure(role: string, error?: TurnFailure, status?: string, apiKey = false, method?: AiConnectionMethod | null): AppError {
  const info = error?.codexErrorInfo;
  const code = typeof info === "string" ? info : info && Object.keys(info)[0];
  const detail = info && typeof info === "object" && code ? info[code] : undefined;
  const httpStatus = detail && typeof detail === "object" ? Number((detail as { httpStatusCode?: unknown }).httpStatusCode) : undefined;
  if (code === "unauthorized" || httpStatus === 401 || httpStatus === 403) {
    return apiKey
      ? runtimeRefusal(
          `${role}未完成：OpenAI 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。`,
          { code: "ai_key_invalid", provider: "openai", ...(method ? { method } : {}) },
        )
      : runtimeRefusal(
          `${role}未完成：Codex 授權已失效，請在伺服器重新執行 codex login。`,
          { code: "ai_auth_expired", provider: "codex", ...(method ? { method } : {}) },
        );
  }
  if (code === "usageLimitExceeded" || code === "sessionBudgetExceeded")
    return new AppError(429, apiKey ? `${role}未完成：OpenAI 帳戶額度不足或已達上限，請到 OpenAI 平台查看用量。` : `${role}未完成：Codex 帳號可用額度已達上限，請查看 Codex 用量。`);
  if (code === "rateLimitExceeded" || code === "serverOverloaded" || httpStatus === 429)
    return new AppError(429, apiKey ? `${role}未完成：OpenAI 暫時限制了請求（速率或帳戶額度），請稍後重試或到 OpenAI 平台查看用量。` : `${role}未完成：Codex 暫時受到速率或服務容量限制，請稍後重試。`);
  if (code === "contextWindowExceeded") return new AppError(413, `${role}未完成：資料超過模型可接受的大小。`);
  if (code && ["responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts", "httpConnectionFailed"].includes(code))
    return new AppError(502, `${role}未完成：Codex 上游連線中斷或重試失敗。`);
  return new AppError(502, `${role}${status === "interrupted" ? "被 Codex 中斷" : "未完成"}：沒有收到完整回覆。`);
}

export interface CodexTurn {
  role: string;
  model?: string;
  effort?: ReasoningEffort;
  /** Trust boundary (cliBoundary). */
  baseInstructions: string;
  /** Task instructions, including the JSON schema text. */
  developerInstructions: string;
  /** The untrusted data, as JSON text. */
  input: string;
  /** turn/start outputSchema: constrains the final message (strict-mode subset; see strictSchemaFor). */
  outputSchema?: Record<string, unknown>;
  signal: AbortSignal;
  onActivity?: (phase: "connecting" | "thinking" | "writing", outputChars: number) => void;
  /** A saved key and BELL's own config home (connection-runtime.ts); omitted: the CLI's own login. */
  launch?: CodexLaunch;
  /** Active AI connection method for structured 503 runtime refusal details; omitted or null when none is selected. */
  method?: AiConnectionMethod | null;
}

/** One ephemeral, tool-less thread; resolves with the final message text. */
export async function runCodexTurn(factory: CodexRpcFactory, turn: CodexTurn): Promise<string> {
  const { role, signal } = turn;
  signal.throwIfAborted();
  let rpc: CodexRpc | undefined;
  let closed = false;
  let unsubscribe = () => {};
  let outputChars = 0;
  const activity = (phase: "connecting" | "thinking" | "writing") => { try { turn.onActivity?.(phase, outputChars); } catch { /* A listener cannot fail the turn. */ } };
  const close = async () => { if (rpc && !closed) { closed = true; await rpc.close(); } };
  activity("connecting");
  try {
    // Race every phase against our own signal; a late factory result is still closed.
    const acquiring = factory(signal, turn.launch).then(async (client) => {
      rpc = client;
      if (signal.aborted) { await close(); throw cancellationReason(signal); }
      return client;
    });
    const client = await withSignal(acquiring, signal);
    const request = <T>(method: string, params: unknown) => withSignal(client.request<T>(method, params), signal);
    const effective = await request<EffectiveConfig>("config/read", { includeLayers: false });
    const config: Record<string, unknown> = { ...(turn.effort ? { model_reasoning_effort: turn.effort } : {}), developer_instructions: "", web_search: "disabled", project_doc_max_bytes: 0 };
    for (const name of Object.keys(effective.config.mcp_servers || {})) config[`mcp_servers.${name}.enabled`] = false;
    const thread = await request<{ thread: { id: string }; model: string; reasoningEffort?: string | null; sandbox: { type: string; networkAccess?: boolean }; instructionSources?: string[] }>("thread/start", {
      cwd: client.cwd, ...(turn.model ? { model: turn.model } : {}), modelProvider: turn.launch?.modelProvider ?? "openai", ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      environments: [], runtimeWorkspaceRoots: [], dynamicTools: [], selectedCapabilityRoots: [],
      baseInstructions: turn.baseInstructions, developerInstructions: turn.developerInstructions, config,
      allowProviderModelFallback: false,
    });
    if ((turn.model && thread.model !== turn.model) || (turn.effort && thread.reasoningEffort && thread.reasoningEffort !== turn.effort)
      || thread.sandbox.type !== "readOnly" || thread.sandbox.networkAccess === true || thread.instructionSources?.length)
      throw new AppError(502, "Codex 未套用指定模型或隔離設定，工作已停止。");
    const messages = new Map<string, string>();
    let rejectCompletion: (error: Error) => void = () => {};
    const completion = new Promise<string>((resolve, reject) => {
      rejectCompletion = reject;
      unsubscribe = client.subscribe((event) => {
        const params = event.params;
        if (params?.threadId !== thread.thread.id) return;
        const item = params.item as { id?: string; type?: string; text?: string; phase?: string } | undefined;
        if (event.method === "model/rerouted" && turn.model && params.toModel !== turn.model) { reject(new AppError(502, `${role}收到 Codex 改用其他模型的通知，已停止本次工作。`)); return; }
        if (event.method === "error") {
          if (params.willRetry === true) { activity("connecting"); return; }
          reject(turnFailure(role, params.error as TurnFailure | undefined, undefined, turn.launch?.apiKey, turn.method)); return;
        }
        if (event.method === "turn/started") activity("thinking");
        if (event.method === "item/started" && item?.type && !["agentMessage", "userMessage", "reasoning", "contextCompaction"].includes(item.type)) {
          reject(new AppError(502, "Codex 嘗試執行工具，工作已停止。")); return;
        }
        if (event.method === "item/agentMessage/delta" && typeof params.delta === "string") { outputChars += params.delta.length; activity("writing"); }
        if (event.method === "item/completed" && item?.type === "agentMessage" && item.text) {
          if (item.text.length > 700_000) { reject(new AppError(502, "Codex 回覆過大。")); return; }
          if (!item.phase || item.phase === "final_answer") messages.set(item.id || String(messages.size), item.text);
        }
        if (event.method === "turn/completed") {
          const status = params.turn as { status?: string; error?: TurnFailure } | undefined;
          if (status?.status !== "completed") { reject(turnFailure(role, status?.error, status?.status, turn.launch?.apiKey, turn.method)); return; }
          const final = [...messages.values()].at(-1);
          if (!final) { reject(new AppError(502, `${role}已結束，但 Codex 沒有回傳內容。`)); return; }
          resolve(final);
        }
      }, reject);
    });
    void completion.catch(() => {});
    try {
      await request("turn/start", {
        threadId: thread.thread.id, input: [{ type: "text", text: turn.input }],
        ...(turn.model ? { model: turn.model } : {}), ...(turn.effort ? { effort: turn.effort } : {}),
        ...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
    } catch (error) { rejectCompletion(error instanceof Error ? error : new Error("Codex request failed")); }
    return await withSignal(completion, signal);
  } finally { unsubscribe(); await close(); }
}
