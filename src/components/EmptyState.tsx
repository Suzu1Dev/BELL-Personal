/**
 * EmptyState (SPEC-ux §9): `.empty-state(.solid)` › `.tile54`, optional `h3`,
 * `p`, at most one `.btn`. Dashed by default; `solid` for celebrations.
 */
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { Tile, type TileTone } from "./Tile";
import type { IconType } from "./Icon";
import "./EmptyState.css";

export interface EmptyStateProps {
  icon: IconType;
  tone?: TileTone;
  title?: ReactNode;
  hint?: ReactNode;
  /** One button (a <Button>) — never more. */
  action?: ReactNode;
  solid?: boolean;
  /** Replaces the tile (e.g. the celebration art). */
  art?: ReactNode;
  children?: ReactNode;
  className?: string;
  role?: "status";
}

export function EmptyState({ icon, tone, title, hint, action, solid, art, children, className, role }: EmptyStateProps) {
  return (
    <div className={cx("empty-state", solid && "solid", className)} role={role}>
      {art ?? <Tile icon={icon} tone={tone} size="xl" />}
      {title ? <h3 className="kp">{title}</h3> : null}
      {hint ? <p className="kp">{hint}</p> : null}
      {children}
      {action}
    </div>
  );
}
