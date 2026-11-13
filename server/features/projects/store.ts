import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GitHubItem } from "../../../shared/github.js";
import {
  PROJECT_COLORS, PROJECT_LIMITS, PROJECT_STATUSES, REPO_PATTERN, nextMilestone, projectProgress, projectRepos,
  type Milestone, type Project, type ProjectRepo, type ProjectSummary, type ProjectTodo,
} from "../../../shared/projects.js";
import { isDayKey } from "../../../shared/time.js";
import type { AppDatabase, DocTable } from "../../db/database.js";
import type { Trash } from "../../db/trash.js";
import { AppError } from "../../errors.js";

const dayKey = z.string().refine(isDayKey, { message: "日期格式必須是 YYYY-MM-DD" });

const milestoneSchema: z.ZodType<Milestone> = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(PROJECT_LIMITS.milestoneTitle),
  dueDay: dayKey.optional(),
  done: z.boolean(),
  doneAt: z.string().optional(),
});

/** The persisted shape (every field of the shared type; new fields optional). */
export const projectSchema: z.ZodType<Project> = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(PROJECT_LIMITS.name),
  description: z.string().max(PROJECT_LIMITS.description).optional(),
  color: z.enum(PROJECT_COLORS),
  status: z.enum(PROJECT_STATUSES),
  milestones: z.array(milestoneSchema).max(PROJECT_LIMITS.milestones),
  repo: z.string().max(141).optional(),
  repos: z.array(z.string().max(141)).max(PROJECT_LIMITS.repos).optional(),
  progress: z.number().min(0).max(100).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Request pieces shared by the routes. */
export const projectFields = {
  name: z.string().trim().min(1, "請輸入專案名稱").max(PROJECT_LIMITS.name),
  description: z.string().trim().max(PROJECT_LIMITS.description),
  color: z.enum(PROJECT_COLORS),
  status: z.enum(PROJECT_STATUSES),
  repos: z.array(z.string().trim().regex(REPO_PATTERN, "Repo 格式是 owner/name")).max(PROJECT_LIMITS.repos),
  progress: z.number().int().min(0).max(100),
  milestoneTitle: z.string().trim().min(1, "請輸入里程碑名稱").max(PROJECT_LIMITS.milestoneTitle),
  dueDay: dayKey,
};

/** Case-insensitive de-duplication, first spelling wins. */
export function uniqueRepos(repos: string[]): string[] {
  const seen = new Set<string>();
  return repos.filter((repo) => {
    const key = repo.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Active projects by next milestone: dated first (soonest), then undated, then none; ties by name. */
export function compareByNextMilestone(a: Project, b: Project): number {
  const rank = (project: Project) => {
    const next = nextMilestone(project);
    return next ? (next.dueDay ? 0 : 1) : 2;
  };
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA - rankB;
  const dueA = nextMilestone(a)?.dueDay ?? "";
  const dueB = nextMilestone(b)?.dueDay ?? "";
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  return a.name.localeCompare(b.name, "zh-Hant");
}

const STATUS_ORDER: Record<Project["status"], number> = { active: 0, paused: 1, done: 2, archived: 3 };

const todoRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  dueDay: z.string().optional(),
  dueTime: z.string().optional(),
}).loose();

/**
 * Native projects (personal.sqlite `projects`, milestones inside the JSON) and
 * read-only views of what links to them: todos with `project_id` (owned by
 * the tasks module) and the GitHub cache for linked repositories.
 */
export class ProjectStore {
  readonly table: DocTable<Project>;

  constructor(private readonly database: AppDatabase, trash: Trash, private readonly now: () => Date) {
    this.table = database.docs<Project>({
      table: "projects",
      label: "專案",
      schema: projectSchema,
      columns: (project) => ({ status: project.status, created_at: project.createdAt }),
    }, trash);
  }

  /** Every project except archived ones, active first, then by next milestone. */
  list(options: { includeArchived?: boolean } = {}): Project[] {
    return this.table.list(options.includeArchived ? {} : { where: "status != ?", params: ["archived"] })
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || compareByNextMilestone(a, b));
  }

  get(id: string): Project | undefined {
    return this.table.get(id);
  }

  /** Strict read for writes: a row that no longer parses stops the edit instead of being overwritten. */
  require(id: string): Project {
    const project = this.table.get(id, { strict: true });
    if (!project) throw new AppError(404, "找不到這個專案。");
    return project;
  }

  create(input: { name: string; description?: string; color?: Project["color"]; status?: Project["status"]; repos?: string[]; progress?: number | null; milestones?: Array<{ title: string; dueDay?: string }> }): Project {
    const stamp = this.now().toISOString();
    const repos = uniqueRepos(input.repos ?? []);
    return this.table.put({
      id: randomUUID(),
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      color: input.color ?? "accent",
      status: input.status ?? "active",
      milestones: (input.milestones ?? []).map((milestone) => ({ id: randomUUID(), title: milestone.title, ...(milestone.dueDay ? { dueDay: milestone.dueDay } : {}), done: false })),
      ...(repos.length ? { repos, repo: repos[0] } : {}),
      ...(typeof input.progress === "number" ? { progress: input.progress } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    });
  }

  update(id: string, change: (project: Project) => Project): Project {
    return this.database.transaction(() => {
      const next = change(structuredClone(this.require(id)));
      return this.table.put({ ...next, updatedAt: this.now().toISOString() });
    });
  }

  delete(id: string): { deleted: boolean; undoToken?: string } {
    this.require(id);
    return this.table.delete(id);
  }

  openTodos(projectId: string): number {
    const row = this.database.db.prepare("SELECT COUNT(*) AS n FROM todos WHERE project_id = ? AND status = 'open'").get(projectId);
    return Number(row?.n ?? 0);
  }

  /** Todos linked to the project (open first, by due day), read straight from the tasks module's table. */
  todos(projectId: string, limit = 50): ProjectTodo[] {
    const rows = this.database.db.prepare(
      "SELECT json FROM todos WHERE project_id = ? ORDER BY status = 'done', due_day IS NULL, due_day, created_at LIMIT ?",
    ).all(projectId, limit);
    return rows.flatMap((row) => {
      try {
        const todo = todoRow.parse(JSON.parse(String(row.json)));
        return [{
          id: todo.id, title: todo.title, status: todo.status,
          ...(todo.dueDay && isDayKey(todo.dueDay) ? { dueDay: todo.dueDay } : {}),
          ...(todo.dueTime ? { dueTime: todo.dueTime } : {}),
        }];
      } catch { return []; }
    });
  }

  summary(project: Project): ProjectSummary {
    const next = nextMilestone(project);
    return {
      id: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      color: project.color,
      status: project.status,
      pct: projectProgress(project),
      manualProgress: typeof project.progress === "number",
      ...(next ? { next: { title: next.title, ...(next.dueDay ? { dueDay: next.dueDay } : {}) } } : {}),
      milestones: { done: project.milestones.filter((item) => item.done).length, total: project.milestones.length },
      repos: projectRepos(project),
      openTodos: this.openTodos(project.id),
      updatedAt: project.updatedAt,
    };
  }
}

/** What the GitHub cache knows about each linked repository. */
export function repoViews(repos: string[], items: GitHubItem[]): ProjectRepo[] {
  return repos.map((repo) => {
    const mine = items.filter((item) => item.repo.toLowerCase() === repo.toLowerCase());
    return {
      repo,
      url: `https://github.com/${repo}`,
      pullRequests: mine.filter((item) => item.kind === "pr" || item.kind === "review-request")
        .map((item) => ({ ...(item.number !== undefined ? { number: item.number } : {}), title: item.title, url: item.url, kind: item.kind as "pr" | "review-request" })),
      issues: mine.filter((item) => item.kind === "issue")
        .map((item) => ({ ...(item.number !== undefined ? { number: item.number } : {}), title: item.title, url: item.url })),
    };
  });
}
