/**
 * Small text links (SPEC-ux §9 Link): `.link` (muted, 12px, arrow), `.link.accent`,
 * and `.link.ext` for external targets (arrow-up-right, new tab, rel noopener).
 */
import type { ComponentPropsWithRef } from "react";
import { cx } from "../lib/cx";
import { ArrowRight, ArrowUpRight, Icon } from "./Icon";
import "./Link.css";

export interface TextLinkProps extends ComponentPropsWithRef<"a"> {
  href: string;
  accent?: boolean;
  external?: boolean;
  /** Hide the trailing arrow. */
  bare?: boolean;
}

export function TextLink({ accent, external, bare, className, children, ...rest }: TextLinkProps) {
  return (
    <a className={cx("link", accent && "accent", external && "ext", className)} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...rest}>
      {children}
      {bare ? null : <Icon icon={external ? ArrowUpRight : ArrowRight} size="xs" />}
    </a>
  );
}
