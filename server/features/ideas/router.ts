import { Router } from "express";
import { z } from "zod";
import { IDEA_LIMITS, type Idea, type IdeaDeleteResponse, type IdeaListResponse, type IdeaView } from "../../../shared/ideas.js";
import { dayKey } from "../../../shared/time.js";
import { streamJob } from "../../jobs-router.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { tagSchema, type IdeaStore } from "./store.js";
import { aiTagsEnabled, pendingProposals, startTagJob, TAG_BATCH } from "./tags.js";
import { convertIdeaToTodo } from "./to-todo.js";

const idSchema = z.string().min(1).max(100);
const createSchema = z.object({
  text: z.string().trim().min(1, { message: "請先寫下靈感內容" }).max(IDEA_LIMITS.text),
  title: z.string().max(IDEA_LIMITS.title).optional(),
  tags: z.array(tagSchema).max(IDEA_LIMITS.tags).optional(),
  pinned: z.boolean().optional(),
}).strict();
const updateSchema = z.object({
  text: z.string().max(IDEA_LIMITS.text).optional(),
  title: z.string().max(IDEA_LIMITS.title).nullable().optional(),
  tags: z.array(tagSchema).max(IDEA_LIMITS.tags).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict();
const suggestSchema = z.object({ ids: z.array(idSchema).max(10).optional() }).strict();
const emptySchema = z.object({}).strict();

const matches = (idea: Idea, query: string) =>
  idea.text.toLowerCase().includes(query) || (idea.title ?? "").toLowerCase().includes(query) || idea.tags.some((tag) => tag.toLowerCase().includes(query.replace(/^#/, "")));

/** /api/ideas: the 靈感 page (list by day, search, tags, AI tag proposals). */
export function createIdeasRouter(store: IdeaStore, ctx: ModuleContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 80) : "";
    const tag = typeof req.query.tag === "string" ? req.query.tag.trim().replace(/^#/, "").toLowerCase() : "";
    const archived = req.query.archived === "1" || req.query.archived === "true";
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));
    const active = store.list({ limit: 2000 });
    const pool = archived ? store.list({ archived: true, limit: 2000 }) : active;
    const filtered = pool.filter((idea) => (!query || matches(idea, query)) && (!tag || idea.tags.some((item) => item.toLowerCase() === tag))).slice(0, limit);
    const proposals = aiTagsEnabled(ctx) ? pendingProposals(ctx, new Map(filtered.map((idea) => [idea.id, idea]))) : new Map();
    const counts = new Map<string, { tag: string; count: number }>();
    for (const idea of active) for (const item of idea.tags) {
      const key = item.toLowerCase();
      const entry = counts.get(key) ?? { tag: item, count: 0 };
      entry.count++;
      counts.set(key, entry);
    }
    const timeZone = ctx.config.timeZone;
    const ideas: IdeaView[] = filtered.map((idea) => ({ ...idea, day: dayKey(timeZone, idea.createdAt), proposals: proposals.get(idea.id) ?? [] }));
    const body: IdeaListResponse = {
      today: ctx.today(),
      ideas,
      tags: [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
      total: active.length,
      aiTags: aiTagsEnabled(ctx),
    };
    res.json(body);
  });

  router.post("/tags/suggest", (req, res) => {
    const { ids } = suggestSchema.parse(req.body ?? {});
    const job = startTagJob(ctx, store, ids);
    streamJob(res, ctx.jobs, job.id);
  });

  router.get("/:id", (req, res) => {
    res.json(store.require(idSchema.parse(req.params.id)));
  });

  router.post("/", (req, res) => {
    const input = createSchema.parse(req.body);
    const idea = store.create({ ...input, origin: "manual" });
    proposeTagsQuietly(ctx, store, idea.id);
    res.status(201).json(idea);
  });

  router.patch("/:id", (req, res) => {
    res.json(store.update(idSchema.parse(req.params.id), updateSchema.parse(req.body)));
  });

  // 轉成待辦: the todo and the archived idea in one transaction; 復原 = POST /api/trash/restore (to-todo.ts).
  router.post("/:id/todo", (req, res) => {
    emptySchema.parse(req.body ?? {});
    res.status(201).json(convertIdeaToTodo(ctx, store, idSchema.parse(req.params.id)));
  });

  router.delete("/:id", (req, res) => {
    const result = store.delete(idSchema.parse(req.params.id));
    const body: IdeaDeleteResponse = { deleted: true, ...(result.undoToken ? { undoToken: result.undoToken } : {}) };
    res.json(body);
  });

  return router;
}

/** New ideas waiting for a background tag proposal, per store, and the tag jobs already watched for the next round. */
const waiting = new WeakMap<IdeaStore, Set<string>>();
const watched = new Set<string>();

/**
 * With 靈感自動標籤 on, a new idea gets a background tag proposal. Only one
 * idea-tags job runs at a time: an idea created meanwhile waits and goes out
 * with the next job once the running one settles, instead of being skipped.
 * A failing job is not the user's problem (logged only).
 */
export function proposeTagsQuietly(ctx: ModuleContext, store: IdeaStore, id: string): void {
  if (!aiTagsEnabled(ctx)) return;
  const queue = waiting.get(store) ?? new Set<string>();
  waiting.set(store, queue);
  queue.add(id);
  drainTagQueue(ctx, store);
}

function drainTagQueue(ctx: ModuleContext, store: IdeaStore): void {
  const queue = waiting.get(store);
  if (!queue?.size) return;
  if (!aiTagsEnabled(ctx)) { queue.clear(); return; }
  const running = ctx.jobs.running("idea-tags")[0];
  if (running) {
    if (!watched.has(running.id)) {
      watched.add(running.id);
      void ctx.jobs.settled(running.id).then(() => { watched.delete(running.id); drainTagQueue(ctx, store); });
    }
    return;
  }
  const ids = [...queue].slice(0, TAG_BATCH);
  for (const id of ids) queue.delete(id);
  try {
    const job = startTagJob(ctx, store, ids);
    watched.add(job.id);
    void ctx.jobs.settled(job.id).then(() => { watched.delete(job.id); drainTagQueue(ctx, store); });
  } catch (error) {
    logEvent("ideas.tags_skipped", { reason: error instanceof Error ? error.name : "unknown" });
    drainTagQueue(ctx, store);
  }
}
