/**
 * #/calendar?view=day|week|month:
 * - 日 / 週 / 月 segmented views with ‹ 今天 › date navigation.
 * - Live Google Calendar two-way sync badge + 1-click 「立即同步」.
 * - Structured in-app event creation & two-way editing (local + Google Calendar)
 *   so every calendar task can be completed directly inside BELL Personal.
 */
import { ChevronLeft, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CalendarDay, CalendarEvent, CalendarEventCreateRequest, CalendarEventCreateResponse,
  CalendarEventDeleteResponse, CalendarGoogleInsertResponse, CalendarItem, CalendarResponse,
  CalendarSourceState, FreeSlot, GoogleCalendarEventDeleteResponse, ManualEvent,
} from "../../../shared/calendar";
import type { TodayGap } from "../../../shared/today";
import { api, core, send } from "../../api";
import { useShell } from "../../app/shell-context";
import { Button } from "../../components/Button";
import { isTidying, useTidyAction, useTidyRevert, useTidyVersion } from "../../components/capture/tidy";
import { useCaptureEnv } from "../../components/capture/useCapture";
import { Card, CardHead } from "../../components/Card";
import { CalendarDays, CalendarPlus, Clock, Icon, Plus, RotateCw, Settings } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SkeletonRow } from "../../components/Skeleton";
import { useToast } from "../../components/toast/ToastProvider";
import { CALENDAR, CALENDAR_PAGE_HEAD, CALENDAR_SHARED, calendarServerError } from "../../copy/calendar";
import { cx } from "../../lib/cx";
import { navigate, routeHref, type RouteOf } from "../../lib/router";
import { useToday } from "../../lib/today";
import { findQueueItem } from "../../lib/today-model";
import { MEDIA, useMediaQuery } from "../../lib/useMediaQuery";
import { POLL_INTERVALS, usePoll } from "../../lib/usePoll";
import { useHabitToggle } from "../habits/useHabitKeys";
import { AgendaTimeline, type AgendaTimelineProps } from "./AgendaTimeline";
import { dayShort, dayTitle, localizeCalendarItem, monthHeading, prefillText, shiftDay, syncedLabel, timelineRows } from "./calendar-model";
import { withEdits, type EventEdit } from "./event-editor";
import { EventEditor } from "./EventEditor";
import { MonthGrid } from "./MonthGrid";
import type { RemoveScope } from "./RemoveMenu";
import { WeekGrid } from "./WeekGrid";
import "../../components/StaleNote.css";
import "./CalendarPage.css";

type View = RouteOf<"calendar">["view"];

const errorText = (cause: unknown) => calendarServerError(cause instanceof Error ? cause.message : CALENDAR_SHARED.offline);
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
/** The `hidden` key of a whole weekly series (a single row hides under its item id). */
const seriesKey = (manualId: string) => `series:${manualId}`;

function CalendarStaleNote({ time, onRefresh }: { time: string; onRefresh: () => void }) {
  return (
    <p className="stale-note">
      <Icon icon={Clock} size="sm" />
      <span>{CALENDAR_SHARED.staleShowing(time)} · </span>
      <button type="button" onClick={onRefresh}>{CALENDAR_SHARED.staleRefresh}</button>
    </p>
  );
}

interface CreateIntent {
  day: string;
  slot?: Pick<FreeSlot, "start" | "end">;
  anchor: HTMLElement | null;
  nonce: number;
}

export default function CalendarPage({ route }: { route: RouteOf<"calendar"> }) {
  const [anchor, setAnchor] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState<CalendarResponse | undefined>(undefined);
  const [selectedDay, setSelectedDay] = useState<string | undefined>(undefined);
  const [createIntent, setCreateIntent] = useState<CreateIntent | null>(null);
  const [syncingNow, setSyncingNow] = useState(false);
  const [syncPulse, setSyncPulse] = useState(0);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const view = route.view;
  const today = shown?.today;
  const day = anchor ?? shown?.day;
  const activeDay = view === "month" ? (selectedDay ?? day) : day;

  const go = (next: View, nextAnchor = anchor) => {
    setAnchor(nextAnchor);
    if (nextAnchor) setSelectedDay(nextAnchor);
    if (next !== view) navigate(routeHref({ name: "calendar", view: next }));
  };

  const shiftAnchor = (direction: -1 | 1) => {
    if (!day) return;
    const next = shiftDay(day, view, direction);
    setAnchor(next);
    setSelectedDay(next);
  };

  const jumpToday = () => {
    if (!today) return;
    setAnchor(today);
    setSelectedDay(today);
  };

  const googleSource = shown?.sources.find((s) => s.id === "google-calendar");
  const isSyncing = syncingNow || googleSource?.state === "syncing";

  const triggerSyncNow = async () => {
    if (isSyncing) return;
    setSyncingNow(true);
    try {
      await api("/sync", send("POST", { sources: ["google-calendar", "ics"], force: true }));
      await wait(1400);
      setSyncPulse((n) => n + 1);
    } catch {
      // Any source failure surfaces through the calendar status banner.
    } finally {
      setSyncingNow(false);
    }
  };

  return (
    <div className="cal-page">
      <PageHead
        eyebrow={CALENDAR_PAGE_HEAD.eyebrow}
        title={CALENDAR_PAGE_HEAD.title}
        sub={CALENDAR_PAGE_HEAD.sub}
        actions={(
          <Button
            ref={addBtnRef}
            variant="primary"
            icon={Plus}
            onClick={(event) => {
              const targetDay = activeDay ?? today ?? new Date().toISOString().slice(0, 10);
              setCreateIntent({ day: targetDay, anchor: event.currentTarget, nonce: Date.now() });
            }}
          >
            {CALENDAR.add}
          </Button>
        )}
      />
      <div className="cal-bar">
        <SegmentedControl
          label={CALENDAR.viewLabel}
          options={[
            { value: "day", label: CALENDAR.views.day },
            { value: "week", label: CALENDAR.views.week },
            { value: "month", label: CALENDAR.views.month },
          ]}
          value={view}
          onChange={(next) => go(next as View)}
        />
        <div className="cal-nav" role="group" aria-label={CALENDAR.navLabel}>
          <Button variant="icon" icon={ChevronLeft} aria-label={CALENDAR.prev[view]} disabled={!day} onClick={() => shiftAnchor(-1)} />
          <Button
            variant="secondary"
            size="sm"
            disabled={!today || (day === today && (view === "day" || (view === "month" && (selectedDay ?? day) === today)))}
            onClick={jumpToday}
          >
            {CALENDAR.today}
          </Button>
          <Button variant="icon" icon={ChevronRight} aria-label={CALENDAR.next[view]} disabled={!day} onClick={() => shiftAnchor(1)} />
        </div>
        <h2 className="cal-range" aria-live="polite">{shown ? rangeTitle(shown, view, anchor) : "\u00a0"}</h2>

        {shown ? (
          <div className="cal-sync">
            {shown.google.connected ? (
              <>
                {shown.google.canWrite ? (
                  <span className="cal-sync-pill is-twoway">
                    <span className="cal-sync-dot" aria-hidden="true" />
                    <span>{CALENDAR.sync.twoWay}</span>
                    {googleSource?.lastSyncedAt ? (
                      <time className="mono">{syncedLabel(googleSource.lastSyncedAt, shown.today, shown.timeZone)}</time>
                    ) : null}
                  </span>
                ) : (
                  <a href="#/settings/sources" className="cal-sync-pill is-readonly">
                    <span className="cal-sync-dot" aria-hidden="true" />
                    <span>{CALENDAR.sync.readOnly}</span>
                  </a>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RotateCw}
                  className={cx("cal-sync-btn", isSyncing && "is-spinning")}
                  disabled={isSyncing}
                  onClick={() => void triggerSyncNow()}
                >
                  {isSyncing ? CALENDAR.sync.syncing : CALENDAR.sync.syncNow}
                </Button>
              </>
            ) : (
              <a href="#/settings/sources" className="cal-sync-pill is-off">
                <span className="cal-sync-dot" aria-hidden="true" />
                <span>{CALENDAR.sync.localOnly}</span>
              </a>
            )}
          </div>
        ) : null}
      </div>

      <CalendarBody
        key={`${view}|${anchor ?? ""}`}
        view={view}
        anchor={anchor}
        selectedDay={selectedDay}
        onSelectDay={setSelectedDay}
        createIntent={createIntent}
        onClearCreate={() => setCreateIntent(null)}
        onRequestCreate={(targetDay, anchorEl, slot) => setCreateIntent({ day: targetDay, anchor: anchorEl, slot, nonce: Date.now() })}
        syncPulse={syncPulse}
        fallback={shown}
        onData={setShown}
        onOpenDay={(next) => go("day", next)}
      />
    </div>
  );
}

function rangeTitle(data: CalendarResponse, view: View, anchor: string | undefined): string {
  const day = anchor ?? data.day;
  if (view === "month") return monthHeading(day);
  if (view === "day" || data.view !== view) return dayTitle(day);
  return CALENDAR.weekOf(dayShort(data.from), dayShort(data.to));
}

interface BodyProps {
  view: View;
  anchor: string | undefined;
  selectedDay: string | undefined;
  onSelectDay: (day: string) => void;
  createIntent: CreateIntent | null;
  onClearCreate: () => void;
  onRequestCreate: (day: string, anchor: HTMLElement | null, slot?: Pick<FreeSlot, "start" | "end">) => void;
  syncPulse: number;
  /** The last answer, shown dimmed while this view loads. */
  fallback: CalendarResponse | undefined;
  onData: (data: CalendarResponse) => void;
  onOpenDay: (day: string) => void;
}

function CalendarBody({
  view,
  anchor,
  selectedDay,
  onSelectDay,
  createIntent,
  onClearCreate,
  onRequestCreate,
  syncPulse,
  fallback,
  onData,
  onOpenDay,
}: BodyProps) {
  const shell = useShell();
  const toast = useToast();
  const today = useToday();
  const toggleHabit = useHabitToggle();
  const captureEnv = useCaptureEnv();
  const tidyAction = useTidyAction();
  const revertTidy = useTidyRevert();
  useTidyVersion();
  const tidyProps = {
    onTidy: captureEnv.aiParse ? (item: CalendarItem) => { if (item.manualId) void tidyAction("event", item.manualId); } : undefined,
    tidying: (manualId: string) => isTidying("event", manualId),
    onRevert: (item: CalendarItem) => { if (item.manualId) void revertTidy("event", item.manualId); },
  };
  const wide = useMediaQuery("(min-width: 980px)");
  const fetcher = useCallback((signal: AbortSignal) => api<CalendarResponse>(`/calendar?view=${view}${anchor ? `&day=${anchor}` : ""}`, { signal }), [view, anchor]);
  const poll = usePoll(fetcher, POLL_INTERVALS.calendar);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [showPast, setShowPast] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mobile = useMediaQuery(MEDIA.mobile);
  const [editing, setEditing] = useState<{ item: CalendarItem; anchor: HTMLElement } | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, CalendarItem>>(new Map());

  useEffect(() => { if (poll.data) onData(poll.data); }, [poll.data, onData]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const refresh = poll.refresh;
  const todayStamp = today.updatedAt;
  useEffect(() => { if (todayStamp) void refresh(); }, [todayStamp, refresh]);
  useEffect(() => {
    if (!syncPulse) return;
    void refresh();
    void today.refresh();
  }, [syncPulse, refresh, today]);

  const data = poll.data ?? fallback;
  const loading = !poll.data;
  const days = useMemo(
    () => withEdits(data?.days ?? [], edits, data?.timeZone ?? "").map((entry) => ({
      ...entry,
      items: entry.items
        .filter((item) => !hidden.has(item.id) && !(item.manualId && hidden.has(seriesKey(item.manualId))))
        .map(localizeCalendarItem),
    })),
    [data, edits, hidden],
  );

  if (!data) {
    if (poll.state === "error") {
      return (
        <Notice tone="error" role="alert" title={CALENDAR.loadErrorTitle} actions={<Button variant="secondary" size="sm" icon={RotateCw} onClick={() => void refresh()}>{CALENDAR.retry}</Button>}>
          {poll.error ? calendarServerError(poll.error) : CALENDAR_SHARED.offline}
        </Notice>
      );
    }
    return (
      <Card className="agenda cal-card" aria-busy="true">
        <CardHead icon={CalendarDays} tone="cal" title={CALENDAR.todayTitle} />
        <div className="cal-skel">{Array.from({ length: 4 }, (_, index) => <SkeletonRow key={index} />)}</div>
      </Card>
    );
  }

  const timeZone = data.timeZone;
  const googleCanWrite = data.google.canWrite;
  const google = data.sources.find((source) => source.id === "google-calendar");
  const ics = data.sources.find((source) => source.id === "ics");
  const notSetUp = google?.state === "off" && ics?.state === "off"
    && !data.days.some((entry) => entry.items.some((item) => item.origin === "google" || item.origin === "ics" || item.origin === "manual"));
  const failing = [google, ics].filter((source): source is CalendarSourceState => !!source && (source.state === "error" || source.state === "reconnect"));
  const staleSource = [google, ics].find((source) => source?.state === "stale" && source.lastSyncedAt);
  const dimmed = failing.length > 0;
  const gap: TodayGap | undefined = today.data?.date === data.today ? today.data.agenda.gap : undefined;

  const resync = async (sources: CalendarSourceState["id"][]) => {
    try {
      await api("/sync", send("POST", { sources, force: true }));
      await wait(1500);
    } catch {
      // Notice keeps showing any persistent failure.
    }
    await refresh();
  };

  const schedule = async (target: TodayGap, slot: FreeSlot) => {
    const start = target.start;
    const end = target.estimateMinutes
      ? new Date(Date.parse(start) + target.estimateMinutes * 60_000).toISOString()
      : target.end ?? slot.end;
    const title = findQueueItem(today.data, target.forItemId)?.title ?? target.label;
    const result = await today.act(target.forItemId, "schedule", { start, end, title }, { silent: true });
    if (!result.ok) {
      toast.error(CALENDAR_SHARED.actionFailed(CALENDAR_SHARED.actionLabels.schedule, result.error ?? CALENDAR_SHARED.offline), () => { void schedule(target, slot); });
      return;
    }
    void refresh();
    toast.undo(CALENDAR_SHARED.actionToasts.schedule(title), () => {
      api(`/actions/${encodeURIComponent(result.actionId!)}`, send("DELETE"))
        .then(() => Promise.all([refresh(), today.refresh()]))
        .catch((cause: unknown) => toast.error(CALENDAR_SHARED.undoFailed(errorText(cause))));
    }, { icon: CalendarPlus });
  };

  const hide = (key: string) => setHidden((current) => new Set(current).add(key));
  const unhide = (key: string) => setHidden((current) => { const next = new Set(current); next.delete(key); return next; });

  /** 只刪這一次: one occurrence of a weekly event is skipped; 復原 puts it back. */
  const skipOccurrence = async (item: CalendarItem, day: string) => {
    hide(item.id);
    const path = `/calendar/events/${encodeURIComponent(item.manualId!)}/skip`;
    try {
      await api(path, send("POST", { day }));
      void refresh();
      void today.refresh();
      toast.undo(CALENDAR.removedOne(item.title, dayTitle(day)), () => {
        api(`${path}/${day}`, send("DELETE"))
          .then(() => {
            unhide(item.id);
            return Promise.all([refresh(), today.refresh()]);
          })
          .catch((cause: unknown) => toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.restoreOneAction, errorText(cause))));
      }, { icon: Trash2 });
    } catch (cause) {
      unhide(item.id);
      toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.skipAction, errorText(cause)), () => { void skipOccurrence(item, day); });
    }
  };

  /** Delete a local event OR a native Google Calendar event (two-way), with full Undo support. */
  const remove = async (item: CalendarItem, scope: RemoveScope = "series") => {
    if (item.repeat && scope === "occurrence") return skipOccurrence(item, item.repeat.day);

    // Native Google Calendar event without local manualId: two-way delete + snapshot Undo restore.
    if (!item.manualId && item.origin === "google") {
      hide(item.id);
      try {
        const result = await api<GoogleCalendarEventDeleteResponse>("/calendar/google-events", send("DELETE", { id: item.id }));
        void refresh();
        void today.refresh();
        toast.undo(CALENDAR.removed(item.title), () => {
          if (!result.snapshot) return;
          api<{ event: CalendarEvent }>("/calendar/google-events/restore", send("POST", { snapshot: result.snapshot }))
            .then(() => {
              unhide(item.id);
              return Promise.all([refresh(), today.refresh()]);
            })
            .catch((cause: unknown) => toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.restoreAction, errorText(cause))));
        }, { icon: Trash2 });
      } catch (cause) {
        unhide(item.id);
        toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.removeAction, errorText(cause)), () => { void remove(item, scope); });
      }
      return;
    }

    const key = item.repeat ? seriesKey(item.manualId!) : item.id;
    hide(key);
    try {
      const result = await api<CalendarEventDeleteResponse>(`/calendar/events/${encodeURIComponent(item.manualId!)}`, send("DELETE"));
      void refresh();
      void today.refresh();
      toast.undo(item.repeat ? CALENDAR.removedSeries(item.title) : CALENDAR.removed(item.title), () => {
        if (!result.undoToken) return;
        core.restore(result.undoToken)
          .then(() => {
            unhide(key);
            return Promise.all([refresh(), today.refresh()]);
          })
          .catch((cause: unknown) => toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.restoreAction, errorText(cause))));
      }, { icon: Trash2 });
    } catch (cause) {
      unhide(key);
      toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.removeAction, errorText(cause)), () => { void remove(item, scope); });
    }
  };

  const openEditor = (item: CalendarItem, anchorEl: HTMLElement) => {
    onClearCreate();
    setEditing((current) => (current?.anchor === anchorEl ? null : { item, anchor: anchorEl }));
  };

  const closeEditor = (options: { focus?: boolean } = {}) => {
    const { item, anchor: anchorEl } = editing ?? {};
    setEditing(null);
    if (options.focus === false) return;
    requestAnimationFrame(() => {
      const row = item?.manualId ? `[data-manual="${CSS.escape(item.manualId)}"]` : undefined;
      const target = anchorEl?.isConnected ? anchorEl : row ? document.querySelector<HTMLElement>(`${row}[data-edit], ${row} [data-edit]`) : null;
      (target ?? document.querySelector<HTMLElement>(".cal-card"))?.focus();
    });
  };

  /** Two-way save: updates SQLite + Google copy for local events, or patches native Google Calendar events directly. */
  const saveEdit = async (item: CalendarItem, edit: EventEdit) => {
    const show = (key: string, row: CalendarItem) => setEdits((current) => new Map(current).set(key, row));
    const drop = (key: string) => setEdits((current) => { const next = new Map(current); next.delete(key); return next; });
    show(item.id, edit.next);

    if (!item.manualId && item.origin === "google") {
      try {
        await api<CalendarEvent>("/calendar/google-events", send("PATCH", { id: item.id, ...edit.patch }));
      } catch (cause) {
        drop(item.id);
        void refresh();
        toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.updateAction, errorText(cause)), () => { void saveEdit(item, edit); });
        return;
      }
      toast.undo(CALENDAR.updated(edit.next.title), () => {
        show(edit.next.id, item);
        api<CalendarEvent>("/calendar/google-events", send("PATCH", { id: item.id, ...edit.undo }))
          .then(() => Promise.all([refresh(), today.refresh()]))
          .catch((cause: unknown) => {
            toast.error(CALENDAR_SHARED.undoFailed(errorText(cause)));
            return refresh();
          })
          .finally(() => drop(edit.next.id));
      }, { icon: Pencil });
      void today.refresh();
      await refresh();
      drop(item.id);
      return;
    }

    const url = `/calendar/events/${encodeURIComponent(item.manualId!)}`;
    try {
      await api<ManualEvent>(url, send("PATCH", edit.patch));
    } catch (cause) {
      drop(item.id);
      void refresh();
      toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.updateAction, errorText(cause)), () => { void saveEdit(item, edit); });
      return;
    }
    toast.undo(CALENDAR.updated(edit.next.title), () => {
      show(edit.next.id, item);
      api<ManualEvent>(url, send("PATCH", edit.undo))
        .then(() => Promise.all([refresh(), today.refresh()]))
        .catch((cause: unknown) => {
          toast.error(CALENDAR_SHARED.undoFailed(errorText(cause)));
          return refresh();
        })
        .finally(() => drop(edit.next.id));
    }, { icon: Pencil });
    void today.refresh();
    await refresh();
    drop(item.id);
  };

  /** Structured in-app event creation (with optional 2-way Google Calendar sync). */
  const saveCreate = async (body: CalendarEventCreateRequest) => {
    try {
      const created = await api<CalendarEventCreateResponse>("/calendar/events", send("POST", body));
      void refresh();
      void today.refresh();
      toast.undo(calendarServerError(created.message), () => {
        api<CalendarEventDeleteResponse>(created.undoPath.replace(/^\/api/, ""), send("DELETE"))
          .then(() => Promise.all([refresh(), today.refresh()]))
          .catch((cause: unknown) => toast.error(CALENDAR_SHARED.undoFailed(errorText(cause))));
      }, { icon: CalendarPlus });
    } catch (cause) {
      toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.add, errorText(cause)));
    }
  };

  /** 1-click push of an unsynced local event to Google Calendar. */
  const pushItemToGoogle = async (item: CalendarItem) => {
    if (!item.manualId) return;
    try {
      const res = await api<CalendarGoogleInsertResponse>(`/calendar/events/${encodeURIComponent(item.manualId)}/google`, send("POST"));
      void refresh();
      toast.undo(CALENDAR.sync.pushedToGoogle(item.title), () => {
        api(res.undoPath.replace(/^\/api/, ""), send("DELETE"))
          .then(() => refresh())
          .catch((cause: unknown) => toast.error(CALENDAR_SHARED.undoFailed(errorText(cause))));
      }, { icon: CalendarPlus });
    } catch (cause) {
      toast.error(CALENDAR_SHARED.actionFailed(CALENDAR.sync.pushAction, errorText(cause)));
    }
  };

  const addInSlot = (dayKeyStr: string) => (slot: FreeSlot) => {
    setEditing(null);
    onRequestCreate(dayKeyStr, document.activeElement instanceof HTMLElement ? document.activeElement : null, slot);
  };

  const notices = (
    <>
      {failing.map((source) => (
        <Notice
          key={source.id}
          tone="error"
          role="alert"
          title={source.id === "google-calendar" ? CALENDAR.googleErrorTitle : CALENDAR.icsErrorTitle}
          actions={source.state === "reconnect"
            ? <Button variant="secondary" size="sm" icon={Settings} href="#/settings/sources">{CALENDAR.reconnect}</Button>
            : <Button variant="secondary" size="sm" icon={RotateCw} onClick={() => void resync([source.id])}>{CALENDAR.retry}</Button>}
        >
          {source.state === "reconnect" ? CALENDAR.googleReconnect : source.message ? calendarServerError(source.message) : undefined}
        </Notice>
      ))}
      {notSetUp ? (
        <Notice title={CALENDAR.notSetUpTitle} icon={CalendarDays} actions={<Button variant="secondary" size="sm" href="#/settings/sources">{CALENDAR.connect}</Button>}>
          {CALENDAR.notSetUp}
        </Notice>
      ) : null}
    </>
  );

  const staleNotes = (
    <>
      {[...failing, ...(staleSource ? [staleSource] : [])].filter((source) => source.lastSyncedAt).slice(0, 1).map((source) => (
        <CalendarStaleNote key={source.id} time={syncedLabel(source.lastSyncedAt!, data.today, timeZone)} onRefresh={() => void resync([source.id])} />
      ))}
      {poll.state === "stale" && poll.updatedAt ? <CalendarStaleNote time={syncedLabel(new Date(poll.updatedAt).toISOString(), data.today, timeZone)} onRefresh={() => void refresh()} /> : null}
    </>
  );

  const editor = editing ? (
    <EventEditor
      key={editing.item.id}
      item={editing.item}
      timeZone={timeZone}
      googleCanWrite={googleCanWrite}
      anchor={editing.anchor}
      sheet={mobile}
      onSave={(edit) => { closeEditor(); void saveEdit(editing.item, edit); }}
      onRemove={(scope) => { closeEditor(); void remove(editing.item, scope); }}
      onPushToGoogle={() => { const current = editing.item; closeEditor(); void pushItemToGoogle(current); }}
      onClose={closeEditor}
    />
  ) : createIntent ? (
    <EventEditor
      key={`create:${createIntent.nonce}`}
      create={{ day: createIntent.day, slot: createIntent.slot }}
      timeZone={timeZone}
      googleCanWrite={googleCanWrite}
      defaultAddToGoogle={captureEnv.eventTarget === "google"}
      anchor={createIntent.anchor}
      sheet={mobile}
      onCreate={(body) => { onClearCreate(); void saveCreate(body); }}
      onQuickCapture={() => {
        const { day: cDay, slot: cSlot } = createIntent;
        onClearCreate();
        shell.openPalette("capture", prefillText(cDay, data.today, timeZone, cSlot ? { ...cSlot, minutes: 60 } : undefined));
      }}
      onClose={() => onClearCreate()}
    />
  ) : null;

  if (view === "month" && data.view === "month") {
    const anchorDay = anchor ?? data.day;
    const monthPrefix = anchorDay.slice(0, 7);
    const monthEventsCount = days
      .filter((entry) => entry.day.slice(0, 7) === monthPrefix)
      .reduce((sum, entry) => sum + entry.items.filter((item) => item.kind === "event").length, 0);
    const resolvedSelectedDay = selectedDay && days.some((d) => d.day === selectedDay)
      ? selectedDay
      : days.some((d) => d.day === data.today && d.day.slice(0, 7) === monthPrefix)
        ? data.today
        : anchorDay;

    return (
      <Card className={cx("cal-card cal-month", loading && "is-loading")} tabIndex={-1} aria-labelledby="cal-month-title" aria-busy={loading || undefined}>
        <CardHead
          icon={CalendarDays}
          tone="cal"
          titleId="cal-month-title"
          title={CALENDAR.monthTitle}
          count={monthEventsCount}
          countLabel={CALENDAR.countLabel(monthEventsCount)}
        />
        {notices}
        <MonthGrid
          days={days}
          anchorDay={anchorDay}
          selectedDay={resolvedSelectedDay}
          today={data.today}
          timeZone={timeZone}
          now={now}
          stale={dimmed}
          googleCanWrite={googleCanWrite}
          gap={gap}
          habits={today.data?.habits}
          onSelectDay={onSelectDay}
          onOpenDay={onOpenDay}
          onCreateOnDay={(targetDay, btn) => {
            setEditing(null);
            onRequestCreate(targetDay, btn);
          }}
          onSchedule={(target, slot) => void schedule(target, slot)}
          onAddInSlot={(targetDay, slot) => addInSlot(targetDay)(slot)}
          onEdit={openEditor}
          onRemove={(item, scope) => void remove(item, scope)}
          onCheckIn={toggleHabit}
          tidyProps={tidyProps}
        />
        {staleNotes}
        {editor}
      </Card>
    );
  }

  if (view === "day" || data.view === "day") {
    const entry = days[0] ?? { day: data.day, items: [], free: [] };
    const rows = timelineRows({ day: entry.day, today: data.today, items: entry.items, free: entry.free, now, timeZone, gap, showPast });
    const events = entry.items.filter((item) => item.kind === "event").length;
    const empty = entry.items.length === 0;
    return (
      <Card className={cx("agenda cal-card", loading && "is-loading")} tabIndex={-1} aria-labelledby="cal-day-title" aria-busy={loading || undefined}>
        <CardHead
          icon={CalendarDays}
          tone="cal"
          titleId="cal-day-title"
          title={entry.day === data.today ? CALENDAR.todayTitle : CALENDAR.dayTitle(dayTitle(entry.day))}
          count={events}
          countLabel={CALENDAR.countLabel(events)}
        />
        {notices}
        {empty && !notSetUp ? <p className="cal-empty kp">{entry.day === data.today ? CALENDAR.emptyToday : CALENDAR.emptyDay}</p> : null}
        {!empty ? (
          <AgendaTimeline
            rows={rows}
            timeZone={timeZone}
            stale={dimmed}
            googleCanWrite={googleCanWrite}
            onSchedule={(target, slot) => void schedule(target, slot)}
            onAddInSlot={addInSlot(entry.day)}
            onRemove={(item, scope) => void remove(item, scope)}
            onEdit={openEditor}
            {...tidyProps}
            onShowPast={() => setShowPast(true)}
            habits={entry.day === data.today ? today.data?.habits : undefined}
            onCheckIn={toggleHabit}
          />
        ) : null}
        {staleNotes}
        {editor}
      </Card>
    );
  }

  const count = days.reduce((sum, entry) => sum + entry.items.filter((item) => item.kind === "event").length, 0);
  return (
    <Card className={cx("cal-card cal-week", loading && "is-loading")} tabIndex={-1} aria-labelledby="cal-week-title" aria-busy={loading || undefined}>
      <CardHead icon={CalendarDays} tone="cal" titleId="cal-week-title" title={CALENDAR.weekTitle} count={count} countLabel={CALENDAR.countLabel(count)} />
      {notices}
      {wide ? (
        <WeekGrid days={days} today={data.today} timeZone={timeZone} now={now} stale={dimmed} googleCanWrite={googleCanWrite} onOpenDay={onOpenDay} onEdit={openEditor} />
      ) : (
        <WeekAgenda days={days} data={data} now={now} stale={dimmed} googleCanWrite={googleCanWrite} onOpenDay={onOpenDay} onRemove={(item, scope) => void remove(item, scope)} onEdit={openEditor} tidyProps={tidyProps} />
      )}
      {staleNotes}
      {editor}
    </Card>
  );
}

/** Below 980px the week is the agenda grouped by day (SPEC-ux §3.3). */
interface WeekAgendaProps {
  days: CalendarDay[];
  data: CalendarResponse;
  now: number;
  stale: boolean;
  googleCanWrite: boolean;
  onOpenDay: (day: string) => void;
  onRemove: (item: CalendarItem, scope?: RemoveScope) => void;
  onEdit: (item: CalendarItem, anchor: HTMLElement) => void;
  tidyProps: Pick<AgendaTimelineProps, "onTidy" | "tidying" | "onRevert">;
}

function WeekAgenda({ days, data, now, stale, googleCanWrite, onOpenDay, onRemove, onEdit, tidyProps }: WeekAgendaProps) {
  return (
    <div className="cal-wdays">
      {days.map((entry) => {
        const rows = timelineRows({ day: entry.day, today: data.today, items: entry.items, free: [], now, timeZone: data.timeZone, showPast: true })
          .filter((row) => row.type !== "now" || entry.items.length > 0);
        return (
          <section key={entry.day} className={cx("cal-wday", entry.day === data.today && "is-today")} aria-label={dayTitle(entry.day)}>
            <h3>
              <button type="button" onClick={() => onOpenDay(entry.day)} aria-label={CALENDAR.openDay(dayTitle(entry.day))}>
                {dayTitle(entry.day)}
                {entry.day === data.today ? <span className="cal-todaymark">{CALENDAR.todayMark}</span> : null}
              </button>
            </h3>
            {entry.items.length ? (
              <AgendaTimeline rows={rows} timeZone={data.timeZone} stale={stale} googleCanWrite={googleCanWrite} onRemove={onRemove} onEdit={onEdit} {...tidyProps} compact />
            ) : (
              <p className="cal-none">{CALENDAR.emptyWeekDay}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
