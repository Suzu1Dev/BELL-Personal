/**
 * Dialog: always the native <dialog> opened with showModal() (focus trap,
 * inert background and Esc for free). `--r-lg`, `--shadow-modal`,
 * `::backdrop{background:var(--scrim);backdrop-filter:blur(5px)}`, and a
 * localized close button (with an optional custom `closeLabel`). Esc while an
 * IME is composing only cancels the composition.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { onboardingCopy } from "../copy/onboarding";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { X } from "./Icon";
import "./Dialog.css";

const defaultCloseLabel = () => onboardingCopy().dialog.close;
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Footer buttons; destructive actions name both outcomes. */
  footer?: ReactNode;
  className?: string;
  closeLabel?: string;
  /** Element to focus first (defaults to the first focusable in the body). */
  initialFocus?: () => HTMLElement | null | undefined;
}

/** Keeps a native dialog's open state in step with `open` and reports native closes (Esc, form method=dialog). */
export function useNativeDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const composing = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      if (composing.current) event.preventDefault();
    };
    const onNativeClose = () => onCloseRef.current();
    const onCompositionStart = () => { composing.current = true; };
    const onCompositionEnd = () => { composing.current = false; };
    dialog.addEventListener("cancel", onCancel);
    dialog.addEventListener("close", onNativeClose);
    dialog.addEventListener("compositionstart", onCompositionStart);
    dialog.addEventListener("compositionend", onCompositionEnd);
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      dialog.removeEventListener("close", onNativeClose);
      dialog.removeEventListener("compositionstart", onCompositionStart);
      dialog.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  return ref;
}

export function Dialog({ open, onClose, title, children, footer, className, closeLabel, initialFocus }: DialogProps) {
  const ref = useNativeDialog(open, onClose);
  const titleId = useId();
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (open) initialFocusRef.current?.()?.focus();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx("dialog", className)}
      aria-labelledby={titleId}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <Button variant="icon" icon={X} aria-label={closeLabel ?? defaultCloseLabel()} onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
