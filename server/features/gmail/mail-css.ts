import postcss, { type AtRule, type ChildNode, type Rule } from "postcss";
import { MAIL_BODY_LIMITS } from "../../../shared/mail.js";

/**
 * The CSS half of the mail sanitizer (SPEC-mail-html §3.3): `<style>` blocks
 * and `style` attributes are kept so newsletters keep their layout, but
 * rebuilt from a parse instead of passed through:
 *
 *  - only plain rules and `@media` survive; `@import`, `@font-face`,
 *    `@namespace`, `@keyframes`, `@supports`, `@layer`, `@container`,
 *    `@page`, `@property`, `@-moz-document`… are dropped, comments too;
 *  - every declaration is checked after CSS escapes are decoded and
 *    comments removed (so `u\72l(`, `\75 rl(`, `ur/​**​/l(` and
 *    `@\69mport` are seen for what they are);
 *  - no fetch survives except an image the policy allows: every `url(…)`
 *    becomes the policy's same-origin URL (a cid: part or the signed proxy
 *    once images are allowed) or `none`; `image-set()`, `image()`,
 *    `cross-fade()`, `element()`, `paint()`, `src()`, `var()`, `attr()`,
 *    `env()`, `expression()`, `behavior`, `-moz-binding`, `javascript:` and
 *    custom properties are dropped;
 *  - only an allowlist of functions, judged with strings blanked the way CSS
 *    reads them (an escaped quote is not a string);
 *  - `position` is static or relative only (no fixed, sticky or absolute
 *    overlays inside the frame), viewport units are dropped (they feed back
 *    into the frame's auto height), and absurd sizes are capped
 *    (sizesWithinCaps; every scan is linear: no backtracking regex reads a
 *    number);
 *  - the paper is always light: `color-scheme` is dropped and
 *    `prefers-color-scheme` media queries are settled as light;
 *  - the output is serialised by us, with no `<`, `{`, `}` or `;` inside a
 *    value, so it can never close the `<style>` element it is written into.
 */

/** Rewrites one url(…) argument: the URL to write instead, or undefined for `none`. */
export type CssImageResolver = (url: string) => string | undefined;

export interface CssDeclaration {
  prop: string;
  value: string;
  important: boolean;
}

/** `/* … *\/` comments replaced by one space, in one pass (an unclosed comment ends the text, as in CSS). */
export function stripCssComments(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("/*", index);
    if (start < 0) { out += text.slice(index); break; }
    out += `${text.slice(index, start)} `;
    const end = text.indexOf("*/", start + 2);
    if (end < 0) break;
    index = end + 2;
  }
  return out;
}

/** CSS escapes decoded (`\75 rl` → `url`, `\(` → `(`, an escaped newline removed); only used to look at a value, never to write it. */
export function decodeCssEscapes(text: string): string {
  return text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([\s\S])|$)/g, (_match, hex: string | undefined, char: string | undefined) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
    }
    if (char === undefined || char === "\n" || char === "\r" || char === "\f") return "";
    return char;
  });
}

const BLOCKED_PROPERTIES = new Set([
  "behavior", "-ms-behavior", "-moz-binding", "binding", "-o-link", "-o-link-source", "src", "-webkit-user-modify", "user-modify",
  // The paper is always light: a mail may not switch the frame to the owner's dark scheme (white text on the white card).
  "color-scheme", "supported-color-schemes",
]);

/** Functions and words that fetch, run or smuggle something, looked for after decoding (url() is handled on its own). */
const BLOCKED_VALUE = /(?:expression|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade|element|-moz-element|paint|src|var|attr|env|binding|behavior)\s*\(|javascript:|vbscript:|livescript:|progid:|-moz-binding|@import|\\|[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

/**
 * The CSS functions a mail may use; any other name( drops the declaration
 * (allowlist, not blocklist). 3-D transforms are left out: with
 * `perspective` they magnify without any size in the value.
 */
const ALLOWED_FUNCTIONS = new Set([
  "", "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "color-mix", "calc", "min", "max", "clamp",
  "linear-gradient", "radial-gradient", "conic-gradient", "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
  "-webkit-linear-gradient", "-webkit-radial-gradient", "-webkit-repeating-linear-gradient", "-webkit-gradient", "-moz-linear-gradient",
  "-moz-radial-gradient", "-o-linear-gradient", "-ms-linear-gradient", "color-stop", "from", "to",
  "translate", "translatex", "translatey", "scale", "scalex", "scaley", "rotate", "skew", "skewx", "skewy",
  "cubic-bezier", "steps", "rect", "inset", "circle", "ellipse", "polygon", "blur", "brightness", "contrast", "drop-shadow",
  "grayscale", "hue-rotate", "invert", "opacity", "saturate", "sepia", "counter", "counters", "repeat", "minmax", "fit-content",
  "none",
]);

const NAME_CHAR = /[a-z0-9_\-\u0080-\uffff]/;
const isNameChar = (char: string | undefined) => char !== undefined && NAME_CHAR.test(char);
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";
const isSpace = (char: string | undefined) => char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

/**
 * The function names of a value: the name right before each `(` (whitespace
 * between them allowed, "" for a bare parenthesis). One walk back per `(`,
 * never past the previous one, so the scan is linear.
 */
export function functionNames(text: string): string[] {
  const names: string[] = [];
  for (let open = text.indexOf("("); open >= 0; open = text.indexOf("(", open + 1)) {
    let end = open;
    while (end > 0 && isSpace(text[end - 1])) end--;
    let start = end;
    while (start > 0 && isNameChar(text[start - 1])) start--;
    names.push(text.slice(start, end));
  }
  return names;
}

function unknownFunction(bare: string): boolean {
  return functionNames(bare).some((name) => !ALLOWED_FUNCTIONS.has(name));
}

/**
 * The value with every string's contents removed (`"…"` → `""`), read the
 * way CSS tokenizes it: a backslash escapes the next character inside a
 * string and out of one, so an escaped quote never opens or closes a string
 * (decoding first would turn `\"` into a quote and hide real tokens).
 */
export function blankCssStrings(text: string): string {
  const parts: string[] = [];
  let quote: string | undefined;
  let from = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote) {
      // A string ends at its quote, or (a bad string) at a newline.
      if (char === quote || char === "\n") {
        parts.push(quote, char === "\n" ? "\n" : "");
        quote = undefined;
        from = index + 1;
      }
    } else if (char === "\"" || char === "'") {
      parts.push(text.slice(from, index + 1));
      quote = char;
    }
  }
  parts.push(quote ? quote : text.slice(from));
  return parts.join("");
}

/** Viewport units: in a frame sized to its content they feed back into the height. */
const VIEWPORT_UNITS = new Set([
  "vh", "vw", "vmin", "vmax", "svh", "lvh", "dvh", "svw", "lvw", "dvw", "vi", "vb", "svi", "svb", "lvi", "lvb", "dvi", "dvb",
  "svmin", "svmax", "lvmin", "lvmax", "dvmin", "dvmax",
]);

/** The most of each unit one declaration may add up to (5000 px and equivalents). */
const SIZE_LIMITS: Record<string, number> = {
  px: 5000, pt: 4000, pc: 300, em: 200, rem: 200, ex: 400, ch: 400, cm: 150, mm: 1500, in: 60, q: 6000, "%": 1000,
};

/** Properties whose unitless numbers multiply a size, and their cap. */
const UNITLESS_LIMITS: Record<string, number> = { zoom: 10, "line-height": 10, scale: 10, "tab-size": 16 };
/** Functions whose unitless arguments multiply a size: scale(), and repeat()'s count. */
const SCALE_LIMIT = 10;
const SCALE_FUNCTIONS = new Set(["scale", "scalex", "scaley"]);
const MATH_FUNCTIONS = new Set(["calc", "min", "max", "clamp"]);
/** Digits a number in mail CSS may have; more is never a real size (and kept every scan short). */
const MAX_DIGITS = 12;

interface NumberToken {
  value: number;
  unit: string;
  end: number;
}

/** A CSS number (sign, digits, fraction, exponent) and its unit at `start`, read by hand; undefined when there is none, "invalid" when it is absurdly long. */
export function readNumber(text: string, start: number): NumberToken | undefined | "invalid" {
  let index = start;
  if (text[index] === "+" || text[index] === "-") index++;
  const digitsFrom = index;
  while (isDigit(text[index])) index++;
  let digits = index - digitsFrom;
  if (text[index] === "." && isDigit(text[index + 1])) {
    index++;
    const fractionFrom = index;
    while (isDigit(text[index])) index++;
    digits += index - fractionFrom;
  }
  if (!digits) return undefined;
  if (digits > MAX_DIGITS) return "invalid";
  if (text[index] === "e" && (isDigit(text[index + 1]) || ((text[index + 1] === "+" || text[index + 1] === "-") && isDigit(text[index + 2])))) {
    index += isDigit(text[index + 1]) ? 1 : 2;
    const exponentFrom = index;
    while (isDigit(text[index])) index++;
    if (index - exponentFrom > 3) return "invalid";
  }
  const value = Number(text.slice(start, index));
  if (text[index] === "%") return { value, unit: "%", end: index + 1 };
  const unitFrom = index;
  if (/[a-z_\u0080-\uffff]/.test(text[index] ?? "") || (text[index] === "-" && /[a-z_]/.test(text[index + 1] ?? ""))) {
    index++;
    while (isNameChar(text[index])) index++;
  }
  return { value, unit: text.slice(unitFrom, index), end: index };
}

/**
 * Whether the sizes in a value stay within the caps, read in one linear pass
 * over the decoded value (strings blank): every number with its exponent
 * (`1e9px` is a billion pixels), the lengths of the declaration added up
 * against their caps (`calc(5000px + 5000px)`), times whatever `*` and `/`
 * inside calc(), min(), max() or clamp() and repeat()'s count can multiply
 * them by (`calc(5000px * 5000)`); unitless multipliers (zoom, line-height,
 * scale, tab-size, scale()) at most 10; no viewport units. Best effort: the
 * frame's own guards (a height cap, sideways scrolling inside the frame) are
 * the real bound on what a mail can draw.
 */
export function sizesWithinCaps(text: string, prop: string): boolean {
  // Open functions ("" for a bare parenthesis), and how many of them are math or scale functions.
  const stack: string[] = [];
  let math = 0;
  let scale = 0;
  const open = (name: string) => {
    stack.push(name);
    if (MATH_FUNCTIONS.has(name)) math++;
    if (SCALE_FUNCTIONS.has(name)) scale++;
  };
  const close = () => {
    const name = stack.pop();
    if (name !== undefined && MATH_FUNCTIONS.has(name)) math--;
    if (name !== undefined && SCALE_FUNCTIONS.has(name)) scale--;
  };
  let share = 0;
  let growth = 1;
  let largestUnitless = 0;
  let largestScale = 0;
  let previous: NumberToken | undefined;
  let pending: { operator: string; before: NumberToken | undefined } | undefined;
  const unitlessLimit = UNITLESS_LIMITS[prop];
  // A corner's radius never makes anything bigger (`border-radius: 9999px` is the usual pill button).
  const sized = !prop.endsWith("radius");
  // An operator takes the number after it (or, for *, the one before it): that is what it can multiply by.
  const settle = (next: NumberToken | undefined): boolean => {
    if (!pending) return true;
    const { operator, before } = pending;
    pending = undefined;
    if (next && next.unit === "") {
      const factor = operator === "*" ? Math.abs(next.value) : next.value === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(next.value);
      growth *= Math.max(1, factor);
      return true;
    }
    if (operator === "*" && before && before.unit === "") {
      growth *= Math.max(1, Math.abs(before.value));
      return true;
    }
    return false;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (isSpace(char)) {
      index++;
      continue;
    }
    const startsNumber = isDigit(char) || (char === "." && isDigit(text[index + 1]))
      || ((char === "+" || char === "-") && (isDigit(text[index + 1]) || (text[index + 1] === "." && isDigit(text[index + 2]))));
    if (startsNumber && !isNameChar(text[index - 1])) {
      const number = readNumber(text, index);
      if (number === "invalid") return false;
      if (number) {
        if (!settle(number)) return false;
        const magnitude = Math.abs(number.value);
        if (VIEWPORT_UNITS.has(number.unit)) return false;
        if (sized && SIZE_LIMITS[number.unit] !== undefined) share += magnitude / SIZE_LIMITS[number.unit];
        if (number.unit === "") {
          if (unitlessLimit !== undefined) largestUnitless = Math.max(largestUnitless, magnitude);
          if (scale) largestScale = Math.max(largestScale, magnitude);
          if (stack.at(-1) === "repeat") growth *= Math.max(1, magnitude);
        }
        previous = number;
        index = number.end;
        continue;
      }
    }
    if (isNameChar(char) || char === "#") {
      // A name (or a #hash colour): its digits are not numbers.
      let end = index + 1;
      while (isNameChar(text[end])) end++;
      if (!settle(undefined)) return false;
      if (text[end] === "(") {
        open(text.slice(index, end));
        end++;
      }
      previous = undefined;
      index = end;
      continue;
    }
    if ((char === "*" || char === "/") && math) {
      if (pending) return false;
      pending = { operator: char, before: previous };
      index++;
      continue;
    }
    if (!settle(undefined)) return false;
    if (char === "(") open("");
    else if (char === ")") close();
    previous = undefined;
    index++;
  }
  if (pending) return false;
  if (share * growth > 1) return false;
  if (unitlessLimit !== undefined && largestUnitless * growth > unitlessLimit) return false;
  return largestScale * growth <= SCALE_LIMIT;
}

/** url(…) tokens of a value without escapes; quoted or bare. */
const URL_TOKEN = /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'()]*))\s*\)/gi;

/**
 * One declaration, checked and rewritten: `prop:value[ !important]`, or
 * undefined when it is dropped.
 */
export function sanitizeDeclaration(rawProp: string, rawValue: string, important: boolean, resolve: CssImageResolver): string | undefined {
  const prop = decodeCssEscapes(stripCssComments(rawProp)).trim().toLowerCase();
  if (!/^-?[a-z][a-z0-9-]{0,63}$/.test(prop) || BLOCKED_PROPERTIES.has(prop)) return undefined;
  let value = stripCssComments(rawValue).trim();
  if (!value || value.length > 2000 || /[{};<>@]/.test(value)) return undefined;
  const raw = value;
  const decoded = decodeCssEscapes(value).toLowerCase();
  const hasUrl = /url\s*\(/.test(decoded);
  if (hasUrl) {
    // An escaped url() cannot be rewritten safely: drop it.
    if (value.includes("\\")) return undefined;
    const parts: string[] = [];
    let last = 0;
    for (const match of value.matchAll(URL_TOKEN)) {
      parts.push(value.slice(last, match.index));
      const target = resolve((match[1] ?? match[2] ?? match[3] ?? "").trim());
      parts.push(target && !/["'\\\n\r<>]/.test(target) ? `url("${target}")` : "none");
      last = (match.index ?? 0) + match[0].length;
    }
    const rest = value.slice(last);
    // Whatever is left between the rewritten tokens must not hold another url( (a malformed one, `url (`…).
    const outside = [...parts.filter((_, index) => index % 2 === 0), rest].join(" ").toLowerCase();
    if (/url\s*\(/.test(outside)) return undefined;
    value = `${parts.join("")}${rest}`;
  }
  // url(…) was rewritten above. The blocklist reads everything (strings too); the function allowlist and the
  // sizes skip string contents (「"Foo (Bold)"」), with strings found before decoding so an escaped quote stays a character.
  const withoutUrls = (text: string) => (hasUrl ? text.replace(/url\s*\([^)]*\)/g, "none") : text);
  const checked = withoutUrls(decoded);
  const bare = withoutUrls(decodeCssEscapes(blankCssStrings(raw)).toLowerCase());
  if (BLOCKED_VALUE.test(checked) || unknownFunction(bare) || !sizesWithinCaps(bare, prop)) return undefined;
  if (prop === "position" && !/^(static|relative)$/.test(checked.trim())) return undefined;
  if (prop.startsWith("-") && /binding|behavior/.test(prop)) return undefined;
  return `${prop}:${value}${important ? " !important" : ""}`;
}

/** The declarations of a style attribute (postcss, as sanitize-html parses them), or undefined when it does not parse. */
export function parseDeclarations(style: string): CssDeclaration[] | undefined {
  if (style.length > MAIL_BODY_LIMITS.styleAttributeChars) return undefined;
  try {
    const root = postcss.parse(`x{${style}}`, { map: false });
    const rule = root.nodes[0];
    if (!rule || rule.type !== "rule") return [];
    return rule.nodes.flatMap((node) => (node.type === "decl" ? [{ prop: node.prop, value: node.value, important: !!node.important }] : []));
  } catch {
    return undefined;
  }
}

/** A `style` attribute rebuilt from its allowed declarations; undefined when nothing is left. */
export function sanitizeStyleAttribute(style: string, resolve: CssImageResolver): string | undefined {
  const declarations = parseDeclarations(style);
  if (!declarations) return undefined;
  const kept = declarations.flatMap((declaration) => sanitizeDeclaration(declaration.prop, declaration.value, declaration.important, resolve) ?? []);
  return kept.length ? kept.join(";") : undefined;
}

const MEDIA_PARAMS = /^[a-z0-9\s(),:.\/-]{1,300}$/i;

function cleanSelector(raw: string): string | undefined {
  const selector = stripCssComments(raw).replace(/\s+/g, " ").trim();
  if (!selector || selector.length > 500 || /[{};<@]/.test(selector)) return undefined;
  let depth = 0;
  for (const char of selector) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    // Deeply nested :has()/:is() chains are a layout-time cost, not a feature newsletters use.
    if (depth > 4 || depth < 0) return undefined;
  }
  return depth === 0 ? selector : undefined;
}

function serializeRule(rule: Rule, resolve: CssImageResolver): string {
  const selector = cleanSelector(rule.selector);
  if (!selector) return "";
  const declarations = (rule.nodes ?? []).flatMap((node) => (node.type === "decl" ? sanitizeDeclaration(node.prop, node.value, !!node.important, resolve) ?? [] : []));
  return declarations.length ? `${selector}{${declarations.join(";")}}` : "";
}

function serializeNodes(nodes: ChildNode[], resolve: CssImageResolver, inMedia: boolean, expired?: () => boolean): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (expired?.()) break;
    if (node.type === "rule") {
      const text = serializeRule(node, resolve);
      if (text) out.push(text);
    } else if (node.type === "atrule" && !inMedia) {
      const media = serializeMedia(node, resolve, expired);
      if (media) out.push(media);
    }
    // Comments, stray declarations, nested at-rules and every other at-rule are dropped.
  }
  return out;
}

const LIGHT_SCHEME = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/i;

/**
 * A media query list as the frame sees it: the paper is always light, so
 * `(prefers-color-scheme: light)` always holds and is taken out, and a query
 * that tests the scheme any other way (dark, `not`, `or`, no value) never
 * holds and is dropped. Undefined when no query is left. (Inside a frame the
 * feature follows the owner's system setting, not the frame's scheme.)
 */
export function lightMediaQueries(params: string): string | undefined {
  if (!/prefers-color-scheme/i.test(params)) return params;
  const kept: string[] = [];
  for (const query of params.split(",")) {
    let text = query.trim();
    if (/prefers-color-scheme/i.test(text)) {
      if (/\b(?:not|or)\b/i.test(text)) continue;
      text = text
        .replace(new RegExp(`\\s*\\band\\s*${LIGHT_SCHEME.source}`, "i"), "")
        .replace(new RegExp(`^${LIGHT_SCHEME.source}\\s*(?:\\band\\b\\s*)?`, "i"), "")
        .trim();
      if (/prefers-color-scheme/i.test(text)) continue;
      if (!text) text = "all";
    }
    if (text) kept.push(text);
  }
  return kept.length ? kept.join(", ") : undefined;
}

function serializeMedia(rule: AtRule, resolve: CssImageResolver, expired?: () => boolean): string {
  const name = decodeCssEscapes(rule.name).toLowerCase();
  if (name !== "media") return "";
  const written = stripCssComments(rule.params).replace(/\s+/g, " ").trim();
  if (!MEDIA_PARAMS.test(written) || /url|\\/i.test(written)) return "";
  const params = lightMediaQueries(written);
  if (!params) return "";
  const inner = serializeNodes(rule.nodes ?? [], resolve, true, expired);
  return inner.length ? `@media ${params}{${inner.join("")}}` : "";
}

/**
 * A `<style>` block rebuilt (rules and @media only, every declaration
 * checked), at most `budget` characters; "" when nothing parses. `expired`
 * stops the work between rules (the caller's wall-clock budget).
 */
export function sanitizeStylesheet(css: string, resolve: CssImageResolver, budget: number = MAIL_BODY_LIMITS.cssChars, expired?: () => boolean): string {
  if (!css.trim()) return "";
  let root: postcss.Root;
  try {
    root = postcss.parse(css.slice(0, MAIL_BODY_LIMITS.cssChars), { map: false });
  } catch {
    return "";
  }
  let out = "";
  for (const text of serializeNodes(root.nodes, resolve, false, expired)) {
    if (out.length + text.length > budget) break;
    out += text;
  }
  // Belt and braces: nothing in the output may open or close an element.
  return out.replace(/</g, "\\3c ");
}

/**
 * Whether a style says the element cannot be seen: a tracking pixel hides
 * behind display:none, zero opacity or a size of at most one pixel.
 */
export function hiddenByStyle(declarations: CssDeclaration[]): { hidden: boolean; width?: number; height?: number } {
  let width: number | undefined;
  let height: number | undefined;
  let hidden = false;
  for (const declaration of declarations) {
    const prop = decodeCssEscapes(declaration.prop).trim().toLowerCase();
    const value = decodeCssEscapes(stripCssComments(declaration.value)).trim().toLowerCase();
    const number = readNumber(value, 0);
    const whole = number && number !== "invalid" && number.end === value.length ? number : undefined;
    const size = whole && (whole.unit === "" || whole.unit === "px") && whole.value >= 0 ? whole.value : undefined;
    if ((prop === "width" || prop === "max-width") && size !== undefined) width = Math.min(width ?? Number.POSITIVE_INFINITY, size);
    if ((prop === "height" || prop === "max-height") && size !== undefined) height = Math.min(height ?? Number.POSITIVE_INFINITY, size);
    if (prop === "display" && value === "none") hidden = true;
    if (prop === "visibility" && (value === "hidden" || value === "collapse")) hidden = true;
    if (prop === "opacity" && whole && whole.value === 0 && (whole.unit === "" || whole.unit === "%")) hidden = true;
  }
  return { hidden, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}
