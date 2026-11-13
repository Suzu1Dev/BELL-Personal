import type { FeatureModule } from "../../modules.js";
import { createIdeasRouter } from "./router.js";
import { ideaStore } from "./store.js";
import { acceptIdeaTags } from "./tags.js";
import { registerIdeaTodoUndo } from "./to-todo.js";

/** Ideas sent to Today; the core keeps the newest 2 for the capture card's 「最近的靈感」. */
const TODAY_IDEAS = 2;

/**
 * 靈感 module (tasks team). Table: ideas (Idea, shared/ideas.ts).
 *
 *  - Routes /api/ideas: list (by day, ?q search, ?tag, ?archived=1, pending AI
 *    tag proposals), get, create, PATCH (text, tags, pinned, archived), DELETE
 *    through the trash, POST /tags/suggest (job `idea-tags`), POST /:id/todo
 *    (轉成待辦: the todo and the archived idea in one transaction; its 復原 is
 *    a trash marker `idea_todo`, restored through POST /api/trash/restore).
 *  - today(): the newest ideas for the Today capture card.
 *  - AI tags (ai.enabled && ai.ideaTags): one `idea-tags` suggestion per proposed
 *    tag; acceptSuggestion["idea-tags"] adds it when the user taps the chip.
 */
export const ideasModule: FeatureModule = {
  name: "ideas",
  label: "靈感",
  setup(ctx) {
    const store = ideaStore(ctx);
    registerIdeaTodoUndo(ctx, store);
    return {
      router: createIdeasRouter(store, ctx),
      today: () => ({ ideas: store.latest(TODAY_IDEAS).map((idea) => ({ id: idea.id, text: idea.title ?? idea.text, at: idea.createdAt })) }),
      acceptSuggestion: { "idea-tags": acceptIdeaTags(store) },
    };
  },
};
