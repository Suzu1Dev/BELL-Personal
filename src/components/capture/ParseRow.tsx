/**
 * The parse row under a capture (SPEC-ux §6.6 step 3, states.html 06):
 * `.parse-row` › `.seg` type control (待辦 · 行程 · 靈感) and `.tokchip`
 * token chips (date/time, length, place, tags). Clicking the date chip
 * edits it in place. Controls never take focus from the text field
 * (tabIndex -1, mousedown kept): keyboard users press Tab for the type.
 * A 行程 also gets 重複 → 每週一 × and an optional 直到 day (palette only: `onRepeat`).
 */
import { Repeat, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { EventRepeatInput } from "../../../shared/calendar";
import { CAPTURE_TYPE_ORDER, type CaptureParse } from "../../../shared/capture-parse";
import type { CaptureType } from "../../../shared/connect";
import { CAPTURE, CAPTURE_TYPE_LABELS, captureWeeklyLabel } from "../../copy/capture";
import { onboardingLocale } from "../../copy/onboarding";
import { cx } from "../../lib/cx";
import { isComposing } from "../../lib/keys";
import { CalendarClock, Clock, Icon } from "../Icon";
import { captureDuration, chipLabel, momentOf } from "./describe";
import "../SegmentedControl.css";
import "./ParseRow.css";

export interface ParseRowProps {
  parse: CaptureParse;
  timeZone: string;
  onType: (type: CaptureType) => void;
  onMoment: (day: string, time: string | null) => void;
  /** Offer the 重複 chip on a 行程: weekly (optionally until a day), or undefined for 不重複. Without it the row never shows one. */
  onRepeat?: (repeat: EventRepeatInput | undefined) => void;
  /** Hide the 「Tab 切換類型」 hint (touch). */
  hideHint?: boolean;
  className?: string;
}

const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

export function ParseRow({ parse, timeZone, onType, onMoment, onRepeat, hideHint, className }: ParseRowProps) {
  const moment = momentOf(parse, timeZone);
  const label = chipLabel(parse, timeZone);
  return (
    <div className={cx("parse-row", className)}>
      <div className="seg" role="group" aria-label={CAPTURE.typeGroup}>
        {CAPTURE_TYPE_ORDER.map((type) => (
          <button key={type} type="button" tabIndex={-1} aria-pressed={parse.type === type} onMouseDown={keepFocus} onClick={() => onType(type)}>
            {CAPTURE_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      {parse.type !== "idea" && moment && label ? <MomentChip label={label} day={moment.day} time={moment.time} onChange={onMoment} /> : null}
      {parse.type !== "idea" && parse.durationMinutes && !(parse.type === "event" && moment?.endTime) ? (
        <span className="tokchip"><Icon icon={Clock} size="xs" />{CAPTURE.chipDuration(captureDuration(parse.durationMinutes))}</span>
      ) : null}
      {parse.type === "event" && moment && onRepeat ? <RepeatChips repeat={parse.repeat} day={moment.day} onChange={onRepeat} /> : null}
      {parse.type === "event" && parse.location ? <span className="tokchip">{CAPTURE.chipLocation(parse.location)}</span> : null}
      {parse.tags.length ? <span className="tokchip is-tags">{CAPTURE.chipTags(parse.tags)}</span> : null}
      {hideHint ? null : <span className="parse-hint d-only">{CAPTURE.tabSwitch}</span>}
    </div>
  );
}

/** 重複 (off) → 每週一 × (on: click to turn off) and 直到 [date] (optional, empty = no end). */
function RepeatChips({ repeat, day, onChange }: { repeat: EventRepeatInput | undefined; day: string; onChange: (repeat: EventRepeatInput | undefined) => void }) {
  if (!repeat) {
    return (
      <button type="button" className="tokchip" tabIndex={-1} title={CAPTURE.repeatOffHint} onMouseDown={keepFocus} onClick={() => onChange({ freq: "weekly" })}>
        <Icon icon={Repeat} size="xs" />{CAPTURE.repeatOff}
      </button>
    );
  }
  const label = captureWeeklyLabel(day);
  return (
    <>
      <button type="button" className="tokchip is-on" tabIndex={-1} title={CAPTURE.repeatOnHint} aria-label={CAPTURE.repeatRemove(label)} onMouseDown={keepFocus} onClick={() => onChange(undefined)}>
        <Icon icon={Repeat} size="xs" />{label}<Icon icon={X} size="xs" />
      </button>
      <label className="tokchip is-editing">
        {CAPTURE.repeatUntil}
        <input
          type="date"
          aria-label={CAPTURE.repeatUntilLabel}
          min={day}
          value={repeat.until ?? ""}
          onChange={(event) => onChange({ freq: "weekly", ...(event.target.value ? { until: event.target.value } : {}) })}
        />
      </label>
    </>
  );
}

function MomentChip({ label, day, time, onChange }: { label: string; day: string; time?: string; onChange: (day: string, time: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!editing) return;
    wrapRef.current?.querySelector("input")?.focus();
    const close = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setEditing(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [editing]);

  if (!editing) {
    return (
      <button type="button" className="tokchip" tabIndex={-1} title={CAPTURE.chipEdit} aria-label={`${CAPTURE.chipEdit}${onboardingLocale() === "en" ? ": " : "："}${label}`} onMouseDown={keepFocus} onClick={() => setEditing(true)}>
        <Icon icon={CalendarClock} size="xs" />{label}
      </button>
    );
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
    }
  };
  return (
    <span ref={wrapRef} className={cx("tokchip", "is-editing")}>
      <Icon icon={CalendarClock} size="xs" />
      <input type="date" aria-label={CAPTURE.dateInputLabel} value={day} onKeyDown={onKeyDown} onChange={(event) => { if (event.target.value) onChange(event.target.value, time ?? null); }} />
      <input type="time" aria-label={CAPTURE.timeInputLabel} value={time ?? ""} onKeyDown={onKeyDown} onChange={(event) => onChange(day, event.target.value || null)} />
    </span>
  );
}
