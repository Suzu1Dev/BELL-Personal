/**
 * #/inbox data: the conversation list (GET /api/gmail/threads, refreshed
 * whenever Today refreshes: its 60 s poll, focus, and every action and undo,
 * so it has no timer of its own) with optimistic edits layered on top; the
 * 封存 / 全部 pages and Gmail searches (GET /api/gmail/search, page by page,
 * read live and never polled); and the reading pane's conversation
 * (GET /api/gmail/threads/:threadId), refetched when its row changes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InboxListResponse, InboxSourceState, InboxThread, InboxThreadResponse, MailSearchResponse, MailView } from "../../../shared/mail";
import { ApiError, api } from "../../api";
import { ERRORS } from "../../copy/common";
import { useToday } from "../../lib/today";
import { usePoll, type PollState } from "../../lib/usePoll";
import { applyEdits, withoutShown, type InboxEdit } from "./inbox-model";

interface Fetched {
  list: InboxListResponse;
  startedAt: number;
}

interface Overlay {
  id: number;
  edit: InboxEdit;
  /** Acknowledged by the server; dropped once a fetch that started later lands. */
  settledAt?: number;
}

export interface EditHandle {
  settle(): void;
  revert(): void;
}

export function useInboxList() {
  const fetcher = useCallback(async (signal: AbortSignal): Promise<Fetched> => {
    const startedAt = Date.now();
    return { list: await api<InboxListResponse>("/gmail/threads", { signal }), startedAt };
  }, []);
  // No timer of its own: Today polls every 60 s (POLL_INTERVALS.mail) and this list follows it below.
  const poll = usePoll(fetcher, null);
  const [overlays, setOverlays] = useState<Overlay[]>([]);
  const nextId = useRef(1);

  const fetchedAt = poll.data?.startedAt;
  useEffect(() => {
    if (fetchedAt === undefined) return;
    setOverlays((list) => {
      const kept = list.filter((overlay) => overlay.settledAt === undefined || overlay.settledAt >= fetchedAt);
      return kept.length === list.length ? list : kept;
    });
  }, [fetchedAt]);

  // Today refreshes on its poll, on focus and after every action, undo and sync: follow it.
  const today = useToday();
  const { refresh } = poll;
  const seenToday = useRef(today.updatedAt);
  useEffect(() => {
    if (today.updatedAt === seenToday.current) return;
    seenToday.current = today.updatedAt;
    void refresh();
  }, [today.updatedAt, refresh]);

  const edit = useCallback((change: InboxEdit): EditHandle => {
    const id = nextId.current++;
    setOverlays((list) => [...list, { id, edit: change }]);
    return {
      settle: () => {
        const settledAt = Date.now();
        setOverlays((list) => list.map((overlay) => (overlay.id === id ? { ...overlay, settledAt } : overlay)));
      },
      revert: () => setOverlays((list) => list.filter((overlay) => overlay.id !== id)),
    };
  }, []);

  const edits = useMemo(() => overlays.map((overlay) => overlay.edit), [overlays]);
  const data = useMemo(() => (poll.data ? applyEdits(poll.data.list, edits) : undefined), [poll.data, edits]);
  return { data, edits, state: poll.state, error: poll.error, updatedAt: poll.updatedAt, refresh, edit };
}

export interface MailPagesState {
  /** `${view}|${q}` of what is loaded (or loading). */
  key: string;
  threads: InboxThread[];
  nextPageToken?: string;
  state: "idle" | "loading" | "ready" | "error";
  origin?: MailSearchResponse["origin"];
  /** Gmail failed and the rows come from the cache (MailSearchResponse.error). */
  gmailError?: string;
  /** The request itself failed (offline, a server error). */
  error?: string;
  source?: InboxSourceState;
  loadingMore: boolean;
}

export interface LoadMoreResult {
  ok: boolean;
  added: number;
  /** The first conversation the page added (focus goes there when 載入更多 is gone). */
  firstAdded?: string;
  /** Gmail has another page: 載入更多 stays. */
  more?: boolean;
  error?: string;
  /** The page token expired: page one was loaded again. */
  expired?: boolean;
}

const IDLE: MailPagesState = { key: "", threads: [], state: "idle", loadingMore: false };

/**
 * One listing of GET /api/gmail/search (SPEC-mail-assignments §3.5, §4.2): the
 * 封存 or 全部 view (q = "") or a Gmail search. Page one loads whenever the
 * view or the query changes (a newer one aborts the older request);
 * 載入更多 appends the next page, dropping conversations already shown.
 * `view` undefined means nothing to load.
 */
export function useMailPages(view: MailView | undefined, q: string) {
  const key = view ? `${view}|${q}` : "";
  const [result, setResult] = useState<MailPagesState>(IDLE);
  const [tick, setTick] = useState(0);
  const current = useRef(result);
  current.current = result;
  const more = useRef<AbortController | null>(null);

  useEffect(() => {
    more.current?.abort();
    if (!view) {
      setResult(IDLE);
      return;
    }
    const controller = new AbortController();
    setResult((previous) => ({ ...IDLE, key, state: "loading", ...(previous.key === key ? { threads: previous.threads, source: previous.source } : {}) }));
    api<MailSearchResponse>(searchPath(view, q), { signal: controller.signal })
      .then((body) => setResult({
        key, threads: withoutShown([], body.threads), state: "ready", origin: body.origin, source: body.source, loadingMore: false,
        ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
        ...(body.error ? { gmailError: body.error } : {}),
      }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ ...IDLE, key, state: "error", error: cause instanceof ApiError || cause instanceof Error ? cause.message : ERRORS.offline });
      });
    return () => controller.abort();
  }, [key, view, q, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  const loadMore = useCallback(async (): Promise<LoadMoreResult> => {
    const before = current.current;
    if (!view || before.key !== key || !before.nextPageToken || before.loadingMore) return { ok: false, added: 0 };
    more.current?.abort();
    const controller = new AbortController();
    more.current = controller;
    setResult((previous) => (previous.key === key ? { ...previous, loadingMore: true } : previous));
    try {
      const body = await api<MailSearchResponse>(searchPath(view, q, before.nextPageToken), { signal: controller.signal });
      const fresh = withoutShown(current.current.threads, body.threads);
      const added = fresh.length;
      setResult((previous) => {
        if (previous.key !== key) return previous;
        const { nextPageToken: _old, ...rest } = previous;
        return {
          ...rest, threads: [...previous.threads, ...withoutShown(previous.threads, body.threads)], loadingMore: false,
          ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
        };
      });
      return { ok: true, added, ...(fresh[0] ? { firstAdded: fresh[0].threadId } : {}), more: !!body.nextPageToken };
    } catch (cause) {
      if (controller.signal.aborted) return { ok: false, added: 0 };
      const status = cause instanceof ApiError ? cause.status : undefined;
      const message = cause instanceof ApiError || cause instanceof Error ? cause.message : ERRORS.offline;
      setResult((previous) => (previous.key === key ? { ...previous, loadingMore: false } : previous));
      if (status === 400) {
        reload();
        return { ok: false, added: 0, error: message, expired: true };
      }
      return { ok: false, added: 0, error: message };
    }
  }, [view, q, key, reload]);

  useEffect(() => () => more.current?.abort(), []);

  const live = result.key === key ? result : { ...IDLE, key, state: view ? "loading" as const : "idle" as const };
  return { ...live, reload, loadMore };
}

function searchPath(view: MailView, q: string, pageToken?: string): string {
  const params = new URLSearchParams({ view });
  if (q) params.set("q", q);
  if (pageToken) params.set("pageToken", pageToken);
  return `/gmail/search?${params.toString()}`;
}

export interface ThreadState {
  data: InboxThreadResponse | undefined;
  state: PollState;
  error: string | undefined;
  /** HTTP status of the last failure (404: the conversation left the cache). */
  status: number | undefined;
  refresh(): void;
}

/** The reading pane's conversation; refetched when `version` changes (threadVersion() of its list row). */
export function useThread(threadId: string | undefined, version: string | undefined): ThreadState {
  const [result, setResult] = useState<{ id?: string; data?: InboxThreadResponse; state: PollState; error?: string; status?: number }>({ state: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!threadId) {
      setResult({ state: "loading" });
      return;
    }
    const controller = new AbortController();
    setResult((previous) => (previous.id === threadId ? previous : { id: threadId, state: "loading" }));
    api<InboxThreadResponse>(`/gmail/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal })
      .then((data) => setResult({ id: threadId, data, state: "ready" }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const message = cause instanceof ApiError || cause instanceof Error ? cause.message : ERRORS.offline;
        const status = cause instanceof ApiError ? cause.status : undefined;
        setResult((previous) => (previous.id === threadId && previous.data && status !== 404
          ? { ...previous, state: "stale", error: message, status }
          : { id: threadId, state: "error", error: message, status }));
      });
    return () => controller.abort();
  }, [threadId, version, tick]);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const current = result.id === threadId ? result : { state: "loading" as const };
  return { data: current.data, state: current.state, error: current.error, status: current.status, refresh };
}
