/**
 * StatusPill (SPEC-ux §9): `.pill(.dot) .p-danger/-warn/-ok/-info/-accent`,
 * 2–4 character labels. Use only when the status is not already said
 * elsewhere in the row (SPEC-ux §1 rule 5).
 */
import type { ReactNode } from "react";
import { SOURCE_STATE_LABELS, type SourceState } from "../../shared/sources";
import { cx } from "../lib/cx";
import "./Pill.css";

export type PillTone = "neutral" | "danger" | "warn" | "ok" | "info" | "accent";

export interface PillProps {
  tone?: PillTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function Pill({ tone = "neutral", dot, children, className }: PillProps) {
  return <span className={cx("pill", dot && "dot", tone !== "neutral" && `p-${tone}`, className)}>{children}</span>;
}

const SOURCE_TONES: Record<SourceState, PillTone> = {
  not_configured: "neutral",
  idle: "neutral",
  syncing: "info",
  ok: "ok",
  error: "danger",
  needs_reconnect: "warn",
  disabled: "neutral",
};

/** A source's state as a dotted pill: 已連線 / 同步失敗 / 需要重新連線 / 尚未設定… */
export function StatusPill({ state, label }: { state: SourceState; label?: string }) {
  return <Pill tone={SOURCE_TONES[state]} dot>{label ?? SOURCE_STATE_LABELS[state]}</Pill>;
}
