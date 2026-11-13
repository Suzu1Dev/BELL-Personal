/**
 * 貢獻與審查 on Today: BELL PR's active contribution runs and counts, read
 * through Personal's /api/suite/sources once paired. Hidden when BELL PR is
 * completely unconfigured; offers a one-click jump to Settings pairing when
 * configured without a token; fails quietly on its own like ExplainTodayCard.
 */
import { Component, useCallback, useId, useRef, useState, type ReactNode } from "react";
import { GitPullRequest, Info } from "lucide-react";
import { SUITE_LIMITS } from "../../shared/suite";
import { Button } from "../components/Button";
import { CardHead } from "../components/Card";
import { Icon, RotateCw } from "../components/Icon";
import { Pill } from "../components/Pill";
import { Skeleton } from "../components/Skeleton";
import { currentLocale, suiteCopy, type SuiteLocale } from "../copy/suite";
import { useStatus } from "../lib/status";
import { effectiveStatus, findSource, readCount, suiteTime, type ExplainCardInput } from "./explain-view";
import { cleanLine, siblingRoute } from "./handoff";
import { SourceDetails, sourceRows } from "./SourceDetails";
import { useSuiteLinks, useSuiteSources } from "./useSuite";
import "./ExplainTodayCard.css";

export type PrCardKind = "loading" | "ready" | "empty" | "stale" | "unavailable" | "unconfigured" | "unsupported";

export interface PrRunRow {
  id: string;
  title: string;
  detail?: string;
  href?: string;
}

export interface PrCardView {
  kind: PrCardKind;
  headline?: string;
  headlineSpoken?: string;
  counts: { needsYou?: number; waiting?: number };
  openHref?: string;
  runs: PrRunRow[];
  updatedAt?: string;
  staleMinutes?: number;
  linked: boolean;
}

const RUN_ROWS = 4;
const formatCount = (value: number, locale: SuiteLocale) => value.toLocaleString(locale);

function prHeadline(
  counts: { needsYou?: number; waiting?: number },
  empty: boolean,
  copy: ReturnType<typeof suiteCopy>["prCard"],
  locale: SuiteLocale,
): string {
  if (empty) return copy.empty;
  const { needsYou, waiting } = counts;
  if (needsYou === undefined && waiting === undefined) return copy.unknown;
  return copy.headline(
    copy.needsYou(needsYou === undefined ? copy.unknown : formatCount(needsYou, locale)),
    copy.waiting(waiting === undefined ? copy.unknown : formatCount(waiting, locale)),
  );
}

export function prCardView({
  pollState,
  data,
  updatedAt,
  links,
  timeZone,
  now = new Date(),
  locale = currentLocale(),
}: ExplainCardInput): PrCardView {
  const PR_CARD = suiteCopy(locale).prCard;
  const origin = links.pr;
  const linked = !!origin;
  const source = findSource(data, "pr");
  const status = effectiveStatus(source, pollState, updatedAt, now);
  const base = { counts: {}, runs: [], linked } satisfies Partial<PrCardView>;

  if (status === "loading" || status === "unconfigured" || status === "unsupported") {
    return { ...base, kind: status, ...(origin ? { openHref: `${origin}/` } : {}) };
  }
  if (status === "unavailable" || !source?.feed) {
    return {
      ...base,
      kind: "unavailable",
      headline: PR_CARD.unknown,
      headlineSpoken: PR_CARD.unknownSpoken,
    };
  }

  const feed = source.feed;
  const counts = {
    needsYou: readCount(feed.counts, "needsYou"),
    waiting: readCount(feed.counts, "waiting"),
  };
  const empty = counts.needsYou === 0 && counts.waiting === 0;
  const runs: PrRunRow[] = [];
  for (const item of Array.isArray(feed.items) ? feed.items : []) {
    if (runs.length >= RUN_ROWS) break;
    if (!item || item.type !== "run" || typeof item.title !== "string" || typeof item.id !== "string") continue;
    const title = cleanLine(item.title);
    if (!title) continue;
    const chars = [...title];
    const shown = chars.length > SUITE_LIMITS.title ? `${chars.slice(0, SUITE_LIMITS.title - 1).join("")}…` : title;
    const detail = typeof item.detail === "string" ? cleanLine(item.detail) : undefined;
    runs.push({
      id: item.id,
      title: shown,
      ...(detail ? { detail } : {}),
      ...(origin && siblingRoute("pr", item.href) ? { href: `${origin}/${item.href}` } : {}),
    });
  }

  const kind = status === "stale" ? "stale" : empty ? "empty" : "ready";
  const lastSuccessMs = source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : Number.NaN;
  return {
    ...base,
    kind,
    headline: prHeadline(counts, empty, PR_CARD, locale),
    headlineSpoken: prHeadline(counts, empty, { ...PR_CARD, unknown: PR_CARD.unknownSpoken }, locale),
    counts,
    ...(origin ? { openHref: `${origin}/` } : {}),
    runs,
    updatedAt: suiteTime(source.lastSuccessAt, timeZone, now),
    ...(kind === "stale" && Number.isFinite(lastSuccessMs)
      ? { staleMinutes: Math.max(0, Math.round((now.getTime() - lastSuccessMs) / 60_000)) }
      : {}),
  };
}

export interface PrTodayViewProps {
  view: PrCardView;
  onRetry?: () => void;
  retrying?: boolean;
  onOpenDetails?: (opener: HTMLButtonElement) => void;
}

export function PrTodayView({ view, onRetry, retrying = false, onOpenDetails }: PrTodayViewProps) {
  const PR_CARD = suiteCopy().prCard;
  const titleId = useId();
  const details = () => onOpenDetails ? (
    <Button size="sm" variant="ghost" icon={Info} onClick={(event) => onOpenDetails(event.currentTarget)}>
      {PR_CARD.details}
    </Button>
  ) : null;
  const retry = (
    <Button size="sm" icon={RotateCw} disabled={retrying} aria-busy={retrying || undefined} onClick={onRetry}>
      {retrying ? PR_CARD.retrying : PR_CARD.retry}
    </Button>
  );

  const head = (
    <CardHead title={PR_CARD.title} titleId={titleId} icon={GitPullRequest} tone="accent">
      <Pill className="explain-today-chip">{PR_CARD.source}</Pill>
    </CardHead>
  );

  if (view.kind === "unconfigured") return null;

  if (view.kind === "loading") {
    return (
      <section className="card explain-today pr-today" aria-labelledby={titleId} aria-busy="true">
        {head}
        <div className="explain-today-skel" aria-hidden="true">
          <Skeleton width="68%" height={18} />
          <Skeleton width="44%" />
        </div>
        <p className="explain-today-loading" role="status">{PR_CARD.loading}</p>
      </section>
    );
  }

  if (view.kind === "unsupported") {
    return (
      <section className="card explain-today pr-today is-quiet" aria-labelledby={titleId}>
        {head}
        <div className="explain-today-foot">
          <p className="explain-today-quiet kp">{PR_CARD.unsupported}</p>
          <Button size="sm" variant="secondary" href="#/settings/sources">{PR_CARD.pairPr}</Button>
        </div>
      </section>
    );
  }

  const spoken = view.headlineSpoken && view.headlineSpoken !== view.headline ? view.headlineSpoken : undefined;
  const headline = view.headline ? (
    <p className={`explain-today-headline${view.kind === "empty" ? " is-empty" : ""}${view.kind === "unavailable" ? " is-unknown" : ""}`}>
      {spoken ? (
        <>
          <span aria-hidden="true">{view.headline}</span>
          <span className="sr-only">{spoken}</span>
        </>
      ) : view.headline}
    </p>
  ) : null;

  if (view.kind === "unavailable") {
    return (
      <section className="card explain-today pr-today" aria-labelledby={titleId}>
        {head}
        {headline}
        <div className="explain-today-problem" role="status">
          <Icon icon={Info} size="sm" />
          <p className="kp">{PR_CARD.unavailable}</p>
        </div>
        <div className="explain-today-actions">
          {retry}
          {details()}
        </div>
      </section>
    );
  }

  return (
    <section className={`card explain-today pr-today${view.kind === "stale" ? " is-stale" : ""}`} aria-labelledby={titleId}>
      {head}
      {headline}
      {view.openHref ? (
        <div className="explain-today-actions">
          <Button variant={view.kind === "empty" ? "secondary" : "primary"} size="sm" icon={GitPullRequest} href={view.openHref}>
            {PR_CARD.openPr}
          </Button>
        </div>
      ) : null}
      {view.runs.length ? (
        <ul className="explain-today-lessons" aria-label={PR_CARD.runsLabel}>
          {view.runs.map((run) => {
            const label = run.detail ? `${run.title} · ${run.detail}` : run.title;
            return (
              <li key={run.id}>
                {run.href
                  ? <a href={run.href}><bdi>{label}</bdi></a>
                  : <span><bdi>{label}</bdi></span>}
              </li>
            );
          })}
        </ul>
      ) : null}
      {view.kind === "stale" ? (
        <div className="explain-today-problem" role="status">
          <Icon icon={Info} size="sm" />
          <p className="kp">{view.staleMinutes !== undefined ? PR_CARD.stale(view.staleMinutes) : PR_CARD.staleNoTime}</p>
          {retry}
        </div>
      ) : null}
      <div className="explain-today-foot">
        {view.kind !== "stale" && view.updatedAt ? <span className="explain-today-time kp">{PR_CARD.updated(view.updatedAt)}</span> : <span />}
        {details()}
      </div>
    </section>
  );
}

class PrCardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (!this.state.failed) return this.props.children;
    const view = prCardView({ pollState: "error", data: undefined, links: {} });
    return <PrTodayView view={view} onRetry={() => this.setState({ failed: false })} />;
  }
}

export function PrTodayCard() {
  return (
    <PrCardBoundary>
      <LivePrTodayCard />
    </PrCardBoundary>
  );
}

function LivePrTodayCard() {
  const poll = useSuiteSources();
  const links = useSuiteLinks();
  const timeZone = useStatus().data?.timeZone;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const input = { pollState: poll.state, data: poll.data, updatedAt: poll.updatedAt, links, timeZone };
  const view = prCardView(input);

  const openDetails = useCallback((button: HTMLButtonElement) => {
    opener.current = button;
    setDetailsOpen(true);
  }, []);
  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    opener.current?.focus();
  }, []);

  if (view.kind === "unconfigured") return null;

  return (
    <>
      <PrTodayView view={view} onRetry={poll.retry} retrying={poll.retrying} onOpenDetails={openDetails} />
      <SourceDetails open={detailsOpen} onClose={closeDetails} rows={sourceRows(input)} onRefresh={poll.retry} refreshing={poll.retrying} />
    </>
  );
}
