import test from "node:test";
import assert from "node:assert/strict";
import {
  blankCssStrings, decodeCssEscapes, functionNames, hiddenByStyle, lightMediaQueries, parseDeclarations, sanitizeDeclaration, sanitizeStyleAttribute,
  sanitizeStylesheet, sizesWithinCaps, stripCssComments,
} from "./mail-css.js";

/**
 * The CSS half of the mail sanitizer (SPEC-mail-html §3.3): escapes and
 * comments are seen through, every url() becomes ours or `none`, only an
 * allowlist of functions survives, no overlay positions or viewport units,
 * only rules and @media, and the output can never close its <style>.
 */

const ours = (url: string) => (url.startsWith("https://img.ok.com/") ? `/api/mail-images/proxy?u=${encodeURIComponent(url)}` : undefined);
const decl = (prop: string, value: string, important = false) => sanitizeDeclaration(prop, value, important, ours);

test("escapes and comments are decoded before anything is judged", () => {
  assert.equal(decodeCssEscapes("u\\72l(x)"), "url(x)");
  assert.equal(decodeCssEscapes("\\75 rl(x)"), "url(x)");
  assert.equal(decodeCssEscapes("\\000075rl(x)"), "url(x)");
  assert.equal(decodeCssEscapes("ur\\l(x)"), "url(x)");
  assert.equal(decodeCssEscapes("\\0 x"), "\ufffdx", "NUL becomes U+FFFD as in CSS");
  assert.equal(stripCssComments("a/* x */b/* unterminated"), "a b ");
  // Linear on hostile input: many openers without a closer.
  const started = performance.now();
  stripCssComments("/*".repeat(200_000));
  decodeCssEscapes("\\".repeat(200_000));
  assert.ok(performance.now() - started < 1000);
});

test("declarations: what fetches, runs or overlays is dropped or rewritten, ordinary layout stays", () => {
  const dropped: Array<[string, string]> = [
    ["background", "u\\72l(https://evil.example/x.png)"],
    ["background", "\\75 rl(https://evil.example/x.png)"],
    ["background", "url/**/(https://evil.example/x.png)"],
    ["background", "url (https://evil.example/x.png)"],
    ["width", "expression(alert(1))"],
    ["xss", "expr/*x*/ession(alert(1))"],
    ["behavior", "url(x.htc)"],
    ["-ms-behavior", "url(x.htc)"],
    ["-moz-binding", "url(x.xml#x)"],
    ["\\62 ehavior", "url(x.htc)"],
    ["background", "image-set(\"https://evil.example/x.png\" 1x)"],
    ["background", "-webkit-image-set(url(https://evil.example/x.png) 1x)"],
    ["background", "cross-fade(url(a), url(b), 50%)"],
    ["background", "element(#x)"],
    ["background", "paint(x)"],
    ["color", "var(--x)"],
    ["--x", "url(https://evil.example/x.png)"],
    ["content", "attr(data-x)"],
    ["width", "env(safe-area-inset-left)"],
    ["position", "fixed"],
    ["position", "sticky"],
    ["position", "absolute"],
    ["position", "-webkit-sticky"],
    ["height", "100vh"],
    ["min-height", "50dvh"],
    ["width", "100000px"],
    ["font-size", "9999px"],
    ["line-height", "500"],
    ["width", "50000%"],
    ["content", "\"</style><script>alert(1)</script>\""],
    ["font-family", "x;y"],
    ["color", "red}body{color:blue"],
    ["filter", "progid:DXImageTransform.Microsoft.Alpha(opacity=50)"],
    ["background", "url(javascript:alert(1)) red, foo(1)"],
    ["src", "url(https://img.ok.com/f.woff)"],
    ["color", "\\\\"],
    ["color", "red\u0000"],
    ["font-family", "@font"],
  ];
  for (const [prop, value] of dropped) assert.equal(decl(prop, value), undefined, `${prop}: ${value}`);

  const kept: Array<[string, string, string]> = [
    ["color", "#1d2b3a", "color:#1d2b3a"],
    ["padding", "16px 24px", "padding:16px 24px"],
    ["font-family", "\"Helvetica Neue\", Arial, \"PingFang TC\", sans-serif", "font-family:\"Helvetica Neue\", Arial, \"PingFang TC\", sans-serif"],
    ["font-family", "\"Foo (Bold)\", serif", "font-family:\"Foo (Bold)\", serif"],
    ["background", "linear-gradient(90deg, rgba(0,0,0,.2), #fff)", "background:linear-gradient(90deg, rgba(0,0,0,.2), #fff)"],
    ["width", "calc(100% - 32px)", "width:calc(100% - 32px)"],
    ["transform", "translateX(-4px) rotate(2deg)", "transform:translateX(-4px) rotate(2deg)"],
    ["position", "relative", "position:relative"],
    ["max-width", "600px", "max-width:600px"],
    ["border", "1px/* x */solid #ddd", "border:1px solid #ddd"],
    ["content", "\"\\3c\"", "content:\"\\3c\""],
  ];
  for (const [prop, value, expected] of kept) assert.equal(decl(prop, value), expected, `${prop}: ${value}`);
  assert.equal(decl("display", "none", true), "display:none !important");
});

test("url(): an allowed image becomes our URL, anything else becomes none and the rest of the declaration stays", () => {
  assert.equal(decl("background", "#fff url(https://img.ok.com/bg.png) no-repeat"), "background:#fff url(\"/api/mail-images/proxy?u=https%3A%2F%2Fimg.ok.com%2Fbg.png\") no-repeat");
  assert.equal(decl("background", "#fff url( 'https://img.ok.com/bg.png' ) top"), "background:#fff url(\"/api/mail-images/proxy?u=https%3A%2F%2Fimg.ok.com%2Fbg.png\") top");
  assert.equal(decl("background", "#fff URL(https://evil.example/bg.png) no-repeat"), "background:#fff none no-repeat");
  assert.equal(decl("background-image", "url(javascript:alert(1))"), undefined, "a url( that does not even tokenise is dropped");
  assert.equal(decl("background-image", "url(javascript:void0)"), "background-image:none");
  assert.equal(decl("list-style", "url(data:text/html,x) disc"), "list-style:none disc");
  assert.equal(decl("cursor", "url(https://evil.example/c.cur), auto"), "cursor:none, auto");
  assert.equal(decl("background", "url(https://img.ok.com/a.png\\)"), undefined, "an escaped url() is dropped, never rewritten");
});

test("stylesheets keep rules and @media only, rebuilt without comments, and cannot close their <style>", () => {
  const css = sanitizeStylesheet(`
    @charset "utf-8";
    @import url("https://evil.example/a.css");
    /* @import "https://evil.example/in-comment.css"; */
    @font-face { font-family: X; src: url(https://evil.example/x.woff); }
    @namespace svg url(http://www.w3.org/2000/svg);
    @keyframes spin { from { transform: rotate(0) } }
    @supports (display:grid) { .a { display: grid } }
    @layer base { .a { color: red } }
    @page { margin: 1cm }
    @-moz-document url-prefix() { .a { color: red } }
    body { margin: 0; background: #f2f4f7 }
    .card { max-width: 600px; position: fixed; top: 0 }
    .hero { background: url(https://img.ok.com/h.png) center/cover }
    @media only screen and (max-width: 480px) { .thumb { display: none !important } @media print { .x { color: red } } }
    @media screen and (url(x)) { .x { color: red } }
    .x:has(:is(:has(:is(:has(:is(a)))))) { color: red }
    .y { content: "\\3c /style\\3e " }
  `, ours);
  assert.equal(css, [
    "body{margin:0;background:#f2f4f7}",
    ".card{max-width:600px;top:0}",
    ".hero{background:url(\"/api/mail-images/proxy?u=https%3A%2F%2Fimg.ok.com%2Fh.png\") center/cover}",
    "@media only screen and (max-width: 480px){.thumb{display:none !important}}",
    ".y{content:\"\\3c /style\\3e \"}",
  ].join(""));
  assert.doesNotMatch(css, /</);
  assert.equal(sanitizeStylesheet("@\\69mport url(https://evil.example/x.css); a{color:red}", ours), "", "an escaped at-rule name does not parse: the whole block goes");
  assert.equal(sanitizeStylesheet("a{color:red", ours), "", "an unclosed block does not parse: dropped");
  assert.equal(sanitizeStylesheet("a{content:\"unclosed}", ours), "", "a parse error drops the whole block");
  assert.equal(sanitizeStylesheet("a{color:red}".repeat(100), ours, 30).length, 24, "the size budget stops at whole rules");
});

test("style attributes: parsed like sanitize-html does, unparseable or empty ones dropped; hidden images recognised", () => {
  assert.equal(sanitizeStyleAttribute("color: red; position: fixed; width: 100vh; background: url(https://img.ok.com/x.png)", ours),
    "color:red;background:url(\"/api/mail-images/proxy?u=https%3A%2F%2Fimg.ok.com%2Fx.png\")");
  assert.equal(sanitizeStyleAttribute("position:fixed", ours), undefined);
  assert.equal(sanitizeStyleAttribute("color:red} body{color:blue", ours), "color:red", "a closing brace cannot add rules");
  assert.equal(sanitizeStyleAttribute("x".repeat(5000), ours), undefined, "over the attribute cap");
  assert.deepEqual(parseDeclarations("width:1px;height:1px"), [{ prop: "width", value: "1px", important: false }, { prop: "height", value: "1px", important: false }]);
  assert.deepEqual(hiddenByStyle(parseDeclarations("width:1px;height:1px")!), { hidden: false, width: 1, height: 1 });
  assert.equal(hiddenByStyle(parseDeclarations("display: none")!).hidden, true);
  assert.equal(hiddenByStyle(parseDeclarations("visibility:hidden")!).hidden, true);
  assert.equal(hiddenByStyle(parseDeclarations("opacity:0.0")!).hidden, true);
  assert.equal(hiddenByStyle(parseDeclarations("opacity:.5")!).hidden, false);
  assert.equal(hiddenByStyle(parseDeclarations("opacity:0%")!).hidden, true);
  assert.deepEqual(hiddenByStyle(parseDeclarations("width:1e0px;height:.1E1")!), { hidden: false, width: 1, height: 1 }, "numbers are read whole");
  assert.deepEqual(hiddenByStyle(parseDeclarations("width:1em;height:-1px")!), { hidden: false });
});

test("a sender's inline source map is never read: <style> blocks and style attributes come out as if it were absent", () => {
  // postcss decodes a `/*# sourceMappingURL=data:… */` comment and hands it to source-map-js unless parse() gets
  // { map: false } (GHSA-68fv-2mgg-jv7q: an indexed map can hold the event loop). Each map here makes that loader
  // throw (base64 decoding, an indexed map through URI decoding, an unknown encoding), so if postcss read it the
  // stylesheet would come back empty and the style attribute would not parse.
  const brokenMaps = [
    `data:application/json;base64,${Buffer.from("{}").toString("base64")}`,
    `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 } }] }))}`,
    "data:application/json;charset=utf-16,{}",
  ];
  const css = "body { margin: 0 } @media only screen and (max-width: 480px) { .thumb { display: none } }";
  const clean = sanitizeStylesheet(css, ours);
  assert.equal(clean, "body{margin:0}@media only screen and (max-width: 480px){.thumb{display:none}}");
  for (const map of brokenMaps) {
    const annotation = `/*# sourceMappingURL=${map} */`;
    assert.equal(sanitizeStylesheet(`${css}\n${annotation}`, ours), clean, `<style> with ${map}`);
    assert.deepEqual(parseDeclarations(`color: red; ${annotation}`), [{ prop: "color", value: "red", important: false }], `style attribute with ${map}`);
    assert.equal(sanitizeStyleAttribute(`color: red; ${annotation}`, ours), "color:red", `style attribute with ${map}`);
  }
});

test("every scan is linear: a 2,000-digit number, long runs of spaces, parentheses or quotes take milliseconds", () => {
  const time = (label: string, run: () => unknown) => {
    const started = performance.now();
    run();
    const ms = performance.now() - started;
    assert.ok(ms < 50, `${label} took ${Math.round(ms)} ms`);
  };
  // The ReDoS: `(\d*\.?\d+)(px|…)` over a digit run with no unit backtracked cubically (2.2 s for one declaration).
  time("width digits", () => assert.equal(decl("width", "1".repeat(1999)), undefined));
  time("width zero-padded digits", () => assert.equal(decl("width", `0001${"1".repeat(1995)}`), undefined));
  time("style attribute", () => sanitizeStyleAttribute(`width:${"1".repeat(1999)};height:${"2".repeat(1999)}`, ours));
  time("stylesheet", () => sanitizeStylesheet(`.a{width:${"1".repeat(1999)}}.b{margin:${"1.".repeat(999)}}`, ours));
  time("fraction digits", () => decl("width", `.${"1".repeat(1998)}`));
  time("exponent run", () => decl("width", `1e${"1".repeat(1997)}`));
  time("spaces before a parenthesis", () => decl("font-family", `a${" ".repeat(1990)}(`));
  time("many parentheses", () => decl("width", "calc(".repeat(400)));
  time("many quotes", () => decl("font-family", "\"'".repeat(999)));
  time("escaped quotes", () => decl("content", "\\\"".repeat(666)));
  time("hidden style", () => hiddenByStyle([{ prop: "width", value: "1".repeat(4000), important: false }, { prop: "opacity", value: "0".repeat(4000), important: false }]));
});

test("sizes are read whole and added up: exponents, calc() products and sums, repeat() counts and unitless multipliers are capped", () => {
  const dropped: Array<[string, string]> = [
    ["width", "1e9px"],
    ["height", "1E9px"],
    ["width", "1e4px"],
    ["width", "50e2%"],
    ["width", "calc(5000px * 5000)"],
    ["width", "calc(5000px*5000)"],
    ["width", "calc(2 * 3000px)"],
    ["width", "calc(5000px / 0.0001)"],
    ["width", "calc(5000px / 0)"],
    ["width", "calc(10px * (5000px / 1px))"],
    ["width", "calc(5000px + 5000px)"],
    ["width", "min(5000px * 2, 10px)"],
    ["margin", "3000px auto 3000px"],
    ["grid-template-columns", "repeat(100, 1000px)"],
    ["zoom", "10000"],
    ["zoom", "1e3"],
    ["zoom", "100000%"],
    ["transform", "scale(10000)"],
    ["transform", "scaleX(1e3) rotate(1deg)"],
    ["transform", "scale(calc(10 * 10))"],
    ["scale", "50"],
    ["line-height", "1e9"],
    ["line-height", "calc(5 * 5)"],
    ["tab-size", "1e9"],
    ["width", `${"1".repeat(13)}px`],
    ["width", "1e1234px"],
    ["height", "100svh"],
    ["width", "10dvw"],
    ["transform", "translateZ(1px) perspective(1px)"],
    ["transform", "matrix(1e4, 0, 0, 1e4, 0, 0)"],
  ];
  for (const [prop, value] of dropped) assert.equal(decl(prop, value), undefined, `${prop}: ${value}`);
  const kept: Array<[string, string]> = [
    ["width", "calc(100% / 3)"],
    ["width", "calc(100% - 32px)"],
    ["width", "calc(600px * 0.5)"],
    ["width", "5000px"],
    ["padding", "20px 24px 20px 24px"],
    ["font", "bold 14px/1.5 Arial"],
    ["line-height", "1.5"],
    ["zoom", "1.25"],
    ["transform", "scale(1.05) translateX(-50%)"],
    ["grid-template-columns", "repeat(3, 1fr)"],
    ["grid-template-columns", "repeat(4, 150px)"],
    ["color", "#1e9e9e"],
    ["border", "1px solid #ddd"],
    ["margin", "-8px 0 0 -8px"],
    ["z-index", "2147483647"],
    ["font-weight", "700"],
    ["border-radius", "9999px"],
    ["border-top-left-radius", "9999px"],
  ];
  for (const [prop, value] of kept) assert.ok(decl(prop, value), `${prop}: ${value}`);
  assert.equal(sizesWithinCaps("calc(5000px * 5000)", "width"), false);
  assert.equal(sizesWithinCaps("calc(5000px *", "width"), false, "an operator with nothing after it");
  assert.equal(sizesWithinCaps("h1 2x3 translate3d", "width"), true, "digits inside names are not numbers");
});

test("the function allowlist reads strings the way CSS does: an escaped quote does not hide a function", () => {
  assert.equal(blankCssStrings(`"Foo (Bold)", serif`), `"", serif`);
  assert.equal(blankCssStrings(`\\"x foo(1) \\"`), `\\"x foo(1) \\"`, "escaped quotes open no string");
  assert.equal(blankCssStrings(`"a\\"b" x`), `"" x`, "an escaped quote inside a string does not end it");
  assert.equal(blankCssStrings(`"unclosed`), `""`);
  assert.deepEqual(functionNames("rgb(1,2,3) calc (1px) (x)"), ["rgb", "calc", ""]);
  const dropped: Array<[string, string]> = [
    ["content", `\\"x foo(1) \\"`],
    ["width", `\\"x if(media(pointer:coarse): 10px) \\"`],
    ["color", `\\"x light-dark(red, blue) \\"`],
    ["content", `"\\"" foo(1) "\\""`],
    ["color", "light-dark(red, blue)"],
  ];
  for (const [prop, value] of dropped) assert.equal(decl(prop, value), undefined, `${prop}: ${value}`);
  assert.equal(decl("font-family", `"\\5FAE\\8EDF\\6B63\\9ED1\\9AD4", sans-serif`), `font-family:"\\5FAE\\8EDF\\6B63\\9ED1\\9AD4", sans-serif`, "an escaped font name (微軟正黑體) stays");
  assert.equal(decl("content", `"a (b) c"`), `content:"a (b) c"`);
});

test("the paper stays light: color-scheme is dropped and prefers-color-scheme queries are settled as light", () => {
  assert.equal(decl("color-scheme", "light dark"), undefined);
  assert.equal(decl("supported-color-schemes", "light dark"), undefined);
  assert.equal(decl("COLOR-SCHEME", "dark"), undefined);
  const settled: Array<[string, string | undefined]> = [
    ["(prefers-color-scheme: dark)", undefined],
    ["(prefers-color-scheme:dark)", undefined],
    ["screen and (prefers-color-scheme: dark)", undefined],
    ["not all and (prefers-color-scheme: light)", undefined],
    ["not (prefers-color-scheme: dark)", undefined],
    ["(prefers-color-scheme: dark) or (min-width: 1px)", undefined],
    ["(prefers-color-scheme)", undefined],
    ["(prefers-color-scheme: light)", "all"],
    ["only screen and (prefers-color-scheme: light)", "only screen"],
    ["(prefers-color-scheme: light) and (max-width: 600px)", "(max-width: 600px)"],
    ["(max-width: 600px), (prefers-color-scheme: dark)", "(max-width: 600px)"],
    ["(max-width: 480px)", "(max-width: 480px)"],
  ];
  for (const [params, expected] of settled) assert.equal(lightMediaQueries(params), expected, params);
  const css = sanitizeStylesheet(`
    :root { color-scheme: light dark; supported-color-schemes: light dark }
    .txt { color: #1a1a1a }
    @media (prefers-color-scheme: dark) { .txt { color: #f2f2f2 !important } }
    @media (PREFERS-COLOR-SCHEME: DARK) { .hdr { background: #1e1e1e } }
    @media (prefers-color-scheme: light) { .hdr { background: #fff } }
  `, ours);
  assert.equal(css, ".txt{color:#1a1a1a}@media all{.hdr{background:#fff}}");
});
