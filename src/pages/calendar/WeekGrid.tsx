/**
 * The 7-column week (SPEC-ux §3.3 行事曆, ≥ 980px): day headers that open
 * the day view, an all-day row, an hour scale and timed events placed by
 * time (overlaps side by side), deadlines as dashed markers, the 現在 line
 * in today's column, and a floating hover info card so truncated side-by-side
 * events reveal their full title, schedule, location and details on hover.
 */
import { Clock, ExternalLink, Flame, MapPin, Pencil, Repeat } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { type CalendarDay, type CalendarItem } from "../../../shared/calendar";
import { localTime, type DayKey } from "../../../shared/time";
import { Icon } from "../../components/Icon";
import { CALENDAR, CALENDAR_MODEL } from "../../copy/calendar";
import { onboardingLocale } from "../../copy/onboarding";
import { cx } from "../../lib/cx";
import { dayShort, dayTitle, hourRange, nowOffset, weekBlocks } from "./calendar-model";
import { isEditable } from "./event-editor";

const HOUR_PX = 44;
const HOVER_CARD_WIDTH = 344;

export interface WeekGridProps {
  days: CalendarDay[];
  today: DayKey;
  timeZone: string;
  now: number;
  stale?: boolean;
  googleCanWrite?: boolean;
  onOpenDay: (day: DayKey) => void;
  /** 編輯行程: a click on an editable block opens its editor under the block. */
  onEdit?: (item: CalendarItem, anchor: HTMLElement) => void;
}

export interface WeekHoverCardModel {
  title: string;
  tone: "cal" | "habit" | "going" | "due";
  source: string;
  weekly?: string;
  goingBadge?: string;
  when: string;
  duration?: string;
  location?: string;
  details?: string;
  habitNote?: string;
  actionHint?: "edit" | "link";
  actionText?: string;
}

const px = (minutes: number) => `${(minutes / 60) * HOUR_PX}px`;

function blockStyle(top: number, height: number, lane: number, lanes: number): CSSProperties {
  return { top: px(top), height: px(height), left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` };
}

/** 「10:10 作業系統 · 每週一」: the accessible fallback tooltip of a block. */
function eventLabel(item: CalendarItem, timeZone: string): string {
  const time = localTime(timeZone, item.start);
  return item.repeat
    ? CALENDAR_MODEL.weekEventTooltip.weekly(time, item.title, CALENDAR_MODEL.weeklyLabel(item.repeat.day))
    : CALENDAR_MODEL.weekEventTooltip.oneOff(time, item.title);
}

function formatDuration(startIso: string, endIso: string | undefined, en: boolean): string | undefined {
  if (!endIso) return undefined;
  const mins = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
  if (!Number.isFinite(mins) || mins <= 0 || mins >= 24 * 60) return undefined;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (en) {
    if (h && m) return `${h}h ${m}m`;
    return h ? `${h}h` : `${m}m`;
  }
  if (h && m) return `${h} 小時 ${m} 分`;
  return h ? `${h} 小時` : `${m} 分鐘`;
}

export function buildHoverCardModel(
  item: CalendarItem,
  day: DayKey,
  timeZone: string,
  editable: boolean,
): WeekHoverCardModel {
  const en = onboardingLocale() === "en";
  const tone: WeekHoverCardModel["tone"] = item.kind === "due"
    ? "due"
    : item.habitLink
      ? "habit"
      : item.going
        ? "going"
        : "cal";

  const weekly = item.repeat ? CALENDAR_MODEL.weeklyLabel(item.repeat.day) : undefined;
  const dateLabel = dayTitle(day);
  const when = item.allDay
    ? `${dateLabel} · ${CALENDAR.allDayLabel}`
    : item.kind === "due"
      ? `${dateLabel} · ${localTime(timeZone, item.start)}`
      : `${dateLabel} · ${localTime(timeZone, item.start)}${item.end ? `–${localTime(timeZone, item.end)}` : ""}`;

  const duration = !item.allDay && item.kind !== "due" ? formatDuration(item.start, item.end, en) : undefined;
  const location = item.location?.trim() || undefined;
  const skipTokens = new Set([item.sourceLabel, weekly, location].filter(Boolean));
  const detailParts = item.meta
    .split(" · ")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !skipTokens.has(part));
  const details = detailParts.length > 0 ? detailParts.join(" · ") : undefined;

  const source = item.kind === "due"
    ? (en ? `Deadline · ${item.sourceLabel}` : `截止 · ${item.sourceLabel}`)
    : item.sourceLabel;

  const goingBadge = item.going ? (en ? "Going" : "要參加") : undefined;
  const habitNote = item.habitLink ? CALENDAR.habitAfter(item.habitLink) : undefined;
  const actionHint = editable ? "edit" : item.url ? "link" : undefined;
  const actionText = editable
    ? (en ? "Click block to edit event" : "點擊方塊即可編輯行程")
    : item.url
      ? (en ? "Click block to open link" : "點擊方塊開啟活動頁面")
      : undefined;

  return {
    title: item.title,
    tone,
    source,
    ...(weekly ? { weekly } : {}),
    ...(goingBadge ? { goingBadge } : {}),
    when,
    ...(duration ? { duration } : {}),
    ...(location ? { location } : {}),
    ...(details ? { details } : {}),
    ...(habitNote ? { habitNote } : {}),
    ...(actionHint ? { actionHint } : {}),
    ...(actionText ? { actionText } : {}),
  };
}

export function WeekHoverCardView({
  model,
  style,
}: {
  model: WeekHoverCardModel;
  style?: CSSProperties;
}) {
  return (
    <div className={cx("wk-hover-card", `is-${model.tone}`)} role="tooltip" style={style}>
      <div className="wk-hover-kicker">
        <span className="wk-hover-dot" aria-hidden="true" />
        <span className="wk-hover-source">{model.source}</span>
        {model.goingBadge ? <span className="wk-hover-pill is-going">{model.goingBadge}</span> : null}
        {model.weekly ? (
          <span className="wk-hover-pill">
            <Icon icon={Repeat} size="xs" />
            {model.weekly}
          </span>
        ) : null}
      </div>

      <strong className="wk-hover-title kp">{model.title}</strong>

      <div className="wk-hover-rows">
        <div className="wk-hover-row">
          <Icon icon={Clock} size="xs" />
          <span className="mono">{model.when}</span>
          {model.duration ? <span className="wk-hover-dur">{model.duration}</span> : null}
        </div>
        {model.location ? (
          <div className="wk-hover-row">
            <Icon icon={MapPin} size="xs" />
            <span>{model.location}</span>
          </div>
        ) : null}
        {model.details ? (
          <p className="wk-hover-details kp">{model.details}</p>
        ) : null}
        {model.habitNote ? (
          <div className="wk-hover-row is-habit">
            <Icon icon={Flame} size="xs" />
            <span>{model.habitNote}</span>
          </div>
        ) : null}
      </div>

      {model.actionText ? (
        <div className="wk-hover-foot">
          <Icon icon={model.actionHint === "edit" ? Pencil : ExternalLink} size="xs" />
          <span>{model.actionText}</span>
        </div>
      ) : null}
    </div>
  );
}

interface HoveredBlock {
  item: CalendarItem;
  day: DayKey;
  anchor: HTMLElement;
}

export function computeHoverPosition(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 10;

  let left = rect.right + gap;
  if (left + HOVER_CARD_WIDTH > vw - 14) {
    left = rect.left - gap - HOVER_CARD_WIDTH;
  }
  if (left < 14) {
    left = Math.max(14, Math.min(rect.left, vw - HOVER_CARD_WIDTH - 14));
  }

  const estimatedHeight = 164;
  const top = Math.max(14, Math.min(rect.top - 4, vh - estimatedHeight - 14));
  return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` };
}

export function WeekGrid({ days, today, timeZone, now, stale, googleCanWrite = false, onOpenDay, onEdit }: WeekGridProps) {
  const range = hourRange(days, timeZone);
  const hours = Array.from({ length: range.end - range.start }, (_, index) => range.start + index);
  const allDay = days.map((day) => day.items.filter((item) => item.allDay));
  const hasAllDay = allDay.some((items) => items.length > 0);
  const height = (range.end - range.start) * HOUR_PX;

  const [hovered, setHovered] = useState<HoveredBlock | null>(null);
  const enterTimerRef = useRef<number | null>(null);
  const leaveTimerRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (enterTimerRef.current !== null) {
      window.clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
  }, []);

  const dismissHover = useCallback(() => {
    clearTimers();
    setHovered(null);
  }, [clearTimers]);

  const scheduleShow = useCallback((item: CalendarItem, day: DayKey, anchor: HTMLElement, immediate = false) => {
    clearTimers();
    if (immediate || hovered !== null) {
      setHovered({ item, day, anchor });
      return;
    }
    enterTimerRef.current = window.setTimeout(() => {
      enterTimerRef.current = null;
      setHovered({ item, day, anchor });
    }, 65);
  }, [clearTimers, hovered]);

  const scheduleHide = useCallback(() => {
    clearTimers();
    leaveTimerRef.current = window.setTimeout(() => {
      leaveTimerRef.current = null;
      setHovered(null);
    }, 80);
  }, [clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (!hovered) return;
    const onScrollOrKey = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      dismissHover();
    };
    window.addEventListener("scroll", onScrollOrKey, true);
    window.addEventListener("resize", dismissHover);
    window.addEventListener("keydown", onScrollOrKey);
    return () => {
      window.removeEventListener("scroll", onScrollOrKey, true);
      window.removeEventListener("resize", dismissHover);
      window.removeEventListener("keydown", onScrollOrKey);
    };
  }, [hovered, dismissHover]);

  const hoverHandlers = (item: CalendarItem, day: DayKey) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      scheduleShow(item, day, event.currentTarget);
    },
    onPointerLeave: () => scheduleHide(),
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      if (event.currentTarget.matches(":focus-visible")) {
        scheduleShow(item, day, event.currentTarget, true);
      }
    },
    onBlur: () => dismissHover(),
  });

  const portal = hovered && typeof document !== "undefined" && hovered.anchor.isConnected
    ? createPortal(
        <WeekHoverCardView
          model={buildHoverCardModel(hovered.item, hovered.day, timeZone, Boolean(onEdit && isEditable(hovered.item, googleCanWrite)))}
          style={computeHoverPosition(hovered.anchor)}
        />,
        document.body,
      )
    : null;

  return (
    <div className={cx("wk", stale && "is-stale")} role="group" aria-label={CALENDAR.weekGridLabel}>
      <div className="wk-head">
        <span className="wk-corner" />
        {days.map(({ day }) => (
          <button
            key={day}
            type="button"
            className={cx("wk-day", day === today && "is-today", day < today && "is-before")}
            aria-label={CALENDAR.openDay(dayTitle(day))}
            aria-current={day === today ? "date" : undefined}
            onClick={() => onOpenDay(day)}
          >
            <span className="wk-wd">{CALENDAR_MODEL.weekday(day)}</span>
            <b className="mono">{dayShort(day)}</b>
          </button>
        ))}
      </div>

      {hasAllDay ? (
        <div className="wk-allday">
          <span className="wk-label">{CALENDAR.allDayLabel}</span>
          {allDay.map((items, index) => {
            const day = days[index].day;
            return (
              <div key={day} className="wk-cell">
                {items.map((item) => {
                  const activeHover = hovered?.item.id === item.id;
                  return isEditable(item, googleCanWrite) && onEdit ? (
                    <button
                      key={item.id}
                      type="button"
                      className={cx("wk-chip is-edit", item.going && "is-going")}
                      title={activeHover ? undefined : item.title}
                      aria-label={CALENDAR.editAria(item.title)}
                      data-manual={item.manualId}
                      data-edit
                      {...hoverHandlers(item, day)}
                      onClick={(event) => {
                        dismissHover();
                        onEdit(item, event.currentTarget);
                      }}
                    >
                      {item.repeat ? <Icon icon={Repeat} size="xs" className="wk-repeat" /> : null}{item.title}
                    </button>
                  ) : (
                    <span
                      key={item.id}
                      className={cx("wk-chip", item.going && "is-going")}
                      title={activeHover ? undefined : item.title}
                      {...hoverHandlers(item, day)}
                    >
                      {item.title}
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="wk-body" style={{ height: `${height}px` }}>
        <div className="wk-hours" aria-hidden="true">
          {hours.map((hour) => (
            <span key={hour} style={{ top: px((hour - range.start) * 60) }}>{`${String(hour).padStart(2, "0")}:00`}</span>
          ))}
        </div>
        {days.map(({ day, items }) => {
          const blocks = weekBlocks(day, items, timeZone, range.start, range.end, now);
          const nowAt = day === today ? nowOffset(day, timeZone, range.start, range.end, now) : undefined;
          return (
            <div key={day} className={cx("wk-col", day === today && "is-today")} style={{ "--hour": `${HOUR_PX}px` } as CSSProperties}>
              {blocks.map(({ item, top, height: size, lane, lanes, past }) => {
                const activeHover = hovered?.item.id === item.id;
                const className = cx(
                  "wk-ev",
                  item.kind === "due" && "is-due",
                  past && "is-past",
                  item.habitLink && "is-habit",
                  item.going && "is-going",
                  size < 40 && "is-short",
                  activeHover && "is-hovered",
                );
                const clock = item.kind === "due" ? localTime(timeZone, item.start) : `${localTime(timeZone, item.start)}${item.end ? `–${localTime(timeZone, item.end)}` : ""}`;
                const content = (
                  <>
                    <b>{item.title}</b>
                    <span className="mono">{item.repeat ? <Icon icon={Repeat} size="xs" className="wk-repeat" /> : null}{clock}</span>
                  </>
                );
                const style = blockStyle(top, size, lane, lanes);
                const fallbackTitle = activeHover ? undefined : eventLabel(item, timeZone);

                if (isEditable(item, googleCanWrite) && onEdit) {
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cx(className, "is-edit")}
                      style={style}
                      title={fallbackTitle}
                      aria-label={CALENDAR.editBlockAria(localTime(timeZone, item.start), item.title, item.repeat ? CALENDAR_MODEL.weeklyLabel(item.repeat.day) : "")}
                      data-manual={item.manualId}
                      data-edit
                      {...hoverHandlers(item, day)}
                      onClick={(event) => {
                        dismissHover();
                        onEdit(item, event.currentTarget);
                      }}
                    >
                      {content}
                    </button>
                  );
                }
                return item.url ? (
                  <a
                    key={item.id}
                    className={className}
                    style={style}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={fallbackTitle}
                    {...hoverHandlers(item, day)}
                    onClick={() => dismissHover()}
                  >
                    {content}
                  </a>
                ) : (
                  <div
                    key={item.id}
                    className={className}
                    style={style}
                    title={fallbackTitle}
                    {...hoverHandlers(item, day)}
                  >
                    {content}
                  </div>
                );
              })}
              {nowAt !== undefined ? <i className="wk-now" style={{ top: px(nowAt) }} role="note" aria-label={CALENDAR.nowAria(localTime(timeZone, now))} /> : null}
            </div>
          );
        })}
      </div>
      {portal}
    </div>
  );
}
