import { z } from "zod";
import type { Idea, IdeaToTodoResponse } from "../../../shared/ideas.js";
import { TODO_LIMITS } from "../../../shared/todos.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import { todoStore } from "../todos/store.js";
import type { IdeaStore } from "./store.js";

/**
 * 轉成待辦 from #/ideas (docs/ARCHITECTURE.md §10.6.1): one transaction creates
 * the todo and archives the idea, so a failure never leaves half of it.
 *
 * 復原 goes through the existing trash: the conversion writes a small undo
 * marker under the table name below, and POST /api/trash/restore runs the
 * restorer registered here, which removes the todo and moves the idea back in
 * one transaction. Nothing new for the client: it already calls core.restore().
 */
export const IDEA_TODO_TABLE = "idea_todo";

const markerSchema = z.object({ ideaId: z.string().min(1), todoId: z.string().min(1), todoUpdatedAt: z.string().min(1) }).strict();

/** The first non-empty line is the title; what is left (and any overflow of a very long first line) is the notes. */
export function todoFieldsFromIdea(idea: Pick<Idea, "title" | "text">): { title: string; notes?: string } {
  const lines = [idea.title ?? "", idea.text].join("\n").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim());
  if (start < 0) throw new AppError(400, "這則靈感沒有內容，無法轉成待辦。");
  const first = lines[start].trim();
  const title = first.slice(0, TODO_LIMITS.title).trimEnd();
  const notes = [first.slice(title.length), ...lines.slice(start + 1)].join("\n").trim().slice(0, TODO_LIMITS.notes);
  return { title, ...(notes ? { notes } : {}) };
}

export function convertIdeaToTodo(ctx: ModuleContext, ideas: IdeaStore, id: string): IdeaToTodoResponse {
  const todos = todoStore(ctx);
  return ctx.db.personal.transaction(() => {
    const idea = ideas.require(id);
    if (idea.archived) throw new AppError(409, "這則靈感已經封存，請先移回靈感再轉成待辦。");
    const todo = todos.create({ ...todoFieldsFromIdea(idea), origin: "manual" });
    ideas.update(idea.id, { archived: true });
    const marker: z.infer<typeof markerSchema> = { ideaId: idea.id, todoId: todo.id, todoUpdatedAt: todo.updatedAt };
    return { todo, undoToken: ctx.trash.put(IDEA_TODO_TABLE, idea.id, JSON.stringify(marker)) };
  });
}

/**
 * Registers the restorer for the undo marker (once, in the module's setup).
 * It refuses when the new todo was changed since (finished, edited, tidied):
 * undoing would throw that work away, so the user is sent to #/tasks instead.
 * A todo that is already gone is not an error; the idea still comes back.
 */
export function registerIdeaTodoUndo(ctx: ModuleContext, ideas: IdeaStore): void {
  const todos = todoStore(ctx);
  ctx.trash.register(IDEA_TODO_TABLE, (record) => ctx.db.personal.transaction(() => {
    const marker = markerSchema.parse(JSON.parse(record.json));
    const idea = ideas.require(marker.ideaId);
    const todo = todos.get(marker.todoId, true);
    if (todo && (todo.status !== "open" || todo.updatedAt !== marker.todoUpdatedAt)) {
      throw new AppError(409, "這項待辦已經有變動，沒有自動復原；請到待辦頁自己處理。");
    }
    if (todo) {
      todos.discard(todo.id);
      ctx.itemState.clear(`native:${todo.id}`);
    }
    if (idea.archived) ideas.update(idea.id, { archived: false });
    return { ideaId: idea.id, todoId: marker.todoId };
  }));
}
