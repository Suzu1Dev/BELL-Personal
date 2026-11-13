/**
 * The cleared queue (SPEC-ux §4.3 "Cleared state", state 02): a solid
 * `.empty-state` with a static confetti tile, 「今天的 N 件事都處理完了。」,
 * how they were handled, and — when habits remain — one-tap chips, so the
 * page never claims everything is done while habits are left.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import type { HandledKind, TodayHabit, TodayPayload } from "../../../shared/today";
import { CELEBRATION, HABITS, QUEUE } from "../../copy/today";
import { Check, Flame, Icon } from "../../components/Icon";
import { habitsLeft } from "./today-view";

/** Five 7px squares in module colours around the tile (static: nothing animates). */
const CONFETTI: { left: number; top: number; color: string; turn: string }[] = [
  { left: 8, top: 18, color: "var(--m-mail)", turn: "18deg" },
  { left: 24, top: 54, color: "var(--m-idea)", turn: "-24deg" },
  { left: 110, top: 12, color: "var(--m-event)", turn: "40deg" },
  { left: 118, top: 50, color: "var(--m-cal)", turn: "-12deg" },
  { left: 66, top: 2, color: "var(--m-habit)", turn: "28deg" },
];

const STAT_ORDER: HandledKind[] = ["reply", "done", "snooze", "calendar"];

export function Celebration({ payload, onToggleHabit, focusOnMount }: { payload: TodayPayload; onToggleHabit: (habit: TodayHabit) => void; focusOnMount?: boolean }) {
  const left = habitsLeft(payload.habits);
  const { counts } = payload;
  // The last row's title left with it: focus lands on the cleared state, so Z or Tab go on from here.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (focusOnMount && (!active || active === document.body || !active.isConnected)) heading.current?.focus({ preventScroll: true });
    // Only when the state appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section className="card queue is-cleared" aria-label={QUEUE.title}>
      <div className="q-cleared">
        <div className="empty-state solid" role="status">
          <div className="e-art" aria-hidden="true">
            {CONFETTI.map((piece) => (
              <i key={`${piece.left}-${piece.top}`} style={{ left: piece.left, top: piece.top, "--c": piece.color, "--r": piece.turn } as CSSProperties} />
            ))}
            <span className="tile54 t-ok"><Icon icon={Check} /></span>
          </div>
          <h3 className="kp" ref={heading} tabIndex={-1}>{CELEBRATION.title(counts.total)}</h3>
          <dl className="e-stats" aria-label={CELEBRATION.statsLabel}>
            {STAT_ORDER.map((kind) => (
              <div key={kind}>
                <dt className="sr-only">{CELEBRATION.stats[kind]}</dt>
                <dd><b>{counts.handledBy[kind]}</b><span aria-hidden="true">{CELEBRATION.stats[kind]}</span></dd>
              </div>
            ))}
          </dl>
          {left.length ? (
            <div className="left-habits">
              <span>{CELEBRATION.habitsLeft(left.length)}</span>
              {left.map((habit) => (
                <span className="hchip" key={habit.id}>
                  <button
                    className="hcheck"
                    type="button"
                    aria-pressed={false}
                    aria-label={HABITS.checkLabel(habit.name, false)}
                    onClick={() => onToggleHabit(habit)}
                  >
                    <Icon icon={Check} />
                  </button>
                  {habit.short || habit.name}
                  <span className="h-streak" aria-label={HABITS.streakLabel(habit.streak, habit.streakUnit)}>
                    <Icon icon={Flame} />
                    {habit.streak}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
