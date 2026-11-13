import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * CSS rules the inbox and Today rows depend on, checked from the source:
 * the swipe reveal colours must outrank the hover, focus and cursor fills
 * whatever order the bundle emits the files in (SPEC-ux §7,
 * SPEC-mail-assignments §2.4), and a search match must stay visible on every
 * row fill (SPEC-mail-assignments §4.2 item 5).
 */

const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule as [selector, declarations]. */
function rules(text: string): Array<[string, string]> {
  return [...text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((match) => [match[1].trim(), match[2]]);
}

/** Specificity of one selector as a single number: classes, attributes and pseudo-classes count 1, ids 100 (none here). */
function specificity(selector: string): number {
  return (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
}

/** The highest specificity among the selectors (comma list) of rules that paint a row's background in a state. */
function strongestFill(text: string, scope: RegExp): number {
  let best = 0;
  for (const [selectors, body] of rules(text)) {
    if (!/background\s*:/.test(body)) continue;
    for (const selector of selectors.split(",").map((part) => part.trim())) {
      if (scope.test(selector) && /\.q-row(?:[.:][\w-]+)*(?::hover|:focus-within|\.is-focus)/.test(selector)) best = Math.max(best, specificity(selector));
    }
  }
  return best;
}

function fillOf(text: string, wanted: string): number {
  for (const [selectors, body] of rules(text)) {
    if (!/background\s*:/.test(body)) continue;
    const found = selectors.split(",").map((part) => part.trim()).find((selector) => selector === wanted);
    if (found) return specificity(found);
  }
  return 0;
}

test("the swipe reveal colours outrank the row's hover, focus and cursor fills on Today and in the inbox", () => {
  const tray = css("../today/SwipeTray.css");
  const today = css("../today/FocusQueue.css");
  const inbox = css("./InboxPage.css");
  for (const direction of ["done", "snooze"]) {
    assert.ok(fillOf(tray, `.q-row.q-row.is-swipe-${direction}`) > strongestFill(today, /^\.q-row/), `Today ${direction}`);
    assert.ok(fillOf(tray, `.inbox .q-row.q-row.is-swipe-${direction}`) > strongestFill(inbox, /^\.inbox \.q-row/), `inbox ${direction}`);
  }
});

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const mix = (a: string, b: string) => `#${[1, 3, 5].map((index) => Math.round((Number.parseInt(a.slice(index, index + 2), 16) + Number.parseInt(b.slice(index, index + 2), 16)) / 2).toString(16).padStart(2, "0")).join("")}`;

test("a search match is underlined in --accent, at least 3:1 on the row, hover and cursor fills in both themes", () => {
  const hit = rules(css("./InboxPage.css")).find(([selector]) => selector === ".inbox mark.hit")?.[1] ?? "";
  assert.match(hit, /text-decoration:\s*underline[^;]*var\(--accent\)/);
  assert.match(hit, /font-weight:\s*6\d\d/);
  const tokens = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  const blocks = [tokens.slice(0, tokens.indexOf("@media")), tokens.slice(tokens.indexOf(":root[data-theme=\"dark\"]"))];
  for (const block of blocks) {
    const token = (name: string) => new RegExp(`--${name}:(#[0-9a-f]{6})`).exec(block)![1];
    const fills = [token("surface"), token("surface-soft"), mix(token("accent-soft"), token("surface"))];
    for (const fill of fills) assert.ok(contrast(token("accent"), fill) >= 3, `--accent on ${fill}: ${contrast(token("accent"), fill).toFixed(2)}`);
  }
});

test("text inputs and textareas never draw a focus-visible outline rectangle in base.css or precise.css", () => {
  for (const file of ["../../styles/base.css", "../../styles/precise.css"]) {
    const parsed = rules(css(file));
    for (const [selectors, body] of parsed) {
      const targetsInput = selectors.split(",").some((s) => /^(?:input|textarea):focus(?:-visible)?$/.test(s.trim()));
      if (targetsInput) {
        assert.match(body, /outline:\s*none/, `${file} rule "${selectors}" must suppress outline`);
      }
      if (/outline:\s*\d+px/.test(body)) {
        assert.doesNotMatch(selectors, /(?:^|,)\s*(?:input|textarea):focus/, `${file} outline rule "${selectors}" must not target input/textarea`);
      }
    }
  }
});
