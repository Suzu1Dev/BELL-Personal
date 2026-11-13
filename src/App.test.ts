import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("English document metadata updates the DOM and route title", async (t) => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const description = { content: "" };
  const target = {
    documentElement: { lang: "zh-Hant" },
    title: "",
    querySelector: (selector: string) => selector === 'meta[name="description"]' ? description : null,
  } as unknown as Document;
  globalThis.window = { location: { search: "?lang=en" } } as Window & typeof globalThis;
  globalThis.document = target;
  t.after(() => {
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else globalThis.document = previousDocument;
  });

  const { applyDocumentMetadata } = await import("./App");
  applyDocumentMetadata({ name: "today" }, null, {}, target);
  assert.equal(target.documentElement.lang, "en");
  assert.equal(target.title, "BELL Personal · Your daily workspace");
  assert.equal(description.content, "Open once a day—mail, calendar, tasks, ideas, and habits in one calm place.");

  applyDocumentMetadata({ name: "settings", tab: "ai" }, null, {}, target);
  assert.equal(target.title, "Settings · BELL Personal");
});

test("the install manifest uses the Today place name", () => {
  const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8")) as { short_name: string };
  assert.equal(manifest.short_name, "BELL 今日");
});
