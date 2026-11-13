import { Router, type Response } from "express";
import type { JobEvent } from "../shared/jobs.js";
import { AppError } from "./errors.js";
import type { JobRegistry } from "./jobs.js";

export interface StreamJobOptions {
  /**
   * Cancel the job when this connection closes before its outcome was sent.
   * For jobs whose only reader is this request and that nobody resumes (the
   * palette's capture parse): without it, a request aborted while it was in
   * flight leaves a job holding the agent slot with no one to answer.
   */
  cancelOnDisconnect?: boolean;
}

/**
 * Streams a job as NDJSON: {type:"job",id} first, then past and live events up
 * to the outcome (bell-explain app.ts). Closing the connection only stops
 * following and the job keeps running, unless `cancelOnDisconnect` is set.
 * Compression skips application/x-ndjson.
 */
export function streamJob(res: Response, jobs: JobRegistry, id: string, from = 0, options: StreamJobOptions = {}): void {
  res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");
  // During shutdown the connection is not kept for further requests (set before the headers go out).
  if (jobs.shuttingDown) res.setHeader("Connection", "close");
  res.flushHeaders();
  const write = (event: JobEvent) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`); };
  write({ type: "job", id });
  let stop: (() => void) | undefined;
  const close = () => { stop?.(); if (!res.destroyed && !res.writableEnded) res.end(); };
  let following = false;
  // A finished job replays and ends during follow(); a live one ends as its outcome is written.
  stop = jobs.follow(id, from, write, () => { if (following) close(); else setImmediate(close); });
  following = true;
  const disconnected = () => {
    // After a normal end the outcome was written (writableFinished); anything else is the client leaving.
    if (options.cancelOnDisconnect && !res.writableFinished) jobs.cancel(id, "連線已中斷，這次工作已取消。");
  };
  res.on("close", () => {
    stop?.();
    disconnected();
  });
  // The client may already be gone (aborted while the request was in flight): 'close' was emitted before we listened.
  if (res.destroyed) {
    stop?.();
    disconnected();
  }
}

/** GET /api/jobs, GET /api/jobs/:id, GET /api/jobs/:id/events?from=N, DELETE /api/jobs/:id. */
export function createJobsRouter(jobs: JobRegistry): Router {
  const router = Router();
  const missing = () => new AppError(404, "找不到這個工作，伺服器可能已重新啟動。");
  router.get("/", (_req, res) => { res.json(jobs.list()); });
  router.get("/:id", (req, res) => {
    const view = jobs.get(req.params.id) ?? jobs.outcome(req.params.id);
    if (!view) throw missing();
    res.json(view);
  });
  router.get("/:id/events", (req, res) => {
    if (!jobs.get(req.params.id)) {
      // Events are gone but the outcome is known: answer with it, so a device that
      // slept for a long time is told the truth.
      const ended = jobs.outcome(req.params.id);
      if (!ended) throw missing();
      const outcome: JobEvent = ended.status === "done"
        ? { type: "done" }
        : {
            type: "error",
            message: ended.error || "這次工作沒有完成。",
            ...(ended.errorDetail ? { detail: ended.errorDetail } : {}),
          };
      res.status(200).setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.end(`${JSON.stringify({ type: "job", id: ended.id } satisfies JobEvent)}\n${JSON.stringify(outcome)}\n`);
      return;
    }
    const from = Number(req.query.from ?? 0);
    streamJob(res, jobs, req.params.id, Number.isInteger(from) && from >= 0 ? from : 0);
  });
  router.delete("/:id", (req, res) => {
    if (!jobs.get(req.params.id)) throw missing();
    jobs.cancel(req.params.id);
    res.status(204).end();
  });
  return router;
}
