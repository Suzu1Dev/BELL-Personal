import type { AppSettings } from "../../../shared/settings.js";
import { todayKey, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";
import { logEvent } from "../../log.js";

export interface BriefSchedulerOptions {
  now: () => Date;
  timeZone: string;
  settings: () => Pick<AppSettings, "ai.enabled" | "brief.autoTime">;
  /** Whether the day still needs an automatic run (no AI brief, no failure recorded since `at`, none running). */
  needsRun: (day: DayKey, at: Date) => boolean;
  /** Starts the generation (fire and forget). */
  run: () => void;
  /** How often the clock is checked; default 60 s. */
  intervalMs?: number;
  /** First check after start (the catch-up after a restart); default 15 s so sources can refresh first. */
  bootDelayMs?: number;
}

/**
 * The 06:30 daily brief (brief.autoTime, local time in BELLPERSONAL_TZ). An
 * unref'd timer checks the clock every minute; once the local time has passed
 * the configured time and today has no brief yet, it starts one generation.
 * The same check runs shortly after boot, so a server that was down at 06:30
 * catches up. Checking instead of sleeping until 06:30 keeps it right across
 * settings changes, DST and a host that suspends.
 */
export class BriefScheduler {
  private interval: ReturnType<typeof setInterval> | undefined;
  private boot: ReturnType<typeof setTimeout> | undefined;
  /** The last day the scheduler triggered (or found nothing to do): at most one automatic run per day. */
  private handledDay: DayKey | undefined;

  constructor(private readonly options: BriefSchedulerOptions) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.options.intervalMs ?? 60_000);
    this.interval.unref();
    this.boot = setTimeout(() => this.tick(), this.options.bootDelayMs ?? 15_000);
    this.boot.unref();
  }

  close(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.boot) clearTimeout(this.boot);
    this.interval = undefined;
    this.boot = undefined;
  }

  /** Today's automatic time as an instant. */
  autoAt(day: DayKey): Date {
    const [hour, minute] = this.options.settings()["brief.autoTime"].split(":").map(Number);
    return zonedTimeToUtc(this.options.timeZone, day, hour, minute);
  }

  /** One clock check; returns whether it started a run. Never throws (it runs on a timer). */
  tick(): boolean {
    try {
      const settings = this.options.settings();
      if (!settings["ai.enabled"]) return false;
      const now = this.options.now();
      const day = todayKey(this.options.timeZone, now);
      if (this.handledDay === day) return false;
      const at = this.autoAt(day);
      if (now < at) return false;
      this.handledDay = day;
      if (!this.options.needsRun(day, at)) return false;
      logEvent("brief.scheduled", { late: now.getTime() - at.getTime() > 5 * 60_000 });
      this.options.run();
      return true;
    } catch (error) {
      logEvent("brief.schedule_failed", { errorClass: error instanceof Error ? error.name : typeof error });
      return false;
    }
  }
}
