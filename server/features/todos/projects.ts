import { projectProgress, type Project } from "../../../shared/projects.js";
import type { ModuleContext } from "../../modules.js";

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  pct: number;
}

/**
 * Read-only look at the projects table (owned by the work team) for todo
 * meta lines (「待辦 · OS 期末專題」) and the palette's 搜尋. Lenient: a row
 * that does not parse is skipped, and this never writes.
 */
export function readProjects(ctx: Pick<ModuleContext, "db">): ProjectSummary[] {
  const rows = ctx.db.personal.db.prepare("SELECT id, json FROM projects ORDER BY created_at").all();
  const projects: ProjectSummary[] = [];
  for (const row of rows) {
    try {
      const value = JSON.parse(String(row.json)) as Partial<Project>;
      if (typeof value.name !== "string" || !value.name) continue;
      projects.push({
        id: String(row.id),
        name: value.name,
        status: typeof value.status === "string" ? value.status : "active",
        pct: projectProgress({ progress: value.progress, milestones: Array.isArray(value.milestones) ? value.milestones : [] }),
      });
    } catch {
      // Unreadable rows belong to the projects module to report.
    }
  }
  return projects;
}

export function projectNames(ctx: Pick<ModuleContext, "db">): Map<string, string> {
  return new Map(readProjects(ctx).map((project) => [project.id, project.name]));
}
