import { SUITE_LIMITS, SUITE_SIBLINGS, type SuiteSiblingId } from "../../shared/suite.js";

/**
 * BELL Suite settings (suite-contract v1 §1), ported from
 * bell-suite/contracts/v1/reference.mjs (parseLinks, parseFetch). Browser
 * links and server reads are separate: a link origin only ever appears in an
 * `<a href>` or a `location` navigation (never connect-src, CORS, Host or
 * Origin), and the server reads only the loopback origins in `fetch`. Both
 * are fixed at boot; no request can choose or change them.
 */
export interface SuiteConfig {
  /** BELLPERSONAL_SUITE_LINKS: the siblings' browser origins; an absent app is 未連結. */
  links: Partial<Record<SuiteSiblingId, string>>;
  /** BELLPERSONAL_SUITE_FETCH: http on an IP-literal loopback the server reads `/api/suite/today` from. */
  fetch: Partial<Record<SuiteSiblingId, string>>;
}

/** What "pointing at Personal itself" means: its own allowed origins and its own ports on loopback. */
export interface SuiteSelf {
  ownOrigins: readonly string[];
  ownPorts: readonly number[];
}

const LINKS = "BELLPERSONAL_SUITE_LINKS";
const FETCH = "BELLPERSONAL_SUITE_FETCH";

const isSibling = (appId: string): appId is SuiteSiblingId => (SUITE_SIBLINGS as readonly string[]).includes(appId);

/** `appId=origin`, comma-separated, at most three, each app once, siblings only. */
function entries(value: string | undefined, variable: string): Array<[SuiteSiblingId, string]> {
  const text = (value ?? "").trim();
  if (!text) return [];
  const list = text.split(",").map((part) => part.trim());
  if (list.length > SUITE_LIMITS.links) throw new Error(`${variable} 最多可設定 ${SUITE_LIMITS.links} 筆。`);
  const seen = new Set<string>();
  return list.map((part) => {
    const match = /^([a-z]+)=(.+)$/.exec(part);
    if (!match) throw new Error(`${variable} 的每一筆必須是「app=來源」並以逗號分隔，例如 explain=http://127.0.0.1:20001。`);
    const [, appId, origin] = match as unknown as [string, string, string];
    if (seen.has(appId)) throw new Error(`${variable} 重複設定了 ${appId}。`);
    seen.add(appId);
    if (!isSibling(appId)) throw new Error(`${variable} 只接受 explain 與 pr，不可設定 BELL Personal 自己或其他 app。`);
    return [appId, origin];
  });
}

/** An exact origin: scheme, host and port only (no credentials, path, trailing slash, query, fragment, wildcard, port 0). */
function exactOrigin(value: string, variable: string, appId: SuiteSiblingId): URL {
  const refuse = () =>
    new Error(`${variable} 的 ${appId} 必須是完整的來源（通訊協定、主機與連接埠），不可包含帳密、路徑（含結尾的 /）、query、fragment、萬用字元或連接埠 0。`);
  if (!/^https?:\/\/[^/?#\\\s@*]+$/i.test(value) || value.endsWith(":")) throw refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refuse();
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") throw refuse();
  return url;
}

function loopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "localhost") return true;
  const parts = bare.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 127.0.0.0/8 or [::1] as an IP literal: no DNS, not even localhost. */
const loopbackIpLiteral = (hostname: string): boolean => hostname !== "localhost" && loopbackHostname(hostname);

/** The tailnet of a MagicDNS name (`host.tailnet.ts.net` → `tailnet.ts.net`); at least four labels. */
function tailnetOf(hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split(".");
  return labels.length >= 4 && labels.at(-1) === "net" && labels.at(-2) === "ts" ? labels.slice(-3).join(".") : undefined;
}

const effectivePort = (url: URL): number => Number(url.port || (url.protocol === "https:" ? 443 : 80));

function selfError(variable: string, appId: SuiteSiblingId): Error {
  return new Error(`${variable} 的 ${appId} 不可指向 BELL Personal 自己的位址。`);
}

/**
 * A browser link: loopback (http or https), or https on a MagicDNS name in the
 * same tailnet as one of Personal's own allowed origins. Any other host, an
 * arbitrary https site included, is refused.
 */
function linkOrigin(value: string, appId: SuiteSiblingId, self: SuiteSelf): string {
  const url = exactOrigin(value, LINKS, appId);
  if (self.ownOrigins.includes(url.origin)) throw selfError(LINKS, appId);
  if (loopbackHostname(url.hostname)) {
    if (self.ownPorts.includes(effectivePort(url))) throw selfError(LINKS, appId);
    return url.origin;
  }
  const tailnet = url.protocol === "https:" ? tailnetOf(url.hostname) : undefined;
  const own = new Set(self.ownOrigins.map((origin) => {
    try { return tailnetOf(new URL(origin).hostname); } catch { return undefined; }
  }).filter(Boolean));
  if (!tailnet || !own.has(tailnet))
    throw new Error(`${LINKS} 的 ${appId} 若不是本機位址，必須是 https 的 *.ts.net 網址，且與 BELLPERSONAL_ALLOWED_ORIGINS 位於同一個 tailnet。`);
  return url.origin;
}

/** A server read target: http on an IP-literal loopback only. */
function fetchOrigin(value: string, appId: SuiteSiblingId, self: SuiteSelf): string {
  const url = exactOrigin(value, FETCH, appId);
  if (url.protocol !== "http:" || !loopbackIpLiteral(url.hostname))
    throw new Error(`${FETCH} 的 ${appId} 只接受本機 IP 的 http 來源，例如 http://127.0.0.1:20001 或 http://[::1]:20001（不接受 localhost、https 或其他主機）。`);
  if (self.ownPorts.includes(effectivePort(url))) throw selfError(FETCH, appId);
  return url.origin;
}

export function parseSuiteLinks(value: string | undefined, self: SuiteSelf): SuiteConfig["links"] {
  const links: SuiteConfig["links"] = {};
  for (const [appId, origin] of entries(value, LINKS)) links[appId] = linkOrigin(origin, appId, self);
  return links;
}

export function parseSuiteFetch(value: string | undefined, self: SuiteSelf): SuiteConfig["fetch"] {
  const targets: SuiteConfig["fetch"] = {};
  for (const [appId, origin] of entries(value, FETCH)) targets[appId] = fetchOrigin(origin, appId, self);
  return targets;
}

/** Both variables; throws a zh-TW error naming the variable (readRuntimeConfig, at boot). */
export function readSuiteConfig(env: NodeJS.ProcessEnv, self: SuiteSelf): SuiteConfig {
  return { links: parseSuiteLinks(env.BELLPERSONAL_SUITE_LINKS, self), fetch: parseSuiteFetch(env.BELLPERSONAL_SUITE_FETCH, self) };
}
