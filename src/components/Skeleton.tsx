/**
 * Loading placeholders (SPEC-ux §9 Skeleton): `.skel` shimmer blocks, and
 * `.skel-status` (13px `.spin` + text, e.g. 「正在整理今日摘要…」).
 */
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../lib/cx";
import "./Skeleton.css";

export interface SkeletonProps {
  /** CSS width, e.g. "72%" or 120. */
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: CSSProperties["borderRadius"];
  className?: string;
}

export function Skeleton({ width, height, radius, className }: SkeletonProps) {
  return <span className={cx("skel", className)} style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("spin", className)} aria-hidden="true" />;
}

/** 「正在…」 status line with a spinner; announced politely. */
export function SkeletonStatus({ children }: { children: ReactNode }) {
  return (
    <span className="skel-status" role="status">
      <Spinner />
      {children}
    </span>
  );
}

/** A row placeholder matching list rows: a 30px tile block and two lines. */
export function SkeletonRow() {
  return (
    <div className="skel-row" aria-hidden="true">
      <Skeleton className="skel-tile" />
      <div>
        <Skeleton width="62%" />
        <Skeleton width="38%" />
      </div>
    </div>
  );
}
