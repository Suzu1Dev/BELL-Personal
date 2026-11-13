import type { AgentProvider } from "./models.js";

/**
 * 初次設定 › 連接 AI (GET /api/ai/connections). Four ways to give BELL a model,
 * each run through a CLI already on the server:
 * - chatgpt: Codex signed in with a ChatGPT plan (device code login).
 * - claude: Claude Code signed in with a Claude Pro/Max plan (paste-code login).
 * - openai-key / anthropic-key: the user's own API key, verified with one tiny
 *   CLI run and kept in the vault. Keys never come back to the browser, only
 *   a masked hint of the last 4 characters (AiSavedKey).
 * The CLIs' own logins (`codex login`, `claude auth login` in a terminal)
 * keep working and show up here as `source: "cli"`.
 */
export const AI_CONNECTION_METHODS = ["chatgpt", "claude", "openai-key", "anthropic-key"] as const;
export type AiConnectionMethod = (typeof AI_CONNECTION_METHODS)[number];

/** Methods with a sign-in flow started from the browser. */
export const AI_LOGIN_METHODS = ["chatgpt", "claude"] as const;
export type AiLoginMethod = (typeof AI_LOGIN_METHODS)[number];

export const AI_KEY_PROVIDERS = ["openai", "anthropic"] as const;
export type AiKeyProvider = (typeof AI_KEY_PROVIDERS)[number];

/** detected: ready to use · not_set · pending: a sign-in or key check is running · failed: the last attempt did not work (`message`). */
export const AI_CONNECTION_STATES = ["detected", "not_set", "pending", "failed"] as const;
export type AiConnectionState = (typeof AI_CONNECTION_STATES)[number];

/**
 * How a browser sign-in (chatgpt, claude) failed, on `failed` rows; read from
 * how the CLI ended and the words it printed, never passed on as text.
 * - denied: the user cancelled or declined it on the sign-in page, or the CLI
 *   says the sign-in was denied, cancelled or interrupted. 取消 in BELL
 *   (DELETE …/login) is not a failure: the row goes back to `not_set`.
 * - code_rejected: Claude did not accept the pasted code (wrong, from another
 *   sign-in, already used or expired).
 * - timed_out: not finished in time (the sign-in's 15 / 10 minutes, the
 *   CLI's own limit, or Claude's 30 s to check a pasted code).
 * - cli_error: the CLI could not run the sign-in: it did not start, showed no
 *   link, crashed, could not reach the provider, or exited without saying why.
 */
export const AI_LOGIN_FAILURES = ["denied", "code_rejected", "timed_out", "cli_error"] as const;
export type AiLoginFailure = (typeof AI_LOGIN_FAILURES)[number];

/**
 * What a pending sign-in asks the user to do.
 * device_code (ChatGPT): open `url` on any device and type `code`; BELL notices by itself (poll GET).
 * paste_code (Claude): open `url`, sign in, copy the code the page shows and send it to
 * POST /api/ai/connections/claude/login/code.
 */
export type AiLoginPrompt =
  | { kind: "device_code"; url: string; code: string; expiresAt: string }
  | { kind: "paste_code"; url: string; expiresAt: string };

/**
 * Why a method is not ready on this server (every state but detected), for
 * the UI to pick its own wording; `message` on the active status is a
 * zh-TW fallback.
 * - cli_not_installed: its CLI is missing on this server.
 * - pending: a sign-in or key check is running.
 * - not_signed_in: chatgpt / claude, the CLI has no plan login.
 * - wrong_login: chatgpt / claude, the CLI is signed in with an API key instead.
 * - key_missing: a key method with no key saved on this server and no API-key
 *   login in the CLI. `ai.connection` syncs between devices but saved keys do
 *   not, so this is what another device shows until the key is entered there.
 * - key_unreadable: a key is saved but this server's master key cannot open it.
 * - vault_disabled: a key method on a server without a master key (no key can be saved here).
 */
export const AI_NOT_READY_REASONS = ["cli_not_installed", "pending", "not_signed_in", "wrong_login", "key_missing", "key_unreadable", "vault_disabled"] as const;
export type AiNotReadyReason = (typeof AI_NOT_READY_REASONS)[number];

/**
 * Whether the active connection can run AI jobs on this server right now.
 * Ready `source`, as on its AiConnection: "bell" = a key saved here; "cli" =
 * the CLI's own login on the server. For openai-key / anthropic-key, "cli"
 * means no key is saved here and jobs use the API key the CLI itself is
 * signed in with (`codex login --with-api-key`, Claude Code's own key).
 */
export type AiActiveStatus =
  | { method: AiConnectionMethod; ready: true; source: "cli" | "bell" }
  | { method: AiConnectionMethod; ready: false; reason: AiNotReadyReason; message: string };

/**
 * A key saved in BELL on this server, as the settings row shows it: which key it
 * is, never the key. Kept in the vault beside the key, so it survives a restart
 * and goes with the key when it is removed or replaced.
 */
export interface AiSavedKey {
  provider: AiKeyProvider;
  /** "••••" and the key's last 4 characters; null for a key shorter than 8 characters. */
  hint: string | null;
  /**
   * When BELL's check of this key passed (ISO 8601), set only by a successful
   * PUT /keys/:provider; a replacement gets its own. null for a key saved
   * before BELL kept this.
   */
  verifiedAt: string | null;
}

export interface AiConnection {
  method: AiConnectionMethod;
  /** The CLI this method runs through. */
  cli: AgentProvider;
  /** False: that CLI is not installed on the server, so this method cannot be set up from the browser. */
  installed: boolean;
  state: AiConnectionState;
  /** detected: the CLI's own login on the server, or a key saved in BELL. */
  source?: "cli" | "bell";
  /** detected Claude subscription: pro, max… (never the account email). */
  plan?: string;
  /** pending sign-in, once the CLI has printed it. */
  prompt?: AiLoginPrompt;
  /** failed: zh-TW, safe to show as is. */
  message?: string;
  /** failed browser login (chatgpt, claude): how it failed (AI_LOGIN_FAILURES), for local copy. */
  failure?: AiLoginFailure;
  /** Every state but detected: why (AI_NOT_READY_REASONS). */
  reason?: AiNotReadyReason;
  /** openai-key / anthropic-key, detected with source "bell": the key saved here. */
  savedKey?: AiSavedKey;
}

export interface AiConnectionsResponse {
  connections: AiConnection[];
  /** The connection AI jobs use (app setting `ai.connection`); `null` = not chosen yet. */
  active: AiConnectionMethod | null;
  /**
   * The active connection's readiness on this server; `null` when none is
   * chosen. Not ready never means another connection is used instead: jobs
   * answer 503 until it is fixed or another one is picked.
   */
  activeStatus: AiActiveStatus | null;
  /** False without a master key: API keys cannot be saved (sign-ins still work). */
  vault: { enabled: boolean };
  checkedAt: string;
}

export const AI_CONNECTION_CLI: Record<AiConnectionMethod, AgentProvider> = {
  chatgpt: "codex",
  claude: "claude",
  "openai-key": "codex",
  "anthropic-key": "claude",
};

export const AI_KEY_METHOD: Record<AiKeyProvider, AiConnectionMethod> = { openai: "openai-key", anthropic: "anthropic-key" };

/** The longest pasted value either endpoint reads (keys are ~50–200 characters, Claude's code ~100). */
export const AI_CONNECTION_LIMITS = { key: 400, code: 1000 } as const;
