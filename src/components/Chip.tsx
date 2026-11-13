/**
 * Filter chips (SPEC-ux §9 Chip): `.chips` › `.chip[aria-pressed] .mono`,
 * `.chip.is-error` (dashed, Unplug icon, no count, `title=` the reason).
 * ChipGroup is single-select: a second click on the pressed chip returns to
 * `allValue` (SPEC-ux §4.3 "a second click returns to 全部").
 */
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../lib/cx";
import { Icon, Unplug } from "./Icon";
import "./Chip.css";

export interface ChipProps extends Omit<ComponentPropsWithRef<"button">, "children"> {
  pressed: boolean;
  label: ReactNode;
  count?: number;
  /** A disconnected source: dashed, Unplug icon, no count; `errorTitle` explains why. */
  error?: boolean;
  errorTitle?: string;
}

export function Chip({ pressed, label, count, error, errorTitle, className, ...rest }: ChipProps) {
  return (
    <button type="button" className={cx("chip", error && "is-error", className)} aria-pressed={pressed} title={error ? errorTitle : rest.title} {...rest}>
      {error ? <Icon icon={Unplug} size="sm" /> : null}
      {label}
      {!error && count !== undefined ? <span className="mono">{count}</span> : null}
    </button>
  );
}

export interface ChipOption<V extends string> {
  value: V;
  label: ReactNode;
  count?: number;
  error?: boolean;
  errorTitle?: string;
}

export interface ChipGroupProps<V extends string> {
  /** zh aria-label for the group, e.g. 「依來源篩選」. */
  label: string;
  options: ChipOption<V>[];
  value: V;
  allValue: V;
  onChange: (value: V) => void;
  className?: string;
}

/** The value after clicking `clicked` while `current` is selected. */
export function nextChipValue<V extends string>(current: V, clicked: V, allValue: V): V {
  return clicked === current && clicked !== allValue ? allValue : clicked;
}

export function scrollFocusedChipIntoView(
  row: Pick<HTMLElement, "scrollWidth" | "clientWidth">,
  target: { scrollIntoView(options: ScrollIntoViewOptions): void },
) {
  if (row.scrollWidth <= row.clientWidth) return;
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function ChipGroup<V extends string>({ label, options, value, allValue, onChange, className }: ChipGroupProps<V>) {
  return (
    <div
      className={cx("chips", className)}
      role="group"
      aria-label={label}
      onFocus={(event) => scrollFocusedChipIntoView(event.currentTarget, event.target as HTMLElement)}
    >
      {options.map((option) => (
        <Chip
          key={option.value}
          pressed={option.value === value}
          label={option.label}
          count={option.count}
          error={option.error}
          errorTitle={option.errorTitle}
          onClick={() => onChange(nextChipValue(value, option.value, allValue))}
        />
      ))}
    </div>
  );
}
