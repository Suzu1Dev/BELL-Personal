/**
 * TodayHero & TodayProgress:
 * - TodayHero sits flush at the top of #/today: date H1 + inline weather pill + AI/rule brief.
 * - TodayProgress sits directly below PersonalBotCard: segmented daily progress + next-up schedule link.
 * Every number comes from `payload.counts`.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { TodayPayload } from "../../../shared/today";
import { localTime } from "../../../shared/time";
import { relativeStart } from "../../../shared/today-format";
import { BRIEF, HERO, PROGRESS } from "../../copy/today";
import { AiTag } from "../../components/AiTag";
import { CalendarDays, ChevronRight, CloudRain, CloudSun, Icon, RefreshCw, TriangleAlert } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Skeleton, SkeletonStatus, Spinner } from "../../components/Skeleton";
import { TODAY_TZ, isRainy, rainTime } from "./today-view";
import "./TodayHero.css";

/** How long the hero waits for a generating brief before showing the rule brief (SPEC-ux §4.2). */
export const BRIEF_WAIT_MS = 8_000;

export interface TodayHeroProps {
  payload: TodayPayload | undefined;
  /** A 重新整理 job is running. */
  refreshing?: boolean;
  onRefreshBrief?: () => void;
  /** The first load failed (no payload): a static hero instead of the loading skeleton. */
  failed?: boolean;
}

export function TodayHero({ payload, refreshing = false, onRefreshBrief, failed = false }: TodayHeroProps) {
  if (!payload) return failed ? <HeroUnavailable /> : <HeroLoading />;
  return (
    <section className="today-hero" aria-labelledby="hero-title">
      <div className="hero-main">
        <div className="hero-topline">
          <HeroTitle payload={payload} />
          <Eyebrow payload={payload} />
        </div>
        <Brief brief={payload.brief} refreshing={refreshing} onRefresh={onRefreshBrief} />
      </div>
    </section>
  );
}

export interface TodayProgressProps {
  payload: TodayPayload | undefined;
  failed?: boolean;
}

export function TodayProgress({ payload, failed = false }: TodayProgressProps) {
  if (!payload) {
    if (failed) return null;
    return (
      <section className="card progress-wrap is-loading" aria-hidden="true">
        <div className="progress">
          <Skeleton width="36%" height={12} />
          <Skeleton className="prog-skel" height={6} radius={3} />
          <Skeleton width="52%" height={11} />
        </div>
      </section>
    );
  }
  const showProgress = payload.counts.total > 0;
  if (!showProgress && !payload.nextUp) return null;
  return (
    <section
      className={`card progress-wrap${showProgress && payload.nextUp ? " has-both" : ""}`}
      aria-label={PROGRESS.label}
    >
      {showProgress ? <Progress payload={payload} /> : null}
      {payload.nextUp ? <NextUp nextUp={payload.nextUp} now={payload.now} /> : null}
    </section>
  );
}

function Eyebrow({ payload }: { payload: TodayPayload }) {
  const weather = payload.weather;
  const rain = rainTime(weather);
  if (!weather && !rain) return null;
  return (
    <p className="eyebrow hero-wx-pill">
      {weather ? (
        <span className="wx">
          <Icon icon={isRainy(weather.text) ? CloudRain : CloudSun} size="sm" />
          {HERO.weather(weather.city, weather.tempC, weather.text)}
        </span>
      ) : null}
      {weather && rain ? <span className="sep" aria-hidden="true" /> : null}
      {rain ? (
        <span className="wx">
          <Icon icon={CloudRain} size="sm" className="rain" />
          {HERO.rain(rain.time, rain.pct)}
        </span>
      ) : null}
    </p>
  );
}

function HeroTitle({ payload }: { payload: TodayPayload }) {
  const parts = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", weekday: "long", timeZone: TODAY_TZ })
    .formatToParts(new Date(`${payload.date}T12:00:00+08:00`));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return <h1 id="hero-title" className="hero-title kp">{part("month")}月{part("day")}日 {part("weekday")}</h1>;
}

/** True while a brief is generating and the 8 s wait has not passed. */
function useBriefWait(state: TodayPayload["brief"]["state"]): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (state !== "generating") {
      setExpired(false);
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), BRIEF_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  return state === "generating" && !expired;
}

function Brief({ brief, refreshing, onRefresh }: { brief: TodayPayload["brief"]; refreshing: boolean; onRefresh?: () => void }) {
  const waiting = useBriefWait(brief.state);
  if (waiting) {
    return (
      <div className="brief-loading">
        <SkeletonStatus>{BRIEF.loading}</SkeletonStatus>
        <div className="skel-brief" aria-hidden="true"><Skeleton width="92%" /><Skeleton width="68%" /></div>
      </div>
    );
  }
  const ai = brief.source === "ai";
  const canRefresh = brief.state !== "off" && onRefresh;
  return (
    <>
      <p className="brief">
        <AiTag kind={ai ? "summary" : "rule"} title={ai && brief.generatedAt ? BRIEF.generatedAt(localTime(TODAY_TZ, brief.generatedAt)) : undefined} />
        <span className="kp">
          {brief.text}
          {canRefresh ? (
            <button
              className="brief-refresh"
              type="button"
              aria-label={refreshing ? BRIEF.refreshing : BRIEF.refresh}
              title={BRIEF.refresh}
              disabled={refreshing}
              onClick={onRefresh}
            >
              {refreshing ? <Spinner /> : <Icon icon={RefreshCw} size="sm" />}
            </button>
          ) : null}
        </span>
      </p>
      {brief.state === "fallback" && brief.reason && !brief.reason.endsWith("尚未登入") ? (
        <p className="fallback-note">
          <Icon icon={TriangleAlert} size="xs" />
          <span className="kp">{BRIEF.fallback(brief.reason)}</span>
          {onRefresh ? <button type="button" onClick={onRefresh} disabled={refreshing}>{BRIEF.retry}</button> : null}
          <span aria-hidden="true">·</span>
          <TextLink href="#/settings/brief" bare>{BRIEF.settings}</TextLink>
        </p>
      ) : null}
    </>
  );
}

const SEGMENT_LIMIT = 15;

function Progress({ payload }: { payload: TodayPayload }) {
  const { handled, total } = payload.counts;
  const previous = useRef(handled);
  const from = Math.min(previous.current, handled);
  useEffect(() => {
    previous.current = handled;
  }, [handled]);
  const aria = {
    role: "progressbar",
    "aria-labelledby": "prog-label",
    "aria-valuemin": 0,
    "aria-valuemax": total,
    "aria-valuenow": handled,
    "aria-valuetext": PROGRESS.valueText(handled, total),
  } as const;
  return (
    <div className="progress">
      <div className="prog-top">
        <span id="prog-label">{PROGRESS.label}</span>
        <b>{handled}<small> / {total}</small></b>
      </div>
      {total > SEGMENT_LIMIT ? (
        <div className="segs is-bar" {...aria}><i className="on" style={{ width: `${Math.round((handled / total) * 100)}%` }} /></div>
      ) : (
        <div className="segs" style={{ "--n": total } as CSSProperties} {...aria}>
          {Array.from({ length: total }, (_, index) => (
            <i
              key={index}
              className={index < handled ? "on" : undefined}
              style={index >= from && index < handled ? { transitionDelay: `${(index - from) * 30}ms` } : undefined}
            />
          ))}
        </div>
      )}
      <p className="prog-foot">
        <span>{PROGRESS.handled(handled)}</span>
        {payload.paceMinutes !== undefined && handled >= 3 ? (
          <span>{PROGRESS.paceBefore}<b>{PROGRESS.paceMinutes(payload.paceMinutes)}</b>{PROGRESS.paceAfter}</span>
        ) : null}
      </p>
    </div>
  );
}

function NextUp({ nextUp, now }: { nextUp: NonNullable<TodayPayload["nextUp"]>; now: string }) {
  const time = localTime(TODAY_TZ, nextUp.start);
  const relative = relativeStart(nextUp.start, new Date(now), TODAY_TZ).replace(` ${time}`, "");
  return (
    <a className="next-up" href="#/calendar" aria-label={PROGRESS.nextUpLabel(time, nextUp.title, relative)}>
      <span className="next-up-ico" aria-hidden="true">
        <Icon icon={CalendarDays} size="sm" />
      </span>
      <span className="next-up-main">
        <span className="mono">{time}</span>
        <b>{nextUp.title}</b>
      </span>
      <span className="in">{relative}</span>
      <Icon icon={ChevronRight} size="xs" className="chev" />
    </a>
  );
}

function HeroUnavailable() {
  return (
    <section className="today-hero is-unavailable" aria-labelledby="hero-title">
      <div className="hero-main">
        <h1 id="hero-title" className="sr-only">{HERO.unavailableLabel}</h1>
      </div>
    </section>
  );
}

function HeroLoading() {
  return (
    <section className="today-hero is-loading" aria-busy="true" aria-labelledby="hero-title">
      <div className="hero-main">
        <div className="hero-topline">
          <Skeleton className="hero-skel" width={220} height={28} radius={8} />
          <Skeleton width={132} height={24} radius={999} />
        </div>
        <h1 id="hero-title" className="sr-only">{HERO.loadingLabel}</h1>
        <div className="skel-brief" aria-hidden="true"><Skeleton width="84%" /><Skeleton width="58%" /></div>
      </div>
    </section>
  );
}
