import { isIP } from "node:net";
import { resolve } from "node:path";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "../shared/time.js";
import { parseAgentProcessLimit } from "./ai/agent-slots.js";
import { parseAgentTimeoutScale } from "./ai/agent-timeouts.js";
import { parseAllowedOrigins } from "./security.js";
import { readSuiteConfig, type SuiteConfig } from "./suite/config.js";

/**
 * Everything the process reads from its environment, validated before any data
 * directory or database is opened. Each value throws a zh-TW error naming the
 * variable, so a bad deploy fails at boot instead of later. Variable names
 * appear only here and in deployment docs, never in the UI.
 */
export interface RuntimeConfig {
  production: boolean;
  host: string;
  port: number;
  frontendPort: number;
  /** Normalised exact origins; see parseAllowedOrigins. */
  allowedOrigins: string[];
  /** Absolute; created 0700 when the databases are opened. */
  dataDir: string;
  /** Absolute; holds secrets.enc.json. Created 0700 on the first write. */
  secretsDir: string;
  /** 32 bytes, or null: credentialed sources are then disabled. */
  masterKey: Buffer | null;
  google: { clientId: string; clientSecret: string } | null;
  /** Default true: built-in PKCE Google OAuth client is available when no env or custom client is set. */
  googleBuiltin: boolean;
  timeZone: string;
  tailscaleUsers: string[];
  maxAgentProcesses: number;
  agentTimeoutScale: number;
  drainSeconds: number;
  claudePath: string;
  codexPath: string;
  ghPath: string;
  /** Dev only: GET /api/today serves this TodayPayload file instead of building one. Refused in production. */
  todayFixture: string | null;
  /** BELL Suite: sibling browser links (BELLPERSONAL_SUITE_LINKS) and loopback reads (BELLPERSONAL_SUITE_FETCH); empty when unset. */
  suite: SuiteConfig;
  /** Optional bearer token for BELL PR loopback reads/writes when provided via environment instead of vault pairing. */
  suitePrToken: string | null;
}

function validHostname(value: string): boolean {
  return value.length <= 253 && !/^[\d.]+$/.test(value) && value.split(".").every(label =>
    label.length >= 1 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
  );
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name] === undefined ? String(fallback) : env[name]!.trim();
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65535)
    throw new Error(`${name} 必須是 1024–65535 的整數。`);
  return parsed;
}

function masterKey(value: string | undefined): Buffer | null {
  const text = value?.trim();
  if (!text) return null;
  const key = Buffer.from(text, "base64");
  if (key.length !== 32 || key.toString("base64") !== text)
    throw new Error("BELLPERSONAL_MASTER_KEY 必須是剛好 32 位元組的 base64 字串（例如 node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"）。");
  return key;
}

const LOGIN = /^[^\s,@]{1,128}@[^\s,@]{1,128}$/;
function tailscaleUsers(value: string | undefined, production: boolean): string[] {
  const users = [...new Set((value ?? "").split(",").map(item => item.trim()).filter(Boolean))];
  if (users.length > 32) throw new Error("BELLPERSONAL_TAILSCALE_USERS 最多可設定 32 個帳號。");
  for (const user of users)
    if (!LOGIN.test(user)) throw new Error("BELLPERSONAL_TAILSCALE_USERS 必須是以逗號分隔的 Tailscale 登入名稱，例如 alice@github。");
  if (production && !users.length)
    throw new Error("正式環境必須設定 BELLPERSONAL_TAILSCALE_USERS，否則任何能連到 tailnet 的人都能開啟個人資料。");
  return users;
}

function drainSeconds(value: string | undefined): number {
  if (value === undefined) return 10;
  const seconds = Number(value);
  // The unit stops the process after TimeoutStopSec=20: drain + 6 s of cleanup must fit.
  if (value.trim() === "" || !Number.isInteger(seconds) || seconds < 0 || seconds > 13)
    throw new Error("BELLPERSONAL_DRAIN_SECONDS 必須是 0–13 的整數（systemd 在 20 秒後強制停止）。");
  return seconds;
}

function executable(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  return text || fallback;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const production = env.NODE_ENV === "production";
  const host = env.BELLPERSONAL_HOST === undefined ? "127.0.0.1" : env.BELLPERSONAL_HOST.trim();
  if (!isIP(host) && !validHostname(host))
    throw new Error("BELLPERSONAL_HOST 必須是有效的 IP 位址或主機名稱，不可包含通訊協定、路徑或連接埠。");
  const origins = parseAllowedOrigins(env.BELLPERSONAL_ALLOWED_ORIGINS ?? "");
  if (origins.length > 32) throw new Error("BELLPERSONAL_ALLOWED_ORIGINS 最多可設定 32 個來源。");
  const timeZone = env.BELLPERSONAL_TZ?.trim() || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new Error("BELLPERSONAL_TZ 必須是有效的 IANA 時區名稱，例如 Asia/Taipei。");
  const clientId = env.BELLPERSONAL_GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.BELLPERSONAL_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!!clientId !== !!clientSecret)
    throw new Error("BELLPERSONAL_GOOGLE_CLIENT_ID 與 BELLPERSONAL_GOOGLE_CLIENT_SECRET 必須同時設定或同時留空。");
  const builtinFlag = env.BELLPERSONAL_GOOGLE_BUILTIN?.trim().toLowerCase() ?? "";
  if (builtinFlag && builtinFlag !== "on" && builtinFlag !== "off")
    throw new Error("BELLPERSONAL_GOOGLE_BUILTIN 只能是 on 或 off。");
  const suitePrTokenRaw = env.BELLPERSONAL_SUITE_PR_TOKEN?.trim() ?? "";
  if (suitePrTokenRaw.length > 256 || /\s/.test(suitePrTokenRaw))
    throw new Error("BELLPERSONAL_SUITE_PR_TOKEN 長度不可超過 256 字元，且不可包含空白。");
  const todayFixture = env.BELLPERSONAL_TODAY_FIXTURE?.trim() || null;
  if (todayFixture && production)
    throw new Error("正式環境不可設定 BELLPERSONAL_TODAY_FIXTURE（只供開發時讓 Today 介面使用示範資料）。");
  const maxAgentProcesses = parseAgentProcessLimit(env.BELLPERSONAL_MAX_AGENT_PROCESSES);
  const agentTimeoutScale = parseAgentTimeoutScale(env.BELLPERSONAL_AGENT_TIMEOUT_SCALE);
  const users = tailscaleUsers(env.BELLPERSONAL_TAILSCALE_USERS, production);
  // The first origin is the public address: the Google redirect URI and /privacy use it, and the
  // Host gate admits the tailnet name only when it is listed. Without it production would boot and
  // pass the loopback health check, then refuse every tailnet request or Google's consent.
  if (production && !origins[0]?.startsWith("https://"))
    throw new Error("正式環境必須設定 BELLPERSONAL_ALLOWED_ORIGINS，且第一個來源必須是 https 的公開網址，例如 https://<your-tailnet-host>:20003。");
  const serverPort = port(env, "BELLPERSONAL_PORT", 4331);
  const frontendPort = port(env, "BELLPERSONAL_FRONTEND_PORT", 4330);
  // Sibling origins are checked against Personal's own: the tailnet of its allowed origins, and never itself.
  const suite = readSuiteConfig(env, { ownOrigins: origins, ownPorts: [serverPort, frontendPort] });
  return {
    production,
    host,
    port: serverPort,
    frontendPort,
    allowedOrigins: [...new Set(origins)],
    dataDir: resolve(env.BELLPERSONAL_DATA_DIR?.trim() || "data"),
    secretsDir: resolve(env.BELLPERSONAL_SECRETS_DIR?.trim() || ".secrets"),
    masterKey: masterKey(env.BELLPERSONAL_MASTER_KEY),
    google: clientId ? { clientId, clientSecret } : null,
    googleBuiltin: builtinFlag !== "off",
    timeZone,
    tailscaleUsers: users,
    maxAgentProcesses,
    agentTimeoutScale,
    drainSeconds: drainSeconds(env.BELLPERSONAL_DRAIN_SECONDS),
    claudePath: executable(env.CLAUDE_CLI_PATH, "claude"),
    codexPath: executable(env.CODEX_CLI_PATH, "codex"),
    ghPath: executable(env.GH_CLI_PATH, "gh"),
    todayFixture: todayFixture ? resolve(todayFixture) : null,
    suite,
    suitePrToken: suitePrTokenRaw || null,
  };
}
