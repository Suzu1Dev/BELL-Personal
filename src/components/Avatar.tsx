/**
 * Avatar: a person's serif initial (`.person`, queue and inbox rows) or the
 * user's own sans initial (`.avatar`, topbar and sidebar profile). The
 * initial is always derived from a name, never hard-coded.
 */
import { cx } from "../lib/cx";
import "./Avatar.css";

export interface AvatarProps {
  /** Full name; the first character becomes the initial. */
  name: string;
  /** Explicit initial (e.g. from QueueItem.avatar.initial). */
  initial?: string;
  variant?: "person" | "self";
  className?: string;
}

export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? "?";
  return first.toLocaleUpperCase("zh-TW");
}

export function Avatar({ name, initial, variant = "person", className }: AvatarProps) {
  return <span className={cx(variant === "self" ? "avatar" : "person", className)} aria-hidden="true">{initial ?? initialOf(name)}</span>;
}
