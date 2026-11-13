import http from "node:http";

/** Why a sibling read failed; the only detail that reaches the log (with appId and ms). */
export type SuiteFailure = "timeout" | "too-large" | "status" | "content-type" | "invalid" | "version" | "connect";

export class SuiteReadError extends Error {
  constructor(readonly reason: SuiteFailure) {
    super(`suite read failed: ${reason}`);
    this.name = "SuiteReadError";
  }
}

export interface SuiteReadRequest {
  /** A configured BELLPERSONAL_SUITE_FETCH origin (http, IP-literal loopback). */
  origin: string;
  /** Fixed by the caller (`/api/suite/today`); never taken from a request. */
  path: string;
  timeoutMs: number;
  maxBytes: number;
  /** Optional server-held Bearer token (for BELL PR); never taken from an incoming request. */
  bearerToken?: string;
}

/** Reads one JSON document from a sibling: the parsed value, or a SuiteReadError. */
export type SuiteTransport = (request: SuiteReadRequest) => Promise<unknown>;

export interface SuiteCallRequest {
  origin: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  bearerToken?: string;
  timeoutMs: number;
  maxBytes: number;
  /** When true, accepts `application/x-ndjson` and resolves as soon as the first JSON line arrives. */
  firstNdjsonLine?: boolean;
}

export interface SuiteCallResult {
  status: number;
  json: unknown;
}

export type SuiteCallTransport = (request: SuiteCallRequest) => Promise<SuiteCallResult>;

// An agent of its own, never fetch() or http.globalAgent: the host exports a proxy together with
// NODE_USE_ENV_PROXY, which the global agents follow, and a loopback read must never leave the host.
// No keep-alive: each read opens one connection and closes it.
const agent = new http.Agent({ keepAlive: false });

/**
 * GET over node:http with the contract's limits (suite-contract v1 §4): one
 * deadline for connect, headers and body (the socket is destroyed when it
 * passes), the body streamed against a byte cap (destroyed as soon as it is
 * exceeded), 200 only (redirects are never followed), application/json only,
 * strict UTF-8. The only request header besides Host is Accept (plus
 * Authorization when reading BELL PR with a server-stored token): no cookie,
 * Origin, identity or anything from the incoming request.
 */
export const readSiblingJson: SuiteTransport = ({ origin, path, timeoutMs, maxBytes, bearerToken }) =>
  new Promise((resolve, reject) => {
    const target = new URL(origin);
    let request: http.ClientRequest | undefined;
    let settled = false;
    const finish = (error: SuiteReadError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        request?.destroy();
        reject(error);
      } else resolve(value);
    };
    const deadline = setTimeout(() => finish(new SuiteReadError("timeout")), timeoutMs);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    request = http.request(
      {
        agent,
        protocol: "http:",
        // An IP literal (config refuses names), so no DNS lookup happens.
        hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: Number(target.port || 80),
        method: "GET",
        path,
        headers,
      },
      (response) => {
        if (response.statusCode !== 200) return finish(new SuiteReadError("status"));
        const type = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (type !== "application/json") return finish(new SuiteReadError("content-type"));
        if (Number(response.headers["content-length"]) > maxBytes) return finish(new SuiteReadError("too-large"));
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) finish(new SuiteReadError("too-large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          let value: unknown;
          try {
            value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            return finish(new SuiteReadError("invalid"));
          }
          finish(null, value);
        });
        response.on("error", () => finish(new SuiteReadError("connect")));
        response.on("close", () => { if (!response.complete) finish(new SuiteReadError("connect")); });
      },
    );
    request.on("error", () => finish(new SuiteReadError("connect")));
    request.end();
  });

/**
 * Loopback sibling API call (GET or POST JSON, or first-line NDJSON job handoff
 * for BELL Explain's POST /api/generate) over the isolated loopback agent.
 */
export const callSiblingJson: SuiteCallTransport = ({
  origin,
  method,
  path,
  body,
  bearerToken,
  timeoutMs,
  maxBytes,
  firstNdjsonLine = false,
}) =>
  new Promise((resolve, reject) => {
    const target = new URL(origin);
    const payload = method === "POST" ? Buffer.from(JSON.stringify(body ?? {}), "utf8") : undefined;
    let request: http.ClientRequest | undefined;
    let settled = false;
    const finish = (error: SuiteReadError | null, result?: SuiteCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        request?.destroy();
        reject(error);
      } else {
        resolve(result!);
      }
    };
    const deadline = setTimeout(() => finish(new SuiteReadError("timeout")), timeoutMs);
    const headers: Record<string, string> = {
      Accept: firstNdjsonLine ? "application/x-ndjson, application/json" : "application/json",
    };
    if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    request = http.request(
      {
        agent,
        protocol: "http:",
        hostname: target.hostname.replace(/^\[(.*)\]$/, "$1"),
        port: Number(target.port || 80),
        method,
        path,
        headers,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 204) {
          response.resume();
          return finish(null, { status, json: null });
        }
        const type = String(response.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (firstNdjsonLine && status === 200 && type === "application/x-ndjson") {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) return finish(new SuiteReadError("too-large"));
            chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            const newline = buf.indexOf(0x0a);
            if (newline >= 0) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, newline)));
              } catch {
                return finish(new SuiteReadError("invalid"));
              }
              finish(null, { status, json: parsed });
              request?.destroy();
            }
          });
          response.on("end", () => finish(new SuiteReadError("invalid")));
          response.on("error", () => { if (!settled) finish(new SuiteReadError("connect")); });
          return;
        }
        if (type !== "application/json") return finish(new SuiteReadError("content-type"));
        if (Number(response.headers["content-length"]) > maxBytes) return finish(new SuiteReadError("too-large"));
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) finish(new SuiteReadError("too-large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          let value: unknown;
          try {
            value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
          } catch {
            return finish(new SuiteReadError("invalid"));
          }
          finish(null, { status, json: value });
        });
        response.on("error", () => finish(new SuiteReadError("connect")));
        response.on("close", () => { if (!response.complete && !settled) finish(new SuiteReadError("connect")); });
      },
    );
    request.on("error", () => { if (!settled) finish(new SuiteReadError("connect")); });
    if (payload) request.write(payload);
    request.end();
  });
