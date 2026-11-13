/** Palette text matching for the 前往 section. Pure, so it is unit-tested. */

export interface Matchable {
  label: string;
  keywords: readonly string[];
}

export interface MatchResult<T> {
  items: T[];
  /** True when some label itself matches: 前往 then stays above 快速新增. */
  strong: boolean;
}

function score(item: Matchable, query: string): number {
  const label = item.label.toLowerCase();
  if (label === query) return 4;
  if (label.startsWith(query)) return 3;
  if (label.includes(query)) return 2;
  if (item.keywords.some((keyword) => keyword.toLowerCase().startsWith(query))) return 1;
  return 0;
}

/** Items whose label or keywords match `query`, best first (ties keep their order). Empty query → all. */
export function matchItems<T extends Matchable>(items: readonly T[], rawQuery: string): MatchResult<T> {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { items: [...items], strong: true };
  const scored = items
    .map((item, index) => ({ item, index, score: score(item, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return { items: scored.map((entry) => entry.item), strong: scored.some((entry) => entry.score >= 2) };
}

/** Capture mode and the text to parse: "+ 明天 9:00 交報告" → capture, "明天 9:00 交報告". */
export function splitCapturePrefix(text: string, mode: "go" | "capture"): { mode: "go" | "capture"; text: string } {
  if (text.startsWith("+") || text.startsWith("＋")) return { mode: "capture", text: text.slice(1).trimStart() };
  return { mode, text };
}
