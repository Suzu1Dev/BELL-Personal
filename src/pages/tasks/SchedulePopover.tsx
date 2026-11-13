/**
 * 排日期 (#/tasks): the quick way to give a todo with no due day its day.
 * 今天 · 明天 · 這週末 · 下週一 on keys 1–4 and 選日期… on 5, each with the day
 * it lands on. It is the snooze popover's sibling and shares its look and keys
 * (`.snooze-pop`, `snoozeKeyIntent`): a bottom sheet at ≤720, keys pressed
 * inside never reach the page shortcuts, Tab cycles inside it, Esc and an
 * outside press close it. The days are counted from the server's `today`.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { isDayKey, type DayKey } from "../../../shared/time";
import { Button } from "../../components/Button";
import { onboardingLocale } from "../../copy/onboarding";
import { TASKS } from "../../copy/tasks";
import { cx } from "../../lib/cx";
import { isTypingTarget } from "../../lib/keys";
import { snoozeKeyIntent } from "../today/SnoozePopover";
import { scheduleDateLabel, schedulePresets } from "./model";
import "../today/SnoozePopover.css";

export interface SchedulePopoverProps {
  /** The server's today; the presets count from it. */
  today: DayKey;
  timeZone: string;
  /** The row the popover belongs to. */
  anchor: HTMLElement | null;
  /** ≤720: a bottom sheet. */
  sheet: boolean;
  onPick: (day: DayKey) => void;
  onClose: () => void;
}

export function SchedulePopover({ today, timeZone, anchor, sheet, onPick, onClose }: SchedulePopoverProps) {
  const locale = onboardingLocale();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const presets = useMemo(() => schedulePresets(today, locale), [today, locale]);
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  // Transparent (not hidden) until placed, so the first option can take focus at once.
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  // Under the row's right edge (above when there is no room); the sheet is pinned by CSS.
  useLayoutEffect(() => {
    if (sheet) {
      setPosition({});
      return;
    }
    const place = () => {
      const popover = ref.current;
      if (!popover || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(16, Math.min(window.innerWidth - popover.offsetWidth - 16, rect.right - popover.offsetWidth - 12));
      const below = rect.bottom + 6;
      const top = below + popover.offsetHeight > window.innerHeight - 12 ? Math.max(12, rect.top - popover.offsetHeight - 6) : below;
      setPosition({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, sheet, picking]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".snooze-opt")?.focus();
  }, []);

  // While open the popover owns the keyboard: no key reaches the page shortcuts (a capturing window listener runs first).
  useEffect(() => {
    const popover = ref.current;
    if (!popover) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      const intent = snoozeKeyIntent(event);
      if (!intent) return;
      event.preventDefault();
      if (intent.type === "close") {
        if (picking && isTypingTarget(event.target)) setPicking(false);
        else onCloseRef.current();
      } else if (intent.type === "pick") {
        const preset = presets[intent.index];
        if (preset) onPickRef.current(preset.day);
      } else if (intent.type === "custom") {
        setPicking(true);
      } else if (intent.type === "tab") {
        const controls = Array.from(popover.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
        const index = controls.indexOf(document.activeElement as HTMLElement);
        controls[index < 0 ? (intent.delta > 0 ? 0 : controls.length - 1) : (index + intent.delta + controls.length) % controls.length]?.focus();
      } else {
        const buttons = Array.from(popover.querySelectorAll<HTMLButtonElement>(".snooze-opt"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + intent.delta + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [presets, picking]);

  // An outside press closes it; the sheet's scrim closes it on its own click, so that tap never lands on the page underneath.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest?.(".snooze-scrim")) return;
      if (ref.current && !ref.current.contains(target)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    if (picking) ref.current?.querySelector<HTMLInputElement>(".snooze-pick input")?.focus();
  }, [picking]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!isDayKey(value) || value < today) {
      setError(TASKS.schedule.pickInvalid);
      return;
    }
    onPick(value);
  };

  return createPortal(
    <>
      {sheet ? <div className="snooze-scrim" aria-hidden="true" onClick={() => onCloseRef.current()} /> : null}
      <div ref={ref} className={cx("snooze-pop", sheet && "is-sheet")} role="dialog" aria-modal="true" aria-labelledby={titleId} style={position}>
        <p className="snooze-head" id={titleId}>{TASKS.schedule.title}</p>
        <div className="snooze-opts">
          {presets.map((preset, index) => (
            <button key={preset.id} type="button" className="snooze-opt" onClick={() => onPick(preset.day)}>
              <span className="t">{preset.label}</span>
              <span className="m">{scheduleDateLabel(preset.day, timeZone, locale)}</span>
              <kbd>{index + 1}</kbd>
            </button>
          ))}
          <button type="button" className="snooze-opt" aria-expanded={picking} onClick={() => setPicking(true)}>
            <span className="t">{TASKS.schedule.pick}</span>
            <kbd>5</kbd>
          </button>
        </div>
        {picking ? (
          <form className="snooze-pick" onSubmit={submit} noValidate>
            <input
              className="input"
              type="date"
              aria-label={TASKS.schedule.pickLabel}
              min={today}
              value={value}
              onChange={(event) => { setValue(event.target.value); setError(undefined); }}
            />
            <Button variant="primary" size="sm" type="submit">{TASKS.schedule.pickSubmit}</Button>
            {error ? <p className="field-error" role="alert">{error}</p> : null}
          </form>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
