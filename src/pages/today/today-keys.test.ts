/**
 * Keyboard handling on Today (SPEC-ux §6.2): the queue keys go through the
 * one guarded dispatcher, the capture field and the snooze popover have
 * their own handlers, and none of them acts while an IME is composing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { QueueItem, TodayPayload } from "../../../shared/today";
import { createShortcutDispatcher } from "../../lib/shortcuts";
import { snoozeKeyIntent } from "./SnoozePopover";
import { actionForKey } from "./today-view";

const payload = JSON.parse(readFileSync(new URL("../../../server/fixtures/today-2026-10-12.json", import.meta.url), "utf8")) as TodayPayload;
const mail = payload.queue[0].items[0] as QueueItem;

function keydown(key: string, extra: Record<string, unknown> = {}) {
  let prevented = false;
  return { key, target: { tagName: "BUTTON" }, preventDefault: () => { prevented = true; }, get prevented() { return prevented; }, ...extra };
}

/** The queue's E/S/T/C/↵ map, as FocusQueue registers it, recording which action would run. */
function queueDispatcher(singleKeys = true) {
  const ran: string[] = [];
  const dispatcher = createShortcutDispatcher({ singleKeys: () => singleKeys, apple: () => false, dialogOpen: () => false, now: () => 0 });
  const run = (key: "Enter" | "E" | "S" | "T" | "C") => {
    const action = actionForKey(mail, key);
    if (!action) return false;
    ran.push(action.id);
    return true;
  };
  const map: Record<string, () => boolean> = { e: () => run("E"), s: () => run("S"), t: () => run("T"), c: () => run("C"), enter: () => run("Enter") };
  dispatcher.register((combo) => map[combo]?.() ?? false);
  return { dispatcher, ran };
}

test("E archives the cursor row, but not while Bopomofo is composing (isComposing or keyCode 229)", () => {
  const { dispatcher, ran } = queueDispatcher();
  assert.equal(dispatcher.handle(keydown("e", { isComposing: true })), false);
  assert.equal(dispatcher.handle(keydown("e", { keyCode: 229 })), false);
  assert.deepEqual(ran, []);
  const event = keydown("e");
  assert.equal(dispatcher.handle(event), true);
  assert.equal(event.prevented, true);
  assert.deepEqual(ran, ["archive"]);
});

test("queue keys map to the row's actions and pass on keys the row has no action for", () => {
  const { dispatcher, ran } = queueDispatcher();
  dispatcher.handle(keydown("t"));
  dispatcher.handle(keydown("s"));
  dispatcher.handle(keydown("Enter"));
  assert.equal(dispatcher.handle(keydown("c")), false, "this mail has no calendar action");
  assert.deepEqual(ran, ["todo", "snooze", "reply"]);
});

test("typing in a field and the 單鍵快捷鍵 setting stop the letter keys; ↵ still works with single keys off", () => {
  const { dispatcher, ran } = queueDispatcher(false);
  assert.equal(dispatcher.handle(keydown("e", { target: { tagName: "INPUT" } })), false);
  assert.equal(dispatcher.handle(keydown("e")), false, "single-key shortcuts are off");
  assert.equal(dispatcher.handle(keydown("Enter")), true, "named keys are not single-key shortcuts");
  assert.deepEqual(ran, ["reply"]);
});

test("the snooze popover: 1–4 pick, 5 opens the time field, arrows move, Esc closes; nothing while composing", () => {
  assert.deepEqual(snoozeKeyIntent({ key: "2", target: { tagName: "BUTTON" } }), { type: "pick", index: 1 });
  assert.deepEqual(snoozeKeyIntent({ key: "5" }), { type: "custom" });
  assert.deepEqual(snoozeKeyIntent({ key: "ArrowDown" }), { type: "move", delta: 1 });
  assert.deepEqual(snoozeKeyIntent({ key: "Escape" }), { type: "close" });
  assert.equal(snoozeKeyIntent({ key: "2", isComposing: true }), null);
  assert.equal(snoozeKeyIntent({ key: "Escape", keyCode: 229 }), null, "Esc during composition only cancels the composition");
  assert.equal(snoozeKeyIntent({ key: "2", target: { tagName: "INPUT" } }), null, "digits typed into the time field stay there");
  assert.deepEqual(snoozeKeyIntent({ key: "Escape", target: { tagName: "INPUT" } }), { type: "close" });
  assert.equal(snoozeKeyIntent({ key: "2", ctrlKey: true }), null);
  // Tab stays inside, also from the time field, so the page's keys are never left dead behind an open popover.
  assert.deepEqual(snoozeKeyIntent({ key: "Tab" }), { type: "tab", delta: 1 });
  assert.deepEqual(snoozeKeyIntent({ key: "Tab", shiftKey: true, target: { tagName: "INPUT" } }), { type: "tab", delta: -1 });
});
