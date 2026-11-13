import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  AI_CONNECTION_CLI, AI_CONNECTION_LIMITS, AI_CONNECTION_METHODS, AI_KEY_METHOD,
  type AiActiveStatus, type AiConnection, type AiConnectionMethod, type AiConnectionsResponse, type AiKeyProvider, type AiLoginFailure, type AiLoginMethod, type AiLoginPrompt, type AiNotReadyReason, type AiSavedKey,
} from "../../shared/ai-connections.js";
import type { AgentProvider } from "../../shared/models.js";
import type { AppSettings } from "../../shared/settings.js";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";
import type { Vault } from "../secrets/vault.js";
import type { CliProbe, StatusService } from "../status.js";
import { appSettingsPatchSchema, type AppSettingsStore } from "../stores/app-settings.js";
import {
  AI_KEY_META_VAULT, AI_KEY_VAULT, BELL_OPENAI_PROVIDER_CONFIG, keyEnvironment, keyHint, keyNotReadyMessage, keyProviderOf, savedKeyInfo, savedKeyState,
  type SavedKeyState, type StoredAiKey, type StoredAiKeyMeta,
} from "./connection-runtime.js";
import { claudeEnvironment, codexEnvironment, type CommandResult, type CommandRunner } from "./process.js";

export { AI_KEY_META_VAULT, AI_KEY_VAULT, keyHint, type StoredAiKey, type StoredAiKeyMeta } from "./connection-runtime.js";

const KEY_CHECK_PROMPT = "Reply with the single word OK.";

/**
 * Every argv this service runs, fixed. Nothing from a request reaches an
 * argv: a pasted Claude code goes to that login's stdin, a key only into the
 * environment of a throwaway check process.
 */
export const AI_CONNECTION_ARGS = {
  /** codex-cli 0.167: prints https://auth.openai.com/codex/device and a one-time code (15 minutes), then waits for the approval; no TTY needed. */
  chatgptLogin: ["login", "--device-auth"],
  /** Claude Code 2.1.321 without a TTY or browser: prints the authorize URL, then reads the code from stdin ("Paste code here if prompted >"). */
  claudeLogin: ["auth", "login", "--claudeai"],
  /**
   * One tiny turn with an empty CODEX_HOME, through BELL's own model provider
   * (the key in BELL_OPENAI_API_KEY, exactly as AI jobs get it); a bad key
   * ends in turn.failed (401) and exit 1.
   */
  openaiKeyCheck: ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "--color", "never", "--json", ...BELL_OPENAI_PROVIDER_CONFIG, KEY_CHECK_PROMPT],
  /** One tiny turn with the key in ANTHROPIC_API_KEY and an empty CLAUDE_CONFIG_DIR; a bad key ends in {is_error, api_error_status: 401} and exit 1. */
  anthropicKeyCheck: ["-p", "--output-format", "json", "--model", "haiku", "--tools", "", "--no-session-persistence", "--setting-sources", "user", "--strict-mcp-config", "--disable-slash-commands", "--max-turns", "1", KEY_CHECK_PROMPT],
} as const;

export interface AiConnectionTimeouts {
  /** A login that prints no link by then is stopped. */
  prompt: number;
  /** The ChatGPT device code's lifetime (the CLI says 15 minutes). */
  chatgptLogin: number;
  /** How long the Claude sign-in page may stay open before the login is stopped. */
  claudeLogin: number;
  /** After the code is pasted, how long the CLI may take to exchange it. */
  codeExchange: number;
  /** One key check (Codex retries a 401 five times, ~15 s). */
  keyCheck: number;
}

export const AI_CONNECTION_TIMEOUTS: AiConnectionTimeouts = {
  prompt: 30_000,
  chatgptLogin: 15 * 60_000,
  claudeLogin: 10 * 60_000,
  codeExchange: 30_000,
  keyCheck: 90_000,
};

export interface AiConnectionOptions {
  command: CommandRunner;
  status: StatusService;
  vault: Vault;
  claudePath: string;
  codexPath: string;
  now?: () => Date;
  timeouts?: Partial<AiConnectionTimeouts>;
  /** Parent of the throwaway config homes for key checks (<dataDir>/ai); default the OS temp directory. */
  tmpDir?: string;
  /** Where the active connection (`ai.connection`) is kept. */
  settings: AppSettingsStore;
  /** After the active connection or a saved key changes: cached model catalogs may no longer apply. */
  onChange?: () => void;
}

const CLI_NAMES: Record<AgentProvider, string> = { claude: "Claude Code", codex: "Codex" };
const PROVIDER_NAMES: Record<AiKeyProvider, string> = { openai: "OpenAI", anthropic: "Anthropic" };
const METHOD_NAMES: Record<AiConnectionMethod, string> = { chatgpt: "ChatGPT", claude: "Claude 訂閱", "openai-key": "OpenAI API 金鑰", "anthropic-key": "Anthropic API 金鑰" };
const isLogin = (method: AiConnectionMethod): method is AiLoginMethod => method === "chatgpt" || method === "claude";

const MESSAGES = {
  notInstalled: (cli: AgentProvider) => `伺服器上沒有安裝 ${CLI_NAMES[cli]}，請先安裝後再回來連接。`,
  alreadySignedIn: (method: AiLoginMethod) => method === "chatgpt"
    ? "伺服器上的 Codex 已經登入。要換帳號，請先在伺服器的終端機執行 codex logout。"
    : "伺服器上的 Claude Code 已經登入。要換帳號，請先在伺服器的終端機執行 claude auth logout。",
  noPrompt: "沒有取得登入連結，請再試一次。",
  expired: "登入逾時，請重新開始。",
  denied: "登入被取消或拒絕了，請重新開始。",
  cliError: (cli: AgentProvider) => `${CLI_NAMES[cli]} 的登入程式出錯，沒有完成登入。請再試一次；一直失敗的話，請確認伺服器連得上網路。`,
  codeRejected: "這組代碼沒有被接受。請重新開始登入，並貼上新頁面顯示的代碼。",
  exchangeTimeout: "確認代碼逾時，請重新開始登入。",
  noPendingClaude: "目前沒有等待代碼的 Claude 登入，請重新開始。",
  codeSent: "代碼已經送出，正在確認。",
  badCode: "請貼上登入頁面顯示的完整代碼。",
  vaultOff: "伺服器尚未設定主金鑰，無法保存 API 金鑰。請依部署說明設定後重新啟動服務。",
  checking: "正在確認另一把金鑰，請稍候。",
  otherLogin: (method: AiLoginMethod) => `${method === "chatgpt" ? "ChatGPT" : "Claude"} 的登入還在進行中。請先完成或取消那個登入，再開始這一個。`,
  /** 409 from PUT /active (and an `ai.connection` in PUT /api/settings/app): this method cannot be picked yet. */
  notReady: (method: AiConnectionMethod, reason: AiNotReadyReason): string => {
    switch (reason) {
      case "cli_not_installed": return MESSAGES.notInstalled(AI_CONNECTION_CLI[method]);
      case "pending": return "登入或金鑰確認還在進行中，完成後再設為使用中。";
      case "wrong_login": return MESSAGES.wrongLogin(method);
      case "key_unreadable": return "這台伺服器的主金鑰解不開已保存的金鑰。請重新輸入金鑰，再設為使用中。";
      case "vault_disabled": return MESSAGES.vaultOff;
      default: return isLogin(method) ? "這個連線還沒有登入。請先完成登入，再設為使用中。" : "這個連線還沒有可用的金鑰。請先保存金鑰，再設為使用中。";
    }
  },
  wrongLogin: (method: AiConnectionMethod) => method === "chatgpt"
    ? "伺服器上的 Codex 目前用 API 金鑰登入，不是 ChatGPT 帳號。請改選「OpenAI API 金鑰」，或先在伺服器的終端機執行 codex logout 再登入 ChatGPT。"
    : "伺服器上的 Claude Code 目前用 API 金鑰登入，不是 Claude 訂閱。請改選「Anthropic API 金鑰」，或先在伺服器的終端機執行 claude auth logout 再登入。",
  /** activeStatus.message: the chosen connection cannot run jobs on this server right now. */
  activeNotReady: (method: AiConnectionMethod, reason: AiNotReadyReason): string => {
    const provider = keyProviderOf(method);
    switch (reason) {
      case "cli_not_installed": return `目前選用的 AI 連線（${METHOD_NAMES[method]}）需要 ${CLI_NAMES[AI_CONNECTION_CLI[method]]}，但這台伺服器沒有安裝。請安裝後重新整理，或改選其他連線。`;
      case "pending": return `目前選用的 AI 連線（${METHOD_NAMES[method]}）正在登入或確認金鑰，完成後就能使用。`;
      case "wrong_login": return MESSAGES.wrongLogin(method);
      case "key_missing":
      case "key_unreadable":
      case "vault_disabled": return keyNotReadyMessage(provider!, reason);
      default: return `目前選用的 AI 連線（${METHOD_NAMES[method]}）在這台伺服器還沒有登入。請到 設定 › 連接 AI 登入，或改選其他連線。`;
    }
  },
  wrongProvider: (provider: AiKeyProvider) => provider === "openai" ? "這是 Anthropic（Claude）的金鑰，請改選 Anthropic。" : "這看起來是 OpenAI 的金鑰，請改選 OpenAI。",
  badKey: (provider: AiKeyProvider) => provider === "openai" ? "請貼上 OpenAI 的 API 金鑰（以 sk- 開頭）。" : "請貼上 Anthropic 的 API 金鑰（以 sk-ant- 開頭）。",
  keyInvalid: (provider: AiKeyProvider) => `${PROVIDER_NAMES[provider]} 不接受這把金鑰（無效或沒有權限）。請確認完整複製，或到 ${PROVIDER_NAMES[provider]} 平台重新產生一把。`,
  keyQuota: (provider: AiKeyProvider) => `這把金鑰可以使用，但帳戶目前沒有可用額度。請先到 ${PROVIDER_NAMES[provider]} 平台儲值或提高上限，再試一次。`,
  keyUnreachable: (provider: AiKeyProvider) => `暫時無法向 ${PROVIDER_NAMES[provider]} 確認這把金鑰，請檢查伺服器網路後再試一次。金鑰沒有保存。`,
  keyNoCli: (provider: AiKeyProvider) => MESSAGES.notInstalled(provider === "openai" ? "codex" : "claude"),
};

type KeyCheck = "ok" | "invalid" | "quota" | "unreachable" | "missing";
const KEY_CHECK_FAILURES: Record<Exclude<KeyCheck, "ok">, { status: number; message: (provider: AiKeyProvider) => string; code?: "ai_key_invalid" | "ai_key_no_credit" }> = {
  invalid: { status: 422, message: MESSAGES.keyInvalid, code: "ai_key_invalid" },
  quota: { status: 422, message: MESSAGES.keyQuota, code: "ai_key_no_credit" },
  unreachable: { status: 502, message: MESSAGES.keyUnreachable },
  missing: { status: 503, message: MESSAGES.keyNoCli },
};

/** Sign-in pages a login may send the user to; anything else the CLI prints is ignored. */
const LOGIN_HOSTS: Record<AiLoginMethod, readonly string[]> = {
  chatgpt: ["auth.openai.com"],
  claude: ["claude.com", "claude.ai", "platform.claude.com"],
};
// CSI sequences (colours) and OSC 8 hyperlinks: codex wraps the one-time code in them.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const DEVICE_CODE = /\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/;
/** Claude's code is `<code>#<state>`, base64url-like; no spaces or newlines, which would reach the CLI as a second line. */
const CLAUDE_CODE = new RegExp(`^[A-Za-z0-9._~#+/=:-]{10,${AI_CONNECTION_LIMITS.code}}$`);
/** A key's state on this server and, once saved, what the settings row shows for it. */
type SavedKey = { state: SavedKeyState; info?: AiSavedKey };

const KEY_SHAPES: Record<AiKeyProvider, RegExp> = {
  openai: /^sk-(?!ant-)[A-Za-z0-9_-]{20,}$/,
  anthropic: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
};

/** The first allowed https sign-in URL in one line of CLI output. */
export function loginUrl(line: string, method: AiLoginMethod): string | undefined {
  for (const match of line.replace(ANSI, "").matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const raw = match[0].replace(/[).,;]+$/, "");
    if (raw.length > 4096) continue;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !LOGIN_HOSTS[method].includes(url.hostname)) continue;
    // A localhost callback only works in a browser on the server itself; the paste flow needs the manual one.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url.searchParams.get("redirect_uri") ?? "")) continue;
    return url.toString();
  }
  return undefined;
}

export function deviceCode(line: string): string | undefined {
  return line.replace(ANSI, "").match(DEVICE_CODE)?.[0];
}

type LoginEnd = "cancelled" | "no_prompt" | "exchange_timeout";

/**
 * What a line from a sign-in CLI says about how the sign-in is going wrong.
 * Only this word is kept (Login.said), never the line. Read from the strings
 * Codex 0.167 and Claude Code 2.1 print; they must not match the sign-in
 * prompts themselves (Codex's "expires in 15 minutes", "…gave you this code, cancel.").
 */
export type LoginSignal = "network" | "denied" | "code" | "expired" | "timeout";
const LOGIN_SIGNALS: ReadonlyArray<readonly [LoginSignal, RegExp]> = [
  ["network", /\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b|error sending request|dns error|tcp connect|connection refused|fetch failed|network error|unable to connect|socket hang up/i],
  ["denied", /access_denied|\bdenied\b|\bdeclined\b|\bcancell?ed\b|\binterrupted\b/i],
  ["code", /invalid (?:authorization )?code|invalid_grant|not from this sign-in|already been used|token exchange failed|failed to exchange authorization code/i],
  ["expired", /has expired|expired_token/i],
  ["timeout", /timed out after|authentication timeout|login timed out|timed out waiting/i],
];

export function loginSignal(line: string): LoginSignal | undefined {
  const text = line.replace(ANSI, "");
  return LOGIN_SIGNALS.find(([, pattern]) => pattern.test(text))?.[0];
}

/**
 * How a failed sign-in is reported (AI_LOGIN_FAILURES). BELL's own endings
 * and the runner's status come first; then what the CLI said; a CLI that
 * exits without saying why is cli_error (or code_rejected once Claude has the code).
 */
export function loginFailure(ended: LoginEnd | undefined, status: number, said: LoginSignal | undefined, codeSent: boolean): AiLoginFailure {
  if (ended === "exchange_timeout") return "timed_out";
  if (ended === "no_prompt" || status === 503) return "cli_error";
  if (status === 504) return "timed_out";
  switch (said) {
    case "network": return "cli_error";
    case "denied": return "denied";
    case "timeout": return "timed_out";
    case "expired": return codeSent ? "code_rejected" : "timed_out";
    default: return codeSent ? "code_rejected" : "cli_error";
  }
}

interface Login {
  method: AiLoginMethod;
  controller: AbortController;
  expiresAt: Date;
  prompt?: AiLoginPrompt;
  /** Claude only: the code goes here. */
  stdin?: PassThrough;
  codeSent: boolean;
  /** Why we stopped it ourselves. */
  ended?: LoginEnd;
  /** The last thing the CLI said about failing (loginSignal), never its words. */
  said?: LoginSignal;
  /** Settles once the link is shown (or the CLI failed before that). */
  started: Promise<void>;
  /** Settles when the CLI exits; never rejects. */
  exited: Promise<void>;
}

/**
 * 初次設定 › 連接 AI: what each sign-in method looks like on this server,
 * browser-started sign-ins (ChatGPT device code, Claude paste-code), and
 * API keys checked with one tiny CLI run and kept in the vault.
 *
 * Guard rails: fixed argv; a sign-in is refused while that CLI is already
 * signed in (no silent account swap, no clobbering a terminal login); one
 * sign-in per method; nothing the CLI prints reaches the browser except a
 * vetted https URL on the provider's host and the one-time code; a key is
 * never logged, returned, or written outside the vault (the check runs with
 * a throwaway config home that is deleted afterwards).
 */
export class AiConnectionService {
  private readonly logins = new Map<AiLoginMethod, Login>();
  private readonly failures = new Map<AiConnectionMethod, { message: string; failure?: AiLoginFailure }>();
  private readonly checking = new Set<AiKeyProvider>();
  private readonly timeouts: AiConnectionTimeouts;
  private readonly now: () => Date;

  constructor(private readonly options: AiConnectionOptions) {
    this.timeouts = { ...AI_CONNECTION_TIMEOUTS, ...options.timeouts };
    this.now = options.now ?? (() => new Date());
  }

  async list(refresh = false): Promise<AiConnectionsResponse> {
    if (refresh) {
      this.options.status.invalidate();
      this.options.onChange?.();
    }
    const probe = await this.options.status.probe();
    const saved = await this.savedKeys();
    const connections = AI_CONNECTION_METHODS.map((method) => this.describe(method, probe, saved));
    const active = this.options.settings.value("ai.connection");
    return {
      connections,
      active,
      activeStatus: activeStatus(active, connections),
      vault: { enabled: this.options.vault.enabled },
      checkedAt: probe.checkedAt,
    };
  }

  /** GET /api/status › ai.connection. */
  async activeStatus(): Promise<AiActiveStatus | null> {
    return (await this.list()).activeStatus;
  }

  /**
   * Picks the one connection AI jobs use (`null` = not chosen: the provider in
   * 設定 › AI 模型 with whatever its CLI is signed in with). Only a method that
   * is ready can be picked; jobs still check again at run time.
   */
  async setActive(method: AiConnectionMethod | null): Promise<AiConnectionsResponse> {
    if (method) await this.assertReady(method);
    this.options.settings.update({ "ai.connection": method });
    this.changed(method);
    return this.list();
  }

  /**
   * PUT /api/settings/app. A patch that changes `ai.connection` gets the same
   * readiness check as PUT /active, and nothing in it is written when that
   * fails; the same value again (a form that saves every key) passes as is.
   */
  async updateSettings(patch: unknown): Promise<AppSettings> {
    const parsed = appSettingsPatchSchema.parse(patch);
    const next = parsed["ai.connection"];
    const changing = next !== undefined && next !== this.options.settings.value("ai.connection");
    if (changing && next) await this.assertReady(next);
    const settings = this.options.settings.update(parsed);
    if (changing) this.changed(next);
    return settings;
  }

  async connection(method: AiConnectionMethod): Promise<AiConnection> {
    return (await this.list()).connections.find((item) => item.method === method)!;
  }

  /** 409 ai_connection_not_ready unless `method` is ready here (jobs still check again at run time). */
  private async assertReady(method: AiConnectionMethod): Promise<void> {
    const connection = await this.connection(method);
    if (connection.state === "detected") return;
    const reason = connection.reason ?? "not_signed_in";
    throw new AppError(409, MESSAGES.notReady(method, reason), { code: "ai_connection_not_ready", method, reason });
  }

  private changed(method: AiConnectionMethod | null): void {
    this.options.onChange?.();
    logEvent("ai.connection", { method });
  }

  /** Starts (or rejoins) a sign-in and answers once its link is known. */
  async startLogin(method: AiLoginMethod): Promise<AiConnection> {
    let login = this.logins.get(method);
    if (!login) {
      // One sign-in at a time; the same method again rejoins it (a reload, a second tab).
      const other = [...this.logins.keys()].find((running) => running !== method);
      if (other) throw new AppError(409, MESSAGES.otherLogin(other));
      const controller = new AbortController();
      const lifetime = method === "chatgpt" ? this.timeouts.chatgptLogin : this.timeouts.claudeLogin;
      login = {
        method, controller, codeSent: false,
        expiresAt: new Date(this.now().getTime() + lifetime),
        ...(method === "claude" ? { stdin: new PassThrough() } : {}),
        started: Promise.resolve(), exited: Promise.resolve(),
      };
      this.logins.set(method, login);
      this.failures.delete(method);
      login.started = this.launch(login, lifetime);
    }
    await login.started;
    return this.connection(method);
  }

  /** Claude: hands the pasted code to the waiting CLI and answers with the outcome. */
  async submitClaudeCode(raw: string): Promise<AiConnection> {
    const code = raw.trim();
    if (!CLAUDE_CODE.test(code)) throw new AppError(400, MESSAGES.badCode);
    const login = this.logins.get("claude");
    if (!login?.prompt || !login.stdin) throw new AppError(409, MESSAGES.noPendingClaude);
    if (login.codeSent) throw new AppError(409, MESSAGES.codeSent);
    login.codeSent = true;
    login.stdin.end(`${code}\n`);
    const timer = setTimeout(() => { login.ended ??= "exchange_timeout"; login.controller.abort(); }, this.timeouts.codeExchange);
    await login.exited;
    clearTimeout(timer);
    const failure = this.failures.get("claude");
    if (failure) throw new AppError(422, failure.message);
    return this.connection("claude");
  }

  /** 取消 also dismisses the last failed attempt, so the next start never shows its error. */
  async cancelLogin(method: AiLoginMethod): Promise<void> {
    const login = this.logins.get(method);
    if (login) {
      login.ended ??= "cancelled";
      login.controller.abort();
      await login.exited;
    }
    this.failures.delete(method);
  }

  /** Checks the key with one tiny run of its CLI, then keeps it in the vault; nothing is saved when the check fails. */
  async saveKey(provider: AiKeyProvider, raw: string): Promise<AiConnection> {
    const method = AI_KEY_METHOD[provider];
    if (!this.options.vault.enabled) throw new AppError(503, MESSAGES.vaultOff);
    const key = raw.trim();
    if (provider === "openai" ? key.startsWith("sk-ant-") : /^sk-(?!ant-)/.test(key)) throw new AppError(400, MESSAGES.wrongProvider(provider));
    if (key.length > AI_CONNECTION_LIMITS.key || !KEY_SHAPES[provider].test(key)) throw new AppError(400, MESSAGES.badKey(provider));
    if (this.checking.has(provider)) throw new AppError(409, MESSAGES.checking);
    this.checking.add(provider);
    this.failures.delete(method);
    try {
      const outcome = await this.checkKey(provider, key);
      logEvent("ai.key_check", { provider, outcome });
      if (outcome !== "ok") {
        const failure = KEY_CHECK_FAILURES[outcome];
        this.failures.set(method, { message: failure.message(provider) });
        throw new AppError(failure.status, failure.message(provider), failure.code ? { code: failure.code } : undefined);
      }
      const { vault } = this.options;
      const verifiedAt = this.now().toISOString();
      // The old key's metadata goes first and the new key's comes last: a crash in between leaves
      // a key without metadata (hint read from the key, verifiedAt null), never one key's hint on another.
      await vault.delete(AI_KEY_META_VAULT[provider]);
      await vault.set(AI_KEY_VAULT[provider], { key, verifiedAt } satisfies StoredAiKey);
      await vault.set(AI_KEY_META_VAULT[provider], { hint: keyHint(key), verifiedAt } satisfies StoredAiKeyMeta);
      this.options.onChange?.();
    } finally {
      this.checking.delete(provider);
    }
    return this.connection(method);
  }

  async deleteKey(provider: AiKeyProvider): Promise<void> {
    this.failures.delete(AI_KEY_METHOD[provider]);
    if (this.options.vault.enabled) {
      await this.options.vault.delete(AI_KEY_VAULT[provider]);
      await this.options.vault.delete(AI_KEY_META_VAULT[provider]);
    }
    this.options.onChange?.();
  }

  /** Shutdown: a login CLI left running could still finish a sign-in later. */
  async close(): Promise<void> {
    await Promise.all([...this.logins.keys()].map((method) => this.cancelLogin(method)));
  }

  private describe(method: AiConnectionMethod, probe: CliProbe, saved: Record<AiKeyProvider, SavedKey>): AiConnection {
    const cliName = AI_CONNECTION_CLI[method];
    const cli = probe.clis[cliName];
    const base = { method, cli: cliName, installed: cli.installed };
    // A CLI that says it is signed in but not how ran with an older output format: its env never carries a key, so a subscription.
    const kind = cli.authenticated ? cli.account?.kind ?? "subscription" : undefined;
    let reason: AiNotReadyReason;
    let failure = this.failures.get(method);
    if (isLogin(method)) {
      const login = this.logins.get(method);
      if (login) return { ...base, state: "pending", reason: "pending", ...(login.prompt && !login.codeSent ? { prompt: login.prompt } : {}) };
      if (kind === "subscription") return { ...base, state: "detected", source: "cli", ...(cli.account?.plan ? { plan: cli.account.plan } : {}) };
      reason = kind === "api_key" ? "wrong_login" : "not_signed_in";
    } else {
      const provider = keyProviderOf(method)!;
      if (this.checking.has(provider)) return { ...base, state: "pending", reason: "pending" };
      const { state: key, info } = saved[provider];
      if (key === "saved") return { ...base, state: "detected", source: "bell", ...(info ? { savedKey: info } : {}) };
      // Jobs take the saved key's path (connection-runtime plan()), so a CLI API-key login does not make this ready.
      if (key === "unreadable") {
        reason = "key_unreadable";
        failure ??= { message: MESSAGES.notReady(method, reason) };
      } else if (kind === "api_key") return { ...base, state: "detected", source: "cli" };
      else reason = key === "vault_disabled" ? "vault_disabled" : "key_missing";
    }
    if (!cli.installed) reason = "cli_not_installed";
    return failure ? { ...base, state: "failed", message: failure.message, reason, ...(failure.failure ? { failure: failure.failure } : {}) } : { ...base, state: "not_set", reason };
  }

  private async savedKeys(): Promise<Record<AiKeyProvider, SavedKey>> {
    const { vault } = this.options;
    const read = async (provider: AiKeyProvider): Promise<SavedKey> => {
      const state = await savedKeyState(vault, provider);
      return state === "saved" ? { state, info: await savedKeyInfo(vault, provider) } : { state };
    };
    return { openai: await read("openai"), anthropic: await read("anthropic") };
  }

  private async launch(login: Login, lifetime: number): Promise<void> {
    const { method } = login;
    const cli = AI_CONNECTION_CLI[method];
    try {
      this.options.status.invalidate();
      const status = (await this.options.status.probe()).clis[cli];
      if (!status.installed) throw new AppError(503, MESSAGES.notInstalled(cli));
      if (status.authenticated) throw new AppError(409, MESSAGES.alreadySignedIn(method));
    } catch (error) {
      this.logins.delete(method);
      throw error;
    }
    logEvent("ai.login", { method, step: "start" });
    const expiresAt = login.expiresAt.toISOString();
    return new Promise<void>((resolve, reject) => {
      const promptTimer = setTimeout(() => { login.ended ??= "no_prompt"; login.controller.abort(); }, this.timeouts.prompt);
      let url: string | undefined;
      const onLine = (line: string) => {
        login.said = loginSignal(line) ?? login.said;
        if (login.prompt) return;
        url ??= loginUrl(line, method);
        if (!url) return;
        if (method === "claude") login.prompt = { kind: "paste_code", url, expiresAt };
        else {
          const code = deviceCode(line);
          if (code) login.prompt = { kind: "device_code", url, code, expiresAt };
        }
        if (login.prompt) {
          clearTimeout(promptTimer);
          resolve();
        }
      };
      const run = method === "chatgpt"
        ? this.options.command(this.options.codexPath, [...AI_CONNECTION_ARGS.chatgptLogin], { env: codexEnvironment(), signal: login.controller.signal, timeoutMs: lifetime, maxBytes: 64_000, onLine })
        : this.options.command(this.options.claudePath, [...AI_CONNECTION_ARGS.claudeLogin], { env: claudeEnvironment(), stdin: login.stdin, signal: login.controller.signal, timeoutMs: lifetime, maxBytes: 64_000, onLine });
      login.exited = run.then(() => undefined, (error: unknown) => error).then((error) => {
        clearTimeout(promptTimer);
        const message = this.finish(login, error);
        if (login.prompt) resolve();
        else if (message) reject(new AppError(error instanceof AppError && error.status === 503 ? 503 : 502, message));
        else if (error) reject(new AppError(409, "已取消登入。"));
        else resolve();
      });
    });
  }

  /** Records how a login ended; returns the failure message, if it failed. */
  private finish(login: Login, error: unknown): string | undefined {
    const { method } = login;
    if (this.logins.get(method) === login) this.logins.delete(method);
    login.stdin?.destroy();
    this.options.status.invalidate();
    if (!error) {
      this.failures.delete(method);
      this.options.onChange?.();
      logEvent("ai.login", { method, step: "done" });
      return undefined;
    }
    if (login.ended === "cancelled") {
      logEvent("ai.login", { method, step: "cancelled" });
      return undefined;
    }
    const status = error instanceof AppError ? error.status : 500;
    const failure = loginFailure(login.ended, status, login.said, login.codeSent);
    const cli = AI_CONNECTION_CLI[method];
    const message = login.ended === "no_prompt" ? MESSAGES.noPrompt
      : login.ended === "exchange_timeout" ? MESSAGES.exchangeTimeout
      : status === 503 ? MESSAGES.notInstalled(cli)
      : failure === "timed_out" ? MESSAGES.expired
      : failure === "denied" ? MESSAGES.denied
      : failure === "code_rejected" ? MESSAGES.codeRejected
      : MESSAGES.cliError(cli);
    this.failures.set(method, { message, failure });
    logEvent("ai.login", { method, step: "failed", failure, reason: login.ended ?? login.said ?? (login.codeSent ? "code" : "exit"), status });
    return message;
  }

  private async checkKey(provider: AiKeyProvider, key: string): Promise<KeyCheck> {
    const parent = this.options.tmpDir ?? tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const home = await mkdtemp(join(parent, "keycheck-"));
    try {
      const config = join(home, "config");
      const cwd = join(home, "work");
      await Promise.all([mkdir(config), mkdir(cwd)]);
      let result: CommandResult;
      const env = keyEnvironment(provider, config, key);
      if (provider === "anthropic") {
        result = await this.options.command(this.options.claudePath, [...AI_CONNECTION_ARGS.anthropicKeyCheck], { env, cwd, secrets: [key], timeoutMs: this.timeouts.keyCheck, allowedCodes: [0, 1] });
        return anthropicKeyCheck(result);
      }
      result = await this.options.command(this.options.codexPath, [...AI_CONNECTION_ARGS.openaiKeyCheck], { env, cwd, secrets: [key], timeoutMs: this.timeouts.keyCheck, allowedCodes: [0, 1] });
      return openaiKeyCheck(result);
    } catch (error) {
      // The CLI's own message can quote the key: never pass it on.
      return error instanceof AppError && error.status === 503 ? "missing" : "unreachable";
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** The active connection's readiness, from the same per-method states the list shows. */
function activeStatus(active: AiConnectionMethod | null, connections: AiConnection[]): AiActiveStatus | null {
  if (!active) return null;
  const connection = connections.find((item) => item.method === active)!;
  if (connection.state === "detected") return { method: active, ready: true, source: connection.source! };
  const reason = connection.reason ?? "not_signed_in";
  return { method: active, ready: false, reason, message: MESSAGES.activeNotReady(active, reason) };
}

function jsonLines(text: string): Record<string, any>[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim().startsWith("{")) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** `claude -p --output-format json`: one result object; a rejected key is api_error_status 401 (Claude Code 2.1.321). */
export function anthropicKeyCheck(result: CommandResult): KeyCheck {
  const answer = jsonLines(result.stdout).findLast((event) => event.type === "result");
  if (!answer) return "unreachable";
  if (result.code === 0 && answer.is_error === false) return "ok";
  const status = Number(answer.api_error_status);
  if (status === 401 || status === 403) return "invalid";
  if (status === 402 || status === 429 || /credit balance/i.test(String(answer.result ?? ""))) return "quota";
  return "unreachable";
}

/** `codex exec --json`: JSONL ending in turn.completed, or turn.failed whose message carries the HTTP status (codex-cli 0.167). */
export function openaiKeyCheck(result: CommandResult): KeyCheck {
  const events = jsonLines(result.stdout);
  if (result.code === 0 && events.some((event) => event.type === "turn.completed")) return "ok";
  const text = events.filter((event) => event.type === "turn.failed" || event.type === "error")
    .map((event) => String(event.error?.message ?? event.message ?? "")).join("\n");
  if (/\b40[13]\b|invalid_api_key|Incorrect API key/i.test(text)) return "invalid";
  if (/\b429\b|insufficient_quota|exceeded your current quota/i.test(text)) return "quota";
  return "unreachable";
}
