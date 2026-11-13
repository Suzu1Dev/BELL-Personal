/**
 * HTTP calls for quick capture (docs/ARCHITECTURE.md §10.6): POST /api/capture,
 * the NDJSON AI parse job, the palette search and the undo of a capture.
 */
import type { CaptureParseResult, CaptureRequest, CaptureResponse, CaptureSearchResponse } from "../../../shared/connect";
import type { JobEvent } from "../../../shared/jobs";
import type { ApiErrorBody } from "../../../shared/api";
import { ApiError, api, core, offlineMessage, send } from "../../api";

/** Fired on window after a capture (or its undo) lands, so pages listing todos or ideas refetch. */
export const CAPTURED_EVENT = "bell-personal:captured";

export function notifyCaptured(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CAPTURED_EVENT));
}

export const captureApi = {
  create: (body: CaptureRequest & { suggestionId?: string }) => api<CaptureResponse>("/capture", send("POST", body)),
  /** 復原: the response's undoPath (with its /api prefix) as a DELETE. */
  undo: (undoPath: string) => api<unknown>(undoPath.replace(/^\/api(?=\/)/, ""), send("DELETE")),
  search: (query: string, signal?: AbortSignal) => api<CaptureSearchResponse>(`/capture/search?q=${encodeURIComponent(query)}`, { signal }),
};

/**
 * POST /api/capture/parse and read its NDJSON stream to the end. Resolves
 * with the option, rejects with the job's zh-TW error. Aborting the signal
 * cancels the job on the server too, so a stale parse never holds the CLI:
 * the aborted request closes its connection, which stops the job
 * (`cancelOnDisconnect`) even while the POST is still in flight, and once the
 * job id has been read a DELETE /api/jobs/:id is sent as well.
 */
export async function aiParse(text: string, signal: AbortSignal): Promise<CaptureParseResult> {
  let response: Response;
  try {
    response = await fetch("/api/capture/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(offlineMessage(), 0);
  }
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => null) as ApiErrorBody | null;
    throw new ApiError((body && typeof body.error === "string" && body.error) || offlineMessage(), response.status, body);
  }
  let jobId: string | undefined;
  const cancel = () => { if (jobId) void core.cancelJob(jobId).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
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
        if (event.type === "job") jobId = event.id;
        if (event.type === "done") return event.result as CaptureParseResult;
        if (event.type === "error") throw new ApiError(event.message, 502);
      }
    }
    throw new ApiError(offlineMessage(), 0);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
