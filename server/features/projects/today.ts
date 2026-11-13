import { nextMilestone, projectProgress, type Project } from "../../../shared/projects.js";
import type { LaterProject, SidebarProject, TodayContribution, TodayInput } from "../../../shared/today.js";
import { compareByNextMilestone } from "./store.js";

/** Sidebar PROJECTS holds at most this many (SPEC-ux §3.2). */
export const SIDEBAR_PROJECTS = 5;

/** 「10/19 題目提案」 (the UI adds 「下一步：」). */
export function nextText(project: Project): string {
  const next = nextMilestone(project);
  if (!next) return project.milestones.length ? "里程碑都完成了" : "還沒有里程碑";
  if (!next.dueDay) return next.title;
  const [, month, day] = next.dueDay.split("-").map(Number);
  return `${month}/${day} ${next.title}`;
}

/**
 * Sidebar order: the pinned `sidebar.projectIds` (in that order, skipping
 * archived or missing ones) when any are set, else active projects by next
 * milestone.
 */
export function sidebarProjects(projects: Project[], pinned: string[]): Project[] {
  const visible = projects.filter((project) => project.status !== "archived");
  if (pinned.length) {
    const byId = new Map(visible.map((project) => [project.id, project]));
    return pinned.flatMap((id) => byId.get(id) ?? []).slice(0, SIDEBAR_PROJECTS);
  }
  return visible.filter((project) => project.status === "active").sort(compareByNextMilestone).slice(0, SIDEBAR_PROJECTS);
}

/**
 * The projects module's part of GET /api/today: 專案 rows of the later card
 * (active projects by next milestone; the core keeps 3, one slot for a
 * waiting PR from the github module) and the sidebar PROJECTS list.
 */
export function projectsToday(projects: Project[], input: Pick<TodayInput, "settings">): TodayContribution {
  const active = projects.filter((project) => project.status === "active").sort(compareByNextMilestone);
  const later: LaterProject[] = active.slice(0, 3).map((project) => ({
    name: project.name,
    pct: projectProgress(project),
    next: nextText(project),
    color: project.color,
    href: `#/work/projects/${encodeURIComponent(project.id)}`,
  }));
  const sidebar: SidebarProject[] = sidebarProjects(projects, input.settings["sidebar.projectIds"] ?? []).map((project) => ({
    id: project.id,
    name: project.name,
    pct: projectProgress(project),
    color: project.color,
  }));
  return {
    ...(later.length ? { later: { projects: later } } : {}),
    ...(sidebar.length ? { sidebar: { projects: sidebar } } : {}),
  };
}
