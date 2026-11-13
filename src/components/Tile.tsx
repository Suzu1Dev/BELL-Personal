/**
 * Module-colour icon tile (SPEC-ux §9 Tile): 28px by default, 30px inside
 * rows and palette options, 36px in source cards (their own CSS), 54px
 * (`size="xl"`, `.tile54`) in empty states.
 */
import { cx } from "../lib/cx";
import { Icon, type IconType } from "./Icon";
import "./Tile.css";

export const TILE_TONES = ["mail", "cal", "task", "event", "idea", "habit", "accent", "info", "warn", "danger", "ok"] as const;
export type TileTone = (typeof TILE_TONES)[number];

export interface TileProps {
  icon: IconType;
  tone?: TileTone;
  size?: "md" | "xl";
  className?: string;
}

export function tileToneClass(tone: TileTone | undefined): string | undefined {
  return tone ? `t-${tone}` : undefined;
}

export function Tile({ icon, tone, size = "md", className }: TileProps) {
  return (
    <span className={cx(size === "xl" ? "tile54" : "tile", tileToneClass(tone), className)} aria-hidden="true">
      <Icon icon={icon} />
    </span>
  );
}
