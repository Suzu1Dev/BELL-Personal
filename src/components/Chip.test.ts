import test from "node:test";
import assert from "node:assert/strict";
import { scrollFocusedChipIntoView } from "./Chip";

test("a focused chip scrolls both axes only as far as needed in an overflowing row", () => {
  const calls: ScrollIntoViewOptions[] = [];
  scrollFocusedChipIntoView(
    { scrollWidth: 520, clientWidth: 280 },
    { scrollIntoView: options => calls.push(options) },
  );
  assert.deepEqual(calls, [{ block: "nearest", inline: "nearest" }]);
});

test("a chip row without horizontal overflow leaves the user's scroll position alone", () => {
  let called = false;
  scrollFocusedChipIntoView(
    { scrollWidth: 280, clientWidth: 280 },
    { scrollIntoView: () => { called = true; } },
  );
  assert.equal(called, false);
});
