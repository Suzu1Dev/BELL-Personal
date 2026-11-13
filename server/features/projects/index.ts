import type { FeatureModule } from "../../modules.js";
import { createProjectsRouter } from "./router.js";
import { ProjectStore } from "./store.js";
import { projectsToday } from "./today.js";

/**
 * 專案 (work team): native projects with milestones and progress, linked
 * GitHub repositories and the todos that point at them (todos.project_id,
 * owned by the tasks module, read here only).
 *
 * Table: personal.sqlite `projects` (v1; milestones live inside the JSON).
 * Routes (/api/projects): see router.ts. today(): later.projects and
 * sidebar.projects (see today.ts).
 */
export const projectsModule: FeatureModule = {
  name: "projects",
  label: "專案",
  setup(ctx) {
    const store = new ProjectStore(ctx.db.personal, ctx.trash, ctx.now);
    return {
      router: createProjectsRouter(ctx, store),
      today: (_context, input) => projectsToday(store.list(), input),
    };
  },
};
