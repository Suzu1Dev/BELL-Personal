import { Router } from "express";
import { z } from "zod";
import { isDayKey, isLocalTime } from "../../../shared/time.js";
import {
  TODO_ESTIMATE_MAX_MINUTES, TODO_LIMITS, TODO_PRIORITIES,
  type Todo, type TodoDeleteResponse, type TodoListResponse,
} from "../../../shared/todos.js";
import type { ModuleContext } from "../../modules.js";
import { cancelTidy } from "../capture/tidy.js";
import type { TodoStore } from "./store.js";

const dayKeySchema = z.string().refine(isDayKey, { message: "日期格式不正確" });
const timeSchema = z.string().refine(isLocalTime, { message: "時間格式不正確" });
const idSchema = z.string().min(1).max(100);

const createSchema = z.object({
  title: z.string().trim().min(1, { message: "請輸入待辦內容" }).max(TODO_LIMITS.title),
  notes: z.string().max(TODO_LIMITS.notes).optional(),
  dueDay: dayKeySchema.optional(),
  dueTime: timeSchema.optional(),
  priority: z.enum(TODO_PRIORITIES).optional(),
  projectId: z.string().max(100).optional(),
  estimateMinutes: z.number().int().positive().max(TODO_ESTIMATE_MAX_MINUTES).optional(),
}).strict();

const updateSchema = z.object({
  title: z.string().trim().min(1, { message: "請輸入待辦內容" }).max(TODO_LIMITS.title).optional(),
  notes: z.string().max(TODO_LIMITS.notes).nullable().optional(),
  dueDay: dayKeySchema.nullable().optional(),
  dueTime: timeSchema.nullable().optional(),
  priority: z.enum(TODO_PRIORITIES).optional(),
  projectId: z.string().max(100).nullable().optional(),
  estimateMinutes: z.number().int().positive().max(TODO_ESTIMATE_MAX_MINUTES).nullable().optional(),
}).strict();

const emptySchema = z.object({}).strict();
const itemId = (id: string) => `native:${id}`;

/**
 * /api/todos (docs/ARCHITECTURE.md §10.6). 完成 from #/tasks goes through
 * POST /api/actions {itemId: "native:<id>", action: "done"} so Today's counts
 * and undo stay in one place; /complete and /uncomplete are the plain record
 * edits (uncomplete also clears the row's queue state so it comes back to Today).
 */
export function createTodosRouter(store: TodoStore, ctx: ModuleContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase().slice(0, 80) : "";
    const matches = (todo: Todo) => !query || todo.title.toLowerCase().includes(query) || (todo.notes ?? "").toLowerCase().includes(query);
    const day = ctx.today();
    const body: TodoListResponse = { day, open: store.open().filter(matches), completedToday: store.completedOn(day).filter(matches) };
    res.json(body);
  });

  router.get("/:id", (req, res) => {
    res.json(store.require(idSchema.parse(req.params.id)));
  });

  router.post("/", (req, res) => {
    const input = createSchema.parse(req.body);
    res.status(201).json(store.create({ ...input, origin: "manual" }));
  });

  // An edit while 自動整理 runs wins: the tidy stops and writes nothing.
  router.patch("/:id", (req, res) => {
    const id = idSchema.parse(req.params.id);
    const todo = store.update(id, updateSchema.parse(req.body));
    cancelTidy(ctx, "todo", id);
    res.json(todo);
  });

  router.post("/:id/complete", (req, res) => {
    emptySchema.parse(req.body ?? {});
    const id = idSchema.parse(req.params.id);
    const todo = store.complete(id);
    cancelTidy(ctx, "todo", id);
    res.json(todo);
  });

  router.post("/:id/uncomplete", (req, res) => {
    emptySchema.parse(req.body ?? {});
    const todo = store.reopen(idSchema.parse(req.params.id));
    ctx.itemState.clear(itemId(todo.id));
    res.json(todo);
  });

  router.delete("/:id", (req, res) => {
    const id = idSchema.parse(req.params.id);
    const result = store.delete(id);
    cancelTidy(ctx, "todo", id);
    ctx.itemState.clear(itemId(id));
    const body: TodoDeleteResponse = { deleted: true, ...(result.undoToken ? { undoToken: result.undoToken } : {}) };
    res.json(body);
  });

  return router;
}
