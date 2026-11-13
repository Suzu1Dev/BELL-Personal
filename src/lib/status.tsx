/**
 * StatusProvider / useStatus(): one shared poll of `GET /api/status` for the
 * topbar sync chip, the profile row and any settings widget that needs
 * source states. Each status probe starts the AI and repository CLIs (one
 * of them calls the GitHub API) once its 10 s server cache expires, so the
 * shell polls every 60 s plus on focus, visibility and reconnect.
 *
 * `noteSources(sources)` lets the POST /api/sync caller show the source
 * states that call returned (同步中…) at once, without a probe; the next
 * status fetch replaces them.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StatusResponse } from "../../shared/api";
import type { SourceStatus } from "../../shared/sources";
import { core } from "../api";
import { useToast } from "../components/toast/ToastProvider";
import { syncChipState, type SyncChipState } from "./today-model";
import { usePoll, type Poll } from "./usePoll";

export const STATUS_POLL_MS = 60_000;

export interface StatusContextValue extends Poll<StatusResponse> {
  chip: SyncChipState;
  /** Source states newer than the last status fetch (the POST /api/sync answer). */
  noteSources(sources: SourceStatus[]): void;
}

const StatusContext = createContext<StatusContextValue | null>(null);

export function StatusProvider({ children }: { children: ReactNode }) {
  const { data, state, error, updatedAt, refresh } = usePoll(core.status, STATUS_POLL_MS);
  const [noted, setNoted] = useState<{ sources: SourceStatus[]; at: number }>();
  // The service answers again: 「無法連線至本機服務…」 errors are no longer true.
  const { dismissTransient } = useToast();
  useEffect(() => {
    if (state === "ready") dismissTransient();
  }, [state, updatedAt, dismissTransient]);
  const noteSources = useCallback((sources: SourceStatus[]) => setNoted({ sources, at: Date.now() }), []);
  const value = useMemo<StatusContextValue>(() => {
    // While the service is unreachable the chip says so instead of showing an old 已同步.
    const unreachable = state === "error" || state === "stale";
    const fresher = noted && (updatedAt === undefined || noted.at > updatedAt) ? noted.sources : undefined;
    const sources = fresher ?? data?.sources;
    return { data, state, error, updatedAt, refresh, noteSources, chip: syncChipState(unreachable ? undefined : sources, unreachable) };
  }, [data, state, error, updatedAt, refresh, noted, noteSources]);
  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useStatus(): StatusContextValue {
  const context = useContext(StatusContext);
  if (!context) throw new Error("useStatus 需要在 StatusProvider 之內使用。");
  return context;
}
