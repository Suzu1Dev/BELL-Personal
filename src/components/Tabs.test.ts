import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { nextTabIndex, setTabKeyboardFocus, tabInteractionForClick, tabValueFromTarget, Tabs, type TabItem } from "./Tabs";

const items: TabItem<"a" | "b" | "c">[] = [
  { value: "a", label: "A", controls: "panel-a" },
  { value: "b", label: "B", controls: "panel-b" },
  { value: "c", label: "C", controls: "panel-c" },
];

test("link tabs keep route semantics while using the shared focus container", () => {
  const linked = items.map(item => ({ ...item, href: `#/${item.value}` }));
  const html = renderToStaticMarkup(createElement(Tabs, { label: "分頁", items: linked, value: "b" }));
  assert.match(html, /<nav class="tabs" aria-label="分頁">/);
  assert.match(html, /<a href="#\/b" class="tab is-active" aria-current="page">/);
  assert.equal((html.match(/<a /g) ?? []).length, 3);
});

test("ARIA tabs keep roving tabindex and arrow, Home and End behavior", () => {
  const html = renderToStaticMarkup(createElement(Tabs, { label: "分頁", items, value: "b" }));
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" data-value="b" class="tab is-active" aria-selected="true" aria-controls="panel-b" tabindex="0"/);
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 2);
  assert.equal(nextTabIndex(items, "c", "ArrowRight"), 0);
  assert.equal(nextTabIndex(items, "a", "ArrowLeft"), 2);
  assert.equal(nextTabIndex(items, "c", "Home"), 0);
  assert.equal(nextTabIndex(items, "a", "End"), 2);
  assert.equal(nextTabIndex(items, "a", "Unidentified"), -1);
});

test("arrow navigation starts at the focused tab after pointer drag-off", () => {
  const focused = { closest: () => ({ getAttribute: () => "c" }) } as unknown as EventTarget;
  assert.equal(tabValueFromTarget(items, "a", focused), "c");
  assert.equal(nextTabIndex(items, tabValueFromTarget(items, "a", focused), "ArrowRight"), 0);
  assert.equal(nextTabIndex(items, "a", "ArrowRight"), 1, "the selected tab is not the keyboard origin");
  assert.equal(tabValueFromTarget(items, "b", null), "b");
});

test("native Enter and Space clicks stay keyboard; mouse and touch clicks are pointer", () => {
  assert.equal(tabInteractionForClick(0), "keyboard");
  assert.equal(tabInteractionForClick(1), "pointer");
  assert.equal(tabInteractionForClick(2), "pointer");
});

test("pointer-cancel to keyboard restores the focus ring, then pointer clears it", () => {
  const classes = new Set<string>();
  const tabs = {
    classList: {
      toggle: (name: string, enabled: boolean) => {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  } as unknown as HTMLDivElement;

  setTabKeyboardFocus(tabs, false);
  assert.equal(classes.has("is-keyboard-focus"), false, "drag-off leaves no keyboard ring");
  setTabKeyboardFocus(tabs, true);
  assert.equal(classes.has("is-keyboard-focus"), true, "the next keyboard operation restores the ring");
  setTabKeyboardFocus(tabs, false);
  assert.equal(classes.has("is-keyboard-focus"), false, "returning to pointer clears the ring");
});
