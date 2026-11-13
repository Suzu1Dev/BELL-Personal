/**
 * LaterCard (SPEC-ux §4.5, §9): 明天與之後 (the next events and deadlines
 * not in the queue, up to 3) and 專案 (active projects, a waiting PR), split
 * by a hairline, no tiles. At ≤720 it folds into one `.later-sum` line;
 * that choice is kept in `bell-personal.today.collapsed-widgets`.
 */
import type { CSSProperties } from "react";
import type { TodayPayload } from "../../../shared/today";
import { LATER, WIDGET_UNAVAILABLE } from "../../copy/today";
import { Button } from "../../components/Button";
import { CalendarDays, ChevronDown, Icon, RotateCw } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Skeleton } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { cx } from "../../lib/cx";
import { STORAGE_KEYS, storedValue, useStoredValue } from "../../lib/storage";
import { projectColorVar } from "../../lib/today-model";
import { LATER_EVENT_SOURCE_IDS, isBroken, laterSummary, sincePhrase } from "./today-view";
import "./LaterCard.css";

/** Widgets the user expanded on a phone (they start folded there). */
export const expandedWidgets = storedValue<string[]>(
  STORAGE_KEYS.todayCollapsed,
  (raw) => {
    try {
      const value: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  },
  (list) => (list.length ? JSON.stringify(list) : null),
);

/** Module names whose failed today() takes out a half (ARCHITECTURE §10.2: a failed module without sources is listed by name). */
const EVENT_MODULES = ["events", "calendar"];
const PROJECT_MODULES = ["projects", "github"];

export interface LaterCardProps {
  payload: TodayPayload | undefined;
  onRetry: () => void;
  onSyncSources: (ids: string[]) => void;
  /** The first load failed (no payload): static lines instead of the loading skeleton. */
  failed?: boolean;
}

export function LaterCard({ payload, onRetry, onSyncSources, failed = false }: LaterCardProps) {
  const expandedList = useStoredValue(expandedWidgets);
  const open = expandedList.includes("later");
  const toggle = () => {
    expandedWidgets.set(open ? expandedList.filter((entry) => entry !== "later") : [...expandedList, "later"]);
  };

  if (!payload && failed) {
    return (
      <section className="card later" aria-label={LATER.label}>
        {[LATER.events, LATER.projects].map((title) => (
          <section key={title}>
            <div className="card-head"><h2>{title}</h2></div>
            <p className="widget-off kp">{WIDGET_UNAVAILABLE}</p>
          </section>
        ))}
      </section>
    );
  }

  if (!payload) {
    return (
      <section className="card later" aria-label={LATER.label} aria-busy="true">
        {[LATER.events, LATER.projects].map((title) => (
          <section key={title}>
            <div className="card-head"><h2>{title}</h2></div>
            <div className="later-skel" aria-hidden="true">
              {[0, 1, 2].map((row) => <Skeleton key={row} height={34} radius={7} />)}
            </div>
          </section>
        ))}
      </section>
    );
  }

  const { events, projects } = payload.later;
  const failedModules = new Set(payload.sources.filter((source) => isBroken(source) && !source.lastSyncedAt).map((source) => source.id));
  const eventsFailed = EVENT_MODULES.some((name) => failedModules.has(name));
  const projectsFailed = PROJECT_MODULES.some((name) => failedModules.has(name));
  const staleEvents = payload.sources.filter((source) => LATER_EVENT_SOURCE_IDS.includes(source.id) && source.state === "stale" && source.lastSyncedAt);
  const summary = laterSummary(payload);

  // Nothing ahead and nothing broken: no card at all. A line that tells a student to go add event
  // sources is the kind of noise Today avoids; tomorrow's classes and deadlines appear here on their own.
  if (!events.length && !projects.length && !eventsFailed && !projectsFailed) return null;

  return (
    <section className={cx("card later", open && "is-open")} aria-label={LATER.label}>
      <button className="later-sum" type="button" aria-expanded={open} aria-controls="later-events later-projects" onClick={toggle}>
        <Icon icon={CalendarDays} size="sm" className="later-sum-ico" />
        <span className="kp">
          {summary.lead ? <b>{summary.lead}</b> : <b>{LATER.sumEmpty}</b>}
          {summary.rest.map((part) => <span key={part}>{` · ${part}`}</span>)}
        </span>
        <Icon icon={ChevronDown} size="sm" className={cx("later-sum-chev", open && "is-open")} />
      </button>
      <section id="later-events" aria-labelledby="up-title">
        <div className="card-head">
          <h2 id="up-title">{LATER.events}</h2>
          <TextLink href="#/events">{LATER.eventsLink}</TextLink>
        </div>
        {eventsFailed ? (
          <HalfFailed onRetry={onRetry} />
        ) : events.length ? (
          events.map((event) => (
            <div className="ev-row" key={`${event.date}-${event.title}`}>
              <span className="dblock"><b>{event.date}</b><span>{event.label}</span></span>
              <div>
                <span className="t">{event.title}</span>
                <span className="m">{event.meta}</span>
              </div>
            </div>
          ))
        ) : (
          <p className="later-empty">{LATER.noEvents}</p>
        )}
        {staleEvents.map((source) => (
          <StaleNote
            key={source.id}
            time={sincePhrase(source.lastSyncedAt!, payload.now)}
            text={LATER.staleNote(source.label, sincePhrase(source.lastSyncedAt!, payload.now))}
            onRefresh={() => onSyncSources([source.id])}
          />
        ))}
      </section>
      <section id="later-projects" aria-labelledby="pj-title">
        <div className="card-head">
          <h2 id="pj-title">{LATER.projects}</h2>
          <TextLink href="#/work?tab=projects">{LATER.projectsLink}</TextLink>
        </div>
        {projectsFailed ? (
          <HalfFailed onRetry={onRetry} />
        ) : projects.length ? (
          projects.map((project) => {
            const external = !!project.href && !project.href.startsWith("#");
            const body = (
              <>
                <div className="pj-top">
                  <span className="t">{project.name}</span>
                  <span className="pct">{project.pr ? LATER.pr : project.pct !== undefined ? `${Math.round(project.pct)}%` : ""}</span>
                </div>
                {!project.pr && project.pct !== undefined ? (
                  <div className="bar" aria-hidden="true">
                    <i style={{ width: `${Math.max(0, Math.min(100, project.pct))}%`, "--c": projectColorVar(project.color) } as CSSProperties} />
                  </div>
                ) : null}
                <span className="m">{project.pr ? project.next : LATER.next(project.next)}</span>
              </>
            );
            return project.href ? (
              <a
                className="pj-row"
                key={project.name}
                href={project.href}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {body}
              </a>
            ) : (
              <div className="pj-row" key={project.name}>{body}</div>
            );
          })
        ) : (
          <p className="later-empty">
            {LATER.noProjects} <a className="link accent" href="#/work?tab=projects">{LATER.addProject}</a>
          </p>
        )}
      </section>
    </section>
  );
}

function HalfFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="later-empty later-failed">
      {LATER.failed}
      <Button variant="ghost" size="sm" icon={RotateCw} onClick={onRetry}>{LATER.retry}</Button>
    </p>
  );
}
