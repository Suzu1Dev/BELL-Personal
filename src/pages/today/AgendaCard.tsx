/**
 * AgendaCard (SPEC-ux §4.8, §9): today's timeline with the 現在 line, past
 * rows faded (and folded beyond two), deadlines dashed, the one free-slot
 * suggestion with 排進, and habit-linked events that offer 打卡 once they
 * end. Error (state 04), stale and not-set-up states per SPEC-ux §5.
 */
import { Repeat } from "lucide-react";
import { useRef, useState } from "react";
import type { TodayAgendaItem, TodayGap, TodayHabit, TodayPayload } from "../../../shared/today";
import { localTime } from "../../../shared/time";
import { AGENDA, WIDGET_UNAVAILABLE } from "../../copy/today";
import { Button } from "../../components/Button";
import { CardHead } from "../../components/Card";
import { CalendarDays, Check, Icon, Plus, RotateCw, Sparkles } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { Skeleton } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { cx } from "../../lib/cx";
import { CALENDAR_SOURCE_IDS, TODAY_TZ, buildTimeline, hoursText, isBroken, sincePhrase } from "./today-view";
import "./AgendaCard.css";

export interface AgendaCardProps {
  payload: TodayPayload | undefined;
  /** 新增行程: opens the quick-add flow (the empty card's primary action). */
  onAdd: () => void;
  onSchedule: (gap: TodayGap) => void;
  onToggleHabit: (habit: TodayHabit) => void;
  onSyncSources: (ids: string[]) => void;
  /** The first load failed (no payload): a static line instead of the loading skeleton. */
  failed?: boolean;
}

export function AgendaCard({ payload, onAdd, onSchedule, onToggleHabit, onSyncSources, failed = false }: AgendaCardProps) {
  const [showPast, setShowPast] = useState(false);
  const card = useRef<HTMLElement>(null);
  const head = (count?: number) => (
    <CardHead
      title={AGENDA.title}
      titleId="tl-title"
      icon={CalendarDays}
      tone="cal"
      count={count}
      countLabel={count === undefined ? undefined : AGENDA.countLabel(count)}
      link={{ href: "#/calendar", label: AGENDA.link }}
    />
  );

  if (!payload && failed) {
    return (
      <section className="card agenda" aria-labelledby="tl-title">
        {head()}
        <p className="widget-off kp">{WIDGET_UNAVAILABLE}</p>
      </section>
    );
  }

  if (!payload) {
    return (
      <section className="card agenda" aria-labelledby="tl-title" aria-busy="true">
        {head()}
        <div className="tl tl-skel" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <div className="tl-row" key={row}>
              <Skeleton height={28} />
              <span className="tl-bar" />
              <div className="tl-body"><Skeleton width="62%" /><Skeleton width="40%" /></div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const calendars = payload.sources.filter((source) => CALENDAR_SOURCE_IDS.includes(source.id));
  const broken = calendars.find(isBroken);
  const stale = calendars.find((source) => source.state === "stale" && source.lastSyncedAt);
  const setUp = calendars.some((source) => source.state !== "off");
  const items = payload.agenda.items;
  const events = items.filter((item) => item.kind === "event").length;
  const checkInFor = (item: TodayAgendaItem) => habitFor(item, payload.habits);
  const rows = buildTimeline(payload.agenda, payload.now, showPast, undefined, (item) => !!(item.past && checkInFor(item)));
  const lastSync = (broken ?? stale)?.lastSyncedAt;

  return (
    <section className="card agenda" aria-labelledby="tl-title" ref={card} tabIndex={-1}>
      {head(items.length ? events : undefined)}
      {broken ? (
        <Notice
          tone="error"
          title={AGENDA.errorTitle}
          actions={broken.state === "reconnect"
            ? <Button variant="secondary" size="sm" href="#/settings/sources">{AGENDA.reconnect}</Button>
            : <Button variant="secondary" size="sm" icon={RotateCw} onClick={() => onSyncSources([broken.id])}>{AGENDA.retry}</Button>}
        >
          {broken.state === "reconnect" ? AGENDA.errorReconnect : AGENDA.errorFailed}
        </Notice>
      ) : null}
      {!items.length ? (
        !setUp && !broken ? (
          <div className="tl-setup">
            <p className="kp">{AGENDA.notSetUp}</p>
            <div className="tl-setup-acts">
              <Button variant="primary" size="sm" icon={Plus} onClick={onAdd}>{AGENDA.add}</Button>
              <TextLink href="#/settings/sources">{AGENDA.connectGoogle}</TextLink>
            </div>
          </div>
        ) : (
          <p className="tl-empty kp">{AGENDA.empty}</p>
        )
      ) : (
        <div className={cx("tl", broken && "is-stale")}>
          {rows.map((row, index) => {
            switch (row.type) {
              case "now":
                return (
                  <div className="tl-now" role="note" aria-label={AGENDA.nowLabel(row.time)} key="now">
                    <span>{row.time}</span>
                    <i><span className="tl-now-label" aria-hidden="true">{AGENDA.now}</span></i>
                  </div>
                );
              case "fold":
                return (
                  <button className="tl-fold" type="button" key="fold" onClick={() => setShowPast(true)}>
                    {AGENDA.pastFold(row.count)}
                  </button>
                );
              case "gap":
                // The slot leaves with 排進; focus stays on the card instead of falling to the page.
                return <GapRow key="gap" gap={row.gap} onSchedule={(gap) => { onSchedule(gap); card.current?.focus({ preventScroll: true }); }} />;
              default:
                return <AgendaRow key={`${row.item.start}-${row.item.title}-${index}`} item={row.item} soon={row.soon} habits={payload.habits} onToggleHabit={onToggleHabit} />;
            }
          })}
        </div>
      )}
      {lastSync ? (
        <StaleNote time={sincePhrase(lastSync, payload.now)} onRefresh={() => onSyncSources(calendars.filter((source) => source.state !== "off").map((source) => source.id))} />
      ) : null}
    </section>
  );
}

/**
 * The 「每週一」 of a weekly event's meta (the server ends a weekly row's meta
 * with it: 「工程三館 EC115 · 林志明 · 每週一」), or undefined for a one-off.
 */
export function weeklyRepeat(meta: string): string | undefined {
  const last = meta.split(" · ").at(-1)?.trim();
  return last && /^每週[一二三四五六日]$/.test(last) ? last : undefined;
}

/** The not-yet-done habit an agenda event checks in (健身 → 運動), if any. */
function habitFor(item: TodayAgendaItem, habits: TodayHabit[]): TodayHabit | undefined {
  if (!item.habitLink) return undefined;
  const habit = habits.find((entry) => entry.id === item.habitId || entry.name === item.habitLink);
  return habit && !habit.doneToday ? habit : undefined;
}

function AgendaRow({ item, soon, habits, onToggleHabit }: { item: TodayAgendaItem; soon?: string; habits: TodayHabit[]; onToggleHabit: (habit: TodayHabit) => void }) {
  const habit = habitFor(item, habits);
  const due = item.kind === "due";
  const checkIn = item.past ? habit : undefined;
  const habitDone = !!item.habitLink && habits.some((entry) => (entry.id === item.habitId || entry.name === item.habitLink) && entry.doneToday);
  const meta = [item.meta, item.habitLink && !item.past && !habitDone ? AGENDA.checkInLater(item.habitLink) : ""].filter(Boolean).join(" · ");
  // A weekly row gets the calendar's repeat mark in front of its meta; the icon is decorative, the label is read.
  const repeat = weeklyRepeat(item.meta);
  return (
    <div className={cx("tl-row", due && "is-due", item.past && "is-past", checkIn && "is-checkin")}>
      <div className="tl-time">
        {item.allDay ? AGENDA.allDay : localTime(TODAY_TZ, item.start)}
        {item.end && !item.allDay && !due ? <small>{localTime(TODAY_TZ, item.end)}</small> : null}
      </div>
      <span className={cx("tl-bar", item.habitLink && "is-habit")} />
      <div className="tl-body">
        <b>{item.title}{soon ? <span className="soon">{soon}</span> : null}</b>
        {meta ? (
          <span>
            {repeat ? <><Icon icon={Repeat} size="xs" className="tl-repeat" /><span className="sr-only">{AGENDA.repeatLabel}</span></> : null}
            {meta}
          </span>
        ) : null}
        {checkIn ? (
          <Button className="tl-checkin" variant="ghost" size="sm" icon={Check} onClick={() => onToggleHabit(checkIn)}>
            {AGENDA.checkIn(item.habitLink!)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function GapRow({ gap, onSchedule }: { gap: TodayGap; onSchedule: (gap: TodayGap) => void }) {
  return (
    <div className="tl-row tl-gap">
      <div className="tl-time">{localTime(TODAY_TZ, gap.start)}</div>
      <span className="tl-bar" />
      <div className="gap-box">
        <Icon icon={Sparkles} size="sm" />
        <span><b>{AGENDA.gapTitle(hoursText(gap.hours))}</b>{gap.label}</span>
        <Button variant="secondary" size="sm" onClick={() => onSchedule(gap)}>{AGENDA.schedule}</Button>
      </div>
    </div>
  );
}

