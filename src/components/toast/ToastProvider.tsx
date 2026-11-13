/**
 * Toasts (SPEC-ux §6.5): `ToastProvider` owns the stack, `ToastHost` renders
 * it (inside .app-shell, centred over the workspace with --sidebar-current),
 * `useToast()` shows them.
 *
 *   toast.undo(message, onUndo)  6 s, timer bar, 復原 button and Z / ⌘Z; a new
 *                                undo toast replaces the previous one (that
 *                                action commits: its onExpire runs).
 *   toast.success(message)       3.5 s.
 *   toast.error(message, retry)  stays until closed, role="alert".
 *   toast.update(id, { message?, note? })  rewrites a visible toast: its message (轉成作業:
 *                                what the server saved) and/or a short status next to it
 *                                (「整理中…」; note undefined removes it).
 *   toast.followUp(id, input)    an undo toast that follows up an earlier one
 *                                (自動整理 after a capture): it takes that toast's
 *                                place while it is visible; otherwise it never
 *                                ends another action's undo toast nor takes Z
 *                                (passive: only its own 復原 button undoes).
 *
 * Timers pause while the toast is hovered or focused and while the tab is
 * hidden. At most 3 toasts stack, and a toast with the same message as a
 * visible one replaces it instead of stacking. Errors that only say the
 * local service did not answer are transient: dismissTransient() (called
 * when /api/today or /api/status answers again) closes them. Focus never
 * moves into a toast.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isOfflineErrorMessage } from "../../api";
import { toastCopy } from "../../copy/suite";
import { isTypingTarget } from "../../lib/keys";
import { useSingleKeyShortcuts } from "../../lib/preferences";
import { undoKeyHint, useShortcuts } from "../../lib/shortcuts";
import { cx } from "../../lib/cx";
import { CircleCheck, Icon, TriangleAlert, Undo2, X, type IconType } from "../Icon";
import { Spinner } from "../Skeleton";
import "./Toast.css";

export const TOAST_DURATIONS = { undo: 6_000, plain: 3_500 } as const;
const MAX_TOASTS = 3;
const EXIT_MS = 150;

export type ToastKind = "plain" | "undo" | "error";

export interface ToastInput {
  kind?: ToastKind;
  message: string;
  icon?: IconType;
  /** undo toasts: runs when the user presses 復原 or Z. */
  onUndo?: () => void;
  /** undo toasts: runs when the window passes (or a newer undo toast replaces this one). */
  onExpire?: () => void;
  /** error toasts: 重試. */
  onRetry?: () => void;
  /** Override the duration in ms; null = until closed. */
  duration?: number | null;
  /** A short status after the message with a spinner (「整理中…」); never clamped away. */
  note?: string;
  /** Closed by dismissTransient() once the service answers again; default: errors that say it could not be reached. */
  transient?: boolean;
  /** undo toasts: does not end the other undo toasts, and Z / ⌘Z skip it (only its 復原 button undoes). */
  passive?: boolean;
}

interface ToastEntry extends ToastInput {
  id: number;
  kind: ToastKind;
  leaving: boolean;
}

export interface ToastApi {
  show(input: ToastInput): number;
  success(message: string, icon?: IconType): number;
  undo(message: string, onUndo: () => void, options?: { icon?: IconType; onExpire?: () => void }): number;
  error(message: string, onRetry?: () => void): number;
  dismiss(id: number): void;
  /**
   * Changes a visible toast's message (the server named what it saved) and/or its
   * note (undefined removes it); nothing happens once it has left.
   */
  update(id: number, patch: { message?: string; note?: string }): void;
  /**
   * Shows an undo toast that follows up the toast `previous` (自動整理 after a
   * capture): in its place with a fresh timer while it is visible; else
   * passive while another action's undo toast is visible (so a late result
   * never takes over that action's 復原 or Z); else as a normal undo toast.
   */
  followUp(previous: number | undefined, input: ToastInput): number;
  /** Runs the newest visible undo toast's onUndo; false when there is none. */
  undoLatest(): boolean;
  /** Closes the transient errors (the service could not be reached): call it when a request succeeds again. */
  dismissTransient(): void;
}

type LiveToast = Pick<ToastEntry, "id" | "kind" | "message" | "leaving" | "passive">;

/** Visible toasts a new one replaces: same kind and message (an undo toast never replaces another one this way). */
export function replacedToasts(live: readonly LiveToast[], next: { kind: ToastKind; message: string }): number[] {
  if (next.kind === "undo") return [];
  return live.filter((toast) => !toast.leaving && toast.kind === next.kind && toast.message === next.message).map((toast) => toast.id);
}

/** Undo toasts a new toast ends (their actions commit): every visible one, for a new undo toast that is not passive. */
export function undoToastsEnded(live: readonly LiveToast[], next: { kind: ToastKind; passive?: boolean }): number[] {
  if (next.kind !== "undo" || next.passive) return [];
  return live.filter((toast) => !toast.leaving && toast.kind === "undo" && !toast.passive).map((toast) => toast.id);
}

/** The undo toast Z / ⌘Z answers: the newest visible one that is not passive. */
export function latestUndo(live: readonly LiveToast[]): number | undefined {
  return [...live].reverse().find((toast) => toast.kind === "undo" && !toast.leaving && !toast.passive)?.id;
}

/** How followUp() shows a follow-up of the toast `previous`. */
export function followUpPlan(live: readonly LiveToast[], previous: number | undefined): "replace" | "passive" | "normal" {
  if (previous !== undefined && live.some((toast) => toast.id === previous && !toast.leaving)) return "replace";
  return latestUndo(live) !== undefined ? "passive" : "normal";
}

/** An error that only says the local service did not answer: it stops being true when the service answers. */
export function isTransientError(kind: ToastKind, message: string): boolean {
  return kind === "error" && isOfflineErrorMessage(message);
}

function toInitialEntries(inputs: readonly ToastInput[] | undefined): ToastEntry[] {
  if (!inputs?.length) return [];
  return inputs.map((input, index) => {
    const kind = input.kind ?? "plain";
    return {
      ...input,
      id: index + 1,
      kind,
      leaving: false,
      transient: input.transient ?? isTransientError(kind, input.message),
    };
  });
}

interface ToastListValue {
  toasts: ToastEntry[];
  finish(id: number, reason: "expire" | "undo" | "close"): void;
}

/** The API is stable for the provider's lifetime; the list changes with every toast. */
const ToastContext = createContext<ToastApi | null>(null);
const ToastListContext = createContext<ToastListValue | null>(null);

export function ToastProvider({ children, initialToasts }: { children: ReactNode; initialToasts?: readonly ToastInput[] }) {
  const [toasts, setToasts] = useState<ToastEntry[]>(() => toInitialEntries(initialToasts));
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;
  const nextId = useRef(toasts.length + 1);

  const remove = useCallback((id: number) => {
    setToasts((list) => list.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    window.setTimeout(() => setToasts((list) => list.filter((toast) => toast.id !== id)), EXIT_MS);
  }, []);

  const finish = useCallback((id: number, reason: "expire" | "undo" | "close") => {
    const toast = toastsRef.current.find((entry) => entry.id === id);
    if (!toast || toast.leaving) return;
    toastsRef.current = toastsRef.current.map((entry) => (entry.id === id ? { ...entry, leaving: true } : entry));
    if (reason === "undo") toast.onUndo?.();
    else if (toast.kind === "undo") toast.onExpire?.();
    remove(id);
  }, [remove]);

  const show = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    const kind = input.kind ?? "plain";
    // Retrying a known failure must not stack identical sticky toasts: the new one takes the old one's place.
    for (const previous of replacedToasts(toastsRef.current, { kind, message: input.message })) finish(previous, "close");
    for (const previous of undoToastsEnded(toastsRef.current, { kind, passive: input.passive })) finish(previous, "expire");
    const stillLive = toastsRef.current.filter((toast) => !toast.leaving);
    for (const extra of stillLive.slice(0, Math.max(0, stillLive.length - (MAX_TOASTS - 1)))) finish(extra.id, "expire");
    const entry: ToastEntry = { ...input, id, kind, leaving: false, transient: input.transient ?? isTransientError(kind, input.message) };
    toastsRef.current = [...toastsRef.current, entry];
    setToasts((list) => [...list, entry]);
    return id;
  }, [finish]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (message, icon) => show({ kind: "plain", message, icon: icon ?? CircleCheck }),
    undo: (message, onUndo, options) => show({ kind: "undo", message, onUndo, icon: options?.icon, onExpire: options?.onExpire }),
    error: (message, onRetry) => show({ kind: "error", message, onRetry }),
    dismiss: (id) => finish(id, "close"),
    update: (id, patch) => {
      const apply = (list: ToastEntry[]) => list.map((toast) => (toast.id === id && !toast.leaving ? { ...toast, ...patch } : toast));
      toastsRef.current = apply(toastsRef.current);
      setToasts(apply);
    },
    followUp: (previous, input) => {
      const plan = followUpPlan(toastsRef.current, previous);
      if (plan !== "replace") return show({ ...input, passive: plan === "passive" });
      // In the earlier toast's place, with a fresh timer (a new id remounts it); that toast's action stands.
      const id = nextId.current++;
      const kind = input.kind ?? "plain";
      const entry: ToastEntry = { ...input, id, kind, leaving: false, transient: input.transient ?? isTransientError(kind, input.message) };
      const swap = (list: ToastEntry[]) => list.map((toast) => (toast.id === previous ? entry : toast));
      toastsRef.current = swap(toastsRef.current);
      setToasts(swap);
      return id;
    },
    undoLatest: () => {
      const latest = latestUndo(toastsRef.current);
      if (latest === undefined) return false;
      finish(latest, "undo");
      return true;
    },
    dismissTransient: () => {
      for (const toast of toastsRef.current) if (toast.transient && !toast.leaving) finish(toast.id, "close");
    },
  }), [finish, show]);
  const list = useMemo<ToastListValue>(() => ({ toasts, finish }), [toasts, finish]);

  // Z (and ⌘Z / Ctrl Z) undo the newest undoable action while its toast is visible.
  const undoKey = () => api.undoLatest();
  useShortcuts({ z: undoKey, "mod+z": undoKey });

  return (
    <ToastContext.Provider value={api}>
      <ToastListContext.Provider value={list}>{children}</ToastListContext.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast 需要在 ToastProvider 之內使用。");
  return context;
}

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}

/** Whether focus is in a text field (where a bare Z types instead of undoing). */
function useTypingFocus(): boolean {
  const [typing, setTyping] = useState(() => typeof document !== "undefined" && isTypingTarget(document.activeElement));
  useEffect(() => {
    const update = () => setTyping(isTypingTarget(document.activeElement));
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);
  return typing;
}

function ToastItem({ toast, onFinish }: { toast: ToastEntry; onFinish: (id: number, reason: "expire" | "undo" | "close") => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hidden = useDocumentHidden();
  const duration = toast.duration !== undefined ? toast.duration : toast.kind === "error" ? null : TOAST_DURATIONS[toast.kind];
  const paused = hovered || focused || hidden;
  const remaining = useRef(duration ?? 0);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  useEffect(() => {
    if (duration === null || paused || toast.leaving) return;
    const started = performance.now();
    const timer = window.setTimeout(() => onFinishRef.current(toast.id, "expire"), Math.max(0, remaining.current));
    return () => {
      window.clearTimeout(timer);
      remaining.current -= performance.now() - started;
    };
  }, [duration, paused, toast.id, toast.leaving]);

  const copy = toastCopy();
  const singleKeys = useSingleKeyShortcuts();
  const typing = useTypingFocus();
  const icon = toast.icon ?? (toast.kind === "error" ? TriangleAlert : toast.kind === "undo" ? Undo2 : CircleCheck);
  return (
    <div
      className={cx("toast", toast.kind === "error" && "toast-error", paused && "is-paused", toast.leaving && "is-leaving")}
      role={toast.kind === "error" ? "alert" : undefined}
      style={duration ? ({ "--toast-ms": `${duration}ms` } as CSSProperties) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
    >
      <Icon icon={icon} />
      <span className="kp">{toast.message}</span>
      {toast.note ? <small className="toast-note"><Spinner />{toast.note}</small> : null}
      {toast.kind === "undo" ? (
        <button type="button" onClick={() => onFinish(toast.id, "undo")}>
          {/* A passive toast does not answer Z / ⌘Z: no key hint. */}
          <Icon icon={Undo2} size="sm" />{copy.undo}{toast.passive ? null : <kbd>{undoKeyHint(singleKeys, typing)}</kbd>}
        </button>
      ) : null}
      {toast.kind === "error" && toast.onRetry ? (
        <button type="button" onClick={() => { onFinish(toast.id, "close"); toast.onRetry?.(); }}>{copy.retry}</button>
      ) : null}
      {toast.kind === "error" ? (
        <button type="button" className="toast-close" aria-label={copy.dismiss} onClick={() => onFinish(toast.id, "close")}>
          <Icon icon={X} size="sm" />
        </button>
      ) : null}
      {duration && toast.kind === "undo" ? <i className="timer" aria-hidden="true" /> : null}
    </div>
  );
}

/** Renders the stack; place it once inside .app-shell. */
export function ToastHost() {
  const context = useContext(ToastListContext);
  if (!context) return null;
  const copy = toastCopy();
  return (
    <div className="toast-host" role="status" aria-live="polite" aria-label={copy.regionLabel}>
      {context.toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onFinish={context.finish} />)}
    </div>
  );
}
