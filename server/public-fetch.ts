import { Resolver } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, isIPv4, isIPv6, type LookupFunction } from "node:net";

/**
 * Fetching a URL that someone else chose (a remote image in a mail, through
 * the mail image proxy) without letting it reach anything private:
 *
 *  - http and https only, no credentials in the URL, default ports only;
 *  - host names that only resolve inside a network (localhost, .local,
 *    .internal, .lan, the tailnet's .ts.net, single labels, .arpa…) are
 *    refused before any lookup;
 *  - every address the name resolves to must be a public unicast address
 *    (isPublicAddress: loopback, RFC 1918, link-local and the cloud metadata
 *    address, CGNAT 100.64.0.0/10 — which is the tailnet —, ULA, multicast,
 *    documentation, benchmarking, NAT64, 6to4, Teredo and IPv4-mapped
 *    private addresses are refused), otherwise nothing is sent;
 *  - the connection is pinned to the address that was checked (the
 *    connection's own lookup returns it), so a DNS answer that changes
 *    between the check and the connect (rebinding) cannot redirect it;
 *  - redirects are followed by hand, at most `maxRedirects`, and every hop is
 *    checked again (URL, name, every address, and the caller's own
 *    `checkUrl`, e.g. the image proxy's tracker list);
 *  - one deadline for the whole chain, a body cap, no cookies, no Referer,
 *    a generic User-Agent and `Accept-Encoding: identity` (no decompression
 *    bombs: the bytes counted are the bytes received).
 *
 * The network itself is a seam (`PublicNetwork`): production resolves with
 * c-ares (a Resolver per lookup: 2 s, one try, cancelled when the fetch is —
 * never getaddrinfo, which runs on libuv's small threadpool and cannot be
 * cancelled, so a slow DNS zone could hold every other lookup of the server)
 * and connects with node:http / node:https; tests and the verification
 * launcher inject one that never leaves the process.
 */

export type PublicFetchFailure =
  | "invalid-url"
  | "blocked-address"
  | "unreachable"
  | "timeout"
  | "too-large"
  | "too-many-redirects"
  | "status"
  /** The caller's checkUrl refused a hop. */
  | "refused-url";

export class PublicFetchError extends Error {
  constructor(readonly reason: PublicFetchFailure, readonly status?: number) {
    super(`public fetch failed: ${reason}`);
    this.name = "PublicFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface PinnedTarget extends ResolvedAddress {
  url: URL;
}

export interface PublicResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Stops reading and closes the connection. */
  cancel(): void;
}

export interface PublicNetwork {
  /** Every address the name resolves to (A and AAAA); stops when `signal` aborts. */
  lookup(hostname: string, signal?: AbortSignal): Promise<ResolvedAddress[]>;
  /** One GET to `target.url`, connected to `target.address` and nothing else. */
  request(target: PinnedTarget, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<PublicResponse>;
}

/** Sent instead of a product name: the sender of a mail learns nothing about the reader. */
export const GENERIC_USER_AGENT = "Mozilla/5.0";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Names that only mean something inside a network. Checked before any lookup. */
const PRIVATE_SUFFIXES = [
  "localhost", "local", "internal", "intranet", "lan", "home", "corp", "private", "home.arpa", "arpa",
  "ts.net", "onion", "test", "invalid", "example",
];

/* ------------------------------------------------------------------ addresses */

function ipv4Octets(text: string): number[] | undefined {
  if (!isIPv4(text)) return undefined;
  const octets = text.split(".").map(Number);
  return octets.length === 4 && octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? octets : undefined;
}

/** IPv4 ranges that are not public unicast (IANA special-purpose registry). */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT: Tailscale addresses live here
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
];

const ipv4Number = (octets: number[]) => ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];

function isPublicIPv4(octets: number[]): boolean {
  const value = ipv4Number(octets);
  for (const [base, bits] of IPV4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((value & mask) >>> 0) === ((ipv4Number(ipv4Octets(base)!) & mask) >>> 0)) return false;
  }
  return true;
}

/** An IPv6 address as eight 16-bit groups (zone ids dropped, an embedded IPv4 tail converted). */
export function ipv6Groups(address: string): number[] | undefined {
  let text = address.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!isIPv6(text)) return undefined;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = ipv4Octets(tail);
    if (!octets) return undefined;
    text = `${text.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
  const groups = [...head, ...(halves.length === 2 ? new Array<string>(missing).fill("0") : []), ...rest].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

function isPublicIPv6(groups: number[]): boolean {
  // IPv4-mapped (::ffff:a.b.c.d): the IPv4 address decides.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPublicIPv4([groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]);
  }
  // Only global unicast (2000::/3) is public: ::, ::1, IPv4-compatible, NAT64 64:ff9b::/96,
  // ULA fc00::/7 (Tailscale's fd7a:115c:a1e0::/48), link-local fe80::/10 and multicast ff00::/8 all fall outside it.
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && groups[1] < 0x0200) return false; // 2001::/23 IETF protocol assignments, incl. Teredo 2001::/32
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (groups[0] === 0x2002) return false; // 6to4: embeds any IPv4 address
  if (groups[0] === 0x3fff && groups[1] < 0x1000) return false; // documentation (3fff::/20)
  return true;
}

/** Whether a literal address (as DNS or the URL parser gives it) is a public unicast address. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Octets(address.trim());
  if (v4) return isPublicIPv4(v4);
  const v6 = ipv6Groups(address);
  return v6 ? isPublicIPv6(v6) : false;
}

/** A URL host (`example.com`, `127.0.0.1`, `[::1]`) without brackets. */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Names that never resolve to the public internet (checked before any lookup). */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIP(bareHost(host))) return false;
  if (!host.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * The URL policy, before any network: http(s), no credentials, default
 * port, and a host that is either a public IP literal or a name outside the
 * private suffixes. The WHATWG parser has already turned `2130706433`,
 * `0177.0.0.1`, `0x7f.1` and `127.1` into `127.0.0.1` and IPv4-mapped IPv6
 * into `[::ffff:7f00:1]`, so the literal check sees the real address.
 */
export function checkPublicUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new PublicFetchError("invalid-url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PublicFetchError("invalid-url");
  if (url.username || url.password) throw new PublicFetchError("invalid-url");
  if (url.port !== "") throw new PublicFetchError("invalid-url");
  const host = bareHost(url.hostname);
  if (!host) throw new PublicFetchError("invalid-url");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new PublicFetchError("blocked-address");
  } else if (isPrivateHostname(host)) {
    throw new PublicFetchError("blocked-address");
  }
  return url;
}

/* ------------------------------------------------------------------ fetching */

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** The one address to connect to: every address of the name must be public, or nothing is sent. */
async function resolvePublic(network: PublicNetwork, url: URL, signal: AbortSignal): Promise<ResolvedAddress> {
  const host = bareHost(url.hostname);
  const family = isIP(host);
  if (family) return { address: host, family: family === 6 ? 6 : 4 };
  let addresses: ResolvedAddress[];
  try {
    addresses = await abortable(network.lookup(host, signal), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PublicFetchError("unreachable");
  }
  if (!addresses.length) throw new PublicFetchError("unreachable");
  if (addresses.some((entry) => !isPublicAddress(entry.address))) throw new PublicFetchError("blocked-address");
  return addresses[0];
}

export interface PublicFetchOptions {
  /** Body cap in bytes. */
  maxBytes: number;
  /** One deadline for the whole redirect chain. */
  timeoutMs: number;
  maxRedirects: number;
  accept: string;
  /** The caller's own abort (the browser went away). */
  signal?: AbortSignal;
  /** Every URL of the chain (the first and each redirect) must pass this too, before anything is sent to it. */
  checkUrl?: (url: URL) => boolean;
}

export interface PublicFetchResult {
  /** The URL that answered (after redirects). */
  url: string;
  status: number;
  contentType?: string;
  body: Buffer;
  redirects: number;
}

export async function publicFetch(network: PublicNetwork, input: string, options: PublicFetchOptions): Promise<PublicFetchResult> {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const headers = { accept: options.accept, "accept-encoding": "identity", "user-agent": GENERIC_USER_AGENT };
  let url = checkPublicUrl(input);
  try {
    for (let hop = 0; ; hop++) {
      if (options.checkUrl && !options.checkUrl(url)) throw new PublicFetchError("refused-url");
      const pinned = await resolvePublic(network, url, signal);
      let response: PublicResponse;
      try {
        response = await abortable(network.request({ url, ...pinned }, { headers, signal }), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PublicFetchError("unreachable");
      }
      if (REDIRECTS.has(response.status)) {
        response.cancel();
        const location = response.headers.location;
        if (!location) throw new PublicFetchError("status", response.status);
        if (hop >= options.maxRedirects) throw new PublicFetchError("too-many-redirects");
        let next: URL;
        try { next = new URL(location, url); } catch { throw new PublicFetchError("invalid-url"); }
        url = checkPublicUrl(next);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.cancel();
        throw new PublicFetchError("status", response.status);
      }
      const declared = Number(response.headers["content-length"] ?? Number.NaN);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.cancel();
        throw new PublicFetchError("too-large");
      }
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        // Every read races the deadline too: a body that stalls mid-way still ends at timeoutMs.
        const reader = response.body[Symbol.asyncIterator]();
        for (;;) {
          const { done, value } = await abortable(reader.next(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > options.maxBytes) throw new PublicFetchError("too-large");
          chunks.push(Buffer.from(value));
        }
      } catch (error) {
        response.cancel();
        if (error instanceof PublicFetchError || signal.aborted) throw error;
        throw new PublicFetchError("unreachable");
      }
      return { url: url.href, status: response.status, contentType: response.headers["content-type"], body: Buffer.concat(chunks), redirects: hop };
    }
  } catch (error) {
    if (error instanceof PublicFetchError) throw error;
    if (deadline.aborted && !options.signal?.aborted) throw new PublicFetchError("timeout");
    throw error;
  }
}

/* ------------------------------------------------------------------ networks */

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  return flat;
}

/**
 * One GET over node:http / node:https whose socket goes to `target.address`
 * only: the connection's lookup answers with that address (never the
 * resolver), TLS still verifies the certificate for the URL's host name (SNI
 * and the hostname check use it), the Host header is the URL's, no agent is
 * shared and no cookie, Referer or credential is ever sent.
 */
export function pinnedRequest(target: PinnedTarget, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<PublicResponse> {
  const { url, address, family } = target;
  const host = bareHost(url.hostname);
  const secure = url.protocol === "https:";
  const pinned = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as LookupFunction;
  return new Promise<PublicResponse>((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: host,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: init.headers,
      agent: false,
      lookup: pinned,
      signal: init.signal,
      ...(secure && !isIP(host) ? { servername: host } : {}),
    }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: flatHeaders(response.headers),
        body: response,
        cancel: () => { response.destroy(); request.destroy(); },
      });
    });
    request.on("error", reject);
    request.end();
  });
}

/** The part of node:dns's Resolver a lookup uses (a seam for tests). */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

/** One query per family, 2 s, no retry: an image is not worth waiting on a slow zone for. */
export const LOOKUP_TIMEOUT_MS = 2000;

/**
 * Lookups with c-ares, off libuv's threadpool: a fresh Resolver per lookup
 * asks for A and AAAA together and is cancelled when `signal` aborts (the
 * fetch's deadline), so an abandoned lookup holds nothing. A family with no
 * answer counts as empty; no answer at all fails. /etc/hosts is not read
 * (nothing private is reachable through it anyway).
 */
export function resolverLookup(create: () => DnsResolver = () => new Resolver({ timeout: LOOKUP_TIMEOUT_MS, tries: 1 })): PublicNetwork["lookup"] {
  return async (hostname, signal) => {
    if (signal?.aborted) throw signal.reason;
    const resolver = create();
    const cancel = () => resolver.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      const addresses: ResolvedAddress[] = [
        ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 as const })) : []),
        ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 as const })) : []),
      ];
      if (!addresses.length) throw v4.status === "rejected" ? v4.reason : v6.status === "rejected" ? v6.reason : new Error("no address");
      return addresses;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  };
}

/** The real network: c-ares lookups (every A and AAAA answer) and pinned connections. */
export const nodePublicNetwork: PublicNetwork = {
  lookup: resolverLookup(),
  request: pinnedRequest,
};

/** Tests: nothing leaves the process unless a test injects its own network. */
export const offlineNetwork: PublicNetwork = {
  lookup: async () => { throw new Error("network disabled in tests"); },
  request: async () => { throw new Error("network disabled in tests"); },
};
