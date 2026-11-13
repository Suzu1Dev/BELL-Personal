/**
 * HabitsCard (SPEC-ux §4.7, §9): ≥1081 a card with the weekday header,
 * 32px round checks, seven dots and the streak; ≤1080 the same markup
 * becomes three 44px one-tap chips (CSS only), plus 「+N」 for the rest.
 * Keys 1–9 toggle habits in order. Habits never count in the queue total.
 */
import type { TodayHabit, TodayPayload } from "../../../shared/today";
import { HABITS, WIDGET_UNAVAILABLE } from "../../copy/today";
import { Button } from "../../components/Button";
import { CardHead } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Check, Flame, Icon, Plus } from "../../components/Icon";
import { Skeleton } from "../../components/Skeleton";
import { cx } from "../../lib/cx";
import { useSingleKeyShortcuts } from "../../lib/preferences";
import { useShortcuts } from "../../lib/shortcuts";
import { CHIP_HABITS, weekHeader } from "./today-view";
import "./HabitsCard.css";

export interface HabitsCardProps {
  payload: TodayPayload | undefined;
  onToggle: (habit: TodayHabit) => void;
  /** Keys 1–9 (off while another layer, e.g. the snooze popover, owns the keyboard). */
  keys?: boolean;
  /** The first load failed (no payload): a static line instead of the loading skeleton. */
  failed?: boolean;
}

const DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function HabitsCard({ payload, onToggle, keys = true, failed = false }: HabitsCardProps) {
  const habits = payload?.habits ?? [];
  const singleKeys = useSingleKeyShortcuts();
  useShortcuts(
    Object.fromEntries(DIGIT_KEYS.map((key, index) => [key, () => {
      const habit = habits[index];
      if (!habit) return false;
      onToggle(habit);
      return true;
    }])),
    keys && habits.length > 0,
  );

  if (!payload && failed) {
    return (
      <section className="card habits" aria-labelledby="hb-title">
        <CardHead title={HABITS.title} titleId="hb-title" icon={Flame} tone="habit" />
        <p className="widget-off kp">{WIDGET_UNAVAILABLE}</p>
      </section>
    );
  }

  if (!payload) {
    return (
      <section className="card habits" aria-labelledby="hb-title" aria-busy="true">
        <CardHead title={HABITS.title} titleId="hb-title" icon={Flame} tone="habit" />
        <div className="habit-list" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <div className="habit habit-skel" key={row}>
              <Skeleton className="hcheck-skel" />
              <div><Skeleton width="70%" /><Skeleton width="44%" className="h-cad-skel" /></div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (!habits.length) {
    return (
      <section className="card habits is-empty" aria-labelledby="hb-title">
        <CardHead title={HABITS.title} titleId="hb-title" icon={Flame} tone="habit" />
        <EmptyState icon={Flame} tone="habit" title={HABITS.emptyTitle} action={<Button variant="secondary" icon={Plus} href="#/habits">{HABITS.add}</Button>} />
        <a className="habit-add-chip" href="#/habits">{HABITS.addChip}</a>
      </section>
    );
  }

  const done = habits.filter((habit) => habit.doneToday).length;
  const max = Math.min(9, habits.length);
  const extra = habits.length - CHIP_HABITS;
  return (
    <section className="card habits" aria-labelledby="hb-title">
      <CardHead title={HABITS.title} titleId="hb-title" icon={Flame} tone="habit">
        <span className="count" aria-label={HABITS.doneLabel(done, habits.length)}>{done}/{habits.length}</span>
        {singleKeys ? (
          <span className="keys">
            {HABITS.keysBefore}
            <kbd>1</kbd>
            {max > 1 ? <>–<kbd>{max}</kbd></> : null}
            {HABITS.keysAfter}
          </span>
        ) : null}
      </CardHead>
      <div className={cx("habit-list", extra > 0 && "has-more")}>
        <div className="habit h-head" aria-hidden="true">
          <span />
          <span />
          <span className="h-days">
            {weekHeader(payload.date).map((day, index) => <span key={index} className={day.today ? "today" : undefined}>{day.label}</span>)}
          </span>
          <span />
        </div>
        {habits.map((habit, index) => (
          <div className={cx("habit", habit.doneToday && "is-done", index >= CHIP_HABITS && "is-extra")} key={habit.id}>
            <button
              className="hcheck"
              type="button"
              aria-pressed={habit.doneToday}
              aria-label={HABITS.checkLabel(habit.name, habit.doneToday, index < 9 && singleKeys ? index + 1 : undefined)}
              onClick={() => onToggle(habit)}
            >
              <Icon icon={Check} />
            </button>
            <div>
              <span className="h-name">{habit.name}</span>
              <span className="h-short" aria-hidden="true">{habit.short || habit.name}</span>
              <span className="h-cad">{habit.cadence}</span>
            </div>
            <div className="h-dots" aria-hidden="true">
              {habit.week.map((state, day) => (
                <i key={day} className={cx(state === "y" && "y", state === "rest" && "rest", day === habit.week.length - 1 && "t")} />
              ))}
            </div>
            <span className="h-streak" aria-label={HABITS.streakLabel(habit.streak, habit.streakUnit)}>
              <Icon icon={Flame} />
              {habit.streak}
            </span>
          </div>
        ))}
        {extra > 0 ? (
          <a className="habit habit-more" href="#/habits" aria-label={HABITS.moreLabel(extra)}>
            {HABITS.more(extra)}
          </a>
        ) : null}
      </div>
    </section>
  );
}
