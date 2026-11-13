/**
 * The palette's 搜尋 section (SPEC-ux §6.6 section order: 快速新增 → AI 解析
 * → 前往 → 搜尋): todos, ideas and projects matching the text, from
 * GET /api/capture/search. ↵ opens the item's page (#/tasks?focus=…).
 */
import { useEffect, useMemo, useState } from "react";
import type { CaptureSearchResult } from "../../../shared/connect";
import { PALETTE_CAPTURE } from "../../copy/capture";
import { PALETTE } from "../../copy/common";
import { navigate } from "../../lib/router";
import { FolderKanban, Lightbulb, ListTodo, type IconType } from "../Icon";
import type { TileTone } from "../Tile";
import { captureApi } from "../capture/client";
import { searchMeta } from "../capture/describe";
import { useCaptureEnv } from "../capture/useCapture";
import { useAppSettings } from "../../lib/app-settings";
import { isFeatureVisible } from "../../../shared/profile";
import type { PaletteQuery, PaletteSection } from "./types";

const SEARCH_DEBOUNCE_MS = 180;
const KIND_ICONS: Record<CaptureSearchResult["kind"], IconType> = { todo: ListTodo, idea: Lightbulb, project: FolderKanban };
const KIND_TONES: Record<CaptureSearchResult["kind"], TileTone> = { todo: "task", idea: "idea", project: "accent" };

export function useSearchSection(query: PaletteQuery): PaletteSection | null {
  const { timeZone } = useCaptureEnv();
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  const text = query.text.trim();
  const [found, setFound] = useState<{ text: string; results: CaptureSearchResult[] }>({ text: "", results: [] });

  useEffect(() => {
    if (!query.open || !text) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      captureApi.search(text, controller.signal)
        .then((response) => setFound({ text, results: response.results }))
        .catch(() => { /* search is a convenience: a failure shows no results */ });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query.open, text]);

  return useMemo(() => {
    if (!text || found.text !== text || !found.results.length) return null;
    const now = new Date();
    return {
      id: "search",
      title: PALETTE.sectionSearch,
      options: found.results.filter((result) => result.kind !== "project" || isFeatureVisible("projects", roles, app.overrides)).map((result) => ({
        id: `search-${result.kind}-${result.id}`,
        title: result.title,
        meta: searchMeta(result, timeZone, now),
        icon: KIND_ICONS[result.kind],
        tone: KIND_TONES[result.kind],
        enterLabel: PALETTE_CAPTURE.searchOpen,
        run: () => navigate(result.href),
      })),
    };
  }, [found, text, timeZone, roles, app.overrides]);
}
