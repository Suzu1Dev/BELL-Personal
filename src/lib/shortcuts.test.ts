import test from "node:test";
import assert from "node:assert/strict";
import { blockingDialogOpen, hasModKey, isComposing, isEmptyTextField, isTypingTarget, normalizeKey } from "./keys";
import { GO_CHORDS, SHORTCUTS, createShortcutDispatcher, displayKeys, inboxLegendItems, undoKeyHint, visibleKeyHint } from "./shortcuts";

interface FakeEvent {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
  prevented: boolean;
  preventDefault(): void;
}

function keydown(key: string, init: Partial<Omit<FakeEvent, "prevented" | "preventDefault">> = {}): FakeEvent {
  return { key, target: { tagName: "BODY" }, ...init, prevented: false, preventDefault() { this.prevented = true; } };
}

function setup(overrides: { singleKeys?: boolean; apple?: boolean; dialogOpen?: boolean } = {}) {
  let clock = 1_000;
  const seen: string[] = [];
  const dispatcher = createShortcutDispatcher({
    singleKeys: () => overrides.singleKeys ?? true,
    apple: () => overrides.apple ?? false,
    dialogOpen: () => overrides.dialogOpen ?? false,
    now: () => clock,
  });
  dispatcher.register((combo) => { seen.push(combo); return true; });
  return { dispatcher, seen, advance: (ms: number) => { clock += ms; } };
}

test("IME guard (SPEC-ux §13 gate 7): keydown E while composing does nothing", () => {
  const { dispatcher, seen } = setup();
  const composing = keydown("e", { isComposing: true });
  assert.equal(dispatcher.handle(composing), false);
  assert.equal(composing.prevented, false);
  const safari = keydown("e", { keyCode: 229 });
  assert.equal(dispatcher.handle(safari), false);
  // Not even ⌘K fires mid-composition.
  assert.equal(dispatcher.handle(keydown("k", { ctrlKey: true, isComposing: true })), false);
  assert.deepEqual(seen, []);
  // The same key after composition ends is a shortcut.
  assert.equal(dispatcher.handle(keydown("e")), true);
  assert.deepEqual(seen, ["e"]);
});

test("isComposing reads isComposing and keyCode 229", () => {
  assert.equal(isComposing({ isComposing: true }), true);
  assert.equal(isComposing({ keyCode: 229 }), true);
  assert.equal(isComposing({ isComposing: false, keyCode: 69 }), false);
});

test("typing targets receive keys as text, except ⌘K / Ctrl K", () => {
  for (const target of [{ tagName: "INPUT" }, { tagName: "textarea" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
    assert.equal(isTypingTarget(target), true);
    const { dispatcher, seen } = setup();
    assert.equal(dispatcher.handle(keydown("e", { target })), false);
    assert.equal(dispatcher.handle(keydown("k", { target, ctrlKey: true })), true);
    assert.deepEqual(seen, ["mod+k"]);
  }
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("⌘Z / Ctrl Z undoes the last action from an empty text field (right after ↵ in the capture field), not from one with text", () => {
  const { dispatcher, seen } = setup();
  const empty = { tagName: "INPUT", type: "text", value: "" };
  assert.equal(dispatcher.handle(keydown("z", { ctrlKey: true, target: empty })), true);
  assert.deepEqual(seen, ["mod+z"]);
  assert.equal(dispatcher.handle(keydown("z", { ctrlKey: true, target: { tagName: "INPUT", type: "text", value: "想到" } })), false, "text in the field: the browser's own undo");
  assert.equal(dispatcher.handle(keydown("z", { target: empty })), false, "a bare Z still types z");
  assert.equal(dispatcher.handle(keydown("z", { ctrlKey: true, shiftKey: true, target: empty })), false, "redo stays native");
  const dialog = setup({ dialogOpen: true });
  assert.equal(dialog.dispatcher.handle(keydown("z", { ctrlKey: true, target: empty })), false);
  // No visible undo toast: the handler passes, nothing is prevented and the browser keeps the key.
  const idle = createShortcutDispatcher({ singleKeys: () => true, apple: () => false, dialogOpen: () => false, now: () => 0 });
  idle.register(() => false);
  const passed = keydown("z", { ctrlKey: true, target: empty });
  assert.equal(idle.handle(passed), false);
  assert.equal(passed.prevented, false);
  assert.equal(isEmptyTextField({ tagName: "TEXTAREA", value: "" }), true);
  assert.equal(isEmptyTextField({ tagName: "INPUT", type: "checkbox", value: "" }), false);
  assert.equal(isEmptyTextField({ tagName: "INPUT", type: "datetime-local", value: "" }), false);
  assert.equal(isEmptyTextField({ tagName: "BUTTON" }), false);
  // The toast advertises the key that works where focus is.
  assert.equal(undoKeyHint(true, false, false), "Z");
  assert.equal(undoKeyHint(true, true, false), "Ctrl Z");
  assert.equal(undoKeyHint(true, true, true), "⌘Z");
  assert.equal(undoKeyHint(false, false, false), "Ctrl Z", "單鍵快捷鍵 off: a bare Z does nothing");
});

test("the platform modifier: ⌘ on Apple, Ctrl elsewhere", () => {
  assert.equal(hasModKey({ metaKey: true }, true), true);
  assert.equal(hasModKey({ ctrlKey: true }, true), false);
  assert.equal(hasModKey({ ctrlKey: true }, false), true);
  assert.equal(hasModKey({ metaKey: true, ctrlKey: true }, false), false);
  const apple = setup({ apple: true });
  assert.equal(apple.dispatcher.handle(keydown("k", { metaKey: true })), true);
  assert.equal(apple.dispatcher.handle(keydown("k", { ctrlKey: true })), false);
  assert.deepEqual(apple.seen, ["mod+k"]);
  assert.deepEqual(displayKeys(["Mod", "K"], true), ["⌘", "K"]);
  assert.deepEqual(displayKeys(["Mod", "K"], false), ["Ctrl", "K"]);
});

test("Alt, other modifier combos and open dialogs are ignored", () => {
  const { dispatcher, seen } = setup();
  assert.equal(dispatcher.handle(keydown("e", { altKey: true })), false);
  assert.equal(dispatcher.handle(keydown("e", { ctrlKey: true })), false);
  assert.equal(dispatcher.handle(keydown("e", { metaKey: true })), false);
  assert.equal(dispatcher.handle(keydown("z", { ctrlKey: true })), true);
  assert.deepEqual(seen, ["mod+z"]);
  const dialog = setup({ dialogOpen: true });
  assert.equal(dialog.dispatcher.handle(keydown("e")), false);
  assert.equal(dialog.dispatcher.handle(keydown("k", { ctrlKey: true })), true);
});

test("blockingDialogOpen ignores the command palette", () => {
  const dialogs = (...classes: string[]) => ({ querySelectorAll: () => classes.map((name) => ({ classList: { contains: (value: string) => value === name } })) });
  assert.equal(blockingDialogOpen(dialogs()), false);
  assert.equal(blockingDialogOpen(dialogs("palette")), false);
  assert.equal(blockingDialogOpen(dialogs("palette", "dialog")), true);
});

test("turning 單鍵快捷鍵 off silences letters, digits and symbols but not named keys or ⌘K", () => {
  const { dispatcher, seen } = setup({ singleKeys: false });
  for (const key of ["e", "n", "?", "1", "g", "z"]) assert.equal(dispatcher.handle(keydown(key)), false, key);
  for (const key of ["Escape", "Enter", "ArrowDown", " "]) assert.equal(dispatcher.handle(keydown(key)), true, key);
  assert.equal(dispatcher.handle(keydown("k", { ctrlKey: true })), true);
  assert.deepEqual(seen, ["escape", "enter", "arrowdown", "space", "mod+k"]);
});

test("with 單鍵快捷鍵 off, hints for single keys are hidden; named keys and chords stay", () => {
  for (const label of ["E", "S", "N", "?", "Z", "1", "1–9"]) {
    assert.equal(visibleKeyHint(label, true), label);
    assert.equal(visibleKeyHint(label, false), undefined, label);
  }
  for (const label of ["↵", "Esc", "Ctrl K", "⌘K", "⌘↵", "Ctrl Z"]) assert.equal(visibleKeyHint(label, false), label, label);
  assert.equal(visibleKeyHint(undefined, true), undefined);
});

test("G chords navigate within one second and swallow the second key", () => {
  const { dispatcher, seen, advance } = setup();
  assert.equal(dispatcher.handle(keydown("g")), true);
  advance(400);
  assert.equal(dispatcher.handle(keydown("i")), true);
  assert.deepEqual(seen, ["g i"]);
  dispatcher.handle(keydown("g"));
  advance(1_200);
  dispatcher.handle(keydown("t"));
  assert.deepEqual(seen, ["g i", "t"], "a stale chord falls back to the plain key");
  assert.deepEqual(Object.keys(GO_CHORDS).sort(), ["g b", "g c", "g d", "g e", "g h", "g i", "g l", "g t", "g w"]);
});

test("handlers run newest first and can pass a key on", () => {
  const calls: string[] = [];
  const dispatcher = createShortcutDispatcher({ singleKeys: () => true, apple: () => false, dialogOpen: () => false, now: () => 0 });
  dispatcher.register((combo) => { calls.push(`shell:${combo}`); return combo === "n"; });
  const unregister = dispatcher.register((combo) => { calls.push(`page:${combo}`); return combo === "j"; });
  const j = keydown("j");
  assert.equal(dispatcher.handle(j), true);
  assert.equal(j.prevented, true);
  dispatcher.handle(keydown("N", { shiftKey: true }));
  assert.deepEqual(calls, ["page:j", "page:n", "shell:n"]);
  unregister();
  const unhandled = keydown("x");
  assert.equal(dispatcher.handle(unhandled), false);
  assert.equal(unhandled.prevented, false);
});

test("the registry covers SPEC-ux §6.2", () => {
  const combos = SHORTCUTS.flatMap((item) => item.combos);
  for (const combo of ["mod+k", "n", "?", "g t", "g i", "g c", "g d", "g w", "g e", "g l", "g h", "j", "arrowdown", "k", "arrowup", "enter", "e", "s", "t", "c", "space", "escape", "z", "mod+z", "1", "9"]) {
    assert.ok(combos.includes(combo), combo);
  }
  assert.equal(new Set(combos).size, combos.length, "no combo is listed twice");
  assert.equal(normalizeKey(" "), "space");
  assert.equal(normalizeKey("Esc"), "escape");
  assert.equal(normalizeKey("Delete"), "delete");
  assert.equal(normalizeKey("ArrowDown"), "arrowdown");
});

test("SPEC-mail-assignments §6: 刪除, 轉成作業 and / are registered, and the inbox has its own legend", () => {
  const combos = SHORTCUTS.flatMap((item) => item.combos);
  for (const combo of ["#", "delete", "a", "/"]) assert.ok(combos.includes(combo), combo);
  assert.deepEqual(inboxLegendItems().map((item) => `${item.keys.join(" ")} ${item.label}`), [
    "J K 移動", "E 封存", "# 刪除", "/ 搜尋", "Z 復原", "? 全部",
  ]);
  // # is Shift+3 on most layouts: Shift does not block a single-key shortcut, the IME guard still does.
  const calls: string[] = [];
  const dispatcher = createShortcutDispatcher({ singleKeys: () => true, apple: () => false, dialogOpen: () => false, now: () => 0 });
  dispatcher.register((combo) => { calls.push(combo); return true; });
  dispatcher.handle(keydown("#", { shiftKey: true }));
  dispatcher.handle(keydown("#", { shiftKey: true, isComposing: true }));
  dispatcher.handle(keydown("/", { keyCode: 229 }));
  dispatcher.handle(keydown("Delete"));
  assert.deepEqual(calls, ["#", "delete"]);
});
