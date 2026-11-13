import type { RequestHandler } from "express";
import { logEvent } from "./log.js";

/**
 * Request guards, in middleware order: localhostGuard (Host, Origin,
 * Sec-Fetch-Site, JSON-only writes, security headers, CSP), then
 * tailscaleIdentityGate (who the visitor is). Copied from bell-pr's guard;
 * the only behavioural change is the OAuth callback exemption below.
 */
export function parseAllowedOrigins(value = ""): string[] {
  if (!value.trim()) return [];
  return value.split(",").map((entry) => {
    const value = entry.trim();
    try {
      const url = new URL(value);
      if (
        !/^https?:\/\/[^/?#\\\s@*]+$/i.test(value) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.hostname.includes("*") ||
        value.endsWith(":") ||
        url.port === "0"
      )
        throw new Error("Invalid origin");
      return url.origin;
    } catch {
      throw new Error(
        "BELLPERSONAL_ALLOWED_ORIGINS must contain comma-separated HTTP(S) origins without credentials, paths, queries, fragments, or wildcards.",
      );
    }
  });
}

/** Google's redirect back after consent: the one route that may arrive as a cross-site navigation. */
export const OAUTH_CALLBACK = "/oauth/google/callback";

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export function localhostGuard(
  ports: number[],
  configuredOrigins = "",
): RequestHandler {
  const localHosts = new Set(
    ports.flatMap((port) => [
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
    ]),
  );
  const localOrigins = new Set([...localHosts].map((host) => `http://${host}`));
  const allowedOrigins = new Set(parseAllowedOrigins(configuredOrigins));
  const allowedHosts = new Set([
    ...localHosts,
    ...[...allowedOrigins].map((origin) => new URL(origin).host),
  ]);
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      res.status(403).json({ error: "不允許此服務網址。" });
      return;
    }
    const origin = req.get("origin");
    // Google's redirect back is a top-level cross-site GET navigation without an
    // Origin header. Only this exact path may arrive cross-site; it is protected
    // by a single-use state bound to the session plus PKCE instead.
    const oauthReturn = req.method === "GET" && req.path === OAUTH_CALLBACK && !origin;
    // Opening the app itself from another site (a link, or the redirect that follows
    // Google's callback, which browsers still label cross-site) is a top-level
    // document navigation. The page shell carries no personal data and cannot be
    // framed, so it may arrive cross-site; /api and /oauth stay same-site only.
    const pageNavigation =
      (req.method === "GET" || req.method === "HEAD") &&
      !origin &&
      req.get("sec-fetch-mode") === "navigate" &&
      req.get("sec-fetch-dest") === "document" &&
      !req.path.startsWith("/api/") &&
      !req.path.startsWith("/oauth/");
    if (
      (origin &&
        !(
          (localHosts.has(host) && localOrigins.has(origin)) ||
          (allowedOrigins.has(origin) && new URL(origin).host === host)
        )) ||
      (req.get("sec-fetch-site") === "cross-site" && !oauthReturn && !pageNavigation)
    ) {
      res.status(403).json({ error: "不允許跨來源請求。" });
      return;
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !req.is("application/json")
    ) {
      res.status(415).json({ error: "變更操作必須使用 application/json。" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    if (req.path.startsWith("/api/"))
      res.setHeader("Cache-Control", "no-store");
    next();
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** GET/HEAD paths with no personal data that anyone who can reach the host may load (deploy checks, Google's review of the privacy policy). */
export const PUBLIC_PATHS = new Set(["/api/health", "/privacy", "/privacy.css", "/favicon.svg"]);

/**
 * Adapted from bell-solver's web-access.mjs. Tailscale Serve strips spoofed
 * identity headers and inserts the verified login, and only a loopback proxy
 * may attest it. The tailnet has other identities, so origin checks alone are
 * not authentication. An empty list (development only: production refuses to
 * boot without users) lets every request through.
 */
export function tailscaleIdentityGate(users: readonly string[]): RequestHandler {
  const allowed = new Set(users);
  // First deploy check: whether Serve really sends the header on this port. The value is never logged.
  const seen = new Set<string>();
  const observe = (fields: { present: boolean; loopback: boolean; admitted: boolean }) => {
    const key = JSON.stringify(fields);
    if (seen.has(key)) return;
    seen.add(key);
    logEvent("identity.header", fields);
  };
  return (req, res, next) => {
    if (allowed.size === 0) return next();
    // Health and the privacy policy carry no personal data (deploy checks, Google's OAuth review).
    if ((req.method === "GET" || req.method === "HEAD") && PUBLIC_PATHS.has(req.path)) return next();
    const loopback = LOOPBACK.has(req.socket.remoteAddress ?? "");
    const login = req.get("tailscale-user-login");
    const admitted = Boolean(loopback && login && allowed.has(login));
    observe({ present: Boolean(login), loopback, admitted });
    if (admitted) return next();
    res.status(403).json({ error: "此服務只開放給擁有者的 Tailscale 帳號。" });
  };
}
