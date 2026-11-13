import { Parser } from "htmlparser2";
import sanitizeHtml from "sanitize-html";
import { MAIL_BODY_LIMITS } from "../../../shared/mail.js";
import { acceptableRaster, sniffImage } from "./images.js";
import { hiddenByStyle, parseDeclarations, sanitizeStyleAttribute, sanitizeStylesheet, type CssImageResolver } from "./mail-css.js";
import { attributePixels, invisibleSize, isTrackerUrl } from "./trackers.js";

/**
 * The mail HTML sanitizer (SPEC-mail-html §3). An allowlist on top of
 * sanitize-html (htmlparser2): layout and text elements, presentational
 * attributes with checked values, and nothing that runs, embeds, submits,
 * navigates or fetches on its own:
 *
 *  - dropped with their content: script, style-like raw text we cannot
 *    trust (noscript, template, xmp, iframe, noembed, noframes, plaintext,
 *    title, textarea, select), svg and math (no foreign content, so no
 *    namespace confusion), object, applet, audio, video, canvas;
 *  - dropped, content kept: html, head, body (becomes a div), meta (refresh
 *    included), link, base, form and its controls, button, every element not
 *    on the list; every attribute not on the list (all on* handlers,
 *    srcset, formaction, xlink:href, ping, data-*, …);
 *  - links: absolute http, https and mailto only, rewritten with
 *    target=_blank rel="noopener noreferrer" and a title naming the real host
 *    (the only title in the output: a mail's own title inside a link would
 *    be the tooltip shown instead); a link without a usable target becomes a
 *    plain <span>, so it no longer looks clickable;
 *  - images: cid: → this message's inline part (same origin), data:image
 *    png/jpeg/gif/webp under a size cap and only when the bytes match and
 *    decode to a sane size (images.ts acceptableRaster),
 *    remote http(s) → the signed proxy once images are allowed, otherwise
 *    no URL at all; tracking pixels and known trackers are removed and counted;
 *  - CSS (style blocks and attributes): mail-css.ts.
 *
 * Defence in depth: the output is sanitized again in a verify mode that only
 * accepts the URLs the first pass wrote, and what is served must be a
 * fixpoint (sanitizing it once more changes nothing; sloppy markup may take
 * one extra round to settle). Anything the parser reads two ways (mutation
 * XSS) never settles, and the reader then shows the plain text instead.
 * Even then the frame has no allow-scripts and a CSP with default-src 'none'.
 * Every scan is linear, and the whole job has a wall-clock budget: past it
 * the result is refused (`slow`) and the reader shows the plain text.
 */

export interface SanitizeOptions {
  messageId: string;
  /** "proxy": remote images become signed proxy URLs; "block": no remote URL survives. */
  remote: "block" | "proxy";
  /** The signed same-origin proxy URL of an absolute http(s) image URL. */
  proxy: (url: string) => string;
  /** Content-IDs of the message's image parts (cid: targets). */
  inline: ReadonlySet<string>;
  /** Wall-clock budget for the whole job (default SANITIZE_BUDGET_MS). */
  budgetMs?: number;
}

/** A mail that takes longer than this to sanitize is not shown as HTML (every scan is linear; this bounds what is left). */
export const SANITIZE_BUDGET_MS = 3000;

export interface SanitizedMail {
  body: string;
  css: string;
  /** Distinct remote images (img, background, CSS) that are not tracking pixels. */
  remote: number;
  /** Their URLs, in the order the mail shows them (what the proxy fetches once images are shown). */
  remoteUrls: string[];
  /** Tracking pixels removed. */
  trackers: number;
  /** Content-IDs the HTML shows inline. */
  inline: Set<string>;
  /** Both passes agree; false means the output must not be shown. */
  stable: boolean;
  /** Over the wall-clock budget: not shown either. */
  slow?: boolean;
  /** The `dir` and `lang` of the mail's <html> (the frame writes them on its wrapper). */
  dir?: string;
  lang?: string;
}

/** Elements kept (with their content). */
const ALLOWED_TAGS = [
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code",
  "col", "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s",
  "samp", "section", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time",
  "tr", "tt", "u", "ul", "var", "wbr",
];

/**
 * Disallowed elements whose content goes with them. Raw-text and template
 * elements first: what htmlparser2 reads as markup inside them is not what a
 * browser reads, so none of it is kept. svg and math: no foreign content.
 */
const DROPPED_WITH_CONTENT = [
  "script", "style", "textarea", "option", "select", "datalist", "xmp", "noscript", "iframe", "frame", "frameset", "noframes",
  "noembed", "plaintext", "title", "template", "svg", "math", "object", "applet", "embed", "audio", "video", "canvas", "head-script",
];

/** No `title`: inside a link it would be the tooltip instead of 「連到 {real host}」 (the only title written). */
const GLOBAL_ATTRIBUTES = ["id", "class", "dir", "lang", "align", "style"];

const TAG_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel", "title"],
  img: ["src", "alt", "width", "height", "border", "hspace", "vspace"],
  table: ["width", "height", "border", "cellpadding", "cellspacing", "bgcolor", "background", "valign"],
  thead: ["valign", "bgcolor"],
  tbody: ["valign", "bgcolor"],
  tfoot: ["valign", "bgcolor"],
  tr: ["height", "bgcolor", "background", "valign"],
  td: ["width", "height", "colspan", "rowspan", "bgcolor", "background", "valign", "nowrap"],
  th: ["width", "height", "colspan", "rowspan", "bgcolor", "background", "valign", "nowrap"],
  col: ["span", "width", "valign"],
  colgroup: ["span", "width", "valign"],
  font: ["color", "face", "size"],
  hr: ["width", "size", "color", "noshade"],
  ol: ["start", "type"],
  ul: ["type"],
  li: ["type", "value"],
  time: ["datetime"],
};

/** The order attributes are written in, so both passes serialise identically. */
const ATTRIBUTE_ORDER = [
  "id", "class", "dir", "lang", "href", "target", "rel", "src", "alt", "title", "width", "height", "border", "hspace", "vspace",
  "cellpadding", "cellspacing", "colspan", "rowspan", "span", "align", "valign", "bgcolor", "background", "color", "face", "size",
  "noshade", "nowrap", "start", "type", "value", "datetime", "style",
];

const ALIGN = /^(left|right|center|justify|top|middle|bottom|baseline|absmiddle|absbottom|texttop)$/;
const VALIGN = /^(top|middle|bottom|baseline)$/;
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/;

/** Plain values of presentational attributes; anything else is dropped. */
function presentational(name: string, raw: string, tag: string): string | undefined {
  const value = raw.trim();
  const lower = value.toLowerCase();
  switch (name) {
    case "id": return /^[A-Za-z][\w:.-]{0,63}$/.test(value) ? value : undefined;
    case "class": {
      const tokens = value.split(/\s+/).filter((token) => /^-?[A-Za-z_][\w-]{0,63}$/.test(token)).slice(0, 16);
      return tokens.length ? tokens.join(" ") : undefined;
    }
    case "dir": return /^(ltr|rtl|auto)$/.test(lower) ? lower : undefined;
    case "lang": return /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) ? value : undefined;
    case "align": return ALIGN.test(lower) ? lower : undefined;
    case "valign": return VALIGN.test(lower) ? lower : undefined;
    case "width":
    case "height": {
      const match = /^(\d{1,5})(?:\.\d+)?\s*(px|%)?$/i.exec(value);
      if (!match) return undefined;
      const number = Number(match[1]);
      if (match[2] === "%") return number <= 100 ? `${number}%` : undefined;
      return number <= 5000 ? String(number) : undefined;
    }
    case "border":
    case "hspace":
    case "vspace":
    case "cellpadding":
    case "cellspacing": return /^\d{1,3}$/.test(value) ? value : undefined;
    case "colspan":
    case "rowspan":
    case "span": return /^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= 100 ? value : undefined;
    case "bgcolor":
    case "color": return COLOR.test(lower) ? lower : undefined;
    case "face": return /^[^<>;{}\\"\u0000-\u001f]{1,100}$/u.test(value) ? value : undefined;
    case "size":
      if (tag === "font") return /^[+-]?[1-7]$/.test(value) ? value : undefined;
      return /^\d{1,2}$/.test(value) ? value : undefined;
    case "noshade": return "noshade";
    case "nowrap": return "nowrap";
    case "start":
    case "value": return /^-?\d{1,6}$/.test(value) ? value : undefined;
    case "type": return /^(1|a|i|disc|circle|square)$/i.test(value) ? value : undefined;
    case "datetime": return /^[\dT:+\-.Z ]{1,40}$/.test(value) ? value : undefined;
    default: return undefined;
  }
}

const OWN_INLINE = (messageId: string) => new RegExp(`^/api/gmail/messages/${messageId}/inline/[A-Za-z0-9%._~!*'()-]{1,600}$`);
const OWN_PROXY = (messageId: string) => new RegExp(`^/api/mail-images/proxy\\?m=${messageId}&u=[A-Za-z0-9%._~!*'()-]{1,6200}&s=[A-Za-z0-9_-]{43}$`);
const OWN_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The same-origin URL of a message's inline part (cid:). */
export function inlineImagePath(messageId: string, contentId: string): string {
  return `/api/gmail/messages/${encodeURIComponent(messageId)}/inline/${encodeURIComponent(contentId)}`;
}

type Resolved = { kind: "ok"; url: string } | { kind: "blocked" } | { kind: "tracker" } | { kind: "invalid" };

/** Every image reference of a message goes through one policy, which also counts what it saw. */
class ImagePolicy {
  readonly remote = new Set<string>();
  readonly trackers = new Set<string>();
  readonly inline = new Set<string>();
  private dataBytes = 0;
  private readonly ownInline: RegExp;
  private readonly ownProxy: RegExp;

  constructor(private readonly options: SanitizeOptions, private readonly verify: boolean) {
    this.ownInline = OWN_INLINE(options.messageId);
    this.ownProxy = OWN_PROXY(options.messageId);
  }

  resolve(raw: string, where: "img" | "background" | "css"): Resolved {
    const value = raw.trim();
    if (this.verify) {
      // The second pass accepts exactly what the first pass writes.
      return this.ownInline.test(value) || this.ownProxy.test(value) || (where !== "background" && OWN_DATA.test(value))
        ? { kind: "ok", url: value } : { kind: "invalid" };
    }
    if (/^data:/i.test(value)) return where === "background" ? { kind: "invalid" } : this.data(value);
    if (/^cid:/i.test(value)) return this.cid(value);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { kind: "invalid" };
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port || url.href.length > 4000) return { kind: "invalid" };
    if (isTrackerUrl(url)) {
      this.trackers.add(url.href);
      return { kind: "tracker" };
    }
    if (!this.remote.has(url.href)) {
      if (this.remote.size >= MAIL_BODY_LIMITS.remoteImages) return { kind: "invalid" };
      this.remote.add(url.href);
    }
    return this.options.remote === "proxy" ? { kind: "ok", url: this.options.proxy(url.href) } : { kind: "blocked" };
  }

  /** A remote image the markup hides or shrinks to a pixel: counted, never fetched. */
  pixel(raw: string): boolean {
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    this.trackers.add(url.href);
    return true;
  }

  private cid(value: string): Resolved {
    let id: string;
    try {
      id = decodeURIComponent(value.slice(4)).trim().replace(/^<|>$/g, "");
    } catch {
      return { kind: "invalid" };
    }
    const found = this.options.inline.has(id) ? id : [...this.options.inline].find((candidate) => candidate.toLowerCase() === id.toLowerCase());
    if (!found) return { kind: "invalid" };
    this.inline.add(found);
    return { kind: "ok", url: inlineImagePath(this.options.messageId, found) };
  }

  private data(value: string): Resolved {
    const match = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]*)$/i.exec(value);
    if (!match) return { kind: "invalid" };
    const clean = match[2].replace(/\s+/g, "");
    const bytes = Buffer.from(clean, "base64");
    if (!bytes.length || bytes.length > MAIL_BODY_LIMITS.dataImageBytes || this.dataBytes + bytes.length > MAIL_BODY_LIMITS.dataImagesTotal) return { kind: "invalid" };
    const sniffed = sniffImage(bytes);
    const declared = match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase();
    // The declared type, and a size the reader can decode (a 64 KB PNG can declare gigabytes of pixels).
    if (!sniffed || sniffed.type !== declared || sniffed.type === "avif" || !acceptableRaster(sniffed)) return { kind: "invalid" };
    this.dataBytes += bytes.length;
    return { kind: "ok", url: `data:${sniffed.mime};base64,${bytes.toString("base64")}` };
  }
}

/** Absolute http, https and mailto links only, with the real destination as the tooltip. */
function linkAttributes(raw: string): { href: string; title: string } | undefined {
  const value = raw.trim();
  if (!value || value.length > 4000) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === "mailto:") {
    let address = url.pathname;
    try { address = decodeURIComponent(address); } catch { /* keep it encoded */ }
    // Bidi and other invisible format characters would make the tooltip read as a different address: no link.
    if (/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u.test(address)) return undefined;
    return { href: url.href, title: `寄信給 ${address.slice(0, 200)}` };
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.hostname) {
    return { href: url.href, title: `連到 ${url.host}` };
  }
  return undefined;
}

type Transform = (tagName: string, attribs: Record<string, string>) => { tagName: string; attribs: Record<string, string> };

/**
 * An image the transform removes (a tracking pixel, a source that can never
 * load) becomes an empty <span>: nothing to see, nothing to fetch. It is
 * renamed to an allowed tag on purpose: sanitize-html remembers a rename by
 * depth and only forgets it when the renamed element is written, so renaming
 * to a disallowed tag would leak onto the next element closed at that depth;
 * and cutting elements out with exclusiveFilter copies the whole output once
 * per element (quadratic on a mail with thousands of pixels).
 */
const dropped = () => ({ tagName: "span", attribs: {} });

/** Declarations sanitized per message at most; style attributes past it are dropped (a bound on hostile input). */
const MAX_STYLE_DECLARATIONS = 40_000;

/** The job's wall-clock budget, checked per element, style and rule (a clock read is cheap next to either). */
class Deadline {
  passed = false;

  constructor(private readonly at: number) {}

  readonly over = (): boolean => {
    if (!this.passed && performance.now() > this.at) this.passed = true;
    return this.passed;
  };
}

function transformer(policy: ImagePolicy, resolveCss: CssImageResolver, deadline: Deadline): Transform {
  // Newsletters repeat the same style attribute hundreds of times: each distinct one is sanitized once.
  const styles = new Map<string, string | undefined>();
  let budget = MAX_STYLE_DECLARATIONS;
  const styleOf = (raw: string): string | undefined => {
    if (styles.has(raw)) return styles.get(raw);
    if (deadline.over()) return undefined;
    const cost = (raw.match(/;/g)?.length ?? 0) + 1;
    if (budget < cost) return undefined;
    budget -= cost;
    const style = sanitizeStyleAttribute(raw, resolveCss);
    if (styles.size < 5000) styles.set(raw, style);
    return style;
  };
  return (name, attribs) => {
    // Past the budget nothing more is worked on (the result is refused anyway).
    if (deadline.over()) return dropped();
    // A mail's <body> becomes a div, so its background and padding stay inside the frame's page;
    // its bgcolor (which a div does not read) becomes the div's background colour.
    if (name === "body") {
      const color = presentational("bgcolor", attribs.bgcolor ?? "", "div");
      const image = (attribs.background ?? "").trim();
      // The image goes through the CSS path below like any other url() (the policy resolves it once).
      const background = image && !/["'\\()\s]/.test(image) ? `background-image:url("${image}")` : "";
      const style = [color ? `background-color:${color}` : "", background, attribs.style ?? ""].filter(Boolean).join(";");
      attribs = { ...attribs, ...(style ? { style } : {}) };
      delete attribs.bgcolor;
      delete attribs.background;
    }
    const tag = name === "body" ? "div" : name;
    if (!ALLOWED_TAGS.includes(tag)) return { tagName: tag, attribs: {} };
    const allowed = new Set([...GLOBAL_ATTRIBUTES, ...(TAG_ATTRIBUTES[tag] ?? [])]);
    const out: Record<string, string> = {};
    for (const key of ATTRIBUTE_ORDER) {
      if (!allowed.has(key) || attribs[key] === undefined) continue;
      const raw = attribs[key];
      if (key === "href" || key === "target" || key === "rel" || key === "title" || key === "src" || key === "background" || key === "alt") continue;
      if (key === "style") {
        const style = styleOf(raw);
        if (style) out.style = style;
        continue;
      }
      const value = presentational(key, raw, tag);
      if (value !== undefined) out[key] = value;
    }
    if (tag === "a") {
      const link = attribs.href === undefined ? undefined : linkAttributes(attribs.href);
      // A link with nowhere to go (an in-page #anchor, tel:, javascript:…) is plain text: a <span> keeps its style, not the link look.
      if (!link) return { tagName: "span", attribs: ordered(out) };
      Object.assign(out, { href: link.href, target: "_blank", rel: "noopener noreferrer", title: link.title });
    }
    if (allowed.has("background") && attribs.background !== undefined) {
      const resolved = policy.resolve(attribs.background, "background");
      if (resolved.kind === "ok") out.background = resolved.url;
    }
    if (tag === "img") {
      if (attribs.alt !== undefined) out.alt = attribs.alt.slice(0, 300);
      const source = attribs.src ?? "";
      const declarations = parseDeclarations(attribs.style ?? "") ?? [];
      const styled = hiddenByStyle(declarations);
      const width = Math.min(attributePixels(attribs.width) ?? Number.POSITIVE_INFINITY, styled.width ?? Number.POSITIVE_INFINITY);
      const height = Math.min(attributePixels(attribs.height) ?? Number.POSITIVE_INFINITY, styled.height ?? Number.POSITIVE_INFINITY);
      const tiny = invisibleSize(Number.isFinite(width) ? width : undefined, Number.isFinite(height) ? height : undefined);
      // An image nobody could see is a tracking pixel: removed, counted, never fetched.
      if ((tiny || styled.hidden) && policy.pixel(source)) return dropped();
      const resolved = policy.resolve(source, "img");
      if (resolved.kind === "tracker") return dropped();
      if (resolved.kind === "ok") out.src = resolved.url;
      // A source that could never load (javascript:, a relative path, svg data) leaves nothing to show but its alt text.
      if (resolved.kind === "invalid" && source.trim() && !out.alt) return dropped();
    }
    return { tagName: tag, attribs: ordered(out) };
  };
}

function ordered(attribs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTE_ORDER) if (attribs[key] !== undefined) out[key] = attribs[key];
  return out;
}

function allowedAttributes(): Record<string, string[]> {
  const map: Record<string, string[]> = { "*": GLOBAL_ATTRIBUTES };
  for (const [tag, attributes] of Object.entries(TAG_ATTRIBUTES)) map[tag] = [...attributes];
  return map;
}

/** Raw-text and dropped containers whose <style> children never count (they are not part of the page). */
const STYLE_SKIPPED = new Set(DROPPED_WITH_CONTENT.filter((tag) => tag !== "style" && tag !== "embed" && tag !== "frame"));

interface DocumentFacts {
  /** The text of each <style>, in order. */
  styles: string[];
  /** The checked `dir` and `lang` of the first <html> (the sanitizer drops <html> itself). */
  dir?: string;
  lang?: string;
}

/**
 * What the sanitizer itself does not keep, read with htmlparser2 (the parser
 * sanitize-html uses) in one linear pass: the text of the mail's <style>
 * elements, in order (styles inside svg, math, template, noscript and the
 * other dropped containers do not count), and the direction and language of
 * its <html>. The style text only ever reaches mail-css.ts, which rebuilds it
 * from a parse: none of it is written into the HTML.
 */
export function readDocument(html: string, budget: number = MAIL_BODY_LIMITS.cssChars): DocumentFacts {
  const facts: DocumentFacts = { styles: [] };
  const blocks = facts.styles;
  let skipped = 0;
  let current: string | undefined;
  let total = 0;
  let sawHtml = false;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "html" && !sawHtml) {
        sawHtml = true;
        const dir = presentational("dir", attribs.dir ?? "", "html");
        const lang = presentational("lang", attribs.lang ?? "", "html");
        if (dir) facts.dir = dir;
        if (lang) facts.lang = lang;
      }
      if (STYLE_SKIPPED.has(name)) skipped++;
      else if (name === "style" && skipped === 0) current = "";
    },
    ontext(text) {
      if (current === undefined || total >= budget) return;
      const part = text.slice(0, budget - total);
      current += part;
      total += part.length;
    },
    onclosetag(name) {
      if (name === "style" && current !== undefined) {
        blocks.push(current);
        current = undefined;
      } else if (STYLE_SKIPPED.has(name) && skipped > 0) skipped--;
    },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.write(html);
  parser.end();
  return facts;
}

/** The text of the mail's <style> elements (readDocument). */
export function styleBlocks(html: string, budget: number = MAIL_BODY_LIMITS.cssChars): string[] {
  return readDocument(html, budget).styles;
}

function pass(html: string, options: SanitizeOptions, verify: boolean, deadline: Deadline): { body: string; policy: ImagePolicy } {
  const policy = new ImagePolicy(options, verify);
  const resolveCss: CssImageResolver = (url) => {
    const resolved = policy.resolve(url, "css");
    return resolved.kind === "ok" ? resolved.url : undefined;
  };
  const body = sanitizeHtml(html, {
    // <style> is never written out: its text is read separately (styleBlocks) and rebuilt by mail-css.ts.
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: allowedAttributes(),
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "background", "cite"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    nonTextTags: DROPPED_WITH_CONTENT,
    parseStyleAttributes: false,
    nestingLimit: 200,
    enforceHtmlBoundary: false,
    parser: { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
    transformTags: { "*": transformer(policy, resolveCss, deadline) },
  });
  return { body, policy };
}

/**
 * The output must be a fixpoint: sanitizing it again (accepting only what we
 * wrote) changes nothing. Sloppy markup (a stray </p>, a <body> inside a <p>)
 * may settle one round later; then that round is served. Undefined when it
 * does not settle within two more rounds or a <style> is left in it.
 */
export function settle(body: string, again: (body: string) => { body: string; styles: number }): string | undefined {
  let current = body;
  for (let round = 0; round < 2; round++) {
    if (/<\/?style/i.test(current)) return undefined;
    const next = again(current);
    if (next.styles) return undefined;
    if (next.body === current) return current;
    current = next.body;
  }
  return undefined;
}

/**
 * Sanitizes a message's HTML for the reader's frame. `stable: false` means
 * the second pass disagreed (or, with `slow`, the budget ran out) and
 * nothing of it may be shown.
 */
export function sanitizeMailHtml(html: string, options: SanitizeOptions): SanitizedMail {
  const deadline = new Deadline(performance.now() + (options.budgetMs ?? SANITIZE_BUDGET_MS));
  const facts = readDocument(html);
  const first = pass(html, options, false, deadline);
  const resolveCss: CssImageResolver = (url) => {
    const resolved = first.policy.resolve(url, "css");
    return resolved.kind === "ok" ? resolved.url : undefined;
  };
  let css = "";
  for (const block of facts.styles) {
    const room = MAIL_BODY_LIMITS.cssChars - css.length;
    if (room <= 0 || deadline.over()) break;
    css += sanitizeStylesheet(block, resolveCss, room, deadline.over);
  }
  const settled = settle(first.body, (body) => ({ body: pass(body, options, true, deadline).body, styles: 0 }));
  const slow = deadline.over();
  const stable = settled !== undefined && !slow;
  return {
    body: stable ? settled : "",
    css: stable ? css : "",
    remote: first.policy.remote.size,
    remoteUrls: [...first.policy.remote],
    trackers: first.policy.trackers.size,
    inline: first.policy.inline,
    stable,
    ...(slow ? { slow } : {}),
    ...(facts.dir ? { dir: facts.dir } : {}),
    ...(facts.lang ? { lang: facts.lang } : {}),
  };
}

/** The frame's own CSP: no script, no fetch except same-origin and data: images, no fonts, forms, base or plugins. */
export const FRAME_CSP = "default-src 'none'; script-src 'none'; object-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; connect-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";

/** The frame's page before the mail's own CSS: white paper (system colours, light scheme), images that fit. */
const BASE_CSS = [
  ":root{color-scheme:light}",
  "html{background:Canvas;color:CanvasText;-webkit-text-size-adjust:100%;text-size-adjust:100%}",
  "body{margin:0;padding:16px;font-family:system-ui,-apple-system,\"Segoe UI\",\"Noto Sans TC\",\"PingFang TC\",\"Microsoft JhengHei\",sans-serif;font-size:15px;line-height:1.6;overflow-wrap:break-word}",
  "img{max-width:100%;height:auto}",
  "img:not([src])[width][height]{outline:1px dashed GrayText;outline-offset:-1px}",
  "a[href]{color:LinkText}",
  "pre{white-space:pre-wrap}",
  ".bell-mail{display:flow-root}",
].join("");

/**
 * After the mail's CSS: the page stays light paper, keeps its natural height
 * (the reader sizes the frame to it), and wide content scrolls inside the
 * frame, never the app.
 */
const OVERRIDE_CSS = [
  // The paper stays light whatever the owner's system uses (the mail cannot set color-scheme; this is the backstop).
  "html:root{color-scheme:light only!important}",
  "html:root,html:root>body{height:auto!important;min-height:0!important;max-height:none!important;position:static!important}",
  "html:root{overflow-x:auto!important;overflow-y:hidden!important}",
  "html:root>body{overflow:visible!important;width:auto!important;transform:none!important}",
].join("");

/** The whole page the reader puts in `<iframe sandbox srcdoc>`; the mail's <html> direction and language go on its wrapper. */
export function mailDocument(mail: Pick<SanitizedMail, "body" | "css" | "dir" | "lang">): string {
  // Both were checked by presentational(): ltr/rtl/auto and a BCP 47 tag, nothing to escape.
  const wrapper = `${mail.dir ? ` dir="${mail.dir}"` : ""}${mail.lang ? ` lang="${mail.lang}"` : ""}`;
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    "<meta name=\"referrer\" content=\"no-referrer\">",
    `<style>${BASE_CSS}</style>`,
    mail.css ? `<style>${mail.css}</style>` : "",
    `<style>${OVERRIDE_CSS}</style>`,
    `</head><body><div class="bell-mail"${wrapper}>${mail.body}</div></body></html>`,
  ].join("");
}
