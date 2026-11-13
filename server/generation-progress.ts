import type { JobEvent } from "../shared/jobs.js";
import type { AiProgress } from "./ai/structured.js";
import { AppError } from "./errors.js";

/** An AbortSignal that also fires after `timeoutMs` with a 504 carrying `message` (bell-explain). */
export function taskDeadline(parent: AbortSignal, timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AppError(504, message)), timeoutMs);
  timer.unref();
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Keeps a job's stream alive before the model emits anything: every
 * `intervalMs` (5 s) a stage line such as 「正在整理今日摘要…（已進行 12 秒）」.
 * Activity is metadata only: neither model text nor partial JSON is sent to
 * the browser. Usage:
 *
 *   const result = await withGenerationProgress("整理今日摘要", "brief", emit, signal,
 *     (onProgress) => ctx.ai.runStructured({ ..., signal, onProgress }));
 */
export async function withGenerationProgress<T>(
  label: string,
  stage: string,
  emit: (event: JobEvent) => void,
  signal: AbortSignal,
  task: (onProgress: (progress: AiProgress) => void) => Promise<T>,
  intervalMs = 5000,
): Promise<T> {
  signal.throwIfAborted();
  const started = Date.now();
  let lastSent = 0;
  let lastActivity = started;
  let active = true;
  let progress: AiProgress = { phase: "connecting" };
  const report = () => {
    if (!active || signal.aborted) return;
    const elapsed = Math.floor((Date.now() - started) / 1000);
    const duration = elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
    const activity = progress.notice
      ? progress.notice
      : Date.now() - lastActivity > 30_000 && progress.phase !== "connecting"
        ? "仍在等候模型的下一次回應"
        : progress.phase === "writing" ? "正在寫入結果" : progress.phase === "thinking" ? "正在思考" : "正在等候模型回應";
    emit({ type: "stage", stage, message: `正在${label}…${activity}（已進行 ${duration}）。` });
    lastSent = Date.now();
  };
  report();
  const timer = setInterval(report, intervalMs);
  timer.unref();
  try {
    return await task((next) => {
      if (!active || signal.aborted) return;
      const changed = next.phase !== progress.phase || next.notice !== progress.notice;
      progress = next;
      lastActivity = Date.now();
      if (changed || Date.now() - lastSent >= intervalMs) report();
    });
  } finally {
    active = false;
    clearInterval(timer);
  }
}
