/**
 * BELL Suite data, always from Personal's own server (same-origin, src/api.ts):
 *
 *   useSuiteManifest()   GET /api/suite/manifest, once per page load and shared
 *                        by every reader (switcher, Today card, draft panel,
 *                        解釋這個). A failed load is retried only on request.
 *   useSuiteSources()    GET /api/suite/sources on mount, then every 5 min while
 *                        the page is visible (usePoll); retry() asks for
 *                        `?refresh=1` once, and repeated clicks while it is out
 *                        are ignored.
 *
 * Links are origins of linked siblings only; anything that is not a plain
 * http(s) origin is dropped here as well, so a bad value never becomes a link.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SUITE_LIMITS, SUITE_SIBLINGS, type SuiteLinks, type SuiteManifest, type SuiteSourcesResponse } from "../../shared/suite";
import { api, ApiError, OFFLINE_MESSAGE } from "../api";
import { usePoll, type Poll } from "../lib/usePoll";

export type ManifestState =
  | { status: "loading" }
  | { status: "ready"; links: SuiteLinks }
  | { status: "error"; error: string };

const ORIGIN = /^https?:\/\/[^/?#\\\s@*]+$/i;

/** Only `explain` and `pr`, only exact http(s) origins (no path, query, credentials or wildcard). */
export function sanitizeLinks(raw: unknown): SuiteLinks {
  const links: SuiteLinks = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return links;
  for (const id of SUITE_SIBLINGS) {
    const value = (raw as Record<string, unknown>)[id];
    if (typeof value !== "string" || !ORIGIN.test(value)) continue;
    try {
      if (new URL(value).origin === value) links[id] = value;
    } catch {
      // Not a URL: not a link.
    }
  }
  return links;
}

/** The manifest's links, or an error when the answer is not a v1 manifest. */
export function manifestState(body: unknown): ManifestState {
  if (!body || typeof body !== "object" || (body as Partial<SuiteManifest>).schemaVersion !== 1) {
    return { status: "error", error: OFFLINE_MESSAGE };
  }
  return { status: "ready", links: sanitizeLinks((body as Partial<SuiteManifest>).links) };
}

let manifest: ManifestState = { status: "loading" };
let manifestRequest: Promise<void> | null = null;
let manifestStarted = false;
const manifestListeners = new Set<() => void>();
const LOADING: ManifestState = { status: "loading" };

function setManifest(next: ManifestState) {
  manifest = next;
  for (const listener of manifestListeners) listener();
}

/** Starts the one load of this page (or a retry after a failure); a load already out is shared. */
export function loadManifest(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (manifestRequest) return manifestRequest;
  if (manifest.status === "ready") return Promise.resolve();
  manifestStarted = true;
  if (manifest.status !== "loading") setManifest({ status: "loading" });
  manifestRequest = api<unknown>("/suite/manifest")
    .then((body) => setManifest(manifestState(body)))
    .catch((cause: unknown) => setManifest({ status: "error", error: cause instanceof ApiError || cause instanceof Error ? cause.message : OFFLINE_MESSAGE }))
    .finally(() => { manifestRequest = null; });
  return manifestRequest;
}

/** The current manifest state; the first reader starts the load. */
export function getManifest(): ManifestState {
  if (!manifestStarted) void loadManifest();
  return manifest;
}

export function subscribeManifest(listener: () => void): () => void {
  manifestListeners.add(listener);
  if (!manifestStarted) void loadManifest();
  return () => { manifestListeners.delete(listener); };
}

export function useSuiteManifest(): ManifestState & { retry: () => void } {
  const state = useSyncExternalStore(subscribeManifest, () => manifest, () => LOADING);
  const retry = useCallback(() => { void loadManifest(); }, []);
  return { ...state, retry };
}

/** Linked origins (empty while loading or after a failure: nothing is linked until the manifest says so). */
export function useSuiteLinks(): SuiteLinks {
  const state = useSuiteManifest();
  return state.status === "ready" ? state.links : NO_LINKS;
}
const NO_LINKS: SuiteLinks = {};

export interface SuiteSourcesPoll extends Poll<SuiteSourcesResponse> {
  /** Manual retry: one `?refresh=1` read; ignored while one is pending. */
  retry: () => void;
  /** A manual retry is out (its buttons are disabled). */
  retrying: boolean;
}

export function sourcesPath(refresh: boolean): string {
  return refresh ? "/suite/sources?refresh=1" : "/suite/sources";
}

export const SUITE_REFRESH_EVENT = "bell:suite-refresh";

export function notifySuiteRefresh(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SUITE_REFRESH_EVENT));
}

export function useSuiteSources(): SuiteSourcesPoll {
  const force = useRef(false);
  const fetcher = useCallback((signal: AbortSignal) => {
    const refresh = force.current;
    force.current = false;
    return api<SuiteSourcesResponse>(sourcesPath(refresh), { signal });
  }, []);
  const poll = usePoll(fetcher, SUITE_LIMITS.activePollMs);
  const [retrying, setRetrying] = useState(false);
  const pending = useRef(false);
  const { refresh } = poll;
  const retry = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    setRetrying(true);
    // The next request out (now, or right after the one in flight) carries refresh=1.
    force.current = true;
    void refresh().finally(() => {
      pending.current = false;
      setRetrying(false);
    });
  }, [refresh]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener(SUITE_REFRESH_EVENT, retry);
    return () => window.removeEventListener(SUITE_REFRESH_EVENT, retry);
  }, [retry]);
  return { ...poll, retry, retrying };
}
