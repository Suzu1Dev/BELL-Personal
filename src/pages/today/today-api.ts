/**
 * The endpoints Today calls besides /api/today and /api/actions (those go
 * through useToday()). Each is owned by another team (ARCHITECTURE §10.6);
 * the calls live here so a contract change touches one file. Habit
 * check-ins (useHabitToggle) and quick capture (CaptureField) come with
 * their own clients from the habits and tasks teams.
 */
import type { ApiErrorBody } from "../../../shared/api";
import type { BriefRefreshResult } from "../../../shared/connect";
import type { JobEvent } from "../../../shared/jobs";
import { ApiError, api, offlineMessage, send } from "../../api";
import { quickCaptureCopy } from "../../copy/capture";

/** Refetch the given sources now (重新整理 on a stale note). */
export function syncSources(sources: string[]): Promise<unknown> {
  return api("/sync", send("POST", { ...(sources.length ? { sources } : {}), force: true }));
}

/**
 * 重新整理摘要: POST /api/brief/refresh streams the job as NDJSON (habits-brief
 * team). Resolves with the result when the job is done; rejects with a localized
 * ApiError when the request is refused (429 busy, 503 AI off) or the job fails.
 */
export async function refreshBrief(signal?: AbortSignal): Promise<BriefRefreshResult | undefined> {
  let response: Response;
  try {
    response = await fetch("/api/brief/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(offlineMessage(), 0);
  }
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => null) as ApiErrorBody | null;
    throw new ApiError(typeof body?.error === "string" && body.error ? body.error : quickCaptureCopy().api.requestFailed, response.status, body);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as JobEvent;
      if (event.type === "error") throw new ApiError(event.message, 502);
      if (event.type === "done") return event.result as BriefRefreshResult | undefined;
    }
  }
  return undefined;
}
