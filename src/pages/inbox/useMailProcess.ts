/**
 * The reader's 用 AI 處理 (POST /api/gmail/threads/:threadId/process): starts
 * (or joins) the conversation's `mail-process` job and follows it to its end,
 * keeping the latest progress line per conversation, so moving to another
 * conversation and back still shows it working. Leaving #/inbox stops
 * following; the job itself finishes on the server and its suggestions show
 * the next time the conversation is opened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MailProcessResult, MailProcessStart } from "../../../shared/mail";
import { api, followJob, send } from "../../api";
import { ERRORS } from "../../copy/common";
import type { MailProcessOutcome } from "./inbox-model";

export type ProcessDone = (threadId: string, outcome: MailProcessOutcome, retry: () => void) => void;

export function useMailProcess(onDone: ProcessDone) {
  /** Conversations being processed → the server's latest progress line ("" before the first). */
  const [running, setRunning] = useState<ReadonlyMap<string, string>>(new Map());
  const controllers = useRef(new Map<string, AbortController>());
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
  }, []);

  const start = useCallback(async function start(threadId: string): Promise<void> {
    if (controllers.current.has(threadId)) return;
    const controller = new AbortController();
    controllers.current.set(threadId, controller);
    setRunning((current) => new Map(current).set(threadId, ""));
    let outcome: MailProcessOutcome;
    try {
      const job = await api<MailProcessStart>(`/gmail/threads/${encodeURIComponent(threadId)}/process`, send("POST", {}, controller.signal));
      const end = await followJob(job.jobId, (event) => {
        if (event.type !== "stage") return;
        setRunning((current) => (current.has(threadId) ? new Map(current).set(threadId, event.message) : current));
      }, controller.signal);
      outcome = end.type === "done" ? (end.result as MailProcessResult) : { error: end.message };
    } catch (cause) {
      if (controller.signal.aborted) return;
      outcome = { error: cause instanceof Error ? cause.message : ERRORS.offline };
    } finally {
      controllers.current.delete(threadId);
      setRunning((current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      });
    }
    done.current(threadId, outcome, () => { void start(threadId); });
  }, []);

  return { running, start };
}
