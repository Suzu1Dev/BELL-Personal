/**
 * #/work/projects/:id (SPEC-ux §3.3 "Detail page has milestones, linked repos
 * and linked todos"): milestones you tick, add and remove; progress; linked
 * repositories with what GitHub reports; todos that point at the project.
 * Edits are immediate; deletes are undoable.
 */
import { useCallback, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import type { Milestone, Project, ProjectDeleteResponse, ProjectDetail as Detail, ProjectListResponse } from "../../../shared/projects";
import { ApiError, api, core, send } from "../../api";
import { ERRORS } from "../../copy/common";
import { PROJECT_DETAIL, PROJECT_STATUS_LABELS, PROJECTS, WORK_PAGE } from "../../copy/work";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { Checkbox } from "../../components/Checkbox";
import { EmptyState } from "../../components/EmptyState";
import { TextInput } from "../../components/Field";
import { ArrowLeft, ArrowUpRight, Check, Flag, FolderKanban, Gauge, GitPullRequest, Icon, ListTodo, Pencil, Plus, RefreshCw, Trash2 } from "./icons";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { Pill } from "../../components/Pill";
import { SkeletonRow } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { useToast } from "../../components/toast/ToastProvider";
import { isComposing } from "../../lib/keys";
import { navigate, routeHref } from "../../lib/router";
import { clockTime, projectColorVar } from "../../lib/today-model";
import { usePoll } from "../../lib/usePoll";
import { ProjectDialog } from "./ProjectDialog";
import { reasonOf } from "./useWork";
import { shortDay } from "./work-model";

const PROJECTS_HREF = routeHref({ name: "work", tab: "projects" });

export function ProjectDetailView({ id, timeZone, headEyebrow }: { id: string; timeZone: string; headEyebrow: string }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const fetcher = useCallback(async (signal: AbortSignal) => {
    // Ask the list first so an unknown id renders 找不到 without a failed request in the console.
    const list = await api<ProjectListResponse>("/projects?archived=include", { signal });
    if (!list.projects.some((project) => project.id === id)) return null;
    try { return await api<Detail>(`/projects/${encodeURIComponent(id)}`, { signal }); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return null;
      throw cause;
    }
  }, [id]);
  const poll = usePoll(fetcher, 30_000);
  const detail = poll.data;
  const back = <Button variant="ghost" size="sm" icon={ArrowLeft} href={PROJECTS_HREF} className="work-back">{WORK_PAGE.backToProjects}</Button>;

  if (poll.state === "loading") {
    return (
      <>
        {back}
        <PageHead eyebrow={headEyebrow} title={<span className="sr-only">{PROJECTS.title}</span>} />
        <Card className="work-card"><div className="skel-list" aria-busy="true">{[0, 1, 2].map((index) => <SkeletonRow key={index} />)}</div></Card>
      </>
    );
  }
  if (poll.state === "error" && detail === undefined) {
    return (
      <>
        {back}
        <PageHead eyebrow={headEyebrow} title={PROJECTS.title} />
        <Notice tone="error" title={WORK_PAGE.loadError} role="alert" actions={<Button size="sm" icon={RefreshCw} onClick={() => void poll.refresh()}>{ERRORS.retry}</Button>}>{poll.error}</Notice>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        {back}
        <PageHead eyebrow={headEyebrow} title={PROJECTS.notFoundTitle} />
        <EmptyState icon={FolderKanban} title={PROJECTS.notFoundHint}
          action={<Button variant="secondary" href={PROJECTS_HREF}>{WORK_PAGE.backToProjects}</Button>} />
      </>
    );
  }

  const { project, summary } = detail;
  const color = { "--c": projectColorVar(project.color) } as CSSProperties;
  const staleSince = poll.state === "stale" && poll.updatedAt ? clockTime(new Date(poll.updatedAt).toISOString(), timeZone) : undefined;

  const removeProject = async () => {
    setEditing(false);
    try {
      const result = await api<ProjectDeleteResponse>(`/projects/${encodeURIComponent(project.id)}`, send("DELETE"));
      navigate(PROJECTS_HREF);
      if (result.undoToken) {
        const token = result.undoToken;
        toast.undo(PROJECTS.deleted(project.name), () => {
          core.restore(token)
            .then(() => navigate(routeHref({ name: "project", id: project.id })))
            .catch((cause: unknown) => toast.error(ERRORS.undoFailed(reasonOf(cause))));
        }, { icon: Trash2 });
      } else toast.success(PROJECTS.deleted(project.name));
    } catch (cause) {
      toast.error(ERRORS.actionFailed(PROJECT_DETAIL.edit, reasonOf(cause)));
    }
  };

  return (
    <>
      {back}
      <PageHead
        eyebrow={headEyebrow}
        className="project-detail-head"
        title={<>{project.name}{project.status !== "active" ? <> <Pill tone={project.status === "done" ? "ok" : "neutral"}>{PROJECT_STATUS_LABELS[project.status]}</Pill></> : null}</>}
        sub={project.description}
        actions={<Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>{PROJECT_DETAIL.edit}</Button>}
      />
      {staleSince ? <StaleNote time={staleSince} onRefresh={() => void poll.refresh()} /> : null}
      <div className="work-grid">
        <div className="work-main">
          <Milestones project={project} onChanged={poll.refresh} />
          <Card className="work-card" aria-labelledby="project-todos-title">
            <CardHead title={PROJECT_DETAIL.todosTitle} titleId="project-todos-title" icon={ListTodo} tone="task" count={summary.openTodos}
              link={{ href: routeHref({ name: "tasks" }), label: PROJECT_DETAIL.todosLink }} />
            {detail.todos.length ? (
              <ul>
                {detail.todos.map((todo) => (
                  <li key={todo.id} className={todo.status === "done" ? "todo-line is-done" : "todo-line"}>
                    <Icon icon={todo.status === "done" ? Check : ListTodo} size="sm" />
                    <a className="kp todo-link" href={routeHref({ name: "tasks", id: todo.id })}>{todo.title}{todo.status === "done" ? <span className="sr-only">（{PROJECT_DETAIL.todoDone}）</span> : null}</a>
                    {todo.dueDay ? <span className="d">{shortDay(todo.dueDay)}{todo.dueTime ? ` ${todo.dueTime}` : ""}</span> : <span />}
                  </li>
                ))}
              </ul>
            ) : (
              <>
                <p className="work-hint"><b>{PROJECT_DETAIL.todosEmpty}</b></p>
                <p className="work-hint">{PROJECT_DETAIL.todosHint}</p>
              </>
            )}
          </Card>
        </div>
        <aside className="work-side" aria-label={PROJECT_DETAIL.progressTitle}>
          <Card className="work-card work-progress" aria-labelledby="project-progress-title">
            <CardHead title={PROJECT_DETAIL.progressTitle} titleId="project-progress-title" icon={Gauge} tone="accent" />
            <div className="big"><b>{summary.pct}</b><span>%</span></div>
            <div className="work-bar" role="img" aria-label={PROJECTS.progressLabel(project.name, summary.pct)}><i style={{ ...color, width: `${summary.pct}%` }} /></div>
            <p>{summary.manualProgress ? PROJECT_DETAIL.progressManual : PROJECT_DETAIL.progressAuto(summary.milestones.done, summary.milestones.total)}</p>
          </Card>
          <Card className="work-card" aria-labelledby="project-repos-title">
            <CardHead title={PROJECT_DETAIL.reposTitle} titleId="project-repos-title" icon={GitPullRequest} tone="info" count={detail.repos.length} />
            {detail.repos.length ? detail.repos.map((repo) => (
              <div key={repo.repo} className="repo-block">
                <a className="repo-name" href={repo.url} target="_blank" rel="noopener noreferrer">{repo.repo}<Icon icon={ArrowUpRight} size="xs" /></a>
                <p>{repo.pullRequests.length || repo.issues.length ? PROJECT_DETAIL.repoCounts(repo.pullRequests.length, repo.issues.length) : PROJECT_DETAIL.repoQuiet}</p>
                {repo.pullRequests.length || repo.issues.length ? (
                  <ul>
                    {[...repo.pullRequests, ...repo.issues].slice(0, 4).map((item) => (
                      <li key={item.url}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.number !== undefined ? `#${item.number} ` : ""}{item.title}</a></li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )) : (
              <>
                <p className="work-hint"><b>{PROJECT_DETAIL.reposEmpty}</b></p>
                <p className="work-hint">{PROJECT_DETAIL.reposHint}</p>
              </>
            )}
          </Card>
        </aside>
      </div>
      <ProjectDialog
        open={editing}
        project={project}
        onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); toast.success(PROJECTS.saved); void poll.refresh(); }}
        onDelete={() => void removeProject()}
      />
    </>
  );
}

function Milestones({ project, onChanged }: { project: Project; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [adding, setAdding] = useState(false);
  const done = project.milestones.filter((item) => item.done).length;
  const base = `/projects/${encodeURIComponent(project.id)}/milestones`;

  const toggle = async (milestone: Milestone, next: boolean) => {
    try {
      await api<Project>(`${base}/${encodeURIComponent(milestone.id)}`, send("PATCH", { done: next }));
    } catch (cause) {
      toast.error(ERRORS.actionFailed(PROJECT_DETAIL.milestonesTitle, reasonOf(cause)));
      throw cause;
    } finally {
      void onChanged();
    }
  };

  const remove = async (milestone: Milestone) => {
    try {
      await api<Project>(`${base}/${encodeURIComponent(milestone.id)}`, send("DELETE"));
      void onChanged();
      toast.undo(PROJECT_DETAIL.milestoneDeleted(milestone.title), () => {
        api<Project>(base, send("POST", { title: milestone.title, ...(milestone.dueDay ? { dueDay: milestone.dueDay } : {}) }))
          .then(async (project) => {
            const restored = project.milestones.at(-1);
            if (milestone.done && restored) await api<Project>(`${base}/${encodeURIComponent(restored.id)}`, send("PATCH", { done: true }));
          })
          .catch((cause: unknown) => toast.error(ERRORS.undoFailed(reasonOf(cause))))
          .finally(() => void onChanged());
      }, { icon: Trash2 });
    } catch (cause) {
      toast.error(ERRORS.actionFailed(PROJECT_DETAIL.milestonesTitle, reasonOf(cause)));
    }
  };

  const add = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = title.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await api<Project>(base, send("POST", { title: text, ...(dueDay ? { dueDay } : {}) }));
      setTitle("");
      setDueDay("");
      await onChanged();
    } catch (cause) {
      toast.error(ERRORS.actionFailed(PROJECT_DETAIL.addMilestone, reasonOf(cause)));
    } finally {
      setAdding(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && isComposing(event.nativeEvent)) event.preventDefault();
  };

  return (
    <Card className="work-card" aria-labelledby="project-milestones-title">
      <CardHead title={PROJECT_DETAIL.milestonesTitle} titleId="project-milestones-title" icon={Flag} tone="task" count={project.milestones.length}
        countLabel={PROJECT_DETAIL.milestonesCount(done, project.milestones.length)} />
      {project.milestones.length ? (
        <ul className="milestone-list">
          {project.milestones.map((milestone) => (
            <li key={milestone.id} className={milestone.done ? "milestone is-done" : "milestone"}>
              <Checkbox checked={milestone.done} ariaLabel={PROJECT_DETAIL.toggleMilestone(milestone.title)} onChange={(next) => toggle(milestone, next)} />
              <span className="t kp">{milestone.title}</span>
              <span className={milestone.dueDay ? "d" : "d zh"}>{milestone.dueDay ? shortDay(milestone.dueDay) : PROJECT_DETAIL.noDate}</span>
              <Button variant="icon" icon={Trash2} aria-label={PROJECT_DETAIL.deleteMilestone(milestone.title)} onClick={() => void remove(milestone)} />
            </li>
          ))}
        </ul>
      ) : <p className="work-hint">{PROJECT_DETAIL.milestonesEmpty}</p>}
      <form className="milestone-add" onSubmit={(event) => void add(event)}>
        <TextInput value={title} maxLength={160} placeholder={PROJECT_DETAIL.milestonePlaceholder} aria-label={PROJECT_DETAIL.addMilestone}
          onChange={(event) => setTitle(event.target.value)} onKeyDown={onKeyDown} />
        <TextInput type="date" value={dueDay} aria-label={PROJECT_DETAIL.milestoneDate} onChange={(event) => setDueDay(event.target.value)} onKeyDown={onKeyDown} />
        <Button type="submit" icon={Plus} disabled={!title.trim() || adding}>{PROJECT_DETAIL.add}</Button>
      </form>
    </Card>
  );
}
