/**
 * StaleNote (SPEC-ux §9): `.stale-note` › clock icon, 「顯示 08:12 的資料 · 」, 重新整理 button.
 * Pass the already-formatted time phrase (`08:12`, `昨天 22:10`).
 */
import { STALE } from "../copy/common";
import { Clock, Icon } from "./Icon";
import "./StaleNote.css";

export interface StaleNoteProps {
  time: string;
  onRefresh?: () => void;
  /** Overrides the default 「顯示 {time} 的資料」, e.g. 「CTFtime 顯示 08:00 的資料」. */
  text?: string;
}

export function StaleNote({ time, onRefresh, text }: StaleNoteProps) {
  return (
    <p className="stale-note">
      <Icon icon={Clock} size="sm" />
      <span>{text ?? STALE.showing(time)}{onRefresh ? " · " : ""}</span>
      {onRefresh ? <button type="button" onClick={onRefresh}>{STALE.refresh}</button> : null}
    </p>
  );
}
