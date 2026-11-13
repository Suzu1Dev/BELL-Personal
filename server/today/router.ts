import { Router } from "express";
import { FixtureActions } from "./fixture.js";
import type { TodayService } from "./service.js";

/**
 * GET /api/today, POST /api/actions, GET /api/actions/:actionId,
 * DELETE /api/actions/:actionId (core routes, mounted under /api).
 * With the dev fixture override the page data comes from the file and actions
 * are kept in memory without touching any data (FixtureActions): they are
 * replayed on the fixture, so the UI's optimistic flow, the undo toast and
 * the commit check behave as they do against real data.
 */
export function createTodayRouter(today: TodayService, now: () => Date): Router {
  const router = Router();
  const fixtureActions = new FixtureActions(now);

  router.get("/today", async (_req, res) => {
    res.json(today.fixturePath ? fixtureActions.apply(await today.fixture()) : await today.build());
  });

  router.post("/actions", async (req, res) => {
    res.status(202).json(today.fixturePath ? fixtureActions.accept(req.body) : await today.actions.perform(req.body));
  });

  router.get("/actions/:actionId", (req, res) => {
    res.json(today.fixturePath ? fixtureActions.status(req.params.actionId) : today.actions.status(req.params.actionId));
  });

  router.delete("/actions/:actionId", async (req, res) => {
    res.json(today.fixturePath ? fixtureActions.undo(req.params.actionId) : await today.actions.undo(req.params.actionId));
  });

  return router;
}
