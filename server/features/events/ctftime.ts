import { z } from "zod";
import { CTFTIME_WINDOW_DAYS, type ExternalEvent } from "../../../shared/events.js";
import { AppError } from "../../errors.js";
import type { ModuleContext } from "../../modules.js";
import type { SourceItemInput } from "../../stores/source-items.js";
import { expectOk, SourceSync, type SyncContext, type SyncOutcome } from "../../sync.js";
import { plainText } from "./feed-parse.js";

/**
 * CTFtime upcoming events (decisions.md item 4): one public API call,
 * `GET https://ctftime.org/api/v1/events/?limit=100&start=<now−14d>&finish=<now+30d>`
 * with the bell-personal User-Agent (safeFetch). The API filters on the start
 * time, so the request reaches back 14 days to keep CTFs that are running;
 * those that already finished are dropped after the fetch. Cached at least an hour:
 * background runs every 3 h and POST /api/sync refetches only after an hour.
 * All events are cached; the weight filter (ctftime.minWeight) applies when
 * they are shown, so changing the setting needs no refetch.
 */

export const CTFTIME_API = "https://ctftime.org/api/v1/events/";
export const CTFTIME_INTERVAL_MS = 3 * 3_600_000;
export const CTFTIME_STALE_MS = 3_600_000;

const ctftimeEventSchema = z.object({
  id: z.number().int(),
  title: z.string().min(1),
  start: z.string(),
  finish: z.string().nullish(),
  url: z.string().nullish(),
  ctftime_url: z.string().nullish(),
  format: z.string().nullish(),
  weight: z.number().nullish(),
  onsite: z.boolean().nullish(),
  location: z.string().nullish(),
  description: z.string().nullish(),
  organizers: z.array(z.object({ name: z.string().nullish() }).loose()).nullish(),
}).loose();
export type CtftimeApiEvent = z.infer<typeof ctftimeEventSchema>;

/** How far back the request reaches for CTFs that started but have not finished (catalog's 14-day window). */
export const CTFTIME_RUNNING_DAYS = 14;

/** The request URL for events starting between now − 14 days and now + 30 days (unix seconds). */
export function ctftimeUrl(now: Date): string {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const start = nowSeconds - CTFTIME_RUNNING_DAYS * 86_400;
  const finish = nowSeconds + CTFTIME_WINDOW_DAYS * 86_400;
  return `${CTFTIME_API}?limit=100&start=${start}&finish=${finish}`;
}

function https(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** One API event → ExternalEvent (id `ctftime:<id>`, link = ctftime_url). Null when its dates are unusable. */
export function mapCtftimeEvent(raw: unknown, now: Date): ExternalEvent | null {
  const parsed = ctftimeEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const event = parsed.data;
  const start = Date.parse(event.start);
  if (Number.isNaN(start)) return null;
  const finish = event.finish ? Date.parse(event.finish) : Number.NaN;
  const online = event.onsite === false;
  const location = plainText(event.location ?? undefined, 200);
  const organizer = plainText(event.organizers?.[0]?.name ?? undefined, 120);
  const description = plainText(event.description ?? undefined, 500);
  const url = https(event.ctftime_url) ?? `https://ctftime.org/event/${event.id}`;
  return {
    id: `ctftime:${event.id}`,
    origin: "ctftime",
    title: plainText(event.title, 200) ?? `CTF #${event.id}`,
    start: new Date(start).toISOString(),
    end: Number.isNaN(finish) || finish <= start ? null : new Date(finish).toISOString(),
    allDay: false,
    ...(location ? { location } : {}),
    url,
    ...(organizer ? { organizer } : {}),
    ...(event.format ? { format: event.format.slice(0, 40) } : {}),
    ...(typeof event.weight === "number" && Number.isFinite(event.weight) ? { weight: Math.max(0, Math.min(100, event.weight)) } : {}),
    online,
    ...(description ? { description } : {}),
    updatedAt: now.toISOString(),
  };
}

export class CtftimeSync extends SourceSync {
  constructor(private readonly ctx: ModuleContext, options: { intervalMs?: number } = {}) {
    super({ id: "ctftime", state: ctx.syncState, intervalMs: options.intervalMs ?? CTFTIME_INTERVAL_MS, staleAfterMs: CTFTIME_STALE_MS, fetch: ctx.fetch, now: ctx.now });
  }

  /** Off for a new install; on once ctftime.enabled is set (the CTF 選手 switch in 初次設定, or 連線與設定). Installs from before 初次設定 keep it on (PRE_ONBOARDING_DEFAULTS). */
  configured(): boolean {
    return this.ctx.settings.value("ctftime.enabled");
  }

  /** Background runs skip a fetch (or a failed attempt) younger than an hour (the cache rule), so restarts do not hit the API. */
  override schedule(): void {
    if (!this.dueForFetch()) return;
    super.schedule();
  }

  protected async run({ http, now }: SyncContext): Promise<SyncOutcome> {
    const response = expectOk(await http(ctftimeUrl(now), { headers: { accept: "application/json" } }), "CTFtime");
    const body = response.json<unknown>();
    if (!Array.isArray(body)) throw new AppError(502, "CTFtime 回傳的資料格式不正確，稍後會自動重試。");
    const events = body.map((raw) => mapCtftimeEvent(raw, now))
      .filter((event): event is ExternalEvent => !!event && Date.parse(event.end ?? event.start) > now.getTime());
    const inputs: SourceItemInput<ExternalEvent>[] = events.map((event) => ({ kind: "external-event", externalId: event.id, value: event, startsAt: event.start }));
    this.ctx.sourceItems.replace("ctftime", "external-event", inputs);
    return { items: inputs.length };
  }
}

/** Whether a CTF passes the user's minimum weight (ctftime.minWeight; a CTF without a weight counts as 0). */
export function passesWeight(event: Pick<ExternalEvent, "weight">, minWeight: number): boolean {
  return (event.weight ?? 0) >= minWeight;
}
