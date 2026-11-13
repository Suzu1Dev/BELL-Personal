import { AppError } from "../errors.js";

/**
 * One model call at a time by default: concurrent Claude Code processes race on
 * the shared OAuth refresh lock (sibling BELL apps use the same login).
 */
export const defaultAgentProcessLimit = 1;

/**
 * interactive: someone is waiting on the answer (the palette's AI 解析, a manual refresh);
 * soon: work the user just caused but does not watch (自動整理 after a capture);
 * background: triage, scheduled work.
 */
export type AgentPriority = "interactive" | "soon" | "background";

const RANK: Record<AgentPriority, number> = { interactive: 2, soon: 1, background: 0 };

/**
 * bell-pr's AgentSlots: bounds how many agent CLI processes run at once across
 * every job. Waiters are granted slots in FIFO order within a priority, and a
 * waiter goes ahead of every waiter of a lower priority (interactive › soon ›
 * background). Acquire per attempt and call the idempotent release in `finally`.
 */
export class AgentSlots {
  private activeCount = 0;
  private waiters: { rank: number; grant: () => void }[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("AgentSlots limit must be a positive integer.");
  }

  get active() {
    return this.activeCount;
  }

  get waiting() {
    return this.waiters.length;
  }

  /** Resolves with an idempotent release function once a slot is free. */
  acquire(signal?: AbortSignal, options: { priority?: AgentPriority } = {}): Promise<() => void> {
    if (signal?.aborted)
      return Promise.reject(new AppError(409, "工作已取消。"));
    if (this.activeCount < this.limit) {
      this.activeCount++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new AppError(409, "工作已取消。"));
      };
      const waiter = {
        rank: RANK[options.priority ?? "background"],
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          this.activeCount++;
          resolve(this.releaser());
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const firstLower = this.waiters.findIndex((item) => item.rank < waiter.rank);
      if (firstLower >= 0) this.waiters.splice(firstLower, 0, waiter);
      else this.waiters.push(waiter);
    });
  }

  private releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount--;
      this.waiters.shift()?.grant();
    };
  }
}

/** Parses BELLPERSONAL_MAX_AGENT_PROCESSES; an unset variable means the default. */
export function parseAgentProcessLimit(value: string | undefined): number {
  if (value === undefined) return defaultAgentProcessLimit;
  const limit = Number(value);
  if (value.trim() === "" || !Number.isInteger(limit) || limit < 1 || limit > 32)
    throw new Error("BELLPERSONAL_MAX_AGENT_PROCESSES 必須是 1–32 的整數。");
  return limit;
}
