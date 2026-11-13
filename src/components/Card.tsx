/**
 * Widget shell (SPEC-ux §9 Card): `.card` › `.card-head` (`.tile.t-*`, `h2`,
 * `.count`, `.link`). Modifier classes (queue, digest, later, capture,
 * habits, agenda…) are passed through `className` by the owning widget.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx";
import { TextLink } from "./Link";
import { Tile, type TileTone } from "./Tile";
import type { IconType } from "./Icon";
import "./Card.css";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "div" | "article";
}

export function Card({ as: Tag = "section", className, ...rest }: CardProps) {
  return <Tag className={cx("card", className)} {...rest} />;
}

export interface CardHeadProps {
  title: ReactNode;
  /** id for the h2 so the card can be aria-labelledby it. */
  titleId?: string;
  icon?: IconType;
  tone?: TileTone;
  /** Mono count after the title. */
  count?: number;
  /** aria-label for the count with its unit, e.g. 「3 個行程」. */
  countLabel?: string;
  link?: { href: string; label: string; external?: boolean };
  /** Extra content at the end of the head (chips, keys hint…). */
  children?: ReactNode;
  className?: string;
}

export function CardHead({ title, titleId, icon, tone, count, countLabel, link, children, className }: CardHeadProps) {
  return (
    <div className={cx("card-head", className)}>
      {icon ? <Tile icon={icon} tone={tone} /> : null}
      <h2 id={titleId}>{title}</h2>
      {count !== undefined ? <span className="count" aria-label={countLabel}>{count}</span> : null}
      {children}
      {link ? <TextLink href={link.href} external={link.external}>{link.label}</TextLink> : null}
    </div>
  );
}
