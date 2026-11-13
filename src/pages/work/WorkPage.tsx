/**
 * #/work?tab=assignments|projects|github and #/work/projects/:id (SPEC-ux
 * §3.1, §3.3): 作業 (Moodle/Canvas by course), 專案 (native projects) and
 * GitHub (reviews, my PRs, assigned issues, notifications). Each tab reads
 * its own endpoint (/api/lms/assignments, /api/projects, /api/github) and
 * renders every widget state on its own.
 */
import { useCallback, useEffect, useState } from "react";
import type { AssignmentDeleteResponse, AssignmentView, AssignmentsResponse } from "../../../shared/assignments";
import type { GitHubOverview } from "../../../shared/github";
import type { ProjectListResponse } from "../../../shared/projects";
import type { SourceId } from "../../../shared/sources";
import { DEFAULT_TIME_ZONE } from "../../../shared/time";
import { api, send } from "../../api";
import { ERRORS, PAGE_HEADS, TAB_GROUP_LABELS, WORK_TAB_LABELS } from "../../copy/common";
import { ASSIGNMENTS, PROJECTS, WORK_PAGE } from "../../copy/work";
import { Button } from "../../components/Button";
import { PageHead } from "../../components/PageHead";
import { Tabs } from "../../components/Tabs";
import { useToast } from "../../components/toast/ToastProvider";
import { WORK_TABS, navigate, routeHref, type RouteOf, type WorkTab } from "../../lib/router";
import { useStatus } from "../../lib/status";
import { useToday } from "../../lib/today";
import { useAppSettings } from "../../lib/app-settings";
import { isFeatureVisible } from "../../../shared/profile";
import { HiddenFeature } from "../../components/HiddenFeature";
import { usePoll } from "../../lib/usePoll";
import { AssignmentDialog } from "./AssignmentDialog";
import { AssignmentsTab } from "./AssignmentsTab";
import { GitHubTab } from "./GitHubTab";
import { Check, Plus, RefreshCw, Trash2 } from "./icons";
import { ProjectDetailView } from "./ProjectDetail";
import { ProjectDialog } from "./ProjectDialog";
import { ProjectsTab } from "./ProjectsTab";
import { reasonOf, useSyncNow } from "./useWork";
import { focusAfterDelete, pendingCount } from "./work-model";
import "./WorkPage.css";

const LMS_SOURCES: readonly SourceId[] = ["moodle", "canvas"];
const GITHUB_SOURCES: readonly SourceId[] = ["github"];
const fetchAssignments = (signal: AbortSignal) => api<AssignmentsResponse>("/lms/assignments", { signal });
const fetchProjects = (signal: AbortSignal) => api<ProjectListResponse>("/projects", { signal });
const fetchGitHub = (signal: AbortSignal) => api<GitHubOverview>("/github", { signal });

export default function WorkPage({ route }: { route: RouteOf<"work"> | RouteOf<"project"> }) {
  const status = useStatus();
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  const timeZone = status.data?.timeZone ?? DEFAULT_TIME_ZONE;
  const tab = route.name === "work" && !isFeatureVisible(route.tab, roles, app.overrides)
    ? WORK_TABS.find((feature) => isFeatureVisible(feature, roles, app.overrides)) ?? route.tab
    : route.name === "work" ? route.tab : "projects";
  if (!isFeatureVisible(tab, roles, app.overrides)) return <HiddenFeature feature={tab} />;
  return (
    <div className="work-page">
      {route.name === "project"
        ? <ProjectDetailView key={route.id} id={route.id} timeZone={timeZone} headEyebrow={PAGE_HEADS.work.eyebrow} />
        : <WorkTabs tab={tab} timeZone={timeZone} />}
    </div>
  );
}

function WorkTabs({ tab, timeZone }: { tab: WorkTab; timeZone: string }) {
  const toast = useToast();
  const today = useToday();
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  const visibleTabs = WORK_TABS.filter((feature) => isFeatureVisible(feature, roles, app.overrides));
  const assignments = usePoll(fetchAssignments, 60_000);
  const projects = usePoll(fetchProjects, 30_000);
  const github = usePoll(fetchGitHub, 60_000);
  const [creating, setCreating] = useState(false);
  /** 新增作業 ("new") or 編輯 (the row), else closed. */
  const [editing, setEditing] = useState<AssignmentView | "new" | null>(null);
  /** Assignments deleted a moment ago: hidden while their undo toast is up. */
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  const hide = (id: string, gone: boolean) => setDeleted((current) => {
    const next = new Set(current);
    if (gone) next.add(id);
    else next.delete(id);
    return next;
  });

  /** After a native assignment changes, #/work and Today (queue, badge, agenda) both refetch. */
  const refreshAssignments = () => { void assignments.refresh(); void today.refresh(); };

  const savedAssignment = (saved: AssignmentView, created: boolean) => {
    setEditing(null);
    refreshAssignments();
    if (!created) { toast.success(ASSIGNMENTS.savedToast, Check); return; }
    toast.undo(ASSIGNMENTS.createdToast(saved.title), () => {
      hide(saved.id, true);
      api(`/lms/assignments/${encodeURIComponent(saved.externalId)}`, send("DELETE"))
        .catch((cause: unknown) => { hide(saved.id, false); toast.error(ERRORS.undoFailed(reasonOf(cause))); })
        .finally(refreshAssignments);
    }, { icon: Plus });
  };

  /** A title to focus once the dialog has closed (its opener was the deleted row's title). */
  const [focusAfter, setFocusAfter] = useState<{ element: HTMLElement | null } | null>(null);
  useEffect(() => {
    if (!focusAfter) return;
    const target = focusAfter.element?.isConnected ? focusAfter.element : document.querySelector<HTMLElement>("[data-create-assignment]");
    target?.focus();
  }, [focusAfter]);

  const deleteAssignment = async (row: AssignmentView) => {
    // The row (and the dialog's opener) leaves now: focus its neighbour's title, else 新增作業 (SPEC-mail-assignments §9).
    const titles = [...document.querySelectorAll<HTMLElement>(".work-page li[data-row-id] .q-title")].filter((element) => element.matches("button, a"));
    const idOf = (element: HTMLElement) => element.closest("li")?.getAttribute("data-row-id") ?? "";
    const next = focusAfterDelete(titles.map(idOf), row.id);
    setFocusAfter({ element: titles.find((element) => idOf(element) === next) ?? null });
    setEditing(null);
    hide(row.id, true);
    try {
      const result = await api<AssignmentDeleteResponse>(`/lms/assignments/${encodeURIComponent(row.externalId)}`, send("DELETE"));
      refreshAssignments();
      const token = result.undoToken;
      toast.undo(ASSIGNMENTS.deletedToast(row.title), () => {
        if (!token) return;
        api("/trash/restore", send("POST", { token }))
          .then(() => hide(row.id, false))
          .catch((cause: unknown) => toast.error(ERRORS.undoFailed(reasonOf(cause))))
          .finally(refreshAssignments);
      }, { icon: Trash2 });
    } catch (cause) {
      hide(row.id, false);
      toast.error(ASSIGNMENTS.deleteFailed(reasonOf(cause)), () => { void deleteAssignment(row); });
    }
  };

  const lmsStates = useCallback(() => assignments.data?.accounts.map((account) => account.status), [assignments.data]);
  const githubStates = useCallback(() => (github.data ? [github.data.status] : undefined), [github.data]);
  const lmsSync = useSyncNow(LMS_SOURCES, assignments.refresh, lmsStates);
  const githubSync = useSyncNow(GITHUB_SOURCES, github.refresh, githubStates);

  const counts: Record<WorkTab, number | undefined> = {
    assignments: assignments.data ? pendingCount(assignments.data.assignments) : undefined,
    projects: projects.data ? projects.data.projects.filter((project) => project.status === "active").length : undefined,
    github: github.data ? github.data.reviewRequests.filter((item) => !item.localReviewed).length : undefined,
  };

  const lmsConnected = !!assignments.data?.accounts.some((account) => account.connected);
  const githubConnected = !!github.data?.status.configured;
  const syncButton = (sync: { syncing: boolean; run: () => Promise<void> }) => (
    <Button variant="secondary" icon={RefreshCw} onClick={() => void sync.run()} disabled={sync.syncing}>{sync.syncing ? WORK_PAGE.syncing : WORK_PAGE.sync}</Button>
  );
  // 作業: 新增作業 is the page's primary action; 立即同步 sits next to it while an LMS is connected (SPEC-mail-assignments §5.8).
  const action = tab === "projects"
    ? <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>{PROJECTS.create}</Button>
    : tab === "assignments"
      ? <>{lmsConnected ? syncButton(lmsSync) : null}<Button variant="primary" icon={Plus} data-create-assignment="" onClick={() => setEditing("new")}>{ASSIGNMENTS.create}</Button></>
      : githubConnected ? syncButton(githubSync) : null;

  return (
    <>
      <PageHead eyebrow={PAGE_HEADS.work.eyebrow} title={PAGE_HEADS.work.title} sub={PAGE_HEADS.work.sub} actions={action} />
      <Tabs
        label={TAB_GROUP_LABELS.work}
        value={tab}
        items={visibleTabs.map((value) => ({ value, label: WORK_TAB_LABELS[value], href: routeHref({ name: "work", tab: value }), ...(counts[value] ? { count: counts[value] } : {}) }))}
      />
      {tab === "assignments" ? (
        <AssignmentsTab
          poll={assignments}
          timeZone={timeZone}
          onSync={() => void lmsSync.run()}
          syncing={lmsSync.syncing}
          onCreate={() => setEditing("new")}
          onEdit={(row) => setEditing(row)}
          hidden={deleted}
        />
      ) : null}
      <AssignmentDialog
        open={editing !== null}
        row={editing === "new" || editing === null ? undefined : editing}
        timeZone={timeZone}
        onClose={() => setEditing(null)}
        onSaved={savedAssignment}
        onDelete={(row) => void deleteAssignment(row)}
      />
      {tab === "projects" ? <ProjectsTab poll={projects} timeZone={timeZone} onCreate={() => setCreating(true)} /> : null}
      {tab === "github" ? <GitHubTab poll={github} timeZone={timeZone} onSync={() => void githubSync.run()} syncing={githubSync.syncing} /> : null}
      <ProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(project) => {
          setCreating(false);
          toast.success(PROJECTS.created(project.name));
          void projects.refresh();
          navigate(routeHref({ name: "project", id: project.id }));
        }}
      />
    </>
  );
}
