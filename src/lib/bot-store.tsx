import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  BotContextStatus,
  BotOperation,
  BotOperationResponse,
  BotSendResponse,
  BotSessionFolder,
  BotSessionResponse,
  BotSessionSummary,
  BotSessionView,
} from "../../shared/bot";
import { api, followJob, send } from "../api";
import { useToast } from "../components/toast/ToastProvider";
import { ERRORS } from "../copy/common";
import { BOT } from "../copy/today";
import { notifySuiteRefresh } from "../suite/useSuite";
import { useToday } from "./today";

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

export interface BotStoreApi {
  session: BotSessionView | undefined;
  sessions: BotSessionSummary[];
  context: BotContextStatus | undefined;
  draft: string;
  sending: boolean;
  progressMessage: string | undefined;
  busyOpId: string | null;
  error: string | null;
  dockOpen: boolean;
  setDraft: (value: string) => void;
  setDockOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  submit: (overrideText?: string) => Promise<void>;
  reset: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  patchSession: (id: string, patch: { title?: string; folder?: BotSessionFolder; pinned?: boolean }) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  approveOp: (op: BotOperation) => Promise<void>;
  dismissOp: (op: BotOperation) => Promise<void>;
  undoOp: (op: BotOperation) => Promise<void>;
}

const noopAsync = async () => {};
const DEFAULT_BOT_STORE: BotStoreApi = {
  session: undefined,
  sessions: [],
  context: undefined,
  draft: "",
  sending: false,
  progressMessage: undefined,
  busyOpId: null,
  error: null,
  dockOpen: false,
  setDraft: () => {},
  setDockOpen: () => {},
  submit: noopAsync,
  reset: noopAsync,
  selectSession: noopAsync,
  patchSession: noopAsync,
  deleteSession: noopAsync,
  approveOp: noopAsync,
  dismissOp: noopAsync,
  undoOp: noopAsync,
};

const BotContext = createContext<BotStoreApi>(DEFAULT_BOT_STORE);

export function useBot(): BotStoreApi {
  return useContext(BotContext);
}

export function BotProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const today = useToday();
  const [session, setSession] = useState<BotSessionView | undefined>(undefined);
  const [sessions, setSessions] = useState<BotSessionSummary[]>([]);
  const [context, setContext] = useState<BotContextStatus | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | undefined>(undefined);
  const [busyOpId, setBusyOpId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const jobAbortRef = useRef<AbortController | null>(null);

  const applyResponse = useCallback((res: { session: BotSessionView; sessions?: BotSessionSummary[]; context: BotContextStatus }) => {
    setSession(res.session);
    if (res.sessions) setSessions(res.sessions);
    setContext(res.context);
  }, []);

  const syncWorld = useCallback(() => {
    void today.refresh();
    notifySuiteRefresh();
  }, [today]);

  const loadSession = useCallback(async (signal?: AbortSignal) => {
    const res = await api<BotSessionResponse>("/bot/session", signal ? { signal } : undefined);
    applyResponse(res);
    return res;
  }, [applyResponse]);

  const watchJob = useCallback(async (jobId: string) => {
    jobAbortRef.current?.abort();
    const controller = new AbortController();
    jobAbortRef.current = controller;
    setSending(true);
    setProgressMessage(BOT.thinkingDefault);
    setError(null);
    try {
      const outcome = await followJob(
        jobId,
        (event) => {
          if (event.type === "stage") setProgressMessage(event.message);
        },
        controller.signal,
      );
      const latest = await loadSession(controller.signal);
      if (outcome.type === "error") {
        setError(outcome.message);
      } else {
        const result = outcome.result as { executedCount?: number } | undefined;
        if ((result?.executedCount ?? 0) > 0 || latest.session.messages.some((m) => m.operations?.some((op) => op.status === "executed"))) {
          syncWorld();
        }
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(reasonOf(cause));
    } finally {
      if (jobAbortRef.current === controller) {
        setSending(false);
        setProgressMessage(undefined);
      }
    }
  }, [loadSession, syncWorld]);

  useEffect(() => {
    const controller = new AbortController();
    loadSession(controller.signal)
      .then((res) => {
        if (res.context.runningJobId) {
          void watchJob(res.context.runningJobId);
        }
      })
      .catch(() => { /* Offline banner is handled by page status */ });
    return () => {
      controller.abort();
      jobAbortRef.current?.abort();
    };
  }, [loadSession, watchJob]);

  const submit = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (!text || sending) return;
    setError(null);
    if (!overrideText) setDraft("");
    try {
      const res = await api<BotSendResponse>("/bot/messages", send("POST", { text }));
      applyResponse(res);
      if (res.jobId) {
        await watchJob(res.jobId);
      }
    } catch (cause) {
      if (!overrideText) setDraft(text);
      setError(reasonOf(cause));
    }
  }, [applyResponse, draft, sending, watchJob]);

  const reset = useCallback(async () => {
    jobAbortRef.current?.abort();
    setSending(false);
    setError(null);
    try {
      const res = await api<BotSessionResponse>("/bot/reset", send("POST"));
      applyResponse(res);
    } catch (cause) {
      toast.error(reasonOf(cause));
    }
  }, [applyResponse, toast]);

  const selectSession = useCallback(async (id: string) => {
    if (sending || session?.id === id) return;
    setError(null);
    try {
      const res = await api<BotSessionResponse>(`/bot/sessions/${encodeURIComponent(id)}/select`, send("POST"));
      applyResponse(res);
    } catch (cause) {
      toast.error(reasonOf(cause));
    }
  }, [applyResponse, sending, session?.id, toast]);

  const patchSession = useCallback(async (id: string, patch: { title?: string; folder?: BotSessionFolder; pinned?: boolean }) => {
    try {
      const res = await api<BotSessionResponse>(`/bot/sessions/${encodeURIComponent(id)}`, send("PATCH", patch));
      applyResponse(res);
    } catch (cause) {
      toast.error(reasonOf(cause));
    }
  }, [applyResponse, toast]);

  const deleteSession = useCallback(async (id: string) => {
    try {
      const res = await api<BotSessionResponse>(`/bot/sessions/${encodeURIComponent(id)}`, send("DELETE"));
      applyResponse(res);
    } catch (cause) {
      toast.error(reasonOf(cause));
    }
  }, [applyResponse, toast]);

  const approveOp = useCallback(async (op: BotOperation) => {
    if (busyOpId) return;
    setBusyOpId(op.id);
    setError(null);
    try {
      const res = await api<BotOperationResponse>(`/bot/operations/${encodeURIComponent(op.id)}/approve`, send("POST"));
      applyResponse(res);
      toast.success(BOT.approvedToast(res.operation.label));
      syncWorld();
    } catch (cause) {
      toast.error(reasonOf(cause));
      await loadSession().catch(() => {});
    } finally {
      setBusyOpId(null);
    }
  }, [applyResponse, busyOpId, loadSession, syncWorld, toast]);

  const dismissOp = useCallback(async (op: BotOperation) => {
    if (busyOpId) return;
    setBusyOpId(op.id);
    try {
      const res = await api<BotOperationResponse>(`/bot/operations/${encodeURIComponent(op.id)}/dismiss`, send("POST"));
      applyResponse(res);
    } catch (cause) {
      toast.error(reasonOf(cause));
    } finally {
      setBusyOpId(null);
    }
  }, [applyResponse, busyOpId, toast]);

  const undoOp = useCallback(async (op: BotOperation) => {
    if (busyOpId) return;
    setBusyOpId(op.id);
    try {
      const res = await api<BotOperationResponse>(`/bot/operations/${encodeURIComponent(op.id)}/undo`, send("POST"));
      applyResponse(res);
      toast.success(BOT.undoneToast(op.label));
      syncWorld();
    } catch (cause) {
      toast.error(ERRORS.undoFailed(reasonOf(cause)));
    } finally {
      setBusyOpId(null);
    }
  }, [applyResponse, busyOpId, syncWorld, toast]);

  const value = useMemo<BotStoreApi>(() => ({
    session,
    sessions,
    context,
    draft,
    sending,
    progressMessage,
    busyOpId,
    error,
    dockOpen,
    setDraft,
    setDockOpen,
    submit,
    reset,
    selectSession,
    patchSession,
    deleteSession,
    approveOp,
    dismissOp,
    undoOp,
  }), [
    session,
    sessions,
    context,
    draft,
    sending,
    progressMessage,
    busyOpId,
    error,
    dockOpen,
    submit,
    reset,
    selectSession,
    patchSession,
    deleteSession,
    approveOp,
    dismissOp,
    undoOp,
  ]);

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
}
