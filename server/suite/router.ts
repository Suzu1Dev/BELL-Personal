import { Router } from "express";
import { z } from "zod";
import type { SuiteBridge } from "./bridge.js";
import type { SuiteService } from "./service.js";

/**
 * `/api/suite` (suite-contract v1 §2, §4) plus BELL PR pairing (`/api/suite/pr`).
 * Mounted in createApp after the origin guard and the identity gate, so all
 * routes are same-origin, owner-only: not in PUBLIC_PATHS, no CORS headers.
 */
export function createSuiteRouter(suite: SuiteService, bridge?: SuiteBridge): Router {
  const router = Router();
  router.get("/manifest", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(suite.manifest());
  });
  router.get("/sources", async (req, res) => {
    const body = await suite.sources(req.query.refresh === "1");
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  });
  if (bridge) {
    router.get("/pr", async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await bridge.prStatus());
    });
    router.post("/pr/pair", async (req, res) => {
      const { code } = z.object({ code: z.string().trim().min(1).max(32) }).strict().parse(req.body);
      res.setHeader("Cache-Control", "no-store");
      res.json(await bridge.pairPr(code));
    });
    router.put("/pr/token", async (req, res) => {
      const { token } = z.object({ token: z.string().trim().min(1).max(256) }).strict().parse(req.body);
      res.setHeader("Cache-Control", "no-store");
      res.json(await bridge.setPrToken(token));
    });
    router.delete("/pr", async (req, res) => {
      z.object({}).strict().parse(req.body ?? {});
      res.setHeader("Cache-Control", "no-store");
      res.json(await bridge.disconnectPr());
    });
  }
  return router;
}
