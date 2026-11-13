/**
 * SegmentedControl (SPEC-ux §9 `.seg`, reused from the palette parse row):
 * `.seg[role=group]` › `button[aria-pressed]`. Used for 日 / 週, the capture
 * type (待辦 · 行程 · 靈感) and the theme choice.
 */
import { cx } from "../lib/cx";
import "./SegmentedControl.css";

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string> {
  /** zh aria-label for the group, e.g. 「類型」. */
  label: string;
  options: SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  className?: string;
}

export function SegmentedControl<V extends string>({ label, options, value, onChange, className }: SegmentedControlProps<V>) {
  return (
    <div className={cx("seg", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}
