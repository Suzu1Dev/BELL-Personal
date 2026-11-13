/**
 * Settings form controls built from the capture-field tokens:
 * `.field` › `label`, control, `.field-hint`, `.field-error`; `.input`,
 * `.textarea`, `.select`, and `.switch[role=switch][aria-checked]`.
 * Field wires `id`, `aria-describedby` and `aria-invalid` for its child.
 */
import { cloneElement, isValidElement, useId, type ComponentPropsWithRef, type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx";
import "./Field.css";

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** A zh sentence that says what is wrong and how to fix it. */
  error?: ReactNode;
  /** One control: <TextInput>, <Textarea> or <Select>. */
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control = isValidElement(children)
    ? cloneElement(children, { id: children.props.id ?? id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })
    : children;
  return (
    <div className={cx("field", error ? "has-error" : undefined, className)}>
      <label htmlFor={children.props.id ?? id}>{label}</label>
      {control}
      {hint ? <p className="field-hint kp" id={hintId}>{hint}</p> : null}
      {error ? <p className="field-error kp" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

export function TextInput({ className, ...rest }: ComponentPropsWithRef<"input">) {
  return <input className={cx("input", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentPropsWithRef<"textarea">) {
  return <textarea className={cx("textarea", className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentPropsWithRef<"select">) {
  return (
    <span className="select-wrap">
      <select className={cx("select", className)} {...rest}>{children}</select>
    </span>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label text. */
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** An on/off setting row: label (+ hint) on the left, the switch on the right. */
export function Switch({ checked, onChange, label, hint, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cx("switch-row", className)}>
      <div className="switch-text">
        <label htmlFor={id}>{label}</label>
        {hint ? <p className="field-hint kp" id={`${id}-hint`}>{hint}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-describedby={hint ? `${id}-hint` : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" />
      </button>
    </div>
  );
}
