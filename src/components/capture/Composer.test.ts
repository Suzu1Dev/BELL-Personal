import test from "node:test";
import assert from "node:assert/strict";
import type { ComposerTab } from "../../copy/ideas";
import { nextTabIndex, type TabItem } from "../Tabs";
import { changeComposerTab, COMPOSER_TABS } from "./Composer";

const items: TabItem<ComposerTab>[] = COMPOSER_TABS.map((value) => ({ value, label: value }));

test("keyboard navigation selects tabs without scheduling input focus", () => {
  const cases = [
    { from: "note", key: "ArrowRight", expected: "idea" },
    { from: "idea", key: "ArrowLeft", expected: "note" },
    { from: "idea", key: "ArrowRight", expected: "todo" },
    { from: "note", key: "Home", expected: "idea" },
    { from: "idea", key: "End", expected: "note" },
  ] as const;

  for (const { from, key, expected } of cases) {
    let selected: ComposerTab = from;
    let scheduled = 0;
    let focused = 0;
    const target = nextTabIndex(items, selected, key);
    changeComposerTab(items[target].value, "keyboard", (tab) => { selected = tab; }, () => { focused += 1; }, () => {
      scheduled += 1;
      return 1;
    });
    assert.equal(selected, expected, `${key} from ${from}`);
    assert.equal(scheduled, 0, `${key} must not schedule textarea focus`);
    assert.equal(focused, 0, `${key} must leave focus on the selected tab`);
  }
});

test("pointer navigation focuses the input only when the scheduled frame runs", () => {
  let selected: ComposerTab = "idea";
  let frame: FrameRequestCallback | undefined;
  let focused = 0;
  changeComposerTab("todo", "pointer", (tab) => { selected = tab; }, () => { focused += 1; }, (callback) => {
    frame = callback;
    return 1;
  });
  assert.equal(selected, "todo");
  assert.equal(focused, 0, "focus waits for the animation frame");
  frame?.(0);
  assert.equal(focused, 1);
});
