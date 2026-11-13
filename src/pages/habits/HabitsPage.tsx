/**
 * #/habits (SPEC-ux §3.3 習慣, §4.7, §5 habits row): every habit with its
 * 5-week heat strip, streak and cadence; 新增習慣 / 編輯 in a dialog; an
 * edit menu (move, 補打卡昨天, 封存, 刪除 with undo); the optional automatic
 * 「GitHub 有貢獻」 habit; keys 1–9 toggle today's check-ins. A past day in
 * the heat strip, like 補打卡昨天, is checked in or taken back with
 * POST / DELETE /check {day}; taking one back offers 復原.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { ArchiveRestore, ChevronDown, GitCommitHorizontal } from "lucide-react";
import type { HabitDeleteResponse, HabitSummary, HabitsResponse, HabitUncheckResponse, HabitUpdateRequest } from "../../../shared/habits";
import { api, core, send } from "../../api";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Switch } from "../../components/Field";
import { Clock, Flame, Icon, Plus, RefreshCw } from "../../components/Icon";
import { Kbd } from "../../components/Kbd";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { Skeleton } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { Tile } from "../../components/Tile";
import { useToast } from "../../components/toast/ToastProvider";
import { EVENT_SHARED } from "../../copy/events";
import { HABIT_ARCHIVE, HABIT_AUTO, HABIT_ERRORS, HABIT_TOASTS, HABITS, HABITS_PAGE_HEAD, habitServerError } from "../../copy/habits";
import { onboardingLocale } from "../../copy/onboarding";
import type { RouteOf } from "../../lib/router";
import { clockTime } from "../../lib/today-model";
import { useToday } from "../../lib/today";
import { usePoll } from "../../lib/usePoll";
import { HabitDialog } from "./HabitDialog";
import { HabitRow } from "./HabitRow";
import { flipSummary, habitBody, habitCadence, moveHabit, replaceSummary, shortDay, updateSummary, weekColumn, weekdayHeads, yesterdayOf, type HabitForm } from "./model";
import { useHabitKeys, useHabitToggle } from "./useHabitKeys";
import "./HabitsPage.css";

export const HABITS_POLL_MS = 60_000;

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function HabitStaleNote({ time, onRefresh }: { time: string; onRefresh: () => void }) {
  if (onboardingLocale() === "zh-TW") return <StaleNote time={time} onRefresh={onRefresh} />;
  return (
    <p className="stale-note">
      <Icon icon={Clock} size="sm" />
      <span>{EVENT_SHARED.staleShowing(time)} · </span>
      <button type="button" onClick={onRefresh}>{EVENT_SHARED.staleRefresh}</button>
    </p>
  );
}

export default function HabitsPage(_props: { route: RouteOf<"habits"> }) {
  const toast = useToast();
  const { refresh: refreshToday } = useToday();
  const fetcher = useCallback(async (signal: AbortSignal) => {
    const startedAt = Date.now();
    return { startedAt, body: await api<HabitsResponse>("/habits", { signal }) };
  }, []);
  const poll = usePoll(fetcher, HABITS_POLL_MS);
  const polled = useRef(poll.data);
  polled.current = poll.data;
  // Local edits (optimistic toggles, server answers) stay on top until a fetch that started after them lands.
  const [edited, setEdited] = useState<{ at: number; data: HabitsResponse }>();
  const visibleData = (state: typeof edited) => (state && (!polled.current || state.at >= polled.current.startedAt) ? state.data : polled.current?.body);
  const data = visibleData(edited);
  const edit = useCallback((change: (current: HabitsResponse) => HabitsResponse) => {
    setEdited((state) => {
      const base = visibleData(state);
      return base ? { at: Date.now(), data: change(base) } : state;
    });
  }, []);

  const [dialog, setDialog] = useState<{ open: boolean; habit?: HabitSummary }>({ open: false });
  const [showArchived, setShowArchived] = useState(false);

  const toggle = useHabitToggle({
    onLocal: (id, done) => edit((current) => updateSummary(current, id, (summary) => flipSummary(summary, done))),
    onServer: (summary) => edit((current) => replaceSummary(current, summary)),
    onRevert: (id, done) => edit((current) => updateSummary(current, id, (summary) => flipSummary(summary, done))),
  });
  useHabitKeys(data?.habits, toggle, !dialog.open);

  // After a write: reload the list (not through the poll, which skips while a fetch is in flight) and Today's badges.
  const reloads = useRef(0);
  const settle = useCallback(() => {
    const seq = ++reloads.current;
    api<HabitsResponse>("/habits")
      .then((fresh) => { if (seq === reloads.current) edit(() => fresh); })
      .catch(() => { /* the next poll catches up */ });
    void refreshToday();
  }, [edit, refreshToday]);

  /** Runs a write; on success applies the server's habit and refreshes, on failure shows the error toast. */
  const write = useCallback(async <T extends HabitSummary>(request: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try {
      const summary = await request();
      edit((current) => replaceSummary(current, summary));
      settle();
      if (success) toast.success(success);
      return summary;
    } catch (cause) {
      toast.error(HABIT_ERRORS.action(reason(cause)));
      return undefined;
    }
  }, [edit, settle, toast]);

  const patch = useCallback((id: string, body: HabitUpdateRequest) => api<HabitSummary>(`/habits/${encodeURIComponent(id)}`, send("PATCH", body)), []);

  const submit = async (form: HabitForm) => {
    const habit = dialog.habit;
    try {
      const summary = habit
        ? await patch(habit.id, habitBody(form, habit.auto))
        : await api<HabitSummary>("/habits", send("POST", habitBody(form)));
      edit((current) => replaceSummary(current, summary));
      settle();
      setDialog({ open: false });
      toast.success(habit ? HABIT_TOASTS.saved(summary.name) : HABIT_TOASTS.created(summary.name));
    } catch (cause) {
      throw new Error(HABIT_ERRORS.save(reason(cause)));
    }
  };

  const move = async (habit: HabitSummary, delta: -1 | 1) => {
    const ids = moveHabit((data?.habits ?? []).map((item) => item.id), habit.id, delta);
    if (!ids) return;
    try {
      const next = await api<HabitsResponse>("/habits/order", send("PUT", { ids }));
      edit(() => next);
      settle();
    } catch (cause) {
      toast.error(HABIT_ERRORS.action(reason(cause)));
    }
  };

  /** Past-day writes still out, by habit and day: a second press waits for the first instead of racing it. */
  const dayWrites = useRef(new Set<string>());

  /**
   * Checks a past day in (done) or takes its check-in back. Taking it back
   * offers 復原, which puts the original check-in time back (the server
   * checks it still falls on that day).
   */
  const setDay = async (habit: HabitSummary, day: string, done: boolean, message: string) => {
    const key = `${habit.id}\u0000${day}`;
    if (dayWrites.current.has(key)) return;
    dayWrites.current.add(key);
    const path = `/habits/${encodeURIComponent(habit.id)}/check`;
    try {
      const result = await write(() => api<HabitUncheckResponse>(path, send(done ? "POST" : "DELETE", { day })), done ? message : undefined);
      if (result && !done) {
        const at = result.previousAt;
        toast.undo(message, () => { void write(() => api<HabitSummary>(path, send("POST", at ? { day, at } : { day }))); });
      }
    } finally {
      dayWrites.current.delete(key);
    }
  };

  const backfill = (habit: HabitSummary, done: boolean) => {
    const day = yesterdayOf(data?.day ?? habit.heat.at(-1)!.day);
    void setDay(habit, day, done, done ? HABIT_TOASTS.backfilled(habit.name) : HABIT_TOASTS.unbackfilled(habit.name));
  };

  const setHeatDay = (habit: HabitSummary, day: string, done: boolean) => {
    void setDay(habit, day, done, done ? HABIT_TOASTS.dayChecked(habit.name, shortDay(day)) : HABIT_TOASTS.dayUnchecked(habit.name, shortDay(day)));
  };

  const archive = async (habit: HabitSummary) => {
    const summary = await write(() => patch(habit.id, { archived: true }));
    if (summary) toast.undo(HABIT_TOASTS.archived(habit.name), () => { void write(() => patch(habit.id, { archived: false })); });
  };

  const unarchive = (habit: HabitSummary) => {
    void write(() => patch(habit.id, { archived: false }), HABIT_TOASTS.restored(habit.name));
  };

  const remove = async (habit: HabitSummary) => {
    try {
      const result = await api<HabitDeleteResponse>(`/habits/${encodeURIComponent(habit.id)}`, send("DELETE"));
      edit((current) => ({ ...current, habits: current.habits.filter((item) => item.id !== habit.id), archived: current.archived.filter((item) => item.id !== habit.id) }));
      settle();
      if (result.undoToken) {
        const token = result.undoToken;
        toast.undo(HABIT_TOASTS.deleted(habit.name), () => {
          core.restore(token).then(settle, (cause: unknown) => toast.error(HABIT_ERRORS.action(reason(cause))));
        });
      }
    } catch (cause) {
      toast.error(HABIT_ERRORS.action(reason(cause)));
    }
  };

  const setAuto = async (enabled: boolean) => {
    try {
      await api("/settings/app", send("PUT", { "habits.githubAuto": enabled }));
      edit((current) => ({ ...current, githubAuto: enabled }));
      settle();
      toast.success(enabled ? HABIT_TOASTS.autoOn : HABIT_TOASTS.autoOff);
    } catch (cause) {
      toast.error(HABIT_ERRORS.action(reason(cause)));
    }
  };

  const habits = data?.habits ?? [];
  const archived = data?.archived ?? [];
  const doneCount = habits.filter((habit) => habit.doneToday).length;
  const heads = useMemo(() => weekdayHeads(data?.weekStartsMonday ?? true), [data?.weekStartsMonday]);
  const todayColumn = data ? weekColumn(data.day, data.weekStartsMonday) : -1;
  const openNew = () => setDialog({ open: true });

  return (
    <>
      <div className="habit-page">
        <PageHead
          eyebrow=""
          title={HABITS_PAGE_HEAD.title}
          sub=""
          actions={<Button variant="primary" icon={Plus} onClick={openNew}>{HABITS.add}</Button>}
        />
        {poll.state === "error" && !data ? (
          <Notice tone="error" title={HABITS.loadFailed} actions={<Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void poll.refresh()}>{HABIT_ERRORS.retry}</Button>}>
            {poll.error ? habitServerError(poll.error) : ""}
          </Notice>
        ) : null}

        {!data && poll.state === "loading" ? (
          <Card className="habit-board" aria-busy="true" aria-label={HABITS.loading}>
            <CardHead title={HABITS.boardTitle} icon={Flame} tone="habit" />
            <ul className="habit-list">
              {[0, 1, 2].map((index) => (
                <li key={index} className="habit habit-skel" aria-hidden="true">
                  <Skeleton className="habit-skel-check" />
                  <div className="h-main"><Skeleton width="56%" /><Skeleton width="34%" /></div>
                  <Skeleton className="habit-skel-heat" />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {data && habits.length === 0 ? (
          <EmptyState
            icon={Flame}
            tone="habit"
            title={HABITS.emptyTitle}
            hint={HABITS.emptyHint}
            action={<Button variant="secondary" icon={Plus} onClick={openNew}>{HABITS.add}</Button>}
          />
        ) : null}

        {data && habits.length > 0 ? (
          <Card className="habit-board" aria-labelledby="habit-board-title">
            <CardHead title={HABITS.boardTitle} titleId="habit-board-title" icon={Flame} tone="habit">
              <span className="count" aria-label={HABITS.boardCountLabel(doneCount, habits.length)}>{doneCount}/{habits.length}</span>
              <span className="keys">
                {HABITS.keysBefore} <Kbd>1</Kbd>{habits.length > 1 ? <>–<Kbd>{String(Math.min(9, habits.length))}</Kbd></> : null} {HABITS.keysAfter}
              </span>
            </CardHead>
            {poll.state === "stale" && poll.updatedAt ? <HabitStaleNote time={clockTime(new Date(poll.updatedAt).toISOString())} onRefresh={() => void poll.refresh()} /> : null}
            <div className="habit h-head" aria-hidden="true">
              <span />
              <span className="h-head-label">{HABITS.headWeeks}</span>
              <span className="h-days">
                {heads.map((head, index) => <span key={index} className={index === todayColumn ? "today" : undefined}>{head}</span>)}
              </span>
              <span className="h-head-streak">{HABITS.headStreak}</span>
              <span />
            </div>
            <ul className="habit-list">
              {habits.map((habit, index) => (
                <HabitRow
                  key={habit.id}
                  habit={habit}
                  index={index}
                  count={habits.length}
                  today={data.day}
                  actions={{
                    toggle: () => void toggle(habit),
                    edit: () => setDialog({ open: true, habit }),
                    move: (delta) => void move(habit, delta),
                    backfill: (done) => backfill(habit, done),
                    setDay: (day, done) => setHeatDay(habit, day, done),
                    archive: () => void archive(habit),
                    remove: () => void remove(habit),
                    autoOff: () => void setAuto(false),
                  }}
                />
              ))}
            </ul>
            <p className="habit-legend" aria-hidden="true">
              <span><i className="y" />{HABITS.legendDone}</span>
              <span><i />{HABITS.legendMissed}</span>
              <span><i className="rest" />{HABITS.legendRest}</span>
              <span><i className="t" />{HABITS.legendToday}</span>
            </p>
          </Card>
        ) : null}

        {data ? (
          <Card className="habit-auto" aria-label={HABIT_AUTO.title}>
            <Tile icon={GitCommitHorizontal} tone="habit" />
            <div className="habit-auto-body">
              <Switch checked={data.githubAuto} onChange={(next) => void setAuto(next)} label={HABIT_AUTO.title} hint={HABIT_AUTO.hint} />
              {data.githubAuto && data.githubDays === 0 ? (
                <p className="habit-auto-note kp">
                  {HABIT_AUTO.notConnected} <TextLink href="#/settings/sources">{HABIT_AUTO.settingsLink}</TextLink>
                </p>
              ) : null}
            </div>
          </Card>
        ) : null}

        {archived.length ? (
          <section className="habit-archived" aria-label={HABIT_ARCHIVE.label}>
            <Button variant="ghost" size="sm" icon={ChevronDown} className={showArchived ? "is-open" : undefined} aria-expanded={showArchived} onClick={() => setShowArchived((open) => !open)}>
              {HABIT_ARCHIVE.toggle(archived.length, showArchived)}
            </Button>
            {showArchived ? (
              <ul>
                {archived.map((habit) => (
                  <li key={habit.id}>
                    <div className="h-main">
                      <span className="h-name">{habit.name}</span>
                      <span className="h-cad">{habitCadence(habit)}</span>
                    </div>
                    <Button variant="secondary" size="sm" icon={ArchiveRestore} onClick={() => unarchive(habit)}>{HABIT_ARCHIVE.restore}</Button>
                    <Button variant="ghost" size="sm" onClick={() => void remove(habit)}>{HABIT_ARCHIVE.delete}</Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
      <HabitDialog open={dialog.open} habit={dialog.habit} onClose={() => setDialog({ open: false })} onSubmit={submit} />
    </>
  );
}
