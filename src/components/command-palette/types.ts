/**
 * The command palette's extension contract. A section provider is a hook
 * that receives the current text and returns sections of options; the
 * palette owns the input, ↑↓ / ↵ / Esc, the active row, focus and drafts.
 */
import type { ReactNode } from "react";
import type { IconType } from "../Icon";
import type { TileTone } from "../Tile";

export interface PaletteOption {
  /** Unique within the palette. */
  id: string;
  title: string;
  meta?: string;
  icon: IconType;
  /** Module colour of the 30px tile; neutral when omitted. */
  tone?: TileTone;
  /** Right side (.r): an `.ai-tag`, a <kbd>, … */
  aside?: ReactNode;
  /** Rendered under the option while it is active (e.g. the `.parse-row`). Use tabIndex={-1} on
   *  controls inside it: keyboard users drive them through `onKeyDown` (Tab, ⌘↵). */
  detail?: ReactNode;
  /** Footer text after ↵ while this option is active: 「建立待辦」, 「前往」… */
  enterLabel?: string;
  /** Runs on ↵ or click. Return false to keep the palette open; throw to keep it open as well. */
  run: () => unknown | Promise<unknown>;
}

export interface PaletteSection {
  id: string;
  /** 「快速新增」, 「AI 解析 · 規則看不懂時」, 「前往」, 「搜尋」 */
  title: string;
  options: PaletteOption[];
}

export interface PaletteQuery {
  /** "capture": opened by N / 快速記下 / ＋捕捉, or the text starts with "+". */
  mode: "go" | "capture";
  /** The text with a leading "+" removed. */
  text: string;
  /** Whether the palette is showing (work such as an AI parse or a search only runs while open). */
  open?: boolean;
}

/** A highlighted token in the input (`mark`): UTF-16 offsets into `PaletteQuery.text`. */
export interface PaletteMark {
  start: number;
  end: number;
}

export interface PaletteSectionsResult {
  sections: PaletteSection[];
  /**
   * Called first for every keydown in the input (never while an IME is
   * composing). Return true when handled (e.g. Tab cycles the type, ⌘↵
   * asks AI); the palette then does nothing else with the key.
   */
  onKeyDown?: (event: KeyboardEvent, active: PaletteOption | undefined) => boolean;
  /** Extra footer hints, e.g. <span><kbd>Tab</kbd>切換類型</span>. */
  footer?: ReactNode;
  /** Tokens the parser understood, highlighted in the input (the date and time of 「明天 9:00 交報告」). */
  marks?: PaletteMark[];
}

/** A section provider hook: `useQuickAddSection(query)` in quickAdd.tsx. */
export type PaletteSectionsHook = (query: PaletteQuery) => PaletteSectionsResult | null;
