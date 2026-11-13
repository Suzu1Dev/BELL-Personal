/**
 * The one HTTP client for /api (bell-pr's api()/send() with bell-explain's
 * ApiError). Every request carries a JSON Content-Type: the server rejects
 * writes without it (415). Error bodies are always { error: string } in zh-TW.
 */
import type { ApiErrorBody, ApiErrorCode, HealthResponse, StatusResponse } from "../shared/api";
import type { JobEvent, JobView } from "../shared/jobs";
import type { ProfileRole } from "../shared/profile";
import { quickCaptureCopy } from "./copy/capture";
import { onboardingLocale, type OnboardingLocale } from "./copy/onboarding";

/** What every "the local service did not answer" message contains (toasts with it close once it answers again). */
export const OFFLINE_REASON = "無法連線至本機服務";
export const OFFLINE_MESSAGE = `${OFFLINE_REASON}，請確認 BELL Personal 正在執行。`;
export const OFFLINE_REASON_EN = "Can't reach the local service";
export const OFFLINE_MESSAGE_EN = `${OFFLINE_REASON_EN}. Make sure BELL Personal is running.`;

function activeLocale(): OnboardingLocale {
  if (typeof window !== "undefined" && !window.location) return "zh-TW";
  return onboardingLocale();
}

export function offlineMessage(locale: OnboardingLocale = activeLocale()): string {
  return locale === "en" ? OFFLINE_MESSAGE_EN : OFFLINE_MESSAGE;
}

export function isOfflineErrorMessage(text: string): boolean {
  return text.includes(OFFLINE_REASON) || text.includes(OFFLINE_REASON_EN);
}

/** An API failure that keeps the HTTP status (0 when the service could not be reached) and structured refusal details. */
export class ApiError extends Error {
  readonly code: ApiErrorCode | undefined;
  readonly roles: ProfileRole[] | undefined;

  constructor(message: string, readonly status: number, body?: ApiErrorBody | null) {
    super(message);
    this.name = "ApiError";
    this.code = body?.code;
    this.roles = body && "roles" in body ? body.roles : undefined;
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options?.headers },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError(offlineMessage(), 0);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError((body && typeof body.error === "string" && body.error) || quickCaptureCopy().api.requestFailed, response.status, body);
  if (body === null) throw new ApiError(offlineMessage(), response.status);
  return body as T;
}

/** Request init for a write: send("PUT", { … }). */
export const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  body: JSON.stringify(body ?? {}),
  ...(signal ? { signal } : {}),
});

export const core = {
  health: (signal?: AbortSignal) => api<HealthResponse>("/health", { signal }),
  status: (signal?: AbortSignal) => api<StatusResponse>("/status", { signal }),
  syncOnOpen: (force = false) => api<{ started: string[] }>("/sync", send("POST", { force })),
  restore: (undoToken: string) => api<{ restored: { table: string; id: string } }>("/trash/restore", send("POST", { token: undoToken })),
  job: (id: string) => api<JobView>(`/jobs/${encodeURIComponent(id)}`),
  // Writes always carry a JSON body: the server answers 415 to a write without one.
  cancelJob: (id: string) => api<void>(`/jobs/${encodeURIComponent(id)}`, send("DELETE")),
};

/**
 * Follows a job's NDJSON stream from event index `from`, reconnecting after a
 * dropped connection (bell-explain followJob). Resolves with the final event
 * ("done" or "error"). Pass the returned cursor to resume after a reload.
 */
export async function followJob(
  id: string,
  onEvent: (event: JobEvent, index: number) => void,
  signal: AbortSignal,
  from = 0,
): Promise<Extract<JobEvent, { type: "done" | "error" }>> {
  let cursor = from;
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(`/api/jobs/${encodeURIComponent(id)}/events?from=${cursor}`, { signal, headers: { "Content-Type": "application/json" } });
    } catch (cause) {
      if (signal.aborted) throw cause;
      await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1000 * 2 ** attempt)));
      continue;
    }
    if (response.status === 404) return { type: "error", message: quickCaptureCopy().api.jobNotFound };
    if (!response.ok || !response.body) throw new ApiError(quickCaptureCopy().api.jobStatusUnavailable, response.status);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let first = true;
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
        // The {type:"job"} header is not part of the job's own event list.
        if (first && event.type === "job") { first = false; continue; }
        first = false;
        onEvent(event, cursor);
        cursor++;
        if (event.type === "done" || event.type === "error") return event;
      }
    }
  }
  throw new ApiError(quickCaptureCopy().api.jobStreamDisconnected, 0);
}
