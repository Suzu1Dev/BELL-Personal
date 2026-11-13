/**
 * Optimistic checkbox (SPEC-ux §9 "Not in the mockup": `.checkbox`, 18px,
 * --r-xs, 2px --border-strong; checked = accent fill + Check). The tick shows
 * at once; when `onChange` returns a promise that rejects, it flips back.
 * Callers show the undo toast (e.g. 「已完成「繳電費」」 [復原]).
 */
import { useEffect, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { Check, Icon } from "./Icon";
import "./Checkbox.css";

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void | Promise<unknown>;
  /** Visible label; omit and pass `ariaLabel` for a bare box. */
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, ariaLabel, disabled, className }: CheckboxProps) {
  const [shown, setShown] = useState(checked);
  useEffect(() => setShown(checked), [checked]);

  const toggle = () => {
    if (disabled) return;
    const next = !shown;
    setShown(next);
    const result = onChange(next);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).catch(() => setShown(!next));
    }
  };

  const box = (
    <button
      type="button"
      role="checkbox"
      className={cx("checkbox", className)}
      aria-checked={shown}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      onClick={toggle}
    >
      <Icon icon={Check} />
    </button>
  );

  if (!label) return box;
  return (
    // A <label> around the button forwards clicks on the text to it and names it.
    <label className="checkbox-field">
      {box}
      <span>{label}</span>
    </label>
  );
}
