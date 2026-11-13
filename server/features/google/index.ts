import { Router, type Request, type Response } from "express";
import type { GoogleErrorReason } from "../../../shared/connect.js";
import { googleCapabilities, googleClientConfig, googleConnected, GoogleAuthFlow, GoogleFlowError, type GoogleReturnTarget } from "../../google/auth.js";
import { logEvent } from "../../log.js";
import type { FeatureModule } from "../../modules.js";

/** Where the browser lands after the OAuth round trip (the settings or setup page reads the query). */
export const GOOGLE_RETURN_PATH = "/#/settings/sources";
export const GOOGLE_SETUP_RETURN_PATH = "/#/setup";

/** The Tailscale login the identity gate admitted (null in development without a gate). */
function login(req: Request): string | null {
  return req.get("tailscale-user-login")?.trim() || null;
}

function returnTo(res: Response, query: Record<string, string>, target: GoogleReturnTarget = "sources"): void {
  res.setHeader("Cache-Control", "no-store");
  const base = target === "setup" ? GOOGLE_SETUP_RETURN_PATH : GOOGLE_RETURN_PATH;
  res.redirect(302, `${base}?${new URLSearchParams(query).toString()}`);
}

function reasonOf(error: unknown): GoogleErrorReason {
  return error instanceof GoogleFlowError ? error.reason : "exchange";
}

/**
 * Google account connection (core platform; Gmail and Calendar build on
 * googleClient() from server/google/auth.ts). Routes:
 *   GET    /api/google              GoogleStatus
 *   PUT    /api/google/client       { clientId, clientSecret, kind? } → GoogleStatus
 *   DELETE /api/google/client       {} → GoogleStatus (resets custom client to built-in)
 *   POST   /api/google/paste        { url } → GoogleConnectResponse (desktop-client fallback)
 *   DELETE /api/google              → GoogleDisconnectResponse
 *   GET    /oauth/google/start      302 → accounts.google.com (?mode=paste for loopback, ?return=setup for onboarding)
 *   GET    /oauth/google/callback   302 → /#/settings/sources (or /#/setup)?google=connected[&missing=…] | ?google=error&reason=…
 */
export const googleModule: FeatureModule = {
  name: "google",
  label: "Google 帳號",
  setup(ctx) {
    const flow = new GoogleAuthFlow(ctx);

    const api = Router();
    api.get("/", async (_req, res) => {
      res.json(await flow.status());
    });
    api.put("/client", async (req, res) => {
      res.json(await flow.setClient(req.body));
    });
    api.delete("/client", async (req, res) => {
      res.json(await flow.clearClient(req.body));
    });
    api.post("/paste", async (req, res) => {
      res.json(await flow.paste(req.body, login(req)));
    });
    api.delete("/", async (_req, res) => {
      res.json(await flow.disconnect());
    });

    const oauth = Router();
    oauth.get("/start", async (req, res) => {
      const target: GoogleReturnTarget = req.query.return === "setup" ? "setup" : "sources";
      try {
        res.setHeader("Cache-Control", "no-store");
        res.redirect(302, await flow.begin(login(req), req.query.mode === "paste" ? "paste" : "web", target));
      } catch (error) {
        logEvent("oauth.start_failed", { provider: "google", reason: reasonOf(error) });
        returnTo(res, { google: "error", reason: reasonOf(error) }, target);
      }
    });
    // The one route that may arrive as a cross-site navigation (security.ts OAUTH_CALLBACK).
    oauth.get("/callback", async (req, res) => {
      const param = (name: string) => (typeof req.query[name] === "string" ? (req.query[name] as string) : undefined);
      const target = flow.returnTarget(param("state"));
      try {
        const result = await flow.complete({ state: param("state"), code: param("code"), error: param("error"), login: login(req) });
        const missing = result.missingScopes.filter((scope) => scope !== "openid" && scope !== "email").map((scope) => scope.replace("https://www.googleapis.com/auth/", ""));
        returnTo(res, { google: "connected", ...(missing.length ? { missing: missing.join(",") } : {}) }, target);
      } catch (error) {
        logEvent("oauth.callback_failed", { provider: "google", reason: reasonOf(error) });
        returnTo(res, { google: "error", reason: reasonOf(error) }, target);
      }
    });

    return {
      router: api,
      routes: [{ path: "/oauth/google", router: oauth }],
      status: async () => ({
        clientConfigured: !!(await googleClientConfig(ctx).catch(() => null)),
        connected: await googleConnected(ctx).catch(() => false),
        capabilities: await googleCapabilities(ctx).catch(() => ({ gmail: false, calendarRead: false, calendarWrite: false })),
      }),
    };
  },
};
