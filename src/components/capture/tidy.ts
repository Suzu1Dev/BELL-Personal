/**
 * 自動整理 and 整理 in the browser (SPEC-ux §6.6.1, docs/FRONTEND.md §5):
 * which records the model is rewriting (the 「整理中…」 marks on rows),
 * following a `capture-tidy` job to its end, and the toast
 * 「已整理成「Deep Hacking 簡報」· 10/18（日）」 [復原]. Automatic tidies that
 * change nothing or fail stay silent; the manual 整理 says why. An automatic
 * tidy's toast takes the capture toast's place while that is visible, and
 * otherwise never takes over another action's 復原 or Z (toast.followUp).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { CaptureTidyRequest, CaptureTidyResult, CaptureTidyStart, CaptureTidyUndoResponse, TidyTarget } from "../../../shared/connect";
import { api, followJob, send } from "../../api";
import { TIDY } from "../../copy/capture";
import { useToday } from "../../lib/today";
import { WandSparkles } from "../Icon";
import { useToast } from "../toast/ToastProvider";
import { notifyCaptured } from "./client";

export const tidyApi = {
  start: (kind: TidyTarget, id: string) => api<CaptureTidyStart>("/capture/tidy", send("POST", { kind, id })),
  undo: (token: string) => api<CaptureTidyUndoResponse>("/capture/tidy/undo", send("POST", { token })),
  /** 復原整理 on the record (any time after the toast, until the user edits the title or notes). */
  revert: (kind: TidyTarget, id: string) => api<CaptureTidyUndoResponse>("/capture/tidy/revert", send("POST", { kind, id } satisfies CaptureTidyRequest)),
};

/* ------------------------------------------------ which records are being tidied */

const running = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const keyOf = (kind: TidyTarget, id: string) => `${kind}:${id}`;

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

export function markTidying(start: CaptureTidyStart): void {
  running.set(keyOf(start.kind, start.id), start.jobId);
  changed();
}

export function clearTidying(start: CaptureTidyStart): void {
  if (running.get(keyOf(start.kind, start.id)) !== start.jobId) return;
  running.delete(keyOf(start.kind, start.id));
  changed();
}

export function isTidying(kind: TidyTarget, id: string): boolean {
  return running.has(keyOf(kind, id));
}

export function subscribeTidying(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True while this record's tidy runs (the row shows 「整理中…」). */
export function useTidying(kind: TidyTarget, id: string | undefined): boolean {
  return useSyncExternalStore(subscribeTidying, () => !!id && isTidying(kind, id), () => false);
}

/** Re-renders when any tidy starts or ends; for lists that call isTidying() per row. */
export function useTidyVersion(): number {
  return useSyncExternalStore(subscribeTidying, () => version, () => 0);
}

/* ------------------------------------------------------------ outcome */

export type TidyOutcome = CaptureTidyResult | { error: string };

/** Follows the job to its end; a failed or cancelled tidy resolves with its message, never rejects. */
export async function followTidy(start: CaptureTidyStart, signal: AbortSignal = new AbortController().signal): Promise<TidyOutcome> {
  markTidying(start);
  try {
    const end = await followJob(start.jobId, () => {}, signal);
    return end.type === "done" ? (end.result as CaptureTidyResult) : { error: end.message };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : "" };
  } finally {
    clearTidying(start);
  }
}

export type TidyNotice =
  | { kind: "undo"; message: string; token: string }
  | { kind: "info"; message: string }
  | { kind: "error"; message: string };

/**
 * What to show for a finished tidy. Applied: the server's line with 復原.
 * Automatic and unchanged or failed: nothing (the rule result simply stays).
 * Manual: why nothing changed, or the failure.
 */
export function tidyNotice(outcome: TidyOutcome, manual: boolean): TidyNotice | undefined {
  if ("error" in outcome) return manual ? { kind: "error", message: TIDY.failed(outcome.error) } : undefined;
  if (outcome.applied && outcome.message && outcome.undoToken) return { kind: "undo", message: outcome.message, token: outcome.undoToken };
  if (!manual) return undefined;
  return { kind: "info", message: TIDY.reasons[outcome.reason ?? "same"] };
}

export interface FollowOptions {
  /** The user pressed 整理 (say why nothing changed; the toast is a normal undo toast). */
  manual?: boolean;
  /** An automatic tidy: the capture toast it follows up (its place is taken while it is visible). */
  toastId?: number;
}

/**
 * `follow(start, options)`: follows a tidy, refreshes the lists when it
 * rewrote something and shows its toast. 復原 posts the undo token.
 */
export function useTidyFollower() {
  const toast = useToast();
  const { refresh } = useToday();
  return useCallback(async (start: CaptureTidyStart, options: FollowOptions = {}): Promise<TidyOutcome> => {
    const outcome = await followTidy(start);
    const notice = tidyNotice(outcome, !!options.manual);
    if (!("error" in outcome) && outcome.applied) {
      notifyCaptured();
      void refresh();
    }
    if (notice?.kind === "undo") {
      const input = {
        kind: "undo" as const,
        message: notice.message,
        icon: WandSparkles,
        onUndo: () => {
          tidyApi.undo(notice.token)
            .then(() => { notifyCaptured(); void refresh(); })
            .catch((cause: unknown) => toast.error(TIDY.undoFailed(cause instanceof Error ? cause.message : "")));
        },
      };
      // The user just pressed 整理: its toast is the newest action. A late automatic one only follows up its capture.
      if (options.manual) toast.show(input);
      else toast.followUp(options.toastId, input);
    } else if (notice?.kind === "info") toast.success(notice.message, WandSparkles);
    else if (notice?.kind === "error") toast.error(notice.message);
    return outcome;
  }, [toast, refresh]);
}

/** 復原整理 on a row: puts the fields from before the tidy back, then refreshes. */
export function useTidyRevert() {
  const toast = useToast();
  const { refresh } = useToday();
  return useCallback(async (kind: TidyTarget, id: string): Promise<boolean> => {
    try {
      const restored = await tidyApi.revert(kind, id);
      notifyCaptured();
      void refresh();
      toast.success(TIDY.reverted(restored.title), WandSparkles);
      return true;
    } catch (cause) {
      toast.error(TIDY.undoFailed(cause instanceof Error ? cause.message : ""));
      return false;
    }
  }, [toast, refresh]);
}

/** The manual 整理 on a row: start (or join) the record's tidy and follow it. */
export function useTidyAction() {
  const toast = useToast();
  const follow = useTidyFollower();
  return useCallback(async (kind: TidyTarget, id: string): Promise<void> => {
    let start: CaptureTidyStart;
    try {
      start = await tidyApi.start(kind, id);
    } catch (cause) {
      toast.error(TIDY.failed(cause instanceof Error ? cause.message : ""));
      return;
    }
    await follow(start, { manual: true });
  }, [toast, follow]);
}
