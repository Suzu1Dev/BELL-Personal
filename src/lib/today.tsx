/**
 * TodayProvider / useToday(): the one client store for `GET /api/today`
 * (SPEC-ux §4.3 "Counts … one store", §6.1, §6.5). The sidebar, quickbar,
 * Today page and any other widget read counts from here; nothing computes
 * them twice.
 *
 *   - Polls every 60 s with usePoll (skipped while hidden; refreshed on
 *     focus, visibility and reconnect), and keeps the last good payload.
 *   - POST /api/sync on mount and on window focus (at most every 15 s), except
 *     during a handoff visit to #/tasks; ordinary routes resume the same sync.
 *     When it starts sources,
 *     the sync chip shows their states from that answer at once, Today
 *     refreshes until they finish, then /api/status is read again.
 *   - act(itemId, action, params?) is optimistic: the row leaves and counts
 *     move at once (applyActionToPayload, shared with the server), and so
 *     does the undo toast 「已完成「…」」 [復原 Z] for actions that took
 *     something away, while POST /api/actions → {actionId, undoUntil} runs.
 *     復原 → the row comes back at once and DELETE /api/actions/:id follows
 *     (after the POST, if it is still out). A failed POST puts the row back,
 *     drops the undo toast and shows an error toast with 重試. After `undoUntil` the
 *     action's status is read once: a deferred remote write that failed shows
 *     the error toast and the row returns on the refresh.
 *   - optimistic(apply) lets other widgets (habits, digest) layer their own
 *     instant edits on the same store.
 *
 * When /api/today fails, `state` is "error" (no data yet) or "stale" (the
 * last payload is kept) and `error` holds a zh-TW sentence; widgets render
 * their own error states — the page never blanks.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SourceId, SourceStatus } from "../../shared/sources";
import { DEFAULT_TIME_ZONE } from "../../shared/time";
import type { ActionAccepted, ActionId, ActionStatus, QueueItem, TodayPayload } from "../../shared/today";
import { applyActionToPayload } from "../../shared/today-logic";
import { ApiError, api, send } from "../api";
import { ACTION_LABELS, ACTION_TOASTS, ERRORS } from "../copy/common";
import { useToast } from "../components/toast/ToastProvider";
import { Archive, ArchiveRestore, CalendarPlus, Check, Flag, GraduationCap, ListPlus, AlarmClock, MailOpen, Trash2, type IconType } from "../components/Icon";
import { useStatus } from "./status";
import {
  createdToast, findQueueItem, followSync, itemTitle, navCounts, offersUndo, remoteFailure, reportRemoteFailure, restoreQueueItem, sidebarProjects, snapshotQueueItem, streakDays,
  type NavCounts, type SidebarProject,
} from "./today-model";
import { usePoll, type PollState } from "./usePoll";
import { taskHandoffSyncBlocked } from "../suite/useTaskHandoff";

export const TODAY_POLL_MS = 60_000;
const SYNC_THROTTLE_MS = 15_000;
/** How long after `undoUntil` the remote write's outcome is first read. */
const COMMIT_CHECK_GRACE_MS = 1_500;

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

interface SyncStarted {
  started: SourceId[];
  sources: SourceStatus[];
}

export interface ActResult {
  ok: boolean;
  actionId?: string;
  undoUntil?: string;
  error?: string;
}

export interface ActOptions {
  /** Toast text instead of the default for the action (e.g. 「已延後到明天 08:00」). */
  message?: string;
  /** Skip the toast (the caller shows its own). */
  silent?: boolean;
  /** 復原 (or Z) on the toast: the caller drops its own optimistic edit too (#/inbox's 封存 / 全部 / search pages). */
  onUndo?: () => void;
  /**
   * The deferred remote write failed after the 202 (the server already put
   * the item back): the caller drops its own optimistic edit, which a
   * refresh of Today alone would not (#/inbox's 封存 / 全部 / search pages).
   */
  onFailed?: () => void;
}

export interface OptimisticHandle {
  /** The server accepted the change: keep it until a refresh that started later lands. */
  settle(): void;
  /** The change failed: drop it now. */
  revert(): void;
}

export interface TodayContextValue {
  data: TodayPayload | undefined;
  state: PollState;
  error: string | undefined;
  /** When the payload was fetched (ms since epoch). */
  updatedAt: number | undefined;
  refresh(): Promise<void>;
  act(itemId: string, action: ActionId, params?: Record<string, unknown>, options?: ActOptions): Promise<ActResult>;
  optimistic(apply: (payload: TodayPayload) => TodayPayload): OptimisticHandle;
  /** Derived once from `data.counts` for the sidebar and quickbar. */
  nav: NavCounts;
  projects: SidebarProject[];
  streak: number | undefined;
}

const TodayContext = createContext<TodayContextValue | null>(null);

interface Overlay {
  id: number;
  apply: (payload: TodayPayload) => TodayPayload;
  /** Set when the server acknowledged; the overlay is dropped after a fetch that started later. */
  settledAt?: number;
}

interface Fetched {
  payload: TodayPayload;
  startedAt: number;
}

const ACTION_ICONS: Partial<Record<ActionId, IconType>> = {
  archive: Archive,
  read: MailOpen,
  todo: ListPlus,
  snooze: AlarmClock,
  done: Check,
  submitted: Check,
  reviewed: Check,
  calendar: CalendarPlus,
  going: Flag,
  schedule: CalendarPlus,
  trash: Trash2,
  unarchive: ArchiveRestore,
  assignment: GraduationCap,
};

function toastMessage(action: ActionId, title: string, params?: Record<string, unknown>): string {
  const when = typeof params?.label === "string" ? params.label : undefined;
  switch (action) {
    case "archive": return ACTION_TOASTS.archive(title);
    case "read": return ACTION_TOASTS.read(title);
    case "done": return ACTION_TOASTS.done(title);
    case "submitted": return ACTION_TOASTS.submitted(title);
    case "reviewed": return ACTION_TOASTS.reviewed(title);
    case "snooze": return when ? ACTION_TOASTS.snooze(when) : ACTION_TOASTS.snoozeGeneric(title);
    case "calendar": return ACTION_TOASTS.calendar(title, when);
    case "going": return ACTION_TOASTS.going(title);
    case "todo": return ACTION_TOASTS.todo(title, when);
    case "dismiss": return ACTION_TOASTS.dismiss(title);
    case "schedule": return ACTION_TOASTS.schedule(title);
    case "trash": return ACTION_TOASTS.trash(title);
    case "unarchive": return ACTION_TOASTS.unarchive(title);
    case "assignment": return ACTION_TOASTS.assignment(title, when);
    default: return ACTION_TOASTS.done(title);
  }
}

const errorText = (cause: unknown) => (cause instanceof ApiError || cause instanceof Error ? cause.message : ERRORS.offline);

export function TodayProvider({ children, endpoint = "/today" }: { children: ReactNode; endpoint?: string }) {
  const toast = useToast();
  const status = useStatus();
  const statusRef = useRef(status);
  statusRef.current = status;
  const fetcher = useCallback(async (signal: AbortSignal): Promise<Fetched> => {
    const startedAt = Date.now();
    const payload = await api<TodayPayload>(endpoint, { signal });
    return { payload, startedAt };
  }, [endpoint]);
  const poll = usePoll(fetcher, TODAY_POLL_MS);

  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const overlayId = useRef(1);

  // Drop settled overlays once a fetch that started after the acknowledgement has landed.
  const fetchedAt = poll.data?.startedAt;
  useEffect(() => {
    if (fetchedAt === undefined) return;
    setOverlays((list) => {
      const kept = list.filter((overlay) => overlay.settledAt === undefined || overlay.settledAt >= fetchedAt);
      return kept.length === list.length ? list : kept;
    });
  }, [fetchedAt]);

  // The service answers again: 「無法連線至本機服務…」 errors are no longer true.
  const { dismissTransient } = toast;
  useEffect(() => {
    if (fetchedAt !== undefined) dismissTransient();
  }, [fetchedAt, dismissTransient]);

  const data = useMemo(() => {
    const base = poll.data?.payload;
    if (!base) return undefined;
    return overlays.reduce((payload, overlay) => overlay.apply(payload), base);
  }, [poll.data, overlays]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const { refresh } = poll;

  // Sync stale sources on load and when the window regains focus; follow the
  // ones that started so the chip and the rows catch up when they finish.
  const lastSync = useRef(0);
  useEffect(() => {
    const syncNow = () => {
      if (taskHandoffSyncBlocked()) return;
      if (Date.now() - lastSync.current < SYNC_THROTTLE_MS) return;
      lastSync.current = Date.now();
      api<SyncStarted>("/sync", send("POST", {}))
        .then(async (result) => {
          if (!result.started.length) return;
          statusRef.current.noteSources(result.sources);
          await followSync(result.started, { refresh, sources: () => dataRef.current?.sources, wait });
          await statusRef.current.refresh();
        })
        .catch(() => { /* the sync chip and widgets report source problems */ });
    };
    syncNow();
    window.addEventListener("focus", syncNow);
    return () => window.removeEventListener("focus", syncNow);
  }, [refresh]);

  const optimistic = useCallback((apply: (payload: TodayPayload) => TodayPayload): OptimisticHandle => {
    const id = overlayId.current++;
    setOverlays((list) => [...list, { id, apply }]);
    return {
      settle: () => {
        const settledAt = Date.now(); // now, not when React runs the updater: a refresh started after this must drop it
        setOverlays((list) => list.map((overlay) => (overlay.id === id ? { ...overlay, settledAt } : overlay)));
      },
      revert: () => setOverlays((list) => list.filter((overlay) => overlay.id !== id)),
    };
  }, []);

  const act = useCallback(async function act(itemId: string, action: ActionId, params?: Record<string, unknown>, options?: ActOptions): Promise<ActResult> {
    const before = dataRef.current;
    const title = itemTitle(findQueueItem(before, itemId), before, itemId);
    const snapshot = snapshotQueueItem(before, itemId, action);
    const handle = optimistic((payload) => applyActionToPayload(payload, itemId, action));
    const request = api<ActionAccepted>("/actions", send("POST", { itemId, action, ...(params ? { params } : {}) }));
    let undone = false;
    let failed = false;
    let toastId: number | undefined;
    if (!options?.silent && offersUndo(action)) {
      // The toast comes with the optimistic edit, not after the POST: 復原 and Z work during the round trip
      // (seconds over Tailscale from a phone), and Z never reaches an older action's toast instead.
      toastId = toast.undo(options?.message ?? toastMessage(action, title, params), () => {
        undone = true;
        // The row comes back at once, in its old place; the server's answer replaces it on the next refresh.
        const restore = optimistic((payload) => (snapshot ? restoreQueueItem(payload, snapshot) : payload));
        handle.revert();
        options?.onUndo?.();
        request
          .then((result) => api(`/actions/${encodeURIComponent(result.actionId)}`, send("DELETE")))
          .then(() => { restore.settle(); return refresh(); })
          .catch((cause: unknown) => {
            restore.revert();
            // A POST that failed did nothing, so there is nothing to undo and nothing to report twice.
            if (failed) return;
            toast.error(ERRORS.undoFailed(errorText(cause)));
            void refresh();
          });
      }, { icon: ACTION_ICONS[action] });
    }
    try {
      const result = await request;
      if (!undone) handle.settle();
      // 轉成作業 / 加入作業: the toast now names what was saved (title, deadline), not the page's guess.
      if (result.created && toastId !== undefined && !undone) {
        toast.update(toastId, { message: createdToast(result.created, new Date(), statusRef.current.data?.timeZone ?? DEFAULT_TIME_ZONE) });
      }
      void refresh();
      if (action !== "open") {
        // A deferred remote write that failed: the server already put the row back; say so (SPEC-ux §6.5).
        void remoteFailure(
          () => (undone ? Promise.resolve(undefined) : api<ActionStatus>(`/actions/${encodeURIComponent(result.actionId)}`).catch(() => undefined)),
          wait,
          { delayMs: Date.parse(result.undoUntil) - Date.now() + COMMIT_CHECK_GRACE_MS },
        ).then((failure) => reportRemoteFailure(failure, {
          onFailed: options?.onFailed,
          error: (reason) => toast.error(ERRORS.actionFailed(ACTION_LABELS[action], reason || ERRORS.remoteFailed), () => { void act(itemId, action, params, options); }),
          refresh: () => { void refresh(); },
        }));
      }
      return { ok: true, actionId: result.actionId, undoUntil: result.undoUntil };
    } catch (cause) {
      failed = true;
      handle.revert();
      if (toastId !== undefined) toast.dismiss(toastId);
      const message = errorText(cause);
      // A 409 (already done, already in the trash, already an assignment) will answer the same again: no 重試.
      const retry = cause instanceof ApiError && cause.status === 409 ? undefined : () => { void act(itemId, action, params, options); };
      // Already taken back with 復原 while the POST was out: the row is where it was, nothing to report.
      if (!options?.silent && !undone) toast.error(ERRORS.actionFailed(ACTION_LABELS[action], message), retry);
      return { ok: false, error: message };
    }
  }, [optimistic, refresh, toast]);

  const value = useMemo<TodayContextValue>(() => ({
    data,
    state: poll.state,
    error: poll.error,
    updatedAt: poll.updatedAt,
    refresh,
    act,
    optimistic,
    nav: navCounts(data),
    projects: sidebarProjects(data),
    streak: streakDays(data),
  }), [data, poll.state, poll.error, poll.updatedAt, refresh, act, optimistic]);

  return <TodayContext.Provider value={value}>{children}</TodayContext.Provider>;
}

export function useToday(): TodayContextValue {
  const context = useContext(TodayContext);
  if (!context) throw new Error("useToday 需要在 TodayProvider 之內使用。");
  return context;
}
