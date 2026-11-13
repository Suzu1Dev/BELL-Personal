/**
 * One day in agenda grammar (SPEC-ux §4.8, at full width on #/calendar):
 * `.tl` › `.tl-now`, `.tl-row(.is-due .is-past .tl-gap)` › `.tl-time small`,
 * `.tl-bar`, `.tl-body b .soon span`, and `.gap-box` for free slots.
 */
import { Check, Pencil, Plus, Repeat, Sparkles, Trash2, Undo2, WandSparkles } from "lucide-react";
import { useState } from "react";
import type { CalendarItem, FreeSlot } from "../../../shared/calendar";
import { localTime } from "../../../shared/time";
import type { TodayGap, TodayHabit } from "../../../shared/today";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Spinner } from "../../components/Skeleton";
import { CALENDAR, CALENDAR_SHARED } from "../../copy/calendar";
import { cx } from "../../lib/cx";
import type { TimelineRow } from "./calendar-model";
import { isEditable, isRemovable } from "./event-editor";
import { RemoveMenu, type RemoveScope } from "./RemoveMenu";

export interface AgendaTimelineProps {
  rows: TimelineRow[];
  timeZone: string;
  /** The source is failing: rows dim (`.is-stale`, SPEC-ux state 04). */
  stale?: boolean;
  /** True when Google Calendar is connected with calendar.events write scope (enables two-way edit & delete). */
  googleCanWrite?: boolean;
  onSchedule?: (gap: TodayGap, slot: FreeSlot) => void;
  onAddInSlot?: (slot: FreeSlot) => void;
  /** Delete a local event. A weekly row first asks 只刪這一次 or 刪除整個每週行程 (`scope`). */
  onRemove?: (item: CalendarItem, scope?: RemoveScope) => void;
  /** 編輯行程: the editor of a local event that is not in Google Calendar opens under `anchor` (the pencil). */
  onEdit?: (item: CalendarItem, anchor: HTMLElement) => void;
  /** 整理 with AI on a local event the owner typed that is not in Google Calendar (SPEC-ux §6.6.1). */
  onTidy?: (item: CalendarItem) => void;
  /** Local event ids being tidied right now: the row shows 「整理中…」. */
  tidying?: (manualId: string) => boolean;
  /** 復原整理 on a local event a tidy rewrote (CalendarItem.tidied), while it is not in Google Calendar. */
  onRevert?: (item: CalendarItem) => void;
  onShowPast?: () => void;
  /** Today's habits: an ended event linked to one that is still open offers 打卡「運動」 (SPEC-ux §4.7). */
  habits?: TodayHabit[];
  onCheckIn?: (habit: TodayHabit) => void;
  /** Rows on other days than today never show 現在 or soon labels (the rows decide that). */
  compact?: boolean;
}

/** 「工程三館 EC115 · 林志明 · 結束後一鍵打卡「運動」」, with 要參加 / the feed for events from #/events. */
export function itemMeta(item: CalendarItem, past: boolean): string {
  const parts = [item.meta];
  if (item.going) parts.push(CALENDAR.going);
  if (item.kind === "event" && item.origin !== "google" && !item.meta.includes(item.sourceLabel)) parts.push(item.sourceLabel);
  if (item.habitLink && !past) parts.push(CALENDAR.habitAfter(item.habitLink));
  return parts.filter(Boolean).join(" · ");
}

/** The still-open habit an ended event checks in (健身 → 運動). */
function checkInHabit(item: CalendarItem, past: boolean, habits: TodayHabit[] | undefined): TodayHabit | undefined {
  if (!past || !item.habitLink || !habits) return undefined;
  const habit = habits.find((entry) => entry.id === item.habitId || entry.name === item.habitLink);
  return habit && !habit.doneToday ? habit : undefined;
}

export function AgendaTimeline({ rows, timeZone, stale, googleCanWrite = false, onSchedule, onAddInSlot, onRemove, onEdit, onTidy, tidying, onRevert, onShowPast, habits, onCheckIn, compact }: AgendaTimelineProps) {
  const [menu, setMenu] = useState<{ item: CalendarItem; anchor: HTMLElement } | null>(null);
  return (
    <div className={cx("tl", stale && "is-stale", compact && "is-compact")}>
      {rows.map((row) => {
        switch (row.type) {
          case "now":
            return (
              <div key={row.key} className="tl-now" role="note" aria-label={CALENDAR.nowAria(row.time)}>
                <span>{row.time}</span>
                <i data-label={CALENDAR.now} aria-hidden="true" />
              </div>
            );
          case "fold":
            return (
              <div key={row.key} className="tl-row tl-fold">
                <span />
                <span />
                <button type="button" className="tl-more" onClick={onShowPast}>{CALENDAR.pastFold(row.count)}</button>
              </div>
            );
          case "gap": {
            const start = localTime(timeZone, row.slot.start);
            const end = localTime(timeZone, row.slot.end);
            return (
              <div key={row.key} className="tl-row tl-gap">
                <div className="tl-time">{start}</div>
                <span className="tl-bar" aria-hidden="true" />
                <div className="gap-box">
                  <Icon icon={Sparkles} size="sm" />
                  <span><b>{CALENDAR.gapHours(row.hours)}</b>{row.match ? row.match.label : CALENDAR.gapRange(start, end)}</span>
                  {row.match ? (
                    <Button variant="secondary" size="sm" aria-label={CALENDAR.scheduleAria(row.match.label)} onClick={() => onSchedule?.(row.match!, row.slot)}>{CALENDAR.schedule}</Button>
                  ) : (
                    <Button variant="ghost" size="sm" icon={Plus} aria-label={CALENDAR.addInGapAria(start, end)} onClick={() => onAddInSlot?.(row.slot)}>{CALENDAR.addInGap}</Button>
                  )}
                </div>
              </div>
            );
          }
          case "item": {
            const { item } = row;
            const meta = itemMeta(item, row.past);
            const removable = isRemovable(item, googleCanWrite) && !!onRemove;
            const editable = isEditable(item, googleCanWrite) && !!onEdit;
            const busy = !!item.manualId && !!tidying?.(item.manualId);
            // A tidied event offers 復原整理 in the 整理 slot; 整理中… takes that slot too, so the row never grows.
            const revertable = !!item.manualId && !!item.tidied && !item.inGoogle && !!onRevert && !busy;
            const tidyable = !!item.manualId && !!item.typed && !item.inGoogle && !!onTidy && !busy && !revertable;
            const acts = removable || editable || tidyable || revertable || busy;
            const checkIn = onCheckIn ? checkInHabit(item, row.past, habits) : undefined;
            return (
              <div
                key={row.key}
                data-manual={item.manualId}
                className={cx("tl-row", item.kind === "due" && "is-due", row.past && "is-past", item.habitLink && "is-habit", item.going && "is-going", acts && "has-acts", checkIn && "is-checkin")}
              >
                <div className="tl-time">
                  {item.allDay ? CALENDAR.allDay : localTime(timeZone, item.start)}
                  {!item.allDay && item.kind === "event" && item.end && item.end !== item.start ? <small>{localTime(timeZone, item.end)}</small> : null}
                </div>
                <span className="tl-bar" aria-hidden="true" />
                <div className="tl-body">
                  <b>
                    {item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className="tl-link">{item.title}</a> : <span className="tl-title">{item.title}</span>}
                    {row.soon ? <span className="soon">{row.soon}</span> : null}
                  </b>
                  {meta ? <span>{item.repeat ? <Icon icon={Repeat} size="xs" className="tl-repeat" /> : null}{meta}</span> : null}
                  {checkIn ? (
                    <Button className="tl-checkin" variant="ghost" size="sm" icon={Check} onClick={() => onCheckIn?.(checkIn)}>
                      {CALENDAR.checkIn(item.habitLink!)}
                    </Button>
                  ) : null}
                </div>
                {acts ? (
                  <div className="tl-acts">
                    {busy ? <span className="ai-tag inline tidy-mark" role="status" aria-label={CALENDAR_SHARED.tidy.workingAria}><Spinner />{CALENDAR_SHARED.tidy.working}</span> : null}
                    {tidyable ? <Button variant="icon" size="sm" icon={WandSparkles} className="tl-tidy" aria-label={CALENDAR_SHARED.tidy.actionAria(item.title)} title={CALENDAR_SHARED.tidy.actionHint} onClick={() => onTidy?.(item)} /> : null}
                    {revertable ? <Button variant="icon" size="sm" icon={Undo2} className="tl-tidy" aria-label={CALENDAR_SHARED.tidy.revertAria(item.title)} title={CALENDAR_SHARED.tidy.revert} onClick={() => onRevert?.(item)} /> : null}
                    {editable ? <Button variant="icon" size="sm" icon={Pencil} className="tl-edit" data-edit aria-label={CALENDAR.editAria(item.title)} title={CALENDAR.edit} onClick={(event) => onEdit?.(item, event.currentTarget)} /> : null}
                    {removable ? (
                      <Button
                        variant="icon"
                        size="sm"
                        icon={Trash2}
                        className="tl-del"
                        aria-label={CALENDAR.removeAria(item.title)}
                        title={CALENDAR.remove}
                        {...(item.repeat ? { "aria-haspopup": "menu" as const, "aria-expanded": menu?.item.id === item.id } : {})}
                        onClick={(event) => (item.repeat ? setMenu({ item, anchor: event.currentTarget }) : onRemove?.(item))}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          }
        }
      })}
      {menu ? (
        <RemoveMenu
          title={menu.item.title}
          anchor={menu.anchor}
          onPick={(scope) => { setMenu(null); onRemove?.(menu.item, scope); }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
