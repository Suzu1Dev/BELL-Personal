/**
 * #/today (SPEC-ux §4): hero, then the two-column grid — main column queue
 * (with its one quiet 還有 N 件待辦沒排日期 line) → digest → later, side
 * column capture → habits → agenda → 今日複習 (BELL Explain, src/suite) —
 * then the end mark. At ≤1080 the grid becomes one column in the SPEC order (habit chips
 * first). Data comes only from useToday() (the 今日複習 card reads its own
 * /api/suite/sources and fails on its own); every widget renders its own
 * loading, empty, error and stale state, so one failure never blanks the page.
 */
import { useCallback, useEffect, useState } from "react";
import type { ActionId, HandledItem, QueueItem, TodayGap } from "../../../shared/today";
import { BUTTONS, ERRORS } from "../../copy/common";
import { BRIEF, QUEUE } from "../../copy/today";
import { api, send } from "../../api";
import { useShell } from "../../app/shell-context";
import { Button } from "../../components/Button";
import { RotateCw } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { useToast } from "../../components/toast/ToastProvider";
import type { RouteOf } from "../../lib/router";
import { useToday } from "../../lib/today";
import { MEDIA, useMediaQuery } from "../../lib/useMediaQuery";
import { ExplainTodayCard } from "../../suite/ExplainTodayCard";
import { PrTodayCard } from "../../suite/PrTodayCard";
import { useHabitToggle } from "../habits/useHabitKeys";
import { AgendaCard } from "./AgendaCard";
import { BacklogNote } from "./BacklogNote";
import { DigestStrip } from "./DigestStrip";
import { EndMark } from "./EndMark";
import { FocusQueue } from "./FocusQueue";
import { HabitsCard } from "./HabitsCard";
import { LaterCard } from "./LaterCard";
import { TodayHero, TodayProgress } from "./TodayHero";
import { refreshBrief, syncSources } from "./today-api";
import { scheduleWindow } from "./today-view";
import "./TodayPage.css";

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

/** A generating brief is looked at again every 3 s for the 8 s it may take (SPEC-ux §4.2). */
const BRIEF_POLL_MS = 3_000;
const BRIEF_POLL_FOR_MS = 9_000;

export default function TodayPage(_props: { route: RouteOf<"today"> }) {
  const today = useToday();
  const toast = useToast();
  const shell = useShell();
  const wide = useMediaQuery(MEDIA.wide);
  const { data, refresh } = today;
  const [refreshing, setRefreshing] = useState(false);

  const briefState = data?.brief.state;
  useEffect(() => {
    if (briefState !== "generating") return;
    const timer = window.setInterval(() => void refresh(), BRIEF_POLL_MS);
    const stop = window.setTimeout(() => window.clearInterval(timer), BRIEF_POLL_FOR_MS);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [briefState, refresh]);

  const act = useCallback((item: QueueItem, action: ActionId, params?: Record<string, unknown>, message?: string) => {
    void today.act(item.id, action, params, message ? { message } : undefined);
  }, [today]);

  const actOn = (itemId: string, action: ActionId, message?: string) => {
    void today.act(itemId, action, undefined, message ? { message } : undefined);
  };

  const sync = (ids: string[]) => {
    syncSources(ids)
      .then(() => refresh())
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(BUTTONS.refresh, reasonOf(cause))));
  };

  // Check-ins (SPEC-ux §4.7) are the habits team's toggle: optimistic, POST/DELETE /api/habits/:id/check, undo toast on un-check.
  const toggleHabit = useHabitToggle();

  const captureField = () => {
    const field = document.querySelector<HTMLElement>(".bot-field textarea, .cap-field input");
    if (wide && field) field.focus();
    else shell.openPalette("capture");
  };

  const onRefreshBrief = () => {
    if (refreshing) return;
    setRefreshing(true);
    refreshBrief()
      .then(() => refresh())
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(BRIEF.refreshFailed, reasonOf(cause))))
      .finally(() => setRefreshing(false));
  };

  const onSchedule = (gap: TodayGap) => {
    void today.act(gap.forItemId, "schedule", scheduleWindow(gap));
  };

  const onUndoHandled = (entry: HandledItem) => {
    api(`/actions/${encodeURIComponent(entry.actionId)}`, send("DELETE"))
      .then(() => {
        toast.success(QUEUE.handledUndone(entry.title));
        return refresh();
      })
      .catch((cause: unknown) => toast.error(ERRORS.undoFailed(reasonOf(cause))));
  };

  // The first load failed: widgets show a static line, not a skeleton that announces loading forever.
  const failed = today.state === "error" && !data;

  return (
    <>
      {failed ? (
        <Notice
          className="today-notice"
          tone="error"
          role="alert"
          title={ERRORS.todayTitle}
          actions={<Button variant="secondary" size="sm" icon={RotateCw} onClick={() => void refresh()}>{BUTTONS.retry}</Button>}
        >
          {today.error ?? ERRORS.offline}
        </Notice>
      ) : null}
      <TodayHero payload={data} refreshing={refreshing} onRefreshBrief={onRefreshBrief} failed={failed} />
      <div className="today-grid">
        <div className="col">
          <FocusQueue
            payload={data}
            pollState={today.state}
            updatedAt={today.updatedAt}
            onAct={act}
            onRetry={() => void refresh()}
            onSyncSources={sync}
            onCapture={captureField}
            onUndoHandled={onUndoHandled}
            onToggleHabit={toggleHabit}
          />
          <BacklogNote payload={data} />
          <DigestStrip payload={data} onAct={actOn} />
          <LaterCard payload={data} onRetry={() => void refresh()} onSyncSources={sync} failed={failed} />
        </div>
        <div className="col">
          <TodayProgress payload={data} failed={failed} />
          <HabitsCard payload={data} onToggle={toggleHabit} failed={failed} />
          <AgendaCard payload={data} onAdd={() => shell.openPalette("capture", "+")} onSchedule={onSchedule} onToggleHabit={toggleHabit} onSyncSources={sync} failed={failed} />
          <ExplainTodayCard />
          <PrTodayCard />
        </div>
      </div>
      <EndMark brief={data?.brief} />
    </>
  );
}
