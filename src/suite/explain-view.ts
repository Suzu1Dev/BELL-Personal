/**
 * The BELL Explain card on Today, as data (bell-suite SPEC §4.5): what
 * /api/suite/sources said, plus the state of that poll, becomes one view
 * model. Pure, so the rules are tested without React:
 *
 *   - unknown is never 0: a count the feed does not report, or any state
 *     without a feed, shows 「—」;
 *   - 「今天沒有到期的複習」 only when due and new are both reported as 0;
 *   - Personal builds the labels from counts, not the feed's title/detail;
 *   - links only when the manifest links BELL Explain, and only to its
 *     allowed routes.
 */
import { SUITE_LIMITS, type SuiteLinks, type SuiteSource, type SuiteSourceStatus, type SuiteSourcesResponse } from "../../shared/suite";
import { currentLocale, suiteCopy, type SuiteLocale } from "../copy/suite";
import type { PollState } from "../lib/usePoll";
import { cleanLine, siblingRoute } from "./handoff";

export const LESSON_ROWS = 4;

export type ExplainCardKind = "loading" | "ready" | "empty" | "stale" | "unavailable" | "unconfigured" | "unsupported";

export interface ExplainCounts {
  due?: number;
  newAvailable?: number;
  reviewedToday?: number;
}

export interface ExplainLessonRow {
  id: string;
  title: string;
  /** Absolute link into BELL Explain; absent when it is not linked. */
  href?: string;
}

export interface ExplainCardView {
  kind: ExplainCardKind;
  /** 「15 張待複習 · 12 到期 · 3 新卡」; unknown parts read 「—」. */
  headline?: string;
  /** The same sentence for screen readers (「—」 → 「未知」). */
  headlineSpoken?: string;
  counts: ExplainCounts;
  /** 開始複習 → `<explain>/#/review`, only when linked and there is something to review. */
  reviewHref?: string;
  /** 開啟知識庫 → `<explain>/#/library`, offered when nothing is due. */
  libraryHref?: string;
  lessons: ExplainLessonRow[];
  /** Local time of the last successful read: 「13:10」 today, 「11/7 13:10」 before. */
  updatedAt?: string;
  /** Whole minutes since the source's last success, shown only for stale data. */
  staleMinutes?: number;
  linked: boolean;
}

/** A count the feed reports: a whole number within the contract's range; anything else is unknown. */
export function readCount(counts: unknown, key: string): number | undefined {
  if (!counts || typeof counts !== "object") return undefined;
  const value = (counts as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SUITE_LIMITS.countMax ? value : undefined;
}

const dayFormat = (timeZone: string | undefined) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** 「HH:mm」 when `iso` is today in `timeZone` (default: the browser's), otherwise 「M/D HH:mm」. */
export function suiteTime(iso: string | undefined, timeZone?: string, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const clock = new Intl.DateTimeFormat("zh-TW", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    if (dayFormat(timeZone).format(date) === dayFormat(timeZone).format(now)) return clock;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).formatToParts(date);
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return month && day ? `${month}/${day} ${clock}` : clock;
  } catch {
    return timeZone ? suiteTime(iso, undefined, now) : undefined;
  }
}

export function effectiveStatus(
  source: SuiteSource | undefined,
  pollState: PollState,
  updatedAt: number | undefined,
  now: Date,
): SuiteSourceStatus | "loading" {
  if (pollState === "loading") return "loading";
  if (!source) return "unavailable";
  if (source.status === "unconfigured" || source.status === "unsupported" || source.status === "unavailable") return source.status;
  if (source.status !== "ready" && source.status !== "stale") return "unavailable";
  if (!source.feed || source.feed.appId !== source.appId) return "unavailable";
  if (pollState === "stale" || pollState === "error") {
    if (updatedAt === undefined || now.getTime() - updatedAt > SUITE_LIMITS.staleDropMs) return "unavailable";
    return "stale";
  }
  return source.status;
}

export function findSource(data: SuiteSourcesResponse | undefined, appId: SuiteSource["appId"]): SuiteSource | undefined {
  return Array.isArray(data?.sources) ? data.sources.find((source) => source?.appId === appId) : undefined;
}

const formatCount = (value: number, locale: SuiteLocale) => value.toLocaleString(locale);

function headlineOf(counts: ExplainCounts, empty: boolean, copy: ReturnType<typeof suiteCopy>["explainCard"], locale: SuiteLocale): string {
  if (empty) return copy.empty;
  const { due, newAvailable } = counts;
  if (due === undefined && newAvailable === undefined) return copy.unknown;
  const total = due !== undefined && newAvailable !== undefined ? formatCount(due + newAvailable, locale) : copy.unknown;
  return copy.headline(
    copy.toReview(total),
    copy.due(due === undefined ? copy.unknown : formatCount(due, locale)),
    copy.fresh(newAvailable === undefined ? copy.unknown : formatCount(newAvailable, locale)),
  );
}

export interface ExplainCardInput {
  /** The state of the /api/suite/sources poll. */
  pollState: PollState;
  data: SuiteSourcesResponse | undefined;
  /** When `data` arrived (ms, this device's clock). */
  updatedAt?: number;
  links: SuiteLinks;
  timeZone?: string;
  now?: Date;
  locale?: SuiteLocale;
}

export function explainCardView({ pollState, data, updatedAt, links, timeZone, now = new Date(), locale = currentLocale() }: ExplainCardInput): ExplainCardView {
  const EXPLAIN_CARD = suiteCopy(locale).explainCard;
  const origin = links.explain;
  const linked = !!origin;
  const source = findSource(data, "explain");
  const status = effectiveStatus(source, pollState, updatedAt, now);
  const base = { counts: {}, lessons: [], linked } satisfies Partial<ExplainCardView>;

  if (status === "loading" || status === "unconfigured" || status === "unsupported") return { ...base, kind: status };
  if (status === "unavailable" || !source?.feed) {
    return {
      ...base,
      kind: "unavailable",
      headline: EXPLAIN_CARD.unknown,
      headlineSpoken: EXPLAIN_CARD.unknownSpoken,
    };
  }

  const feed = source.feed;
  const counts: ExplainCounts = {
    due: readCount(feed.counts, "due"),
    newAvailable: readCount(feed.counts, "newAvailable"),
    reviewedToday: readCount(feed.counts, "reviewedToday"),
  };
  const empty = counts.due === 0 && counts.newAvailable === 0;
  const lessons: ExplainLessonRow[] = [];
  for (const item of Array.isArray(feed.items) ? feed.items : []) {
    if (lessons.length >= LESSON_ROWS) break;
    if (!item || item.type !== "lesson" || typeof item.title !== "string" || typeof item.id !== "string") continue;
    const title = cleanLine(item.title);
    if (!title) continue;
    const chars = [...title];
    const shown = chars.length > SUITE_LIMITS.title ? `${chars.slice(0, SUITE_LIMITS.title - 1).join("")}…` : title;
    lessons.push({ id: item.id, title: shown, ...(origin && siblingRoute("explain", item.href) ? { href: `${origin}/${item.href}` } : {}) });
  }
  const kind = status === "stale" ? "stale" : empty ? "empty" : "ready";
  const lastSuccessMs = source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : Number.NaN;
  return {
    ...base,
    kind,
    headline: headlineOf(counts, empty, EXPLAIN_CARD, locale),
    headlineSpoken: headlineOf(counts, empty, { ...EXPLAIN_CARD, unknown: EXPLAIN_CARD.unknownSpoken }, locale),
    counts,
    ...(origin && !empty ? { reviewHref: `${origin}/#/review` } : {}),
    ...(origin && empty ? { libraryHref: `${origin}/#/library` } : {}),
    lessons,
    updatedAt: suiteTime(source.lastSuccessAt, timeZone, now),
    ...(kind === "stale" && Number.isFinite(lastSuccessMs) ? { staleMinutes: Math.max(0, Math.round((now.getTime() - lastSuccessMs) / 60_000)) } : {}),
  };
}
