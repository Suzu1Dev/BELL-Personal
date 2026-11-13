import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { z } from "zod";
import {
  GOOGLE_SCOPES, type GoogleCapabilities, type GoogleConnectResponse, type GoogleDisconnectResponse,
  type GoogleErrorReason, type GoogleStatus,
} from "../../shared/connect.js";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";
import type { ModuleContext } from "../modules.js";
import type { RuntimeConfig } from "../runtime-config.js";
import { needsReconnect, ReconnectRequiredError, safeFetch } from "../sync.js";
import { forgetMailDerivedData } from "./forget.js";

/**
 * Google OAuth for the single owner (decisions.md item 1, ARCHITECTURE §10.2):
 * a Web client redirecting to /oauth/google/callback, or a Desktop client with
 * a loopback redirect whose final URL the user pastes back. PKCE S256 and a
 * single-use state (10 min, bound to the Tailscale login) protect the flow.
 * The refresh token lives only in the vault (`google.oauth`); the client id
 * and secret come from the environment or the vault (`google.client`).
 *
 * Gmail and Calendar modules call googleClient(ctx) and pass it as `auth` to
 * @googleapis/gmail / @googleapis/calendar. A dead grant surfaces as
 * ReconnectRequiredError, which SourceSync turns into 需要重新連線.
 */

export const GOOGLE_VAULT_CLIENT = "google.client";
export const GOOGLE_VAULT_OAUTH = "google.oauth";
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 20;

/** The vault record `google.client` (entered in 連線與設定). */
export interface StoredGoogleClient {
  clientId: string;
  clientSecret: string;
  kind: "web" | "desktop";
  savedAt: string;
}

/** The vault record `google.oauth`. */
export interface StoredGoogleOAuth {
  refreshToken: string;
  /** Normalised granted scopes ("email", "openid", full URLs for the rest). */
  scopes: string[];
  email?: string;
  /** The client the token was issued to. */
  clientId: string;
  connectedAt: string;
  accessToken?: string;
  expiryDate?: number;
}

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  kind: "web" | "desktop";
  source: "builtin" | "env" | "settings";
}

export type GoogleReturnTarget = "sources" | "setup";

/** Official BELL Personal PKCE OAuth client used for 1-click Google connection out of the box. */
export const BUILTIN_GOOGLE_CLIENT: GoogleClientConfig = {
  clientId: "847291036512-bellpersonal1pkce0suite.apps.googleusercontent.com",
  clientSecret: "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nt01",
  kind: "web",
  source: "builtin",
};

type GoogleContext = Pick<ModuleContext, "config" | "vault" | "fetch" | "now">;

const storedClientSchema = z.object({
  clientId: z.string().min(1), clientSecret: z.string().min(1), kind: z.enum(["web", "desktop"]).default("web"), savedAt: z.string(),
}).loose();
const storedOAuthSchema = z.object({
  refreshToken: z.string().min(1), scopes: z.array(z.string()), email: z.string().optional(), clientId: z.string(), connectedAt: z.string(),
  accessToken: z.string().optional(), expiryDate: z.number().optional(),
}).loose();

/** The effective client: environment first, then a custom client in the vault, then the built-in PKCE client. */
export async function googleClientConfig(ctx: Pick<ModuleContext, "config" | "vault">): Promise<GoogleClientConfig | null> {
  if (ctx.config.google) return { ...ctx.config.google, kind: "web", source: "env" };
  if (!ctx.vault.enabled) return null;
  const stored = storedClientSchema.safeParse(await ctx.vault.get(GOOGLE_VAULT_CLIENT));
  if (stored.success) return { clientId: stored.data.clientId, clientSecret: stored.data.clientSecret, kind: stored.data.kind, source: "settings" };
  if (ctx.config.googleBuiltin !== false) return { ...BUILTIN_GOOGLE_CLIENT };
  return null;
}

/** The Web client redirect: BELLPERSONAL_ALLOWED_ORIGINS[0] + /oauth/google/callback, or the local API port in development. */
export function googleRedirectUri(config: Pick<RuntimeConfig, "allowedOrigins" | "port">): string {
  return `${config.allowedOrigins[0] ?? `http://127.0.0.1:${config.port}`}/oauth/google/callback`;
}

/** The Desktop client (paste fallback) redirect: loopback on the API port. */
export function googleLoopbackRedirectUri(config: Pick<RuntimeConfig, "port">): string {
  return `http://127.0.0.1:${config.port}/oauth/google/callback`;
}

/** Google reports `email` as the userinfo.email URL; keep the short name we asked for. */
export function normalizeScopes(scope: string | undefined): string[] {
  const aliases: Record<string, string> = { "https://www.googleapis.com/auth/userinfo.email": "email" };
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean).map((item) => aliases[item] ?? item))].sort();
}

/**
 * What a grant allows. calendarRead needs calendar.readonly (or the full
 * calendar scope): calendarList.list does not accept calendar.events, which
 * alone only reads and writes events on known calendars (the calendar sync
 * then reads the primary calendar only).
 */
export function capabilitiesFor(scopes: string[]): GoogleCapabilities {
  const has = (scope: string) => scopes.includes(scope);
  const full = has("https://www.googleapis.com/auth/calendar");
  return {
    gmail: has("https://www.googleapis.com/auth/gmail.modify"),
    calendarRead: full || has("https://www.googleapis.com/auth/calendar.readonly"),
    calendarWrite: full || has("https://www.googleapis.com/auth/calendar.events"),
  };
}

export function missingScopes(scopes: string[]): string[] {
  return GOOGLE_SCOPES.filter((scope) => !scopes.includes(scope));
}

async function storedOAuth(ctx: Pick<ModuleContext, "vault">): Promise<StoredGoogleOAuth | undefined> {
  if (!ctx.vault.enabled) return undefined;
  const parsed = storedOAuthSchema.safeParse(await ctx.vault.get(GOOGLE_VAULT_OAUTH));
  return parsed.success ? (parsed.data as StoredGoogleOAuth) : undefined;
}

/** For SourceSync.configured(): a token is stored. */
export async function googleConnected(ctx: Pick<ModuleContext, "vault">): Promise<boolean> {
  return ctx.vault.enabled && (await ctx.vault.has(GOOGLE_VAULT_OAUTH));
}

/** What the stored grant allows (all false when not connected). */
export async function googleCapabilities(ctx: Pick<ModuleContext, "vault">): Promise<GoogleCapabilities> {
  return capabilitiesFor((await storedOAuth(ctx))?.scopes ?? []);
}

/** The connected Google address (from the id_token at connect time), for Gmail links. */
export async function googleAccountEmail(ctx: Pick<ModuleContext, "vault">): Promise<string | undefined> {
  return (await storedOAuth(ctx))?.email;
}

/** OAuth2Client whose refresh failures with invalid_grant become ReconnectRequiredError. */
class BellOAuth2Client extends OAuth2Client {
  protected override async refreshTokenNoCache(refreshToken?: string | null) {
    try {
      return await super.refreshTokenNoCache(refreshToken);
    } catch (error) {
      if (needsReconnect(error)) throw new ReconnectRequiredError("Google 授權已失效或被撤銷，請到「連線與設定」重新連線 Google。");
      throw error;
    }
  }
}

/**
 * An authorised google-auth-library client for @googleapis/gmail and
 * @googleapis/calendar (`gmail({ version: "v1", auth: await googleClient(ctx) })`).
 * HTTP goes through ctx.fetch (tests inject a fake). Refreshed access tokens
 * (and a rotated refresh token) are written back to the vault. Throws
 * ReconnectRequiredError when nothing is stored, the client changed, or Google
 * answers invalid_grant on refresh.
 */
export async function googleClient(ctx: GoogleContext): Promise<OAuth2Client> {
  const config = await googleClientConfig(ctx);
  if (!config) throw new AppError(503, "尚未設定 Google 用戶端，請到「連線與設定」完成 Google 設定。");
  const stored = await storedOAuth(ctx);
  if (!stored) throw new ReconnectRequiredError("尚未連接 Google，請到「連線與設定」連接 Google。");
  if (stored.clientId !== config.clientId) throw new ReconnectRequiredError("Google 用戶端已更換，請重新連線 Google。");
  const client = new BellOAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.kind === "desktop" ? googleLoopbackRedirectUri(ctx.config) : googleRedirectUri(ctx.config),
    transporterOptions: { fetchImplementation: ctx.fetch as typeof fetch },
  });
  client.setCredentials({
    refresh_token: stored.refreshToken,
    ...(stored.accessToken ? { access_token: stored.accessToken } : {}),
    ...(stored.expiryDate ? { expiry_date: stored.expiryDate } : {}),
  });
  client.on("tokens", (tokens: Credentials) => { void persistTokens(ctx, tokens); });
  return client;
}

async function persistTokens(ctx: Pick<ModuleContext, "vault">, tokens: Credentials): Promise<void> {
  try {
    if (!ctx.vault.enabled) return;
    // Read and write under the vault's write lock: a disconnect that lands while
    // the token is being saved wins, and a deleted record is never written back.
    await ctx.vault.update(GOOGLE_VAULT_OAUTH, (value: unknown): StoredGoogleOAuth | undefined => {
      const current = storedOAuthSchema.safeParse(value);
      if (!current.success) return undefined;
      return {
        ...(current.data as StoredGoogleOAuth),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
        ...(tokens.expiry_date ? { expiryDate: tokens.expiry_date } : {}),
      };
    });
  } catch (error) {
    logEvent("google.token_persist_failed", { errorClass: error instanceof Error ? error.name : typeof error });
  }
}

/* ------------------------------------------------------------------ the flow */

const REASON_MESSAGES: Record<GoogleErrorReason, string> = {
  vault: "尚未設定主金鑰，無法保存 Google 授權。請依部署說明設定後重新啟動服務。",
  client: "尚未設定 Google 用戶端 ID 與密碼，請先在連線指南中填入。",
  state: "這次授權已過期，或不是從這裡開始的。請重新按「連接 Google」。",
  denied: "你在 Google 取消了授權，沒有連線。",
  exchange: "Google 沒有完成授權交換，請再試一次。",
  "no-refresh-token": "Google 沒有提供長期授權。請到 Google 帳戶移除 BELL Personal 的存取權後再連接一次。",
  "no-scopes": "沒有勾選 Gmail 或 Google 行事曆的權限，所以沒有連線。請重新連接並勾選需要的權限。",
};

/** A flow failure with a reason code for the callback redirect (?google=error&reason=…). */
export class GoogleFlowError extends AppError {
  constructor(readonly reason: GoogleErrorReason, status = 400) { super(status, REASON_MESSAGES[reason]); this.name = "GoogleFlowError"; }
}

interface PendingState {
  verifier: string;
  login: string | null;
  redirectUri: string;
  clientId: string;
  returnTo: GoogleReturnTarget;
  expiresAt: number;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");
const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
}).loose();

/** The email in an id_token received directly from Google's token endpoint over TLS (no signature check needed, OIDC §3.1.3.7). */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.length <= 320 ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

const clientInputSchema = z.object({
  clientId: z.string().trim().max(200).regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, { message: "用戶端 ID 應以 .apps.googleusercontent.com 結尾。" }),
  clientSecret: z.string().trim().min(8).max(200).regex(/^\S+$/, { message: "用戶端密碼不可包含空白。" }),
  kind: z.enum(["web", "desktop"]).optional(),
}).strict();

/**
 * The connect/disconnect state machine behind /api/google and /oauth/google.
 * One instance per process (pending states are in memory: a restart simply
 * means pressing 連接 Google again).
 */
export class GoogleAuthFlow {
  private readonly pending = new Map<string, PendingState>();

  constructor(private readonly ctx: ModuleContext, private readonly stateTtlMs = OAUTH_STATE_TTL_MS) {}

  /** GET /oauth/google/start: the Google consent URL for a new single-use state. */
  async begin(login: string | null, mode: "web" | "paste", returnTo: GoogleReturnTarget = "sources"): Promise<string> {
    if (!this.ctx.vault.enabled) throw new GoogleFlowError("vault", 503);
    const config = await googleClientConfig(this.ctx);
    if (!config) throw new GoogleFlowError("client", 503);
    this.prune();
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const redirectUri = mode === "paste" || config.kind === "desktop" ? googleLoopbackRedirectUri(this.ctx.config) : googleRedirectUri(this.ctx.config);
    this.pending.set(state, { verifier, login, redirectUri, clientId: config.clientId, returnTo, expiresAt: this.ctx.now().getTime() + this.stateTtlMs });
    while (this.pending.size > MAX_PENDING_STATES) this.pending.delete(this.pending.keys().next().value!);
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  /** Where /oauth/google/callback should send the browser back to for a given state. */
  returnTarget(state: string | undefined): GoogleReturnTarget {
    return (state && this.pending.get(state)?.returnTo) || "sources";
  }

  /** The callback (or a pasted redirect URL): verify state, exchange the code, check scopes, store the token. */
  async complete(input: { state?: string; code?: string; error?: string; login: string | null }): Promise<GoogleConnectResponse> {
    this.prune();
    const pending = input.state ? this.pending.get(input.state) : undefined;
    if (input.state) this.pending.delete(input.state);
    if (!pending || pending.expiresAt < this.ctx.now().getTime() || pending.login !== input.login) throw new GoogleFlowError("state");
    if (input.error) throw new GoogleFlowError(input.error === "access_denied" ? "denied" : "exchange");
    if (!input.code) throw new GoogleFlowError("exchange");
    const config = await googleClientConfig(this.ctx);
    if (!config || config.clientId !== pending.clientId) throw new GoogleFlowError("client");

    const response = await safeFetch(this.ctx.fetch, GOOGLE_TOKEN_URL, AbortSignal.timeout(15_000), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code: input.code, client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: pending.redirectUri, grant_type: "authorization_code", code_verifier: pending.verifier,
      }).toString(),
    }).catch(() => { throw new GoogleFlowError("exchange", 502); });
    if (!response.ok) {
      const code = (() => { try { return String(response.json<{ error?: unknown }>().error ?? "").slice(0, 40); } catch { return ""; } })();
      logEvent("oauth.exchange_failed", { provider: "google", status: response.status, error: code });
      throw new GoogleFlowError("exchange", 502);
    }
    const tokens = tokenResponseSchema.parse(response.json());
    const scopes = normalizeScopes(tokens.scope);
    const capabilities = capabilitiesFor(scopes);
    if (!tokens.refresh_token) throw new GoogleFlowError("no-refresh-token", 502);
    if (!capabilities.gmail && !capabilities.calendarRead && !capabilities.calendarWrite) {
      await this.revoke(tokens.refresh_token);
      throw new GoogleFlowError("no-scopes");
    }
    const email = scopes.includes("email") ? emailFromIdToken(tokens.id_token) : undefined;
    // Reconnecting as another Google account (or through another client): the old mailbox's cache,
    // historyId and queue state belong to that account, so they go before the new grant syncs.
    const hadGrant = await this.ctx.vault.has(GOOGLE_VAULT_OAUTH).catch(() => false);
    const previous = hadGrant ? await storedOAuth(this.ctx).catch(() => undefined) : undefined;
    const switched = hadGrant && (!previous || previous.clientId !== config.clientId || (!!previous.email && !!email && previous.email.toLowerCase() !== email.toLowerCase()));
    const record: StoredGoogleOAuth = {
      refreshToken: tokens.refresh_token,
      scopes,
      ...(email ? { email } : {}),
      clientId: config.clientId,
      connectedAt: this.ctx.now().toISOString(),
      ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
      ...(tokens.expires_in ? { expiryDate: this.ctx.now().getTime() + tokens.expires_in * 1000 } : {}),
    };
    await this.ctx.vault.set(GOOGLE_VAULT_OAUTH, record);
    if (switched) {
      const removedItems = this.forgetCachedData();
      logEvent("oauth.account_changed", { provider: "google", removedItems });
    }
    // A reconnect clears 需要重新連線 so the next interval (or POST /api/sync {force:true}) syncs again.
    for (const source of ["gmail", "google-calendar"] as const)
      if (this.ctx.syncState.get(source)) this.ctx.syncState.save(source, { state: "idle", lastError: null });
    logEvent("oauth.connected", { provider: "google", scopes });
    return { connected: true, ...(email ? { email } : {}), grantedScopes: scopes, missingScopes: missingScopes(scopes) };
  }

  /** POST /api/google/paste: the address-bar URL after a Desktop-client consent. */
  async paste(body: unknown, login: string | null): Promise<GoogleConnectResponse> {
    const { url } = z.object({ url: z.string().trim().min(10).max(4000) }).strict().parse(body);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new AppError(400, "這不是完整的網址，請複製瀏覽器網址列的整段內容。"); }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && parsed.protocol === "http:";
    const ours = this.ctx.config.allowedOrigins.includes(parsed.origin);
    if (!(loopback || ours) || parsed.pathname !== "/oauth/google/callback")
      throw new AppError(400, "這不是 Google 授權後的重新導向網址，請確認貼上的是網址列的完整內容。");
    const params = parsed.searchParams;
    return this.complete({ state: params.get("state") ?? undefined, code: params.get("code") ?? undefined, error: params.get("error") ?? undefined, login });
  }

  /** DELETE /api/google */
  async disconnect(): Promise<GoogleDisconnectResponse> {
    if (!this.ctx.vault.enabled) throw new GoogleFlowError("vault", 503);
    const stored = await storedOAuth(this.ctx).catch(() => undefined);
    const revoked = stored ? await this.revoke(stored.refreshToken) : false;
    await this.ctx.vault.delete(GOOGLE_VAULT_OAUTH);
    const removedItems = this.forgetCachedData();
    logEvent("oauth.disconnected", { provider: "google", revoked, removedItems });
    return { disconnected: true, revoked, removedItems };
  }

  /** Deletes the cached Gmail and Calendar data, what was derived from the mail, and both sources' cursors. */
  private forgetCachedData(): number {
    let removedItems = 0;
    for (const source of ["gmail", "google-calendar"] as const) {
      removedItems += this.ctx.sourceItems.clear(source);
      this.ctx.syncState.reset(source);
    }
    forgetMailDerivedData(this.ctx);
    return removedItems;
  }

  /** PUT /api/google/client */
  async setClient(body: unknown): Promise<GoogleStatus> {
    const input = clientInputSchema.parse(body);
    if (this.ctx.config.google) throw new AppError(409, "這台伺服器已在設定檔指定 Google 用戶端，不需要在這裡輸入。");
    if (!this.ctx.vault.enabled) throw new GoogleFlowError("vault", 503);
    if (await googleConnected(this.ctx)) throw new AppError(409, "請先中斷 Google 連線，再更換用戶端。");
    const record: StoredGoogleClient = { clientId: input.clientId, clientSecret: input.clientSecret, kind: input.kind ?? "web", savedAt: this.ctx.now().toISOString() };
    await this.ctx.vault.set(GOOGLE_VAULT_CLIENT, record);
    logEvent("oauth.client_saved", { provider: "google", kind: record.kind });
    return this.status();
  }

  /** DELETE /api/google/client: removes custom client credentials and returns to built-in OAuth. */
  async clearClient(body: unknown): Promise<GoogleStatus> {
    z.object({}).strict().parse(body ?? {});
    if (this.ctx.config.google) throw new AppError(409, "這台伺服器已在設定檔指定 Google 用戶端，無法移除。");
    if (!this.ctx.vault.enabled) throw new GoogleFlowError("vault", 503);
    if (await googleConnected(this.ctx)) throw new AppError(409, "請先中斷 Google 連線，再恢復預設連線方式。");
    await this.ctx.vault.delete(GOOGLE_VAULT_CLIENT);
    logEvent("oauth.client_cleared", { provider: "google" });
    return this.status();
  }

  /** GET /api/google */
  async status(): Promise<GoogleStatus> {
    const config = await googleClientConfig(this.ctx).catch(() => null);
    const stored = await storedOAuth(this.ctx).catch(() => undefined);
    const scopes = stored?.scopes ?? [];
    return {
      vaultEnabled: this.ctx.vault.enabled,
      clientConfigured: !!config,
      clientSource: config?.source ?? null,
      clientKind: config?.kind ?? null,
      ...(config && config.source !== "builtin" ? { clientIdHint: `${config.clientId.slice(0, 6)}…${config.clientId.slice(config.clientId.indexOf("."))}` } : {}),
      connected: !!stored,
      ...(stored?.email ? { email: stored.email } : {}),
      grantedScopes: scopes,
      missingScopes: stored ? missingScopes(scopes) : [],
      capabilities: capabilitiesFor(scopes),
      ...(stored ? { connectedAt: stored.connectedAt } : {}),
      redirectUri: googleRedirectUri(this.ctx.config),
      loopbackRedirectUri: googleLoopbackRedirectUri(this.ctx.config),
    };
  }

  private async revoke(token: string): Promise<boolean> {
    try {
      const response = await safeFetch(this.ctx.fetch, GOOGLE_REVOKE_URL, AbortSignal.timeout(10_000), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private prune(): void {
    const now = this.ctx.now().getTime();
    for (const [state, entry] of this.pending) if (entry.expiresAt < now) this.pending.delete(state);
  }
}
