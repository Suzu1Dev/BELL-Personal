/**
 * The palette's 信件 section (SPEC-mail-assignments §4.4): in go mode, with
 * text that is not a capture, one option 「搜尋信件「…」」 that opens
 * `#/inbox?view=all&q=…`, where the field shows the text and the search runs.
 * It is the last section, so it never pushes 快速新增 or 前往 down.
 */
import { useMemo } from "react";
import { MAIL_SEARCH_LIMITS } from "../../../shared/mail";
import { MAIL_SEARCH } from "../../copy/inbox";
import { navigate, routeHref } from "../../lib/router";
import { Search } from "../Icon";
import type { PaletteQuery, PaletteSection } from "./types";

/** The section for a palette query, or null when it has nothing to offer (pure, for tests). */
export function mailSearchSection(query: PaletteQuery, go: (hash: string) => void = navigate): PaletteSection | null {
  const text = query.text.trim().slice(0, MAIL_SEARCH_LIMITS.query);
  if (query.mode !== "go" || !text) return null;
  return {
    id: "mail-search",
    title: MAIL_SEARCH.paletteSection,
    options: [{
      id: "mail-search",
      title: MAIL_SEARCH.paletteOption(text),
      meta: MAIL_SEARCH.paletteMeta,
      icon: Search,
      tone: "mail",
      enterLabel: MAIL_SEARCH.paletteEnter,
      run: () => go(routeHref({ name: "inbox", view: "all", q: text })),
    }],
  };
}

export function useMailSearchSection(query: PaletteQuery): PaletteSection | null {
  return useMemo(() => mailSearchSection(query), [query]);
}
