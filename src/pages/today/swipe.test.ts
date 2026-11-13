import test from "node:test";
import assert from "node:assert/strict";
import { SWIPE, swipeDecision, swipeOffset, type SwipeOptions } from "./swipe";

const mail: SwipeOptions = { tray: true, open: false, canDone: true, canLeft: true };
const other: SwipeOptions = { tray: false, open: false, canDone: true, canLeft: true };

test("mail rows: a left swipe opens the tray past 56 px or on a flick; right still runs E (SPEC-mail-assignments §2.4)", () => {
  assert.equal(swipeDecision(-SWIPE.open, 0.1, 360, mail), "tray-open");
  assert.equal(swipeDecision(-40, 0.1, 360, mail), "none", "short drags spring back");
  assert.equal(swipeDecision(-30, 0.7, 360, mail), "tray-open", "a flick opens it");
  assert.equal(swipeDecision(130, 0.1, 360, mail), "done", "35 % of the row to the right is the E action");
  assert.equal(swipeDecision(100, 0.1, 360, mail), "none");
  // An open tray: dragging back right closes it, a little wiggle keeps it.
  assert.equal(swipeDecision(SWIPE.close, 0.1, 360, { ...mail, open: true }), "tray-close");
  assert.equal(swipeDecision(10, 0.1, 360, { ...mail, open: true }), "tray-open");
  assert.equal(swipeDecision(-80, 0.1, 360, { ...mail, open: true }), "tray-open");
});

test("the content follows the finger up to the tray, then with 0.3× resistance; an open tray never reveals the E colour", () => {
  assert.equal(swipeOffset(-100, mail), -100);
  assert.equal(swipeOffset(-144, mail), -144);
  assert.equal(swipeOffset(-244, mail), -144 - 30, "100 px past the tray moves 30 px");
  assert.equal(swipeOffset(60, mail), 60, "right reveals the E action");
  assert.equal(swipeOffset(0, { ...mail, open: true }), -144, "an open tray rests at −144");
  assert.equal(swipeOffset(200, { ...mail, open: true }), 0, "dragging an open tray right stops at rest");
  assert.equal(swipeOffset(-80, { ...mail, canLeft: false }), 0);
  assert.equal(swipeOffset(80, { ...mail, canDone: false }), 0);
});

test("other rows keep SPEC-ux §7: right runs E, left past 35 % snoozes", () => {
  assert.equal(swipeDecision(-130, 0.1, 360, other), "snooze");
  assert.equal(swipeDecision(-60, 0.1, 360, other), "none", "the tray's 56 px is not enough for snooze");
  assert.equal(swipeDecision(130, 0.1, 360, other), "done");
  assert.equal(swipeDecision(-130, 0.1, 360, { ...other, canLeft: false }), "none");
  assert.equal(swipeOffset(-300, other), -300, "no resistance without a tray");
});
