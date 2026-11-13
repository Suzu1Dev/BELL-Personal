import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { GitHubItem } from "../../../shared/github.js";
import { PROJECT_LIMITS, projectRepos, type ProjectDeleteResponse, type ProjectDetail, type ProjectListResponse } from "../../../shared/projects.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import { projectFields, repoViews, uniqueRepos, type ProjectStore } from "./store.js";

const createBody = z.object({
  name: projectFields.name,
  description: projectFields.description.optional(),
  color: projectFields.color.optional(),
  status: projectFields.status.optional(),
  repos: projectFields.repos.optional(),
  progress: projectFields.progress.nullable().optional(),
  milestones: z.array(z.object({ title: projectFields.milestoneTitle, dueDay: projectFields.dueDay.optional() }).strict()).max(PROJECT_LIMITS.milestones).optional(),
}).strict();

const updateBody = z.object({
  name: projectFields.name.optional(),
  description: projectFields.description.nullable().optional(),
  color: projectFields.color.optional(),
  status: projectFields.status.optional(),
  repos: projectFields.repos.optional(),
  progress: projectFields.progress.nullable().optional(),
}).strict();

const milestoneCreate = z.object({ title: projectFields.milestoneTitle, dueDay: projectFields.dueDay.optional() }).strict();
const milestoneUpdate = z.object({
  title: projectFields.milestoneTitle.optional(),
  dueDay: projectFields.dueDay.nullable().optional(),
  done: z.boolean().optional(),
}).strict();

const idParam = z.string().min(1).max(100);

/**
 * /api/projects (#/work?tab=projects, #/work/projects/:id):
 *   GET    /[?archived=include]            ProjectListResponse (archived projects only when asked)
 *   POST   /                               ProjectCreateRequest → 201 Project
 *   GET    /:id                            ProjectDetail
 *   PATCH  /:id                            ProjectUpdateRequest → Project
 *   DELETE /:id                            → ProjectDeleteResponse (undo with POST /api/trash/restore)
 *   POST   /:id/milestones                 MilestoneCreateRequest → 201 Project
 *   PATCH  /:id/milestones/:milestoneId    MilestoneUpdateRequest → Project
 *   DELETE /:id/milestones/:milestoneId    → Project
 */
export function createProjectsRouter(ctx: ModuleContext, store: ProjectStore): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const includeArchived = req.query.archived === "include";
    res.json({ projects: store.list({ includeArchived }).map((project) => store.summary(project)) } satisfies ProjectListResponse);
  });

  router.post("/", (req, res) => {
    const input = createBody.parse(req.body);
    res.status(201).json(store.create(input));
  });

  router.get("/:id", (req, res) => {
    const project = store.get(idParam.parse(req.params.id));
    if (!project) throw new AppError(404, "找不到這個專案。");
    const github = ctx.sourceItems.list<GitHubItem>({ source: "github", kind: "github-item" }).map((item) => item.value);
    const detail: ProjectDetail = {
      project,
      summary: store.summary(project),
      todos: store.todos(project.id),
      repos: repoViews(projectRepos(project), github),
    };
    res.json(detail);
  });

  router.patch("/:id", (req, res) => {
    const input = updateBody.parse(req.body);
    const project = store.update(idParam.parse(req.params.id), (current) => {
      const next = { ...current };
      if (input.name !== undefined) next.name = input.name;
      if (input.description !== undefined) {
        if (input.description) next.description = input.description;
        else delete next.description;
      }
      if (input.color !== undefined) next.color = input.color;
      if (input.status !== undefined) next.status = input.status;
      if (input.repos !== undefined) {
        const repos = uniqueRepos(input.repos);
        if (repos.length) { next.repos = repos; next.repo = repos[0]; }
        else { delete next.repos; delete next.repo; }
      }
      if (input.progress !== undefined) {
        if (input.progress === null) delete next.progress;
        else next.progress = input.progress;
      }
      return next;
    });
    res.json(project);
  });

  router.delete("/:id", (req, res) => {
    const result = store.delete(idParam.parse(req.params.id));
    res.json({ deleted: true, ...(result.undoToken ? { undoToken: result.undoToken } : {}) } satisfies ProjectDeleteResponse);
  });

  router.post("/:id/milestones", (req, res) => {
    const input = milestoneCreate.parse(req.body);
    const project = store.update(idParam.parse(req.params.id), (current) => {
      if (current.milestones.length >= PROJECT_LIMITS.milestones) throw new AppError(400, `一個專案最多 ${PROJECT_LIMITS.milestones} 個里程碑。`);
      return { ...current, milestones: [...current.milestones, { id: randomUUID(), title: input.title, ...(input.dueDay ? { dueDay: input.dueDay } : {}), done: false }] };
    });
    res.status(201).json(project);
  });

  router.patch("/:id/milestones/:milestoneId", (req, res) => {
    const input = milestoneUpdate.parse(req.body);
    const milestoneId = idParam.parse(req.params.milestoneId);
    const project = store.update(idParam.parse(req.params.id), (current) => {
      const index = current.milestones.findIndex((item) => item.id === milestoneId);
      if (index < 0) throw new AppError(404, "找不到這個里程碑。");
      const milestone = { ...current.milestones[index] };
      if (input.title !== undefined) milestone.title = input.title;
      if (input.dueDay !== undefined) {
        if (input.dueDay) milestone.dueDay = input.dueDay;
        else delete milestone.dueDay;
      }
      if (input.done !== undefined && input.done !== milestone.done) {
        milestone.done = input.done;
        if (input.done) milestone.doneAt = ctx.now().toISOString();
        else delete milestone.doneAt;
      }
      const milestones = [...current.milestones];
      milestones[index] = milestone;
      return { ...current, milestones };
    });
    res.json(project);
  });

  router.delete("/:id/milestones/:milestoneId", (req, res) => {
    const milestoneId = idParam.parse(req.params.milestoneId);
    const project = store.update(idParam.parse(req.params.id), (current) => {
      if (!current.milestones.some((item) => item.id === milestoneId)) throw new AppError(404, "找不到這個里程碑。");
      return { ...current, milestones: current.milestones.filter((item) => item.id !== milestoneId) };
    });
    res.json(project);
  });

  return router;
}
