/**
 * One habit on #/habits (SPEC-ux §3.3, §4.7, §11): the 32px `.hcheck`
 * toggle, name and cadence, the 5-week heat strip (7 columns × 5 weeks of
 * 12px dots, the current week last), the streak, and the ⋯ menu.
 *
 * Each day the server lets you change (heatCellAction) is a toggle button
 * around its dot: pressing it checks that day in or takes the check-in
 * back, today's through the same toggle as `.hcheck`. The strip is one tab
 * stop; the arrow keys, Home and End move between its days. The automatic
 * habit's strip stays a picture.
 */
import { useState, type KeyboardEvent } from "react";
import { Archive, ArrowDown, ArrowUp, CalendarCheck, CalendarX, Pencil, Trash2, Unplug } from "lucide-react";
import type { HabitHeatCell, HabitSummary } from "../../../shared/habits";
import { Check, Flame, Icon } from "../../components/Icon";
import { HABIT_MENU, HABIT_MODEL, HABITS } from "../../copy/habits";
import { cx } from "../../lib/cx";
import { HabitMenu, type HabitMenuItem } from "./HabitMenu";
import { doneYesterday, habitCadence, habitStreakUnit, heatCellAction, heatDone, heatFocusTarget, shortDay } from "./model";

export interface HabitRowActions {
  toggle: () => void;
  edit: () => void;
  move: (delta: -1 | 1) => void;
  backfill: (done: boolean) => void;
  /** A past day in the heat strip: check it in (true) or take the check-in back. */
  setDay: (day: string, done: boolean) => void;
  archive: () => void;
  remove: () => void;
  autoOff: () => void;
}

function cellTitle(cell: HabitHeatCell): string | undefined {
  if (cell.state === "off") return undefined;
  const state = cell.state === "y" ? HABITS.legendDone : cell.state === "n" ? HABITS.legendMissed : HABITS.legendRest;
  return HABIT_MODEL.cellTitle(shortDay(cell.day), state);
}

const dotClass = (cell: HabitHeatCell, today: string) => cx(cell.state !== "n" && cell.state, cell.day === today && "t");

function HeatStrip({ habit, today, actions }: { habit: HabitSummary; today: string; actions: HabitRowActions }) {
  const pressable = (cell: HabitHeatCell) => heatCellAction(cell, today, habit.auto) !== undefined;
  const days = habit.heat.filter(pressable).map((cell) => cell.day);
  const [focused, setFocused] = useState<string>();
  // One tab stop: the day last moved to, else today, else the latest day that can be pressed.
  const active = focused && days.includes(focused) ? focused : days.includes(today) ? today : days.at(-1);

  if (habit.auto || !days.length) {
    return (
      <div className="h-heat" role="img" aria-label={HABITS.heatLabel(heatDone(habit))}>
        {habit.heat.map((cell) => <i key={cell.day} className={dotClass(cell, today)} title={cellTitle(cell)} />)}
      </div>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = heatFocusTarget(habit.heat, pressable, active, event.key);
    if (target === undefined) return;
    // The strip's own keys: the page's ↑ ↓ shortcuts and scrolling do not see them.
    event.preventDefault();
    event.stopPropagation();
    setFocused(target);
    event.currentTarget.querySelector<HTMLButtonElement>(`button[data-day="${target}"]`)?.focus();
  };

  const press = (cell: HabitHeatCell) => {
    setFocused(cell.day);
    if (cell.day === today) actions.toggle();
    else actions.setDay(cell.day, heatCellAction(cell, today, false) === "check");
  };

  return (
    <div className="h-heat" role="group" aria-label={HABITS.heatGroupLabel(habit.name, heatDone(habit))} onKeyDown={onKeyDown}>
      {habit.heat.map((cell) => (pressable(cell) ? (
        <button
          key={cell.day}
          type="button"
          data-day={cell.day}
          tabIndex={cell.day === active ? 0 : -1}
          aria-pressed={cell.state === "y"}
          aria-label={HABITS.heatCellLabel(shortDay(cell.day), { today: cell.day === today, rest: cell.state === "rest" })}
          title={cellTitle(cell)}
          onClick={() => press(cell)}
        >
          <i className={dotClass(cell, today)} />
        </button>
      ) : (
        <i key={cell.day} className={dotClass(cell, today)} aria-hidden="true" />
      )))}
    </div>
  );
}

export function HabitRow({ habit, index, count, today, actions }: {
  habit: HabitSummary;
  index: number;
  count: number;
  today: string;
  actions: HabitRowActions;
}) {
  const key = index < 9 ? index + 1 : undefined;
  const items: HabitMenuItem[] = [
    { id: "edit", label: HABIT_MENU.edit, icon: Pencil, onSelect: actions.edit },
    { id: "up", label: HABIT_MENU.moveUp, icon: ArrowUp, onSelect: () => actions.move(-1), disabled: index === 0 },
    { id: "down", label: HABIT_MENU.moveDown, icon: ArrowDown, onSelect: () => actions.move(1), disabled: index === count - 1 },
    ...(habit.auto ? [
      { id: "auto-off", label: HABIT_MENU.autoOff, icon: Unplug, onSelect: actions.autoOff },
    ] : [
      doneYesterday(habit)
        ? { id: "unbackfill", label: HABIT_MENU.unbackfill, icon: CalendarX, onSelect: () => actions.backfill(false) }
        : { id: "backfill", label: HABIT_MENU.backfill, icon: CalendarCheck, onSelect: () => actions.backfill(true) },
      { id: "archive", label: HABIT_MENU.archive, icon: Archive, onSelect: actions.archive },
      { id: "delete", label: HABIT_MENU.delete, icon: Trash2, onSelect: actions.remove, danger: true },
    ]),
  ];

  return (
    <li className={cx("habit", habit.doneToday && "is-done", habit.auto && "is-auto")}>
      {habit.auto ? (
        <span className="hcheck" role="img" aria-label={HABITS.autoCheckLabel(habit.name, habit.doneToday)} data-pressed={habit.doneToday}>
          <Icon icon={Check} />
        </span>
      ) : (
        <button type="button" className="hcheck" aria-pressed={habit.doneToday} aria-label={HABITS.checkLabel(habit.name, habit.doneToday, key)} onClick={actions.toggle}>
          <Icon icon={Check} />
        </button>
      )}
      <div className="h-main">
        <span className="h-name">{habit.name}</span>
        <span className="h-cad">{habitCadence(habit)}</span>
      </div>
      <HeatStrip habit={habit} today={today} actions={actions} />
      <span className="h-streak" aria-label={HABITS.streakLabel(habit.streak, habitStreakUnit(habit))}>
        <Icon icon={Flame} />
        <span aria-hidden="true">{habit.streak}</span>
        <small aria-hidden="true">{habitStreakUnit(habit)}</small>
      </span>
      <HabitMenu label={HABIT_MENU.open(habit.name)} items={items} />
    </li>
  );
}
