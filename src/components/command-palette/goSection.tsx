/** The palette's 前往 section: every module page plus 連線與設定 and 使用指南, with counts and G chords. */
import { useMemo } from "react";
import { bottomNavItems, navCountLabel, visibleNavItems } from "../../app/nav";
import { useAppSettings } from "../../lib/app-settings";
import { PALETTE } from "../../copy/common";
import { navigate } from "../../lib/router";
import { useToday } from "../../lib/today";
import { Keys } from "../Kbd";
import { matchItems } from "./match";
import type { PaletteQuery, PaletteSection } from "./types";

export function useGoSection(query: PaletteQuery): { section: PaletteSection | null; strong: boolean } {
  const { nav } = useToday();
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  return useMemo(() => {
    if (query.mode === "capture") return { section: null, strong: false };
    const { items, strong } = matchItems([...visibleNavItems(roles, app.overrides), ...bottomNavItems()], query.text);
    if (!items.length) return { section: null, strong: false };
    return {
      strong,
      section: {
        id: "go",
        title: PALETTE.sectionGo,
        options: items.map((item) => {
          const count = item.count ? nav[item.count] : undefined;
          return {
            id: `go-${item.section}`,
            title: item.label,
            meta: item.count && count ? navCountLabel(item.count, count) : undefined,
            icon: item.icon,
            aside: item.chord ? <Keys keys={["G", item.chord]} /> : item.section === "guide" ? <Keys keys={["?"]} /> : undefined,
            enterLabel: PALETTE.footGo,
            run: () => navigate(item.href),
          };
        }),
      },
    };
  }, [query.mode, query.text, nav, roles, app.overrides]);
}
