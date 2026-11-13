/**
 * The snooze popover (SPEC-ux §6.4, §9 `.snooze-pop`): 今晚 20:00 · 明天
 * 08:00 · 週六 09:00 · 下週一 08:00 · 選擇時間… on keys 1–5. Options past the
 * row's snoozeLimit (deadline − 2 h) are disabled with 「會超過截止時間」.
 * A bottom sheet at ≤720. Keys pressed inside never reach the page
 * shortcuts, and Tab cycles inside it (focus cannot wander off and leave
 * the page's keys dead while it is open); Esc and an outside click close
 * it. Shared by the Today queue and the #/inbox reading pane.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { SNOOZE } from "../../copy/today";
import { Button } from "../../components/Button";
import { isComposing, isTypingTarget, type KeyEventLike } from "../../lib/keys";
import { cx } from "../../lib/cx";
import { customSnooze, snoozeOptions, toLocalInput, type SnoozeOption } from "./today-view";
import "./SnoozePopover.css";

export type SnoozeKeyIntent =
  | { type: "pick"; index: number }
  | { type: "custom" }
  | { type: "close" }
  | { type: "move"; delta: number }
  | { type: "tab"; delta: number };

/** What a key does inside the popover; nothing while an IME is composing or while typing in the time field (except Esc and Tab). */
export function snoozeKeyIntent(event: KeyEventLike): SnoozeKeyIntent | null {
  if (isComposing(event)) return null;
  if (event.key === "Escape" || event.key === "Esc") return { type: "close" };
  if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) return { type: "tab", delta: event.shiftKey ? -1 : 1 };
  if (isTypingTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) return null;
  if (/^[1-4]$/.test(event.key)) return { type: "pick", index: Number(event.key) - 1 };
  if (event.key === "5") return { type: "custom" };
  if (event.key === "ArrowDown") return { type: "move", delta: 1 };
  if (event.key === "ArrowUp") return { type: "move", delta: -1 };
  return null;
}

export interface SnoozePopoverProps {
  /** The row's latest allowed time (deadline − 2 h); later options are disabled. */
  snoozeLimit?: string;
  /** The payload's now (the options are relative to it). */
  now: string;
  /** The row the popover belongs to. */
  anchor: HTMLElement | null;
  /** ≤720: a bottom sheet. */
  sheet: boolean;
  onPick: (until: string, label: string) => void;
  onClose: () => void;
}

export function SnoozePopover({ snoozeLimit, now, anchor, sheet, onPick, onClose }: SnoozePopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const options = useMemo(() => snoozeOptions(now, snoozeLimit), [now, snoozeLimit]);
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  // Transparent (not hidden) until placed, so the first option can take focus at once.
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const pick = (option: SnoozeOption | undefined) => {
    if (!option || option.disabled) return;
    onPick(option.until, option.label);
  };

  // Place it under the row's right edge (or above when there is no room); the sheet is pinned by CSS.
  useLayoutEffect(() => {
    if (sheet) {
      setPosition({});
      return;
    }
    const place = () => {
      const popover = ref.current;
      if (!popover || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = popover.offsetWidth;
      const height = popover.offsetHeight;
      const left = Math.max(16, Math.min(window.innerWidth - width - 16, rect.right - width - 12));
      const below = rect.bottom + 6;
      const top = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 6) : below;
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

  // Focus the first option that can be chosen.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".snooze-opt:not(:disabled)")?.focus();
  }, []);

  // While open the popover owns the keyboard: 1–5, arrows and Esc act here, and no key reaches
  // the page shortcuts (a capturing window listener runs before the global one).
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
        const option = options[intent.index];
        if (option && !option.disabled) onPick(option.until, option.label);
      } else if (intent.type === "custom") {
        setPicking(true);
      } else if (intent.type === "tab") {
        // Tab wraps from the last control to the first (and back with Shift).
        const controls = Array.from(popover.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
        const index = controls.indexOf(document.activeElement as HTMLElement);
        const next = index < 0 ? (intent.delta > 0 ? 0 : controls.length - 1) : (index + intent.delta + controls.length) % controls.length;
        controls[next]?.focus();
      } else {
        const buttons = Array.from(popover.querySelectorAll<HTMLButtonElement>(".snooze-opt:not(:disabled)"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + intent.delta + buttons.length) % buttons.length]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [options, onPick, picking]);

  // An outside press closes the popover; the sheet's scrim closes it on its own click, so the
  // tap that dismisses it never lands on the page underneath.
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
    const result = customSnooze(value, now, snoozeLimit);
    if ("error" in result) {
      setError(result.error === "limit" ? SNOOZE.tooLate : result.error === "past" ? SNOOZE.past : SNOOZE.pickInvalid);
      return;
    }
    onPick(result.until, result.label);
  };

  const minimum = toLocalInput(now);
  const maximum = snoozeLimit ? toLocalInput(snoozeLimit) : undefined;

  const body = (
    <>
      {sheet ? <div className="snooze-scrim" aria-hidden="true" onClick={() => onCloseRef.current()} /> : null}
      <div
        ref={ref}
        className={cx("snooze-pop", sheet && "is-sheet")}
        role="dialog"
        aria-labelledby={titleId}
        style={position}
      >
        <p className="snooze-head" id={titleId}>{SNOOZE.title}</p>
        <div className="snooze-opts">
          {options.map((option, index) => (
            <button key={option.id} type="button" className="snooze-opt" disabled={!!option.disabled} onClick={() => pick(option)}>
              <span className="t">{option.label}</span>
              {option.disabled === "limit" ? <span className="m">{SNOOZE.tooLate}</span> : null}
              <kbd>{index + 1}</kbd>
            </button>
          ))}
          <button type="button" className="snooze-opt" aria-expanded={picking} onClick={() => setPicking(true)}>
            <span className="t">{SNOOZE.pick}</span>
            <kbd>5</kbd>
          </button>
        </div>
        {picking ? (
          <form className="snooze-pick" onSubmit={submit} noValidate>
            <input
              className="input"
              type="datetime-local"
              aria-label={SNOOZE.pickLabel}
              min={minimum}
              max={maximum}
              value={value}
              onChange={(event) => { setValue(event.target.value); setError(undefined); }}
            />
            <Button variant="primary" size="sm" type="submit">{SNOOZE.pickSubmit}</Button>
            {error ? <p className="field-error" role="alert">{error}</p> : null}
          </form>
        ) : null}
      </div>
    </>
  );
  return createPortal(body, document.body);
}
