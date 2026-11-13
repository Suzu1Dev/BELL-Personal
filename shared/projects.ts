import type { DayKey } from "./time.js";

export const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Module colour tokens a project dot may use (see src/styles/tokens.css). */
export const PROJECT_COLORS = ["accent", "mail", "cal", "task", "event", "idea", "habit"] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export interface Milestone {
  id: string;
  title: string;
  dueDay?: DayKey;
  done: boolean;
  doneAt?: string;
}

/** Stored as one JSON document; milestones live inside it. */
export interface Project {
  id: string;
  name: string;
  description?: string;
  color: ProjectColor;
  status: ProjectStatus;
  milestones: Milestone[];
  /** Linked GitHub repository, "owner/name" (the first of `repos`; kept for older rows). */
  repo?: string;
  /** Linked GitHub repositories, "owner/name" (up to PROJECT_LIMITS.repos). */
  repos?: string[];
  /** Manual progress 0–100; when absent, progress is derived from milestones. */
  progress?: number;
  createdAt: string;
  updatedAt: string;
}

export const PROJECT_LIMITS = { name: 120, description: 2000, milestones: 50, milestoneTitle: 160, repos: 10 } as const;

/** "owner/name" as GitHub allows it. */
export const REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** Every linked repository: `repos`, else the older single `repo`. */
export function projectRepos(project: Pick<Project, "repo" | "repos">): string[] {
  return project.repos ?? (project.repo ? [project.repo] : []);
}

/** 0–100: manual value when set, otherwise the share of finished milestones. */
export function projectProgress(project: Pick<Project, "progress" | "milestones">): number {
  if (typeof project.progress === "number") return Math.max(0, Math.min(100, Math.round(project.progress)));
  if (!project.milestones.length) return 0;
  return Math.round((project.milestones.filter((item) => item.done).length / project.milestones.length) * 100);
}

/** The first unfinished milestone, earliest due day first; undated ones keep their order after dated ones. */
export function nextMilestone(project: Pick<Project, "milestones">): Milestone | undefined {
  const open = project.milestones.filter((item) => !item.done);
  const dated = open.filter((item) => item.dueDay).sort((a, b) => a.dueDay!.localeCompare(b.dueDay!));
  return dated[0] ?? open[0];
}

/* ---------------------------------------------------------------- /api/projects */

/** POST /api/projects → 201 Project. */
export interface ProjectCreateRequest {
  name: string;
  description?: string;
  color?: ProjectColor;
  status?: ProjectStatus;
  repos?: string[];
  progress?: number | null;
  milestones?: Array<{ title: string; dueDay?: DayKey }>;
}

/** PATCH /api/projects/:id → Project. `null` clears description / progress (back to milestone-based). */
export interface ProjectUpdateRequest {
  name?: string;
  description?: string | null;
  color?: ProjectColor;
  status?: ProjectStatus;
  repos?: string[];
  progress?: number | null;
}

/** POST /api/projects/:id/milestones → 201 Project. */
export interface MilestoneCreateRequest {
  title: string;
  dueDay?: DayKey;
}

/** PATCH /api/projects/:id/milestones/:milestoneId → Project. */
export interface MilestoneUpdateRequest {
  title?: string;
  dueDay?: DayKey | null;
  done?: boolean;
}

/** A row of #/work?tab=projects. */
export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  color: ProjectColor;
  status: ProjectStatus;
  pct: number;
  /** Whether pct is the manual value (else derived from milestones). */
  manualProgress: boolean;
  next?: { title: string; dueDay?: DayKey };
  milestones: { done: number; total: number };
  repos: string[];
  openTodos: number;
  updatedAt: string;
}

/** GET /api/projects */
export interface ProjectListResponse {
  projects: ProjectSummary[];
}

/** A todo linked to a project (todos.project_id), read-only here. */
export interface ProjectTodo {
  id: string;
  title: string;
  status: "open" | "done";
  dueDay?: DayKey;
  dueTime?: string;
}

/** A linked repository with what the GitHub cache knows about it. */
export interface ProjectRepo {
  repo: string;
  url: string;
  pullRequests: Array<{ number?: number; title: string; url: string; kind: "pr" | "review-request" }>;
  issues: Array<{ number?: number; title: string; url: string }>;
}

/** GET /api/projects/:id */
export interface ProjectDetail {
  project: Project;
  summary: ProjectSummary;
  todos: ProjectTodo[];
  repos: ProjectRepo[];
}

/** DELETE /api/projects/:id → 200 (POST /api/trash/restore with the token undoes it). */
export interface ProjectDeleteResponse {
  deleted: true;
  undoToken?: string;
}
