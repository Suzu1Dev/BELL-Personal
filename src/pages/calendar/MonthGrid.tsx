/**
 * Architectural 7-column Month Matrix + Selected-Day Inspector (#/calendar?view=month):
 * - Desktop / Tablet (≥ 760px): 7-column full-week grid aligned to weekStartsMonday,
 *   showing up to 3 semantic event pills per day (+N overflow), 1-click `+` day creation,
 *   and our 100% opaque WeekHoverCardView tooltip on pill hover.
 * - Mobile (< 760px): compact tap-to-select date cells with semantic colored dots
 *   and zero horizontal scroll.
 * - Selected-Day Inspector: renders the full AgendaTimeline (events, free slots,
 *   排進, inline edit/delete, habit check-ins) for the selected day right below the matrix.
 */
import { ArrowUpRight, Plus, Repeat } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CalendarDay, CalendarItem, FreeSlot } from "../../../shared/calendar";
import { localTime, type DayKey } from "../../../shared/time";
import type { TodayGap, TodayHabit } from "../../../shared/today";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { CALENDAR, CALENDAR_MODEL } from "../../copy/calendar";
import { cx } from "../../lib/cx";
import { AgendaTimeline, type AgendaTimelineProps } from "./AgendaTimeline";
import { dayTitle, isPast, timelineRows } from "./calendar-model";
import { isEditable } from "./event-editor";
import type { RemoveScope } from "./RemoveMenu";
import { buildHoverCardModel, computeHoverPosition, WeekHoverCardView } from "./WeekGrid";

const MAX_VISIBLE_PILLS = 3;

export interface MonthGridProps {
  days: CalendarDay[];
  /** DayKey inside the active month (determines which days are outside-month). */
  anchorDay: DayKey;
  selectedDay: DayKey;
  today: DayKey;
  timeZone: string;
  now: number;
  stale?: boolean;
  googleCanWrite?: boolean;
  gap?: TodayGap;
  habits?: TodayHabit[];
  onSelectDay: (day: DayKey) => void;
  onOpenDay: (day: DayKey) => void;
  onCreateOnDay?: (day: DayKey, anchor: HTMLElement) => void;
  onSchedule?: (gap: TodayGap, slot: FreeSlot) => void;
  onAddInSlot?: (day: DayKey, slot: FreeSlot) => void;
  onEdit?: (item: CalendarItem, anchor: HTMLElement) => void;
  onRemove?: (item: CalendarItem, scope?: RemoveScope) => void;
  onCheckIn?: (habit: TodayHabit) => void;
  tidyProps?: Pick<AgendaTimelineProps, "onTidy" | "tidying" | "onRevert">;
}

interface HoveredPill {
  item: CalendarItem;
  day: DayKey;
  anchor: HTMLElement;
}

export function MonthGrid({
  days,
  anchorDay,
  selectedDay,
  today,
  timeZone,
  now,
  stale,
  googleCanWrite = false,
  gap,
  habits,
  onSelectDay,
  onOpenDay,
  onCreateOnDay,
  onSchedule,
  onAddInSlot,
  onEdit,
  onRemove,
  onCheckIn,
  tidyProps,
}: MonthGridProps) {
  const activeMonth = anchorDay.slice(0, 7);
  const inspectorRef = useRef<HTMLElement>(null);
  const [showPast, setShowPast] = useState(false);

  const [hovered, setHovered] = useState<HoveredPill | null>(null);
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

  const weekdays = days.slice(0, 7).map((entry) => ({
    key: entry.day,
    label: CALENDAR_MODEL.weekday(entry.day),
  }));

  const selectedEntry = days.find((entry) => entry.day === selectedDay) ?? days.find((entry) => entry.day === today) ?? days[0];
  const selectedRows = selectedEntry
    ? timelineRows({
        day: selectedEntry.day,
        today,
        items: selectedEntry.items,
        free: selectedEntry.free,
        now,
        timeZone,
        gap: selectedEntry.day === today ? gap : undefined,
        showPast,
      })
    : [];
  const selectedEventsCount = selectedEntry ? selectedEntry.items.filter((item) => item.kind === "event").length : 0;

  return (
    <div className={cx("mo-wrap", stale && "is-stale")}>
      <div className="mo" role="group" aria-label={CALENDAR.monthGridLabel}>
        <div className="mo-weekdays" aria-hidden="true">
          {weekdays.map((wd) => (
            <span key={wd.key} className="mo-wd">{wd.label}</span>
          ))}
        </div>

        <div className="mo-grid">
          {days.map(({ day, items }, index) => {
            const outside = day.slice(0, 7) !== activeMonth;
            const isToday = day === today;
            const isSelected = day === selectedDay;
            const [, monthNum, dateNum] = day.split("-").map(Number);
            const dateText = dateNum === 1 || index === 0 ? `${monthNum}/${dateNum}` : String(dateNum);
            const visible = items.slice(0, MAX_VISIBLE_PILLS);
            const overflowCount = Math.max(0, items.length - MAX_VISIBLE_PILLS);

            return (
              <div
                key={day}
                className={cx(
                  "mo-cell",
                  outside && "is-outside",
                  isToday && "is-today",
                  isSelected && "is-selected",
                )}
                onClick={() => onSelectDay(day)}
              >
                <div className="mo-cell-head">
                  <button
                    type="button"
                    className="mo-date-btn mono"
                    aria-label={CALENDAR.selectDayAria(dayTitle(day), items.length)}
                    aria-pressed={isSelected}
                    aria-current={isToday ? "date" : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDay(day);
                    }}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      onOpenDay(day);
                    }}
                  >
                    {dateText}
                  </button>
                  {onCreateOnDay ? (
                    <button
                      type="button"
                      className="mo-cell-add"
                      aria-label={CALENDAR.addOnDayAria(dayTitle(day))}
                      title={CALENDAR.addOnDayAria(dayTitle(day))}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectDay(day);
                        onCreateOnDay(day, event.currentTarget);
                      }}
                    >
                      <Icon icon={Plus} size="xs" />
                    </button>
                  ) : null}
                </div>

                {/* Desktop / Tablet: up to 3 semantic pills + overflow badge */}
                <div className="mo-pills">
                  {visible.map((item) => {
                    const past = isPast(item, now);
                    const editable = isEditable(item, googleCanWrite) && !!onEdit;
                    const activeHover = hovered?.item.id === item.id && hovered.day === day;
                    const pillClass = cx(
                      "mo-pill",
                      item.allDay && "is-allday",
                      item.kind === "due" && "is-due",
                      item.habitLink && "is-habit",
                      item.going && "is-going",
                      past && "is-past",
                      editable && "is-edit",
                      activeHover && "is-hovered",
                    );
                    const content = (
                      <>
                        {!item.allDay ? (
                          <span className="mo-pill-time mono">
                            {item.repeat ? <Icon icon={Repeat} size="xs" className="mo-repeat" /> : null}
                            {localTime(timeZone, item.start)}
                          </span>
                        ) : item.repeat ? (
                          <Icon icon={Repeat} size="xs" className="mo-repeat" />
                        ) : null}
                        <b className="mo-pill-title">{item.title}</b>
                      </>
                    );

                    if (editable) {
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={pillClass}
                          aria-label={CALENDAR.editAria(item.title)}
                          data-manual={item.manualId}
                          data-edit
                          {...hoverHandlers(item, day)}
                          onClick={(event) => {
                            event.stopPropagation();
                            dismissHover();
                            onSelectDay(day);
                            onEdit!(item, event.currentTarget);
                          }}
                        >
                          {content}
                        </button>
                      );
                    }

                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={pillClass}
                        {...hoverHandlers(item, day)}
                        onClick={(event) => {
                          event.stopPropagation();
                          dismissHover();
                          onSelectDay(day);
                        }}
                      >
                        {content}
                      </button>
                    );
                  })}

                  {overflowCount > 0 ? (
                    <button
                      type="button"
                      className="mo-more"
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectDay(day);
                        inspectorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                      }}
                    >
                      {CALENDAR.moreCount(overflowCount)}
                    </button>
                  ) : null}
                </div>

                {/* Mobile (< 760px): crisp semantic dots without horizontal overflow */}
                {items.length > 0 ? (
                  <div className="mo-dots" aria-hidden="true">
                    {items.slice(0, 4).map((item) => (
                      <span
                        key={item.id}
                        className={cx(
                          "mo-dot",
                          item.kind === "due" && "is-due",
                          item.habitLink && "is-habit",
                          item.going && "is-going",
                        )}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {selectedEntry ? (
        <section ref={inspectorRef} className="mo-inspector" aria-label={dayTitle(selectedEntry.day)}>
          <div className="mo-inspector-head">
            <div className="mo-inspector-title">
              <h3>{dayTitle(selectedEntry.day)}</h3>
              {selectedEntry.day === today ? <span className="cal-todaymark">{CALENDAR.todayMark}</span> : null}
              <span className="mo-inspector-count">{CALENDAR.countLabel(selectedEventsCount)}</span>
            </div>
            <div className="mo-inspector-acts">
              <Button variant="ghost" size="sm" icon={ArrowUpRight} onClick={() => onOpenDay(selectedEntry.day)}>
                {CALENDAR.openDayTimeline}
              </Button>
              {onCreateOnDay ? (
                <Button variant="secondary" size="sm" icon={Plus} onClick={(event) => onCreateOnDay(selectedEntry.day, event.currentTarget)}>
                  {CALENDAR.add}
                </Button>
              ) : null}
            </div>
          </div>

          {selectedEntry.items.length > 0 ? (
            <AgendaTimeline
              rows={selectedRows}
              timeZone={timeZone}
              stale={stale}
              googleCanWrite={googleCanWrite}
              onSchedule={onSchedule}
              onAddInSlot={onAddInSlot ? (slot) => onAddInSlot(selectedEntry.day, slot) : undefined}
              onRemove={onRemove}
              onEdit={onEdit}
              {...tidyProps}
              onShowPast={() => setShowPast(true)}
              habits={selectedEntry.day === today ? habits : undefined}
              onCheckIn={onCheckIn}
            />
          ) : (
            <p className="cal-empty kp">
              {selectedEntry.day === today ? CALENDAR.emptyToday : CALENDAR.emptyDay}
            </p>
          )}
        </section>
      ) : null}

      {portal}
    </div>
  );
}
