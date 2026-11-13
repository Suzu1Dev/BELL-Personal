import { Router } from "express";
import { z } from "zod";
import { AI_CONNECTION_LIMITS, AI_CONNECTION_METHODS, AI_KEY_PROVIDERS, AI_LOGIN_METHODS } from "../../shared/ai-connections.js";
import type { AiConnectionService } from "./connections.js";

const loginParams = z.object({ method: z.enum(AI_LOGIN_METHODS) });
const keyParams = z.object({ provider: z.enum(AI_KEY_PROVIDERS) });
/** Starting a sign-in takes no options: the argv is fixed. */
const emptyBody = z.object({}).strict();
// Generous bounds here; the service checks the exact shape with fixed messages that never quote the value.
const codeBody = z.object({ code: z.string().max(AI_CONNECTION_LIMITS.code + 100) }).strict();
const keyBody = z.object({ key: z.string().max(AI_CONNECTION_LIMITS.key + 100) }).strict();
const activeBody = z.object({ method: z.enum(AI_CONNECTION_METHODS).nullable() }).strict();

/**
 * /api/ai/connections (初次設定 › 連接 AI), behind the same origin guard and
 * identity gate as every /api route. No response carries a key (a saved key's
 * row shows only savedKey: provider, a 4-character hint, verifiedAt) or anything
 * the CLI printed besides the vetted sign-in link and one-time code.
 *
 *   GET    /                        every method's state and the active one (?refresh=true re-probes the CLIs)
 *   PUT    /active                  {method | null}: the connection AI jobs use; 409 unless it is ready
 *   POST   /:method/login           chatgpt | claude: start or rejoin a sign-in → its prompt
 *   DELETE /:method/login           stop that sign-in (204)
 *   POST   /claude/login/code       {code}: the code Claude's page showed → the outcome
 *   PUT    /keys/:provider          {key}: openai | anthropic, checked, then saved in the vault
 *   DELETE /keys/:provider          forget the saved key (204)
 */
export function createAiConnectionsRouter(connections: AiConnectionService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/", async (req, res) => {
    res.json(await connections.list(req.query.refresh === "true"));
  });

  router.put("/active", async (req, res) => {
    const { method } = activeBody.parse(req.body ?? {});
    res.json(await connections.setActive(method));
  });

  router.post("/claude/login/code", async (req, res) => {
    const { code } = codeBody.parse(req.body ?? {});
    res.json(await connections.submitClaudeCode(code));
  });

  router.post("/:method/login", async (req, res) => {
    const { method } = loginParams.parse(req.params);
    emptyBody.parse(req.body ?? {});
    res.json(await connections.startLogin(method));
  });

  router.delete("/:method/login", async (req, res) => {
    const { method } = loginParams.parse(req.params);
    await connections.cancelLogin(method);
    res.status(204).end();
  });

  router.put("/keys/:provider", async (req, res) => {
    const { provider } = keyParams.parse(req.params);
    const { key } = keyBody.parse(req.body ?? {});
    res.json(await connections.saveKey(provider, key));
  });

  router.delete("/keys/:provider", async (req, res) => {
    const { provider } = keyParams.parse(req.params);
    await connections.deleteKey(provider);
    res.status(204).end();
  });

  return router;
}
