import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AI_CONNECTION_CLI, type AiConnectionMethod, type AiKeyProvider, type AiNotReadyReason, type AiSavedKey } from "../../shared/ai-connections.js";
import type { AgentProvider } from "../../shared/models.js";
import { AppError } from "../errors.js";
import type { Vault } from "../secrets/vault.js";
import type { CliAccount } from "../status.js";
import type { CodexLaunch } from "./codex.js";
import { claudeEnvironment, codexEnvironment } from "./process.js";

/**
 * Vault records for saved keys: {key, verifiedAt}. Read only at spawn time, and
 * by savedKeyInfo for a key saved before its metadata record existed; never by
 * a route otherwise.
 */
export const AI_KEY_VAULT: Record<AiKeyProvider, string> = { openai: "ai.key.openai", anthropic: "ai.key.anthropic" };
export interface StoredAiKey { key: string; verifiedAt: string }

/**
 * What the settings row shows for a saved key (AiSavedKey), in a record of its
 * own so listing the connections never opens the key. Written after the key
 * and removed before it changes (AiConnectionService.saveKey / deleteKey).
 */
export const AI_KEY_META_VAULT: Record<AiKeyProvider, string> = { openai: "ai.keymeta.openai", anthropic: "ai.keymeta.anthropic" };
export interface StoredAiKeyMeta { hint: string | null; verifiedAt: string }

const HINT_MASK = "\u2022".repeat(4);
/** "••••" and the last 4 characters; nothing for a key shorter than 8, where 4 characters would be half of it. */
export const keyHint = (key: string): string | null => (key.length < 8 ? null : `${HINT_MASK}${key.slice(-4)}`);
const isHint = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length === HINT_MASK.length + 4 && value.startsWith(HINT_MASK));
const isTimestamp = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * The saved key's provider, hint and last successful check, for a key whose
 * state is "saved". Its metadata record when there is a readable one; else a
 * key saved before metadata existed: the hint from the key itself and no
 * verifiedAt. Nothing is written here (a list racing a save must not write an
 * old key's hint).
 */
export async function savedKeyInfo(vault: Vault, provider: AiKeyProvider): Promise<AiSavedKey> {
  try {
    const meta = await vault.get<StoredAiKeyMeta>(AI_KEY_META_VAULT[provider]);
    if (meta && isHint(meta.hint) && isTimestamp(meta.verifiedAt)) return { provider, hint: meta.hint, verifiedAt: meta.verifiedAt };
  } catch { /* unreadable metadata: fall back to the key */ }
  try {
    const record = await vault.get<Partial<StoredAiKey>>(AI_KEY_VAULT[provider]);
    return { provider, hint: typeof record?.key === "string" ? keyHint(record.key) : null, verifiedAt: null };
  } catch {
    return { provider, hint: null, verifiedAt: null };
  }
}

/**
 * `codex app-server` ignores OPENAI_API_KEY and CODEX_API_KEY (codex-cli 0.167:
 * account/read stays null and the turn goes out without a bearer). A model
 * provider of BELL's own that names the variable it reads works for both
 * app-server and `codex exec`, so a saved OpenAI key reaches Codex through the
 * environment only: nothing is written to auth.json. These overrides are
 * constants; no request value reaches them.
 */
export const BELL_OPENAI_KEY_ENV = "BELL_OPENAI_API_KEY";
export const BELL_OPENAI_PROVIDER = "bell_openai";
export const BELL_OPENAI_PROVIDER_CONFIG: readonly string[] = [
  "-c", `model_providers.${BELL_OPENAI_PROVIDER}.name="OpenAI API key"`,
  "-c", `model_providers.${BELL_OPENAI_PROVIDER}.base_url="https://api.openai.com/v1"`,
  "-c", `model_providers.${BELL_OPENAI_PROVIDER}.env_key="${BELL_OPENAI_KEY_ENV}"`,
  "-c", `model_providers.${BELL_OPENAI_PROVIDER}.wire_api="responses"`,
  "-c", `model_provider="${BELL_OPENAI_PROVIDER}"`,
];

/**
 * A saved key's state on this server, read without opening it. Keys stay on
 * the server that saved them while `ai.connection` syncs, so another device
 * reads "missing" until the key is entered there too.
 */
export type SavedKeyState = "saved" | "missing" | "unreadable" | "vault_disabled";

export async function savedKeyState(vault: Vault, provider: AiKeyProvider): Promise<SavedKeyState> {
  if (!vault.enabled) return "vault_disabled";
  try {
    const sealed = await vault.sealedBy(AI_KEY_VAULT[provider]);
    return sealed === "known" ? "saved" : sealed === "missing" ? "missing" : "unreadable";
  } catch {
    // An unreadable secrets file: the key may be in it, so never treat it as "no key, use the CLI's own".
    return "unreadable";
  }
}

const KEY_PROVIDER: Partial<Record<AiConnectionMethod, AiKeyProvider>> = { "openai-key": "openai", "anthropic-key": "anthropic" };
export const keyProviderOf = (method: AiConnectionMethod | null): AiKeyProvider | undefined => (method ? KEY_PROVIDER[method] : undefined);

/** Why a key method cannot use a key saved in BELL on this server (the key reasons of AiNotReadyReason). */
export type KeyNotReadyReason = Extract<AiNotReadyReason, "key_missing" | "key_unreadable" | "vault_disabled">;

/**
 * How one AI job reaches its model.
 * - home "shared": the CLI's own login and config home (~/.codex, ~/.claude),
 *   exactly as before. `expect` is the kind of login the chosen method needs;
 *   none when no connection was chosen (whatever the CLI is signed in with).
 * - home "bell": a key saved in BELL, read from the vault at spawn time into
 *   the process environment, with a throwaway config home under
 *   <dataDir>/ai that is removed afterwards. The shared login is never read,
 *   written or logged out.
 * `keyReason`: a key method with no usable key saved here. With home "shared"
 * (key_missing, vault_disabled) the CLI's own API-key login may still run the
 * job, and the reason is the 503 when it has none; with home "bell"
 * (key_unreadable) the job fails before any CLI starts.
 */
export interface AiConnectionPlan {
  provider: AgentProvider;
  method: AiConnectionMethod | null;
  home: "shared" | "bell";
  expect?: CliAccount["kind"];
  keyReason?: KeyNotReadyReason;
}

/** The process environment for one spawn, and the cleanup of its config home. */
export interface AiSpawn {
  env: NodeJS.ProcessEnv;
  /** The throwaway config home ("bell" plans only). */
  home?: string;
  cleanup(): Promise<void>;
}

export interface AiConnectionRuntimeOptions {
  vault: Vault;
  /** The saved active connection (app setting `ai.connection`). */
  active: () => AiConnectionMethod | null;
  /** Parent of the throwaway config homes: <dataDir>/ai. */
  root: string;
}

/** The environment a CLI gets with a saved key and a BELL-owned config home; inherited keys and homes are dropped. */
export function keyEnvironment(provider: AiKeyProvider, home: string, key: string): NodeJS.ProcessEnv {
  if (provider === "anthropic") {
    const { CLAUDE_CONFIG_DIR: _shared, ...base } = claudeEnvironment();
    return { ...base, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: key };
  }
  const { CODEX_HOME: _shared, OPENAI_API_KEY: _openai, CODEX_API_KEY: _codex, ...base } = codexEnvironment();
  return { ...base, CODEX_HOME: home, [BELL_OPENAI_KEY_ENV]: key };
}

const sharedEnvironment = (provider: AgentProvider) => (provider === "claude" ? claudeEnvironment() : codexEnvironment());

/**
 * Turns the active connection (設定 › 連接 AI) into what a job runs with. The
 * job runner asks for a plan once per job, then for the environment right
 * before each spawn.
 */
export class AiConnectionRuntime {
  constructor(private readonly options: AiConnectionRuntimeOptions) {}

  active(): AiConnectionMethod | null {
    return this.options.active();
  }

  /** The plan for a job on `provider`: the active connection when it runs through that CLI, else the CLI's own login. */
  async plan(provider: AgentProvider): Promise<AiConnectionPlan> {
    const active = this.options.active();
    const method = active && AI_CONNECTION_CLI[active] === provider ? active : null;
    if (!method) return { provider, method: null, home: "shared" };
    const keyProvider = keyProviderOf(method);
    if (!keyProvider) return { provider, method, home: "shared", expect: "subscription" };
    const saved = await savedKeyState(this.options.vault, keyProvider);
    if (saved === "saved") return { provider, method, home: "bell" };
    // A key this server cannot open stays on the BELL path, so the job answers 503 instead of quietly using another login.
    if (saved === "unreadable") return { provider, method, home: "bell", keyReason: "key_unreadable" };
    // No key saved in BELL: the CLI's own API-key login (設定頁 shows it as detected, source cli), never a plan login.
    return { provider, method, home: "shared", expect: "api_key", keyReason: saved === "vault_disabled" ? "vault_disabled" : "key_missing" };
  }

  /** Reads the key from the vault (never earlier) and makes the config home for one spawn. */
  async spawn(plan: AiConnectionPlan): Promise<AiSpawn> {
    if (plan.home === "shared") return { env: sharedEnvironment(plan.provider), cleanup: async () => {} };
    const provider = keyProviderOf(plan.method)!;
    const key = await this.key(plan.method!, provider);
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(this.options.root, `${plan.provider}-home-`));
    return { env: keyEnvironment(provider, home, key), home, cleanup: () => rm(home, { recursive: true, force: true }) };
  }

  private async key(method: AiConnectionMethod, provider: AiKeyProvider): Promise<string> {
    const { vault } = this.options;
    if (!vault.enabled) throw keyNotReady(method, "vault_disabled");
    let record: StoredAiKey | undefined;
    try {
      record = await vault.get<StoredAiKey>(AI_KEY_VAULT[provider]);
    } catch {
      // Another master key, or a secrets file that does not parse: the key may be in it, so never "not saved".
      throw keyNotReady(method, "key_unreadable");
    }
    if (!record) throw keyNotReady(method, "key_missing");
    if (typeof record.key !== "string" || !record.key) throw keyNotReady(method, "key_unreadable");
    return record.key;
  }
}

const KEY_NAMES: Record<AiKeyProvider, string> = { openai: "OpenAI", anthropic: "Anthropic" };
const CLI_NAMES: Record<AgentProvider, string> = { claude: "Claude Code", codex: "Codex" };

export function missingKeyMessage(provider: AiKeyProvider): string {
  return `目前選用的 AI 連線是 ${KEY_NAMES[provider]} API 金鑰，但這台伺服器還沒有保存金鑰。請到 設定 › 連接 AI 輸入金鑰，或改選其他連線。`;
}

export function unreadableKeyMessage(provider: AiKeyProvider): string {
  return `目前選用的 AI 連線是 ${KEY_NAMES[provider]} API 金鑰，但這台伺服器的主金鑰解不開已保存的金鑰。請到 設定 › 連接 AI 重新輸入金鑰，或改選其他連線。`;
}

export function vaultDisabledKeyMessage(provider: AiKeyProvider): string {
  return `目前選用的 AI 連線是 ${KEY_NAMES[provider]} API 金鑰，但這台伺服器尚未設定主金鑰，無法保存金鑰。請依部署說明設定後重新啟動服務，或改選其他連線。`;
}

export function keyNotReadyMessage(provider: AiKeyProvider, reason: KeyNotReadyReason): string {
  return reason === "key_unreadable" ? unreadableKeyMessage(provider) : reason === "vault_disabled" ? vaultDisabledKeyMessage(provider) : missingKeyMessage(provider);
}

/** 503 for a key method that cannot run here, with the reason 設定 › 連接 AI shows (`ai_connection_not_ready`). */
export function keyNotReady(method: AiConnectionMethod, reason: KeyNotReadyReason): AppError {
  return new AppError(503, keyNotReadyMessage(keyProviderOf(method)!, reason), { code: "ai_connection_not_ready", method, reason });
}

/** 503 for a shared login that is missing or of the wrong kind for the chosen connection. */
export function loginError(plan: AiConnectionPlan, found: CliAccount["kind"] | undefined): AppError {
  if (plan.expect === "api_key") return keyNotReady(plan.method!, plan.keyReason ?? "key_missing");
  return new AppError(
    503,
    loginMessage(plan, found),
    plan.method ? { code: "ai_connection_not_ready", method: plan.method, reason: found === "api_key" ? "wrong_login" : "not_signed_in" } : undefined,
  );
}

function loginMessage(plan: AiConnectionPlan, found: CliAccount["kind"] | undefined): string {
  const cli = CLI_NAMES[plan.provider];
  if (plan.expect === "subscription" && found === "api_key") {
    return plan.provider === "codex"
      ? "伺服器上的 Codex 目前用 API 金鑰登入，不是 ChatGPT 帳號。請到 設定 › 連接 AI 改選「OpenAI API 金鑰」，或在伺服器重新執行 codex login 改用 ChatGPT 登入。"
      : "伺服器上的 Claude Code 目前用 API 金鑰登入，不是 Claude 訂閱。請到 設定 › 連接 AI 改選「Anthropic API 金鑰」，或在伺服器重新執行 claude auth login。";
  }
  if (plan.method) return `無法使用 ${cli}：目前選用的 AI 連線尚未登入。請到 設定 › 連接 AI 重新登入，或改選其他連線。`;
  return plan.provider === "claude" ? "無法使用 Claude Code：請在伺服器的終端機執行 claude auth login。" : "無法使用 Codex：請在伺服器的終端機執行 codex login。";
}

/** 503 when the model provider refuses a saved key during a job. */
export function keyRejectedMessage(role: string, provider: AiKeyProvider): string {
  return `${role}未完成：${KEY_NAMES[provider]} 不接受目前保存的 API 金鑰（無效、已撤銷或沒有權限）。請到 設定 › 連接 AI 重新輸入金鑰。`;
}

/** The app-server launch for a plan: none for the CLI's own login, BELL's provider and a throwaway CODEX_HOME for a saved key. */
export function codexLaunch(runtime: AiConnectionRuntime | undefined, plan: AiConnectionPlan): CodexLaunch | undefined {
  if (!runtime || plan.provider !== "codex" || plan.home === "shared") return undefined;
  return { spawn: () => runtime.spawn(plan), config: BELL_OPENAI_PROVIDER_CONFIG, modelProvider: BELL_OPENAI_PROVIDER, apiKey: true };
}
