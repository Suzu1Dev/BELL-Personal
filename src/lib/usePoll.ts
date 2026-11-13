import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, OFFLINE_MESSAGE } from "../api";

/** Polling cadences from the UI spec (ui §8.6). */
export const POLL_INTERVALS = {
  mail: 60_000,
  calendar: 5 * 60_000,
  tasks: 30_000,
  syncStatus: 10_000,
} as const;

/**
 * loading: nothing yet. ready: fresh data. stale: the last refresh failed, the
 * previous data is still shown (「顯示 08:12 的資料 · 重新整理」). error: no data at all.
 */
export type PollState = "loading" | "ready" | "stale" | "error";

export interface Poll<T> {
  data: T | undefined;
  state: PollState;
  error: string | undefined;
  /** When `data` was fetched (ms since epoch). */
  updatedAt: number | undefined;
  /**
   * Refetch now, even while the tab is hidden. Called while a request is out,
   * it runs once more after that one, so what changed since is never missed.
   */
  refresh: () => Promise<void>;
}

/**
 * One request at a time. A timer or focus tick shares the request already
 * out; an explicit refresh (after an action) asked for while one is out runs
 * once more after it, because the request out may have started before the
 * change it must show. Ticks are skipped while the tab is hidden.
 */
export function serialLoader(run: () => Promise<void>, options: { hidden: () => boolean; alive: () => boolean }): (force: boolean) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const load = (force: boolean): Promise<void> => {
    if (inFlight) {
      if (!force) return inFlight;
      queued ??= inFlight.then(() => {
        queued = null;
        return options.alive() ? load(true) : undefined;
      });
      return queued;
    }
    if (!force && options.hidden()) return Promise.resolve();
    const request = run().finally(() => { inFlight = null; });
    inFlight = request;
    return request;
  };
  return load;
}

/**
 * Every widget's data hook: one request in flight at a time, no polling while
 * the tab is hidden, an immediate refresh on focus, visibility and reconnect,
 * the request aborted on unmount, and the last good data kept on failure.
 * `intervalMs: null` loads once and then only on refresh(), for data that
 * follows another poll (the inbox list follows Today's).
 */
export function usePoll<T>(fetcher: (signal: AbortSignal) => Promise<T>, intervalMs: number | null): Poll<T> {
  const [snapshot, setSnapshot] = useState<Omit<Poll<T>, "refresh">>({ data: undefined, state: "loading", error: undefined, updatedAt: undefined });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    const current = new AbortController();
    controller.current = current;
    try {
      const data = await fetcherRef.current(current.signal);
      if (!current.signal.aborted) setSnapshot({ data, state: "ready", error: undefined, updatedAt: Date.now() });
    } catch (cause) {
      if (current.signal.aborted) return;
      const message = cause instanceof ApiError || cause instanceof Error ? cause.message : OFFLINE_MESSAGE;
      setSnapshot((previous) => previous.data !== undefined
        ? { ...previous, state: "stale", error: message }
        : { data: undefined, state: "error", error: message, updatedAt: undefined });
    }
  }, []);

  const load = useMemo(() => serialLoader(run, {
    hidden: () => typeof document !== "undefined" && document.hidden,
    alive: () => mounted.current,
  }), [run]);

  useEffect(() => {
    mounted.current = true;
    void load(true);
    if (intervalMs === null) {
      return () => {
        mounted.current = false;
        controller.current?.abort();
      };
    }
    const timer = window.setInterval(() => void load(false), intervalMs);
    const wake = () => void load(false);
    const visible = () => { if (!document.hidden) void load(false); };
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visible);
      controller.current?.abort();
    };
  }, [load, intervalMs]);

  const refresh = useCallback(() => load(true), [load]);
  return { ...snapshot, refresh };
}
