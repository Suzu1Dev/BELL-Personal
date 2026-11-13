import test from "node:test";
import assert from "node:assert/strict";
import { STORAGE_KEYS } from "../../lib/storage";
import { handToPalette, modEnterIntent } from "./CaptureField";

/** A window with a working localStorage for the draft (node has none). */
function withStorage(t: test.TestContext): Map<string, string> {
  const store = new Map<string, string>();
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    },
  };
  t.after(() => { (globalThis as { window?: unknown }).window = previous; });
  return store;
}

test("⌘↵ in the capture field opens the palette only when AI 解析 is there; otherwise it saves like ↵", () => {
  assert.equal(modEnterIntent(true), "palette");
  assert.equal(modEnterIntent(false), "submit");
});

test("the text handed to the palette is its draft, so Esc in the palette keeps it", (t) => {
  const store = withStorage(t);
  const opened: Array<[string, string]> = [];
  handToPalette("下週找時間跟教授聊提案 ", (mode, text) => { opened.push([mode, text]); });
  assert.deepEqual(opened, [["capture", "下週找時間跟教授聊提案 "]]);
  // The palette restores composerDraft the next time it opens in capture mode.
  assert.equal(store.get(STORAGE_KEYS.composerDraft), "下週找時間跟教授聊提案");

  store.set(STORAGE_KEYS.composerDraft, "older draft");
  handToPalette("   ", () => {});
  assert.equal(store.get(STORAGE_KEYS.composerDraft), "older draft", "an empty hand-over keeps the palette's own draft");
});
