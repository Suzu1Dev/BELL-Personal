/**
 * #/work actions: 標為已交 / 標為已審查 / 標為已讀 go through the Today action
 * endpoint (so the badge, the handled list and undo stay one system), with
 * this page's own undo toast so 復原 refreshes the page that showed it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceId, SourceStatus } from "../../../shared/sources";
import type { ActionId } from "../../../shared/today";
import { ApiError, api, send } from "../../api";
import { ACTION_LABELS, ERRORS } from "../../copy/common";
import { WORK_PAGE } from "../../copy/work";
import { Check, CheckCheck, type IconType } from "../../components/Icon";
import { useToast } from "../../components/toast/ToastProvider";
import { useStatus } from "../../lib/status";
import { useToday } from "../../lib/today";

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
export const reasonOf = (cause: unknown) => (cause instanceof ApiError || cause instanceof Error ? cause.message : ERRORS.offline);

/**
 * Optimistic values per id on top of polled data (SPEC-ux §1 rule 4: the UI
 * updates first). An entry stays until a fetch that finished after it was
 * settled has landed, so the page never flickers back to the old value.
 */
export function useOptimistic<V>(updatedAt: number | undefined) {
  const [entries, setEntries] = useState<Map<string, { value: V; settledAt?: number }>>(() => new Map());
  useEffect(() => {
    if (updatedAt === undefined) return;
    setEntries((previous) => {
      const kept = [...previous].filter(([, entry]) => entry.settledAt === undefined || entry.settledAt >= updatedAt);
      return kept.length === previous.size ? previous : new Map(kept);
    });
  }, [updatedAt]);
  const put = useCallback((id: string, value: V) => setEntries((previous) => new Map(previous).set(id, { value })), []);
  const settle = useCallback((id: string) => {
    const settledAt = Date.now();
    setEntries((previous) => {
      const entry = previous.get(id);
      return entry ? new Map(previous).set(id, { ...entry, settledAt }) : previous;
    });
  }, []);
  const drop = useCallback((id: string) => setEntries((previous) => {
    if (!previous.has(id)) return previous;
    const next = new Map(previous);
    next.delete(id);
    return next;
  }), []);
  const get = useCallback((id: string) => entries.get(id)?.value, [entries]);
  return { get, put, settle, drop, size: entries.size };
}

export interface WorkActionOptions {
  /** Undo-toast text. */
  message: string;
  /** The toast's glyph (default: Check, CheckCheck for 標為已讀). */
  icon?: IconType;
  params?: Record<string, unknown>;
  /** Optimistic hooks: apply at once, undo on 復原, settle once the server answered, drop when it refused. */
  local?: { apply(): void; undo(): void; settle(): void; drop(): void };
}

export function useWorkAction(refresh: () => Promise<void>) {
  const today = useToday();
  const toast = useToast();
  const run = useCallback(async function run(itemId: string, action: ActionId, options: WorkActionOptions): Promise<boolean> {
    options.local?.apply();
    const result = await today.act(itemId, action, options.params, { silent: true });
    if (!result.ok || !result.actionId) {
      options.local?.drop();
      toast.error(ERRORS.actionFailed(ACTION_LABELS[action], result.error ?? ERRORS.offline), () => { void run(itemId, action, options); });
      return false;
    }
    options.local?.settle();
    void refresh();
    const actionId = result.actionId;
    toast.undo(options.message, () => {
      options.local?.undo();
      api(`/actions/${encodeURIComponent(actionId)}`, send("DELETE"))
        .catch((cause: unknown) => { toast.error(ERRORS.undoFailed(reasonOf(cause))); })
        .finally(() => { options.local?.settle(); void refresh(); void today.refresh(); });
    }, { icon: options.icon ?? (action === "read" ? CheckCheck : Check) });
    return true;
  }, [refresh, today, toast]);
  return run;
}

/**
 * 立即同步: POST /api/sync for these sources (forced), then refresh while
 * any of them is still syncing (at most ~20 s). `sources` must be stable.
 */
export function useSyncNow(sources: readonly SourceId[], refresh: () => Promise<void>, current: () => SourceStatus[] | undefined) {
  const status = useStatus();
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);
  const currentRef = useRef(current);
  currentRef.current = current;
  const statusRef = useRef(status);
  statusRef.current = status;
  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setSyncing(true);
    try {
      const result = await api<{ started: SourceId[]; sources: SourceStatus[] }>("/sync", send("POST", { sources, force: true }));
      statusRef.current.noteSources(result.sources);
      for (let attempt = 0; attempt < 14; attempt++) {
        await wait(attempt < 4 ? 700 : 1500);
        await refresh();
        const states = currentRef.current() ?? [];
        if (!states.some((entry) => result.started.includes(entry.id) && entry.state === "syncing")) break;
      }
      void statusRef.current.refresh();
    } catch (cause) {
      toast.error(ERRORS.actionFailed(WORK_PAGE.syncFailed, reasonOf(cause)));
    } finally {
      busy.current = false;
      setSyncing(false);
    }
  }, [refresh, sources, toast]);
  return { syncing, run };
}
