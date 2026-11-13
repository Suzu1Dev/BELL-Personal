/**
 * Notice (SPEC-ux §9): `.notice.notice-warn | -error | -ok` › icon,
 * `div > b + p`, `.n-acts`. Copy says what failed and what to do; actions
 * wrap under the text at ≤720.
 */
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { CircleCheck, Icon, TriangleAlert, type IconType } from "./Icon";
import "./Notice.css";

export type NoticeTone = "warn" | "error" | "ok" | "neutral";

export interface NoticeProps {
  tone?: NoticeTone;
  title: ReactNode;
  children?: ReactNode;
  /** Defaults: TriangleAlert for warn/error, CircleCheck for ok. */
  icon?: IconType;
  /** Buttons (usually one `btn-secondary btn-sm`). */
  actions?: ReactNode;
  /** "alert" for source failures shown once per session (SPEC-ux §11). */
  role?: "alert" | "status";
  className?: string;
}

export function Notice({ tone = "neutral", title, children, icon, actions, role, className }: NoticeProps) {
  const glyph = icon ?? (tone === "ok" ? CircleCheck : TriangleAlert);
  return (
    <div className={cx("notice", tone !== "neutral" && `notice-${tone}`, className)} role={role}>
      <Icon icon={glyph} />
      <div>
        <b>{title}</b>
        {children ? <p>{children}</p> : null}
      </div>
      {actions ? <div className="n-acts">{actions}</div> : null}
    </div>
  );
}
