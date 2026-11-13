/**
 * #/work?tab=projects (SPEC-ux §3.3): the `.project-row` list (name, next
 * milestone, 6px progress bar, mono %), status chips, and the next dated
 * milestones in the side column.
 */
import { useState, type CSSProperties } from "react";
import type { ProjectListResponse, ProjectSummary } from "../../../shared/projects";
import { ERRORS } from "../../copy/common";
import { PROJECT_STATUS_LABELS, PROJECTS, WORK_PAGE } from "../../copy/work";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { ChipGroup } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { ChevronRight, Flag, FolderKanban, Icon, Plus, RefreshCw } from "./icons";
import { Notice } from "../../components/Notice";
import { Pill } from "../../components/Pill";
import { SkeletonRow } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { routeHref } from "../../lib/router";
import { clockTime, projectColorVar } from "../../lib/today-model";
import type { Poll } from "../../lib/usePoll";
import { weekdayChar } from "../../../shared/today-format";
import { filterProjects, projectNext, shortDay, upcomingMilestones, type ProjectFilter } from "./work-model";

export function ProjectsTab({ poll, timeZone, onCreate }: { poll: Poll<ProjectListResponse>; timeZone: string; onCreate: () => void }) {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const projects = poll.data?.projects ?? [];
  const visible = filterProjects(projects, filter);
  const count = (status: ProjectFilter) => filterProjects(projects, status).length;
  const staleSince = poll.state === "stale" && poll.updatedAt ? clockTime(new Date(poll.updatedAt).toISOString(), timeZone) : undefined;

  let body;
  if (poll.state === "loading") body = <div className="skel-list" aria-busy="true">{[0, 1, 2].map((index) => <SkeletonRow key={index} />)}</div>;
  else if (poll.state === "error") body = (
    <Notice tone="error" title={WORK_PAGE.loadError} role="alert" actions={<Button size="sm" icon={RefreshCw} onClick={() => void poll.refresh()}>{ERRORS.retry}</Button>}>
      {poll.error}
    </Notice>
  );
  else if (!projects.length) body = (
    <EmptyState icon={FolderKanban} tone="accent" title={PROJECTS.emptyTitle} hint={PROJECTS.emptyHint}
      action={<Button variant="secondary" icon={Plus} onClick={onCreate}>{PROJECTS.create}</Button>} />
  );
  else if (!visible.length) body = <p className="q-empty">{PROJECTS.filteredEmpty}</p>;
  else body = <ul className="project-list">{visible.map((project) => <li key={project.id}><ProjectRow project={project} /></li>)}</ul>;

  const upcoming = upcomingMilestones(projects);
  return (
    <div className="work-grid">
      <div className="work-main">
        <Card className="work-list" aria-labelledby="work-projects-title">
          <div className="q-head">
            <CardHead title={PROJECTS.title} titleId="work-projects-title" icon={FolderKanban} tone="accent" count={projects.length} countLabel={PROJECTS.countLabel(projects.length)} />
            {new Set(projects.map((project) => project.status)).size > 1 ? (
              <ChipGroup
                label={PROJECTS.filterLabel}
                allValue="all"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: PROJECTS.all, count: projects.length },
                  ...(["active", "paused", "done"] as const).filter((status) => count(status) > 0)
                    .map((status) => ({ value: status, label: PROJECT_STATUS_LABELS[status], count: count(status) })),
                ]}
              />
            ) : null}
          </div>
          {staleSince ? <StaleNote time={staleSince} onRefresh={() => void poll.refresh()} /> : null}
          {body}
        </Card>
      </div>
      <aside className="work-side" aria-label={PROJECTS.upcomingTitle}>
        <Card className="work-card" aria-labelledby="work-upcoming-title">
          <CardHead title={PROJECTS.upcomingTitle} titleId="work-upcoming-title" icon={Flag} tone="task" count={upcoming.length} />
          {poll.state === "loading" ? <div className="skel-list" aria-busy="true"><SkeletonRow /><SkeletonRow /></div>
            : upcoming.length ? upcoming.map(({ project, title, dueDay }) => (
              <a key={project.id} className="ev-row" href={routeHref({ name: "project", id: project.id })}>
                <span className="dblock"><b>{shortDay(dueDay)}</b><span>{PROJECTS.weekday(weekdayChar(dueDay))}</span></span>
                <span><span className="t">{title}</span><span className="m">{project.name}</span></span>
              </a>
            ))
            : <p className="work-hint">{PROJECTS.upcomingEmpty}</p>}
        </Card>
      </aside>
    </div>
  );
}

/** `.project-row`: colour dot, name, next step and counts, status pill, 6px bar + mono %. */
export function ProjectRow({ project }: { project: ProjectSummary }) {
  const color = { "--c": projectColorVar(project.color) } as CSSProperties;
  const meta = [
    projectNext(project),
    project.milestones.total ? PROJECTS.milestones(project.milestones.done, project.milestones.total) : undefined,
    project.openTodos ? PROJECTS.todos(project.openTodos) : undefined,
    ...project.repos.slice(0, 1),
  ].filter(Boolean).join(" · ");
  return (
    <a className="project-row" href={routeHref({ name: "project", id: project.id })}>
      <span className="pr-dot" style={color} aria-hidden="true" />
      <span className="pr-main">
        <span className="t">{project.name}</span>
        <span className="m">{meta}</span>
      </span>
      {project.status !== "active" ? <Pill tone={project.status === "done" ? "ok" : "neutral"}>{PROJECT_STATUS_LABELS[project.status]}</Pill> : <span aria-hidden="true" />}
      <span className="pr-progress" role="img" aria-label={PROJECTS.progressLabel(project.name, project.pct)}>
        <span className="work-bar"><i style={{ ...color, width: `${project.pct}%` }} /></span>
        <span className="pct">{project.pct}%</span>
      </span>
      <Icon icon={ChevronRight} size="sm" />
    </a>
  );
}
