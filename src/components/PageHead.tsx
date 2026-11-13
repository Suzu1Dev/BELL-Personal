/**
 * Route head for every page except Today's hero (SPEC-ux §3.3):
 * `.page-head` › optional eyebrow, 26px H1 (22px at ≤720), optional `.page-sub`,
 * and the page-level primary action on the right.
 */
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import "./PageHead.css";

export interface PageHeadProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** The page's primary action (one button). */
  actions?: ReactNode;
  titleId?: string;
  className?: string;
}

export function PageHead({ eyebrow, title, sub, actions, titleId, className }: PageHeadProps) {
  return (
    <header className={cx("page-head", className)}>
      <div className="page-titles">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="page-title kp" id={titleId}>{title}</h1>
        {sub ? <p className="page-sub kp" title={typeof sub === "string" ? sub : undefined}>{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
