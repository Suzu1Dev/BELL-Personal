/**
 * #/tasks — native todos (SPEC-ux §3.3 「待辦」). The top row is an inline
 * add field with the live parse (§6.6); groups 逾期 · 今天 · 明天 · 本週 ·
 * 之後 · 沒有期限; each row has an 18px checkbox, title, meta (來源 · 期限)
 * and `.when`; today's finished todos fold into 「今天完成 N 件 · 顯示」.
 *
 * 完成 goes through POST /api/actions (`native:<id>`, done) so Today's counts
 * and 復原 stay in one place. Keys: J/K (↓/↑) move, E 完成, ↵ / Space open
 * the row editor, Esc closes it. A row being tidied by AI (自動整理 after a
 * capture, or 整理 in the editor) shows 「整理中…」; the editor shows what
 * was typed (原文) once a tidy rewrote it, with 復原整理 while the fields
 * from before are kept. An open editor takes a tidy that lands under it into
 * the fields the user has not touched, and 儲存 sends only what they changed.
 *
 * 排日期: a todo with no due day (沒有期限) offers a quick control (and the S
 * key on the cursor row): 今天 · 明天 · 這週末 · 下週一 · 選日期… sets `dueDay`
 * with PATCH /api/todos/:id, the row moves to its new group at once and 復原
 * takes the day back. `#/tasks?group=someday` (Today's 還有 N 件待辦沒排日期)
 * lands on the first of them.
 *
 * `#/tasks/<id>` (a deep link, e.g. from a project or 解釋這個's 回到): once
 * the list is in, the row scrolls into view, flashes and opens its editor
 * (focus goes to the title field). A todo that is not open is looked up with
 * GET /api/todos/:id: a finished one shows a panel with 改回未完成; a 404
 * shows 「找不到這個待辦」 with 回到全部待辦.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { TIDY_TODO_ORIGINS, type CaptureResponse } from "../../../shared/connect";
import type { DayKey } from "../../../shared/time";
import { todoWhen } from "../../../shared/todo-format";
import type { Todo, TodoDeleteResponse, TodoListResponse, TodoUpdateRequest } from "../../../shared/todos";
import { api, core, send } from "../../api";
import { ExplainThis } from "../../suite/ExplainThis";
import { SendToPr } from "../../suite/SendToPr";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Checkbox } from "../../components/Checkbox";
import { EmptyState } from "../../components/EmptyState";
import { Field, Switch, TextInput, Textarea } from "../../components/Field";
import { ArrowUpRight, CalendarDays, CalendarPlus, Check, ChevronDown, Icon, ListTodo, Plus, RotateCw, Undo2, WandSparkles } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { SkeletonRow, Spinner } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { ParseRow } from "../../components/capture/ParseRow";
import { CAPTURED_EVENT } from "../../components/capture/client";
import { whenLabel } from "../../components/capture/describe";
import { useTidyAction, useTidyRevert, useTidying } from "../../components/capture/tidy";
import { useCaptureCommit, useCaptureEnv, useCaptureState } from "../../components/capture/useCapture";
import { useToast } from "../../components/toast/ToastProvider";
import { CAPTURE } from "../../copy/capture";
import { ACTION_TOASTS, BUTTONS, ERRORS } from "../../copy/common";
import { onboardingLocale } from "../../copy/onboarding";
import { TASKS, TIDY, tasksCopy } from "../../copy/tasks";
import { cx } from "../../lib/cx";
import { isComposing } from "../../lib/keys";
import { routeHref, type RouteOf } from "../../lib/router";
import { useSingleKeyShortcuts } from "../../lib/preferences";
import { useShortcuts } from "../../lib/shortcuts";
import { useToday } from "../../lib/today";
import { MEDIA, useMediaQuery } from "../../lib/useMediaQuery";
import { POLL_INTERVALS, usePoll } from "../../lib/usePoll";
import {
  editorFields, editorPatch, focusFromHash, groupFromHash, groupTodos, keepUnsettled, mergeTodos, resyncEditor, sameEditorFields, scheduleWhen, taskMeta,
  type ClosingTodo, type EditorFields, type ReopenedTodo, type ScheduledTodo,
} from "./model";
import { SchedulePopover } from "./SchedulePopover";
import { explainText, isMissing, landOn, useFlash, useLandOnce } from "../not-found/deep-link";
import { MissingObject } from "../not-found/MissingObject";
import "../../components/capture/CaptureField.css";
import "./TasksPage.css";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

interface FetchedTodos {
  list: TodoListResponse;
  /** When the request started: local edits acknowledged before it are in this list. */
  startedAt: number;
}

function without<V>(map: ReadonlyMap<string, V>, id: string): ReadonlyMap<string, V> {
  if (!map.has(id)) return map;
  const copy = new Map(map);
  copy.delete(id);
  return copy;
}
const clock = (ms: number | undefined) => (ms ? new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const todoHref = (id: string) => routeHref({ name: "tasks", id });

/** What a `#/tasks/<id>` link resolved to (once per id, so finishing the row later does not swap in the panel). */
type LinkState =
  | { id: string; kind: "open" }
  | { id: string; kind: "pending" }
  | { id: string; kind: "done"; todo: Todo }
  | { id: string; kind: "missing" }
  | { id: string; kind: "error"; message: string };

export default function TasksPage({ route }: { route: RouteOf<"tasks"> }) {
  const locale = onboardingLocale();
  const env = useCaptureEnv();
  const toast = useToast();
  const today = useToday();
  // 「J K 移動 · E 完成」 names single keys: shown only while 單鍵快捷鍵 is on.
  const singleKeys = useSingleKeyShortcuts();
  const poll = usePoll(useCallback(async (signal: AbortSignal): Promise<FetchedTodos> => {
    const startedAt = Date.now();
    return { list: await api<TodoListResponse>("/todos", { signal }), startedAt };
  }, []), POLL_INTERVALS.tasks);
  const { refresh } = poll;
  const refreshAll = useCallback(() => { void refresh(); void today.refresh(); }, [refresh, today]);
  const list = poll.data?.list;

  // Locally finished, deleted, reopened or scheduled rows until a list fetched after the server acknowledged them lands
  // (a poll or focus refresh that started earlier would otherwise put a finished row back, unchecked).
  const [closing, setClosing] = useState<ReadonlyMap<string, ClosingTodo>>(new Map());
  const [reopened, setReopened] = useState<ReadonlyMap<string, ReopenedTodo>>(new Map());
  const [scheduled, setScheduled] = useState<ReadonlyMap<string, ScheduledTodo>>(new Map());
  const fetchedAt = poll.data?.startedAt;
  useEffect(() => {
    if (fetchedAt === undefined) return;
    setClosing((map) => keepUnsettled(map, fetchedAt));
    setReopened((map) => keepUnsettled(map, fetchedAt));
    setScheduled((map) => keepUnsettled(map, fetchedAt));
  }, [fetchedAt]);
  const edit = {
    close: (todo: Todo, kind: ClosingTodo["kind"]) => {
      setClosing((map) => new Map(map).set(todo.id, { todo: kind === "done" ? { ...todo, status: "done", completedAt: new Date().toISOString() } : todo, kind }));
      setReopened((map) => without(map, todo.id));
    },
    reopen: (id: string) => {
      setReopened((map) => new Map(map).set(id, {}));
      setClosing((map) => without(map, id));
    },
    schedule: (id: string, dueDay: DayKey | null) => setScheduled((map) => new Map(map).set(id, { dueDay })),
    settle: (id: string) => {
      const settledAt = Date.now();
      setClosing((map) => (map.has(id) ? new Map(map).set(id, { ...map.get(id)!, settledAt }) : map));
      setReopened((map) => (map.has(id) ? new Map(map).set(id, { settledAt }) : map));
      setScheduled((map) => (map.has(id) ? new Map(map).set(id, { ...map.get(id)!, settledAt }) : map));
    },
    drop: (id: string) => {
      setClosing((map) => without(map, id));
      setReopened((map) => without(map, id));
      setScheduled((map) => without(map, id));
    },
  };

  useEffect(() => {
    const onCaptured = () => void refresh();
    window.addEventListener(CAPTURED_EVENT, onCaptured);
    return () => window.removeEventListener(CAPTURED_EVENT, onCaptured);
  }, [refresh]);

  // Project names for the meta line, from Today's sidebar projects (the work team owns /api/projects).
  const sidebar = today.data?.sidebar?.projects;
  const projectNames = useMemo(() => new Map((sidebar ?? []).map((project) => [project.id, project.name])), [sidebar]);
  const now = new Date();
  const day = list?.day;
  const merged = useMemo(() => mergeTodos(list, closing, reopened, scheduled), [list, closing, reopened, scheduled]);
  const open = merged.open;
  const groups = useMemo(() => (day ? groupTodos(open, day, new Date(), env.timeZone, locale) : []), [open, day, env.timeZone, locale]);
  const doneToday = merged.done;
  const rows = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const [cursor, setCursor] = useState<string | undefined>();
  const [expanded, setExpanded] = useState<string | undefined>();
  const [showDone, setShowDone] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const cursorId = cursor && rows.some((row) => row.id === cursor) ? cursor : rows[0]?.id;

  const focusTitle = (id: string | undefined) => {
    if (!id) return;
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLButtonElement>(`[data-todo="${CSS.escape(id)}"] .q-title`)?.focus());
  };

  // #/tasks?focus=<id> (the palette's 搜尋): open that row once it is loaded.
  const focusId = focusFromHash(typeof window === "undefined" ? "" : window.location.hash);
  const focused = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusId || focused.current === focusId || !rows.some((row) => row.id === focusId)) return;
    focused.current = focusId;
    setCursor(focusId);
    setExpanded(focusId);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-todo="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: "center" }));
  }, [focusId, rows]);

  // #/tasks/<id>: resolve the link once per id — on the list, finished (today's fold or GET /api/todos/:id), or gone.
  const linkId = route.id;
  const [linkState, setLinkState] = useState<LinkState>();
  const link = linkId && linkState?.id === linkId ? linkState : undefined;
  const linkOnList = !!linkId && rows.some((row) => row.id === linkId);
  const linkDoneToday = linkId ? doneToday.find((todo) => todo.id === linkId) : undefined;
  const resolved = useRef<string | undefined>(undefined);
  const [retryLink, setRetryLink] = useState(0);
  useEffect(() => {
    if (!linkId) { resolved.current = undefined; return; }
    if (!list || resolved.current === linkId) return;
    resolved.current = linkId;
    if (linkOnList) { setLinkState({ id: linkId, kind: "open" }); return; }
    if (linkDoneToday) { setLinkState({ id: linkId, kind: "done", todo: linkDoneToday }); return; }
    setLinkState({ id: linkId, kind: "pending" });
    api<Todo>(`/todos/${encodeURIComponent(linkId)}`)
      .then((todo) => {
        if (resolved.current !== linkId) return;
        // Open but not on this list yet (just made elsewhere): the next list has it.
        if (todo.status === "open") { setLinkState({ id: linkId, kind: "open" }); void refresh(); }
        else setLinkState({ id: linkId, kind: "done", todo });
      })
      .catch((cause: unknown) => {
        if (resolved.current !== linkId) return;
        setLinkState(isMissing(cause) ? { id: linkId, kind: "missing" } : { id: linkId, kind: "error", message: errorText(cause) });
      });
  }, [linkId, list, linkOnList, linkDoneToday, refresh, retryLink]);
  const [flash, startFlash] = useFlash();
  // On the list: the cursor moves there, the row flashes and its editor opens (its title field takes focus).
  useLandOnce(link?.kind === "open" ? linkId : undefined, linkOnList, (id) => {
    setCursor(id);
    setExpanded(id);
    startFlash(id);
    landOn(listRef.current, "todo", id, ".task-editor input");
  });
  const retryLinkLookup = () => { resolved.current = undefined; setLinkState(undefined); setRetryLink((n) => n + 1); };

  // #/tasks?group=someday (Today's 還有 N 件待辦沒排日期): the cursor and focus go to the first todo with no due day,
  // so S (or ↵) works at once.
  const groupParam = groupFromHash(typeof window === "undefined" ? "" : window.location.hash);
  const landed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!groupParam || landed.current === groupParam) return;
    const first = groups.find((group) => group.key === groupParam)?.items[0];
    if (!first) return;
    landed.current = groupParam;
    setCursor(first.id);
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector(`[data-todo="${CSS.escape(first.id)}"]`);
      row?.scrollIntoView({ block: "center" });
      row?.querySelector<HTMLButtonElement>(".q-title")?.focus({ preventScroll: true });
    });
  }, [groupParam, groups]);

  const complete = async (todo: Todo) => {
    edit.close(todo, "done");
    if (expanded === todo.id) setExpanded(undefined);
    const index = rows.findIndex((row) => row.id === todo.id);
    const next = rows[index + 1] ?? rows[index - 1];
    if (next) { setCursor(next.id); focusTitle(next.id); }
    const result = await today.act(`native:${todo.id}`, "done", undefined, { silent: true });
    if (!result.ok) {
      edit.drop(todo.id);
      toast.error(ERRORS.actionFailed(TASKS.toasts.completeFailed, result.error ?? ""), () => { void complete(todo); });
      throw new Error(result.error);
    }
    edit.settle(todo.id);
    void refresh();
    toast.undo(ACTION_TOASTS.done(todo.title), () => {
      // Back in the list at once; kept there until a list fetched after the undo lands.
      edit.reopen(todo.id);
      api(`/actions/${encodeURIComponent(result.actionId!)}`, send("DELETE"))
        .then(() => { edit.settle(todo.id); refreshAll(); })
        .catch((cause: unknown) => { edit.drop(todo.id); toast.error(ERRORS.undoFailed(errorText(cause))); refreshAll(); });
    }, { icon: Check });
  };

  const reopen = async (todo: Todo) => {
    edit.reopen(todo.id);
    try {
      await api<Todo>(`/todos/${encodeURIComponent(todo.id)}/uncomplete`, send("POST", {}));
      edit.settle(todo.id);
      // 改回未完成 on the linked panel: the row is back on the list (after the refresh), so land there.
      setLinkState((state) => (state?.kind === "done" && state.id === todo.id ? { id: todo.id, kind: "open" } : state));
      refreshAll();
      toast.success(TASKS.toasts.reopened(todo.title), RotateCw);
    } catch (cause) {
      edit.drop(todo.id);
      toast.error(ERRORS.actionFailed(TASKS.toasts.reopenFailed, errorText(cause)));
      throw cause;
    }
  };

  const remove = async (todo: Todo) => {
    edit.close(todo, "deleted");
    setExpanded(undefined);
    try {
      const result = await api<TodoDeleteResponse>(`/todos/${encodeURIComponent(todo.id)}`, send("DELETE"));
      edit.settle(todo.id);
      refreshAll();
      if (result.undoToken) {
        const token = result.undoToken;
        toast.undo(TASKS.toasts.deleted(todo.title), () => {
          edit.drop(todo.id);
          core.restore(token).then(refreshAll).catch((cause: unknown) => toast.error(ERRORS.undoFailed(errorText(cause))));
        });
      }
    } catch (cause) {
      edit.drop(todo.id);
      toast.error(ERRORS.actionFailed(TASKS.toasts.deleteFailed, errorText(cause)));
    }
  };

  // 排日期: the row moves to its new group at once and 復原 takes the day back. Focus goes to the next row, like 完成.
  const [picking, setPicking] = useState<{ todo: Todo; anchor: HTMLElement | null }>();
  const mobile = useMediaQuery(MEDIA.mobile);
  const openSchedule = (todo: Todo) => {
    setCursor(todo.id);
    setPicking({ todo, anchor: listRef.current?.querySelector<HTMLElement>(`[data-todo="${CSS.escape(todo.id)}"]`) ?? null });
  };

  const schedule = async (todo: Todo, dueDay: DayKey) => {
    const when = scheduleWhen(dueDay, day!, env.timeZone, locale);
    const index = rows.findIndex((row) => row.id === todo.id);
    const next = rows[index + 1] ?? rows[index - 1];
    const url = `/todos/${encodeURIComponent(todo.id)}`;
    edit.schedule(todo.id, dueDay);
    if (next) { setCursor(next.id); focusTitle(next.id); }
    try {
      await api<Todo>(url, send("PATCH", { dueDay }));
    } catch (cause) {
      edit.drop(todo.id);
      toast.error(ERRORS.actionFailed(TASKS.toasts.scheduleFailed, errorText(cause)), () => { void schedule(todo, dueDay); });
      return;
    }
    edit.settle(todo.id);
    refreshAll();
    toast.undo(TASKS.toasts.scheduled(todo.title, when), () => {
      edit.schedule(todo.id, null);
      api<Todo>(url, send("PATCH", { dueDay: null }))
        .then(() => { edit.settle(todo.id); refreshAll(); })
        .catch((cause: unknown) => { edit.drop(todo.id); toast.error(ERRORS.undoFailed(errorText(cause))); refreshAll(); });
    }, { icon: CalendarDays });
  };

  // 整理 closes the editor (its fields would be stale) and lets the row show 「整理中…」.
  const tidyAction = useTidyAction();
  const tidy = (todo: Todo) => {
    setExpanded(undefined);
    focusTitle(todo.id);
    void tidyAction("todo", todo.id);
  };

  const save = async (todo: Todo, patch: TodoUpdateRequest) => {
    // Nothing changed: no PATCH (it would also stop a tidy that is still running).
    if (Object.keys(patch).length) await api<Todo>(`/todos/${encodeURIComponent(todo.id)}`, send("PATCH", patch));
    setExpanded(undefined);
    focusTitle(todo.id);
    if (Object.keys(patch).length) refreshAll();
  };

  // 復原整理 keeps the editor open: its untouched fields take the restored title and notes (the list refreshes on notifyCaptured).
  const revertTidy = useTidyRevert();
  const revert = (todo: Todo) => { void revertTidy("todo", todo.id); };

  const move = (step: number) => {
    if (!rows.length) return;
    // The first J or ↓ only steps into the list, onto the highlighted row (SPEC-ux §6.1, like Today's queue).
    const active = document.activeElement;
    if (!(active instanceof HTMLElement && active.classList.contains("q-title") && listRef.current?.contains(active))) {
      setCursor(cursorId);
      focusTitle(cursorId);
      return;
    }
    const index = Math.max(0, rows.findIndex((row) => row.id === cursorId));
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + step))];
    setCursor(next.id);
    if (expanded && expanded !== next.id) setExpanded(undefined);
    focusTitle(next.id);
  };
  const current = rows.find((row) => row.id === cursorId);
  // ↵ / Space on a focused button or link is that control's own click; only take them from the page itself.
  const onControl = (target: unknown) => target instanceof Element && !!target.closest("button, a, [role=checkbox], [role=switch]");
  const toggleCurrent = (event: { target?: unknown }) => {
    if (!current || onControl(event.target)) return false;
    setExpanded((value) => (value === current.id ? undefined : current.id));
  };
  useShortcuts({
    j: () => move(1), arrowdown: () => move(1),
    k: () => move(-1), arrowup: () => move(-1),
    e: () => { if (current) void complete(current).catch(() => {}); },
    s: () => { if (!current || current.dueDay) return false; openSchedule(current); },
    enter: toggleCurrent,
    space: toggleCurrent,
    escape: () => { if (!expanded) return false; setExpanded(undefined); focusTitle(expanded); },
  });

  const loading = poll.state === "loading";
  const failed = poll.state === "error";
  const empty = !loading && !failed && !rows.length;

  if (link?.kind === "missing") {
    return (
      <div className="tasks-page">
        <PageHead title={tasksCopy().PAGE_HEAD_TITLE} />
        <MissingObject icon={ListTodo} tone="task" title={TASKS.linked.missingTitle} hint={TASKS.linked.missingHint} backHref="#/tasks" backLabel={TASKS.linked.back} />
      </div>
    );
  }

  return (
    <div className="tasks-page">
      <PageHead title={tasksCopy().PAGE_HEAD_TITLE} />
      {link?.kind === "done" ? (
        <LinkedDoneTodo todo={link.todo} timeZone={env.timeZone} onReopen={() => reopen(link.todo).catch(() => {})} />
      ) : null}
      {link?.kind === "error" ? (
        <div className="tasks-linked-error">
          <Notice tone="error" title={TASKS.linked.loadErrorTitle} role="alert" actions={<Button size="sm" icon={RotateCw} onClick={retryLinkLookup}>{BUTTONS.retry}</Button>}>
            {link.message}
          </Notice>
        </div>
      ) : null}
      <Card className="tasks-card" aria-label={TASKS.groupsLabel}>
        <TaskAdd timeZone={env.timeZone} onAdded={() => void refresh()} />
        {poll.state === "stale" ? <div className="tasks-stale"><StaleNote time={clock(poll.updatedAt)} onRefresh={() => void refresh()} /></div> : null}
        {failed ? (
          <div className="tasks-notice">
            <Notice tone="error" title={TASKS.loadErrorTitle} role="alert" actions={<Button size="sm" icon={RotateCw} onClick={() => void refresh()}>{BUTTONS.retry}</Button>}>
              {poll.error}
            </Notice>
          </div>
        ) : null}
        {loading ? <div className="tasks-skeleton"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div> : null}
        {empty ? (
          <div className="tasks-empty">
            <EmptyState icon={ListTodo} tone="task" title={TASKS.emptyTitle} hint={TASKS.emptyHint} />
          </div>
        ) : null}
        <div ref={listRef}>
          {groups.map((group) => (
            <TaskGroupSection key={group.key} label={group.label} count={group.items.length} overdue={group.key === "overdue"}>
              {group.items.map((todo) => (
                <TaskRow
                  key={todo.id}
                  todo={todo}
                  meta={taskMeta(todo, day!, now, env.timeZone, (id) => projectNames.get(id), locale)}
                  when={todoWhen(todo, day!, now, env.timeZone, locale)}
                  cursor={todo.id === cursorId}
                  expanded={todo.id === expanded}
                  flash={todo.id === flash}
                  onFocusRow={() => setCursor(todo.id)}
                  onToggle={() => { setCursor(todo.id); setExpanded((value) => (value === todo.id ? undefined : todo.id)); }}
                  onCheck={() => complete(todo)}
                  onSave={(patch) => save(todo, patch)}
                  onDelete={() => void remove(todo)}
                  onTidy={env.aiParse && (TIDY_TODO_ORIGINS as readonly string[]).includes(todo.origin) ? () => tidy(todo) : undefined}
                  onRevert={todo.pretidy ? () => revert(todo) : undefined}
                  onSchedule={todo.dueDay ? undefined : () => openSchedule(todo)}
                />
              ))}
            </TaskGroupSection>
          ))}
        </div>
        {doneToday.length ? (
          <div className="tasks-done">
            <button type="button" className="tasks-done-toggle" aria-expanded={showDone} onClick={() => setShowDone((value) => !value)}>
              <Icon icon={Check} size="sm" />
              <span>{TASKS.doneToday(doneToday.length)}</span>
              <span className="tasks-done-show">{showDone ? TASKS.hide : TASKS.show}<Icon icon={ChevronDown} size="xs" /></span>
            </button>
            {showDone ? (
              <ul className="q-list tasks-done-list">
                {doneToday.map((todo) => (
                  <li key={todo.id} className="q-row is-done" data-todo={todo.id}>
                    <span className="task-check"><Checkbox checked onChange={() => reopen(todo)} ariaLabel={TASKS.checkLabel(todo.title, true)} /></span>
                    <div className="q-main"><span className="q-title">{todo.title}</span></div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>
      {picking && day ? (
        <SchedulePopover
          today={day}
          timeZone={env.timeZone}
          anchor={picking.anchor}
          sheet={mobile}
          onClose={() => { focusTitle(picking.todo.id); setPicking(undefined); }}
          onPick={(picked) => { setPicking(undefined); void schedule(picking.todo, picked); }}
        />
      ) : null}
      {rows.length && singleKeys ? <p className="tasks-keys d-only" aria-hidden="true">{rows.some((row) => !row.dueDay) ? TASKS.keysHintSchedule : TASKS.keysHint}</p> : null}
    </div>
  );
}

/** #/tasks/<id> for a finished todo: what it was, with 改回未完成 and 解釋這個. Takes focus when it appears. */
function LinkedDoneTodo({ todo, timeZone, onReopen }: { todo: Todo; timeZone: string; onReopen: () => Promise<unknown> }) {
  const locale = onboardingLocale();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    heading.current?.scrollIntoView({ block: "nearest" });
    heading.current?.focus({ preventScroll: true });
  }, [todo.id]);
  const at = todo.completedAt
    ? new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-TW", { month: locale === "en" ? "short" : "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(new Date(todo.completedAt))
    : "";
  return (
    <Card className="task-linked is-flash" aria-labelledby={headingId}>
      <p className="task-linked-state"><Icon icon={Check} size="sm" />{at ? TASKS.linked.doneAt(at) : TASKS.linked.done}</p>
      <h2 id={headingId} ref={heading} tabIndex={-1} className="task-linked-title">{todo.title}</h2>
      {todo.notes ? <p className="task-linked-notes">{todo.notes}</p> : null}
      <div className="q-actions">
        <Button size="sm" icon={RotateCw} disabled={busy} onClick={() => { setBusy(true); void onReopen().finally(() => setBusy(false)); }}>{TASKS.linked.reopen}</Button>
        <ExplainThis text={explainText(todo.title, todo.notes)} title={todo.title} back={todoHref(todo.id)} />
        <SendToPr text={explainText(todo.title, todo.notes)} title={todo.title} back={todoHref(todo.id)} />
        <Button variant="ghost" size="sm" href="#/tasks">{TASKS.linked.back}</Button>
      </div>
    </Card>
  );
}

function TaskGroupSection({ label, count, overdue, children }: { label: string; count: number; overdue: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section className={cx("q-group", overdue && "is-overdue")} aria-labelledby={id}>
      <div className="q-ghead">
        <h3 id={id}>{label}</h3>
        <span className="count" aria-label={TASKS.countLabel(count)}>{count}</span>
      </div>
      <ul className="q-list">{children}</ul>
    </section>
  );
}

interface TaskRowProps {
  todo: Todo;
  meta: string[];
  when: ReturnType<typeof todoWhen>;
  cursor: boolean;
  expanded: boolean;
  /** Just landed on from `#/tasks/<id>`. */
  flash?: boolean;
  onFocusRow: () => void;
  onToggle: () => void;
  onCheck: () => Promise<unknown>;
  onSave: (patch: TodoUpdateRequest) => Promise<void>;
  onDelete: () => void;
  /** 整理 with AI; undefined while AI is off or the CLI is not signed in. */
  onTidy?: () => void;
  /** 復原整理; undefined unless the todo keeps the fields from before a tidy. */
  onRevert?: () => void;
  /** 排日期; undefined unless the todo has no due day. */
  onSchedule?: () => void;
}

function TaskRow({ todo, meta, when, cursor, expanded, flash, onFocusRow, onToggle, onCheck, onSave, onDelete, onTidy, onRevert, onSchedule }: TaskRowProps) {
  const detailId = useId();
  const tidying = useTidying("todo", todo.id);
  return (
    <li className={cx("q-row", cursor && "is-cursor", expanded && "is-focus", flash && "is-flash")} data-todo={todo.id} aria-current={cursor ? "true" : undefined}>
      <span className="task-check">
        <Checkbox checked={false} onChange={() => onCheck()} ariaLabel={TASKS.checkLabel(todo.title, false)} />
      </span>
      <div className="q-main">
        <button type="button" className="q-title" tabIndex={cursor ? 0 : -1} aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onFocus={onFocusRow} onClick={onToggle}>
          {todo.title}
        </button>
        <p className="q-meta">
          {todo.priority === "high" ? <span className="hot">{TASKS.important} · </span> : null}
          {meta.join(" · ")}
        </p>
      </div>
      <div className="q-end">
        {onSchedule && !tidying ? (
          <Button variant="ghost" size="sm" icon={CalendarPlus} kbd="S" className="task-sched" tabIndex={cursor ? 0 : -1} aria-label={TASKS.schedule.buttonLabel(todo.title)} onClick={onSchedule}>
            {TASKS.schedule.button}
          </Button>
        ) : null}
        {tidying ? <span className="ai-tag inline tidy-mark" role="status" aria-label={TIDY.workingAria}><Spinner />{TIDY.working}</span> : null}
        {when ? <span className={cx("when", !when.mono && "zh", when.tone === "hot" && "hot", when.tone === "warm" && "warm")}>{when.label}</span> : null}
      </div>
      {expanded ? <TaskEditor id={detailId} todo={todo} onSave={onSave} onDelete={onDelete} onClose={onToggle} onTidy={tidying ? undefined : onTidy} onRevert={tidying ? undefined : onRevert} /> : null}
    </li>
  );
}

interface TaskEditorProps {
  id: string;
  todo: Todo;
  onSave: (patch: TodoUpdateRequest) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
  onTidy?: () => void;
  onRevert?: () => void;
}

function TaskEditor({ id, todo, onSave, onDelete, onClose, onTidy, onRevert }: TaskEditorProps) {
  const toast = useToast();
  // `base` is the todo as the fields last took it; a tidy landing (or 復原整理) moves it and the untouched fields follow.
  const latest = editorFields(todo);
  const [form, setForm] = useState<{ base: EditorFields; fields: EditorFields }>(() => ({ base: latest, fields: latest }));
  useEffect(() => {
    setForm((state) => (sameEditorFields(state.base, latest) ? state : { base: latest, fields: resyncEditor(state.base, state.fields, latest) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the values, not the object identity
  }, [latest.title, latest.dueDay, latest.dueTime, latest.notes, latest.important]);
  const { title, dueDay, dueTime, notes, important } = form.fields;
  const set = (patch: Partial<EditorFields>) => setForm((state) => ({ ...state, fields: { ...state.fields, ...patch } }));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!title.trim()) { setError(TASKS.edit.titleRequired); return; }
    setSaving(true);
    try {
      await onSave(editorPatch(form.base, form.fields));
    } catch (cause) {
      toast.error(ERRORS.actionFailed(TASKS.toasts.saveFailed, errorText(cause)));
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
  };

  return (
    <form id={id} className="q-detail task-editor" onSubmit={submit} onKeyDown={onKeyDown}>
      <Field label={TASKS.edit.title} error={error}>
        <TextInput value={title} maxLength={200} onChange={(event) => { set({ title: event.target.value }); setError(undefined); }} autoFocus />
      </Field>
      <div className="task-editor-row">
        <Field label={TASKS.edit.due}>
          <TextInput type="date" value={dueDay} onChange={(event) => set({ dueDay: event.target.value })} />
        </Field>
        <Field label={TASKS.edit.time}>
          <TextInput type="time" value={dueTime} disabled={!dueDay} onChange={(event) => set({ dueTime: event.target.value })} />
        </Field>
      </div>
      <Field label={TASKS.edit.notes}>
        <Textarea rows={2} value={notes} maxLength={4000} placeholder={TASKS.edit.notesPlaceholder} onChange={(event) => set({ notes: event.target.value })} />
      </Field>
      <Switch checked={important} onChange={(on) => set({ important: on })} label={TASKS.edit.important} />
      {(todo.tidiedAt && todo.originalText) || onRevert ? (
        <div className="task-original">
          {todo.tidiedAt && todo.originalText ? <p className="kp">{TIDY.original(todo.originalText)}</p> : null}
          {onRevert ? <Button variant="ghost" size="sm" icon={Undo2} aria-label={TIDY.revertAria(todo.title)} onClick={onRevert}>{TIDY.revert}</Button> : null}
        </div>
      ) : null}
      <div className="q-actions">
        <Button type="submit" variant="primary" size="sm" disabled={saving}>{TASKS.edit.save}</Button>
        <Button variant="secondary" size="sm" onClick={onClose}>{TASKS.edit.close}</Button>
        {onTidy ? <Button variant="ghost" size="sm" icon={WandSparkles} title={TIDY.actionHint} aria-label={TIDY.actionAria(todo.title)} onClick={onTidy}>{TIDY.action}</Button> : null}
        <ExplainThis text={explainText(todo.title, todo.notes)} title={todo.title} back={todoHref(todo.id)} />
        <SendToPr text={explainText(todo.title, todo.notes)} title={todo.title} back={todoHref(todo.id)} />
        <Button variant="ghost" size="sm" className="task-delete" onClick={onDelete}>{TASKS.edit.delete}</Button>
        {todo.sourceRef?.url ? <Button variant="ghost" size="sm" icon={ArrowUpRight} href={todo.sourceRef.url} external className="ext">{TASKS.edit.open}</Button> : null}
      </div>
    </form>
  );
}

/** The inline add row with the live parse (待辦 context: text without a date is a todo). */
function TaskAdd({ timeZone, onAdded }: { timeZone: string; onAdded: (response: CaptureResponse) => void }) {
  const [text, setText] = useState("");
  const state = useCaptureState(text, "todo", timeZone);
  const commit = useCaptureCommit(timeZone);
  const inputId = useId();
  const typing = text.trim().length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const value = text.trim();
      if (!value) return;
      const parse = state.parse;
      setText("");
      void commit(value, parse, { onCreated: onAdded, onFailed: () => setText((current) => current || value) }).catch(() => {});
    } else if (event.key === "Tab" && !event.shiftKey && typing) {
      event.preventDefault();
      state.cycleType();
    } else if (event.key === "Escape" && typing) {
      event.preventDefault();
      setText("");
    }
  };

  return (
    <div className="task-add">
      <label className="cap-field" htmlFor={inputId}>
        <Icon icon={Plus} />
        <span className="sr-only">{TASKS.addLabel}</span>
        <input
          id={inputId}
          type="text"
          placeholder={TASKS.addPlaceholder}
          autoComplete="off"
          enterKeyHint="done"
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <kbd className="d-only">↵</kbd>
      </label>
      {typing ? (
        <div className="task-add-parse">
          <span className="task-add-preview">{CAPTURE.preview(state.parse.type, whenLabel(state.parse, timeZone, new Date()))}</span>
          <ParseRow parse={state.parse} timeZone={timeZone} onType={state.setType} onMoment={state.setMoment} hideHint />
        </div>
      ) : (
        <p className="task-add-hint">{TASKS.addHint}</p>
      )}
    </div>
  );
}
