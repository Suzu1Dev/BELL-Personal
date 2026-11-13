/**
 * The one button API (SPEC-ux §9 Button): `.btn` + `.btn-primary | -secondary
 * | -ghost | -danger | -icon` + `.btn-sm`, with an optional leading icon and a
 * trailing <kbd> hint. Pass `href` to render a link that looks like a button.
 * Icon-only buttons (`variant="icon"`) must carry a zh `aria-label`.
 */
import type { ComponentPropsWithRef, ReactNode } from "react";
import { cx } from "../lib/cx";
import { useSingleKeyShortcuts } from "../lib/preferences";
import { visibleKeyHint } from "../lib/shortcuts";
import { Icon, type IconType } from "./Icon";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";

interface ButtonLookProps {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: IconType;
  /** Shortcut hint rendered as <kbd> after the label (hidden on touch rows by their own CSS). */
  kbd?: string;
  children?: ReactNode;
}

export type ButtonProps = ButtonLookProps & ComponentPropsWithRef<"button"> & { href?: undefined };
export type ButtonLinkProps = ButtonLookProps & ComponentPropsWithRef<"a"> & {
  href: string;
  /** Opens in a new tab with rel="noopener noreferrer". */
  external?: boolean;
};

export function buttonClass(variant: ButtonVariant = "secondary", size: "md" | "sm" = "md", className?: string): string {
  return cx("btn", `btn-${variant}`, size === "sm" && "btn-sm", className);
}

function Content({ icon, kbd, children, size }: ButtonLookProps) {
  // A single-key hint (E, S, N…) only while 單鍵快捷鍵 is on: hints never advertise a key that does nothing.
  const hint = visibleKeyHint(kbd, useSingleKeyShortcuts());
  return (
    <>
      {icon ? <Icon icon={icon} size={size === "sm" ? "sm" : "md"} /> : null}
      {children}
      {hint ? <kbd>{hint}</kbd> : null}
    </>
  );
}

export function Button(props: ButtonProps | ButtonLinkProps) {
  if (props.href !== undefined) {
    const { variant, size, icon, kbd, children, className, external, ...rest } = props as ButtonLinkProps;
    return (
      <a className={buttonClass(variant, size, className)} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...rest}>
        <Content icon={icon} kbd={kbd} size={size}>{children}</Content>
      </a>
    );
  }
  const { variant, size, icon, kbd, children, className, type = "button", ...rest } = props as ButtonProps;
  return (
    <button className={buttonClass(variant, size, className)} type={type} {...rest}>
      <Content icon={icon} kbd={kbd} size={size}>{children}</Content>
    </button>
  );
}
