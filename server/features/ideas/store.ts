import { randomUUID } from "node:crypto";
import { z } from "zod";
import { IDEA_LIMITS, IDEA_ORIGINS, type Idea, type IdeaOrigin } from "../../../shared/ideas.js";
import type { DocTable } from "../../db/database.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";

/** A tag as stored: no leading #, no spaces, at most IDEA_LIMITS.tag characters. */
export const tagSchema = z.string().trim().transform((tag) => tag.replace(/^[#＃]+/, "").trim())
  .pipe(z.string().min(1, { message: "標籤不能是空的" }).max(IDEA_LIMITS.tag).regex(/^[^\s#＃,，]+$/, { message: "標籤不能有空白或逗號" }));

export const ideaSchema: z.ZodType<Idea> = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(IDEA_LIMITS.text),
  title: z.string().max(IDEA_LIMITS.title).optional(),
  tags: z.array(z.string().max(IDEA_LIMITS.tag)).max(IDEA_LIMITS.tags),
  pinned: z.boolean(),
  archived: z.boolean(),
  origin: z.enum(IDEA_ORIGINS),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface NewIdea {
  text: string;
  title?: string;
  tags?: string[];
  pinned?: boolean;
  origin: IdeaOrigin;
}

export interface IdeaPatch {
  text?: string;
  title?: string | null;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
}

/** Unique tags (case-insensitive), in order, capped at IDEA_LIMITS.tags. */
export function uniqueTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, IDEA_LIMITS.tags);
}

/** personal.sqlite `ideas`; one instance per database (`ideaStore(ctx)`), deletes through the trash. */
export class IdeaStore {
  readonly table: DocTable<Idea>;

  constructor(private readonly ctx: Pick<ModuleContext, "db" | "trash" | "now">) {
    this.table = ctx.db.personal.docs<Idea>({
      table: "ideas",
      label: "靈感",
      schema: ideaSchema,
      columns: (idea) => ({ archived: idea.archived ? 1 : 0, pinned: idea.pinned ? 1 : 0, created_at: idea.createdAt }),
    }, ctx.trash);
  }

  get(id: string, strict = false): Idea | undefined {
    return this.table.get(id, { strict });
  }

  require(id: string): Idea {
    const idea = this.table.get(id, { strict: true });
    if (!idea) throw new AppError(404, "找不到這則靈感，可能已經刪除了。");
    return idea;
  }

  /** Newest first. */
  list(options: { archived?: boolean; limit?: number } = {}): Idea[] {
    return this.table.list({ where: "archived = ?", params: [options.archived ? 1 : 0], orderBy: "created_at DESC", limit: options.limit ?? 1000 });
  }

  latest(count: number): Idea[] {
    return this.list({ limit: count });
  }

  create(input: NewIdea): Idea {
    const now = this.ctx.now().toISOString();
    const text = input.text.trim();
    if (!text) throw new AppError(400, "請先寫下靈感內容。");
    return this.table.put({
      id: randomUUID(),
      text: text.slice(0, IDEA_LIMITS.text),
      ...(input.title?.trim() ? { title: input.title.trim().slice(0, IDEA_LIMITS.title) } : {}),
      tags: uniqueTags(input.tags ?? []),
      pinned: input.pinned ?? false,
      archived: false,
      origin: input.origin,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(id: string, patch: IdeaPatch): Idea {
    const current = this.require(id);
    const next: Idea = { ...current, updatedAt: this.ctx.now().toISOString() };
    if (patch.text !== undefined) {
      if (!patch.text.trim()) throw new AppError(400, "靈感內容不能是空的；要刪除請用刪除。");
      next.text = patch.text.trim();
    }
    if (patch.title === null || patch.title === "") delete next.title;
    else if (patch.title !== undefined) next.title = patch.title.trim();
    if (patch.tags !== undefined) next.tags = uniqueTags(patch.tags);
    if (patch.pinned !== undefined) next.pinned = patch.pinned;
    if (patch.archived !== undefined) next.archived = patch.archived;
    return this.table.put(next);
  }

  addTags(id: string, tags: string[]): Idea {
    const current = this.require(id);
    return this.update(id, { tags: [...current.tags, ...tags] });
  }

  delete(id: string): { deleted: boolean; undoToken?: string } {
    this.require(id);
    return this.table.delete(id);
  }

  /** Removes an idea a capture created, without a trash copy (its undo). */
  discard(id: string): void {
    this.ctx.db.personal.db.prepare("DELETE FROM ideas WHERE id = ?").run(id);
  }
}

const stores = new WeakMap<object, IdeaStore>();

/** The one IdeaStore for this context's personal database. */
export function ideaStore(ctx: Pick<ModuleContext, "db" | "trash" | "now">): IdeaStore {
  let store = stores.get(ctx.db.personal);
  if (!store) {
    store = new IdeaStore(ctx);
    stores.set(ctx.db.personal, store);
  }
  return store;
}
