/**
 * 今日複習 on Today (bell-suite SPEC §4.5): BELL Explain's review counts and
 * a few lessons, read through Personal's own /api/suite/sources. The card
 * fails on its own: whatever happens to the read, the rest of Today is
 * untouched. Unknown is never 0 — a count that was not read shows 「—」.
 * Titles are plain text. Links go to BELL Explain in the same tab, and only
 * while it is linked.
 */
import { Component, useCallback, useId, useRef, useState, type ReactNode } from "react";
import { BookOpen, Info } from "lucide-react";
import { Button } from "../components/Button";
import { CardHead } from "../components/Card";
import { Icon, RotateCw } from "../components/Icon";
import { Pill } from "../components/Pill";
import { Skeleton } from "../components/Skeleton";
import { suiteCopy } from "../copy/suite";
import { useStatus } from "../lib/status";
import { explainCardView, type ExplainCardView } from "./explain-view";
import { SourceDetails, sourceRows } from "./SourceDetails";
import { useSuiteLinks, useSuiteSources } from "./useSuite";
import "./ExplainTodayCard.css";

export interface ExplainTodayViewProps {
  view: ExplainCardView;
  onRetry?: () => void;
  retrying?: boolean;
  /** 來源詳情; receives the button so focus can go back to it. */
  onOpenDetails?: (opener: HTMLButtonElement) => void;
}

function Headline({ view }: { view: ExplainCardView }) {
  if (!view.headline) return null;
  const spoken = view.headlineSpoken && view.headlineSpoken !== view.headline ? view.headlineSpoken : undefined;
  return (
    <p className={`explain-today-headline${view.kind === "empty" ? " is-empty" : ""}${view.kind === "unavailable" ? " is-unknown" : ""}`}>
      {spoken ? (
        <>
          <span aria-hidden="true">{view.headline}</span>
          <span className="sr-only">{spoken}</span>
        </>
      ) : view.headline}
    </p>
  );
}

/** The card for one view model (pure: the tests render it as it is). */
export function ExplainTodayView({ view, onRetry, retrying = false, onOpenDetails }: ExplainTodayViewProps) {
  const EXPLAIN_CARD = suiteCopy().explainCard;
  const titleId = useId();
  const details = () => onOpenDetails ? (
    <Button size="sm" variant="ghost" icon={Info} onClick={(event) => onOpenDetails(event.currentTarget)}>
      {EXPLAIN_CARD.details}
    </Button>
  ) : null;
  const retry = (
    <Button size="sm" icon={RotateCw} disabled={retrying} aria-busy={retrying || undefined} onClick={onRetry}>
      {retrying ? EXPLAIN_CARD.retrying : EXPLAIN_CARD.retry}
    </Button>
  );

  const head = (
    <CardHead title={EXPLAIN_CARD.title} titleId={titleId} icon={BookOpen} tone="accent">
      <Pill className="explain-today-chip">{EXPLAIN_CARD.source}</Pill>
    </CardHead>
  );

  if (view.kind === "loading") {
    return (
      <section className="card explain-today" aria-labelledby={titleId} aria-busy="true">
        {head}
        <div className="explain-today-skel" aria-hidden="true">
          <Skeleton width="72%" height={18} />
          <Skeleton width="48%" />
          <Skeleton width="56%" />
        </div>
        <p className="explain-today-loading" role="status">{EXPLAIN_CARD.loading}</p>
      </section>
    );
  }

  if (view.kind === "unconfigured" || view.kind === "unsupported") {
    return (
      <section className="card explain-today is-quiet" aria-labelledby={titleId}>
        {head}
        <div className="explain-today-foot">
          <p className="explain-today-quiet kp">{view.kind === "unconfigured" ? EXPLAIN_CARD.unconfigured : EXPLAIN_CARD.unsupported}</p>
          {details()}
        </div>
      </section>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <section className="card explain-today" aria-labelledby={titleId}>
        {head}
        <Headline view={view} />
        <div className="explain-today-problem" role="status">
          <Icon icon={Info} size="sm" />
          <p className="kp">{EXPLAIN_CARD.unavailable}</p>
        </div>
        <div className="explain-today-actions">
          {retry}
          {details()}
        </div>
      </section>
    );
  }

  // ready, empty, stale: the counts that were read, the lessons, and when.
  return (
    <section className={`card explain-today${view.kind === "stale" ? " is-stale" : ""}`} aria-labelledby={titleId}>
      {head}
      <Headline view={view} />
      {view.reviewHref || view.libraryHref ? (
        <div className="explain-today-actions">
          {view.reviewHref ? <Button variant="primary" size="sm" icon={BookOpen} href={view.reviewHref}>{EXPLAIN_CARD.start}</Button> : null}
          {view.libraryHref ? <Button variant="secondary" size="sm" icon={BookOpen} href={view.libraryHref}>{EXPLAIN_CARD.openLibrary}</Button> : null}
        </div>
      ) : null}
      {view.lessons.length ? (
        <ul className="explain-today-lessons" aria-label={EXPLAIN_CARD.lessonsLabel}>
          {view.lessons.map((lesson) => (
            <li key={lesson.id}>
              {lesson.href
                ? <a href={lesson.href}><bdi>{lesson.title}</bdi></a>
                : <span><bdi>{lesson.title}</bdi></span>}
            </li>
          ))}
        </ul>
      ) : null}
      {view.kind === "stale" ? (
        <div className="explain-today-problem" role="status">
          <Icon icon={Info} size="sm" />
          <p className="kp">{view.staleMinutes !== undefined ? EXPLAIN_CARD.stale(view.staleMinutes) : EXPLAIN_CARD.staleNoTime}</p>
          {retry}
        </div>
      ) : null}
      <div className="explain-today-foot">
        {view.kind !== "stale" && view.updatedAt ? <span className="explain-today-time kp">{EXPLAIN_CARD.updated(view.updatedAt)}</span> : <span />}
        {details()}
      </div>
    </section>
  );
}

/**
 * The card's own error boundary: a bug in it (or in 來源詳情) leaves a quiet
 * 「暫時無法讀取」 card, never a blank Today. 重試 mounts it again.
 */
class ExplainCardBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const view = explainCardView({ pollState: "error", data: undefined, links: {} });
    return <ExplainTodayView view={view} onRetry={() => this.setState({ failed: false })} />;
  }
}

export function ExplainTodayCard() {
  return (
    <ExplainCardBoundary>
      <LiveExplainTodayCard />
    </ExplainCardBoundary>
  );
}

function LiveExplainTodayCard() {
  const poll = useSuiteSources();
  const links = useSuiteLinks();
  const timeZone = useStatus().data?.timeZone;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const input = { pollState: poll.state, data: poll.data, updatedAt: poll.updatedAt, links, timeZone };
  const view = explainCardView(input);

  const openDetails = useCallback((button: HTMLButtonElement) => {
    opener.current = button;
    setDetailsOpen(true);
  }, []);
  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    // The button may have been replaced (the state changed while the drawer was open): fall back to the card's.
    const button = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>(".explain-today .explain-today-foot .btn, .explain-today .explain-today-actions .btn");
    button?.focus();
  }, []);

  return (
    <>
      <ExplainTodayView view={view} onRetry={poll.retry} retrying={poll.retrying} onOpenDetails={openDetails} />
      <SourceDetails open={detailsOpen} onClose={closeDetails} rows={sourceRows(input)} onRefresh={poll.retry} refreshing={poll.retrying} />
    </>
  );
}
