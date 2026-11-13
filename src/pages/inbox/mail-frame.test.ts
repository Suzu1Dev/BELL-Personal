import test from "node:test";
import assert from "node:assert/strict";
import { contentHeight, fitZoom, formatBytes, forwardsKey, HeightGuard, MAX_FRAME_HEIGHT, MAX_RESIZES, MIN_ZOOM, senderLabel } from "./mail-frame";

test("a fixed-width mail zooms to fit the reader, never below half; one that fits stays at 1", () => {
  assert.equal(fitZoom(600, 640), 1);
  assert.equal(fitZoom(641, 640), 1, "a pixel of rounding is not overflow");
  assert.equal(fitZoom(752, 640), 0.851, "the 720 px sale mail plus its padding in the desktop reader");
  assert.equal(fitZoom(600, 358), 0.596, "a 600 px newsletter on a phone");
  assert.equal(fitZoom(700, 600), 0.857);
  assert.equal(fitZoom(2400, 358), MIN_ZOOM, "wider than twice the column: half size and a sideways scroll inside the frame");
  assert.equal(fitZoom(700, 0), 1, "a frame not laid out yet");
});

test("the frame height follows the content, ignores 1 px jitter and freezes on a loop or past the cap", () => {
  const guard = new HeightGuard();
  assert.deepEqual(guard.next(812.3), { height: 813, changed: true, capped: false });
  assert.deepEqual(guard.next(813.9), { height: 813, changed: false, capped: false });
  assert.deepEqual(guard.next(1200), { height: 1200, changed: true, capped: false });

  const loop = new HeightGuard();
  let last = loop.next(100);
  for (let index = 1; index <= MAX_RESIZES + 5; index++) last = loop.next(100 + index * 32);
  assert.equal(last.capped, true, "body{height:100%;padding:16px} would grow forever: frozen");
  assert.deepEqual(loop.next(99_999), { height: last.height, changed: false, capped: true });

  const tall = new HeightGuard();
  assert.deepEqual(tall.next(MAX_FRAME_HEIGHT + 5000), { height: MAX_FRAME_HEIGHT, changed: true, capped: true });
});

test("labels: the sender's name or address, cut when long; sizes in B, KB and MB", () => {
  assert.equal(senderLabel({ name: "iThome 電子報", email: "newsletter@ithome.com.tw" }), "iThome 電子報");
  assert.equal(senderLabel({ email: "news@example.com" }), "news@example.com");
  assert.equal(senderLabel({ name: "一二三四五六七八九十一二三四五六七八九十一二三四五六", email: "a@b.c" }), "一二三四五六七八九十一二三四五六七八九十一二三…");
  assert.deepEqual([formatBytes(512), formatBytes(12_800), formatBytes(1_468_006)], ["512 B", "13 KB", "1.4 MB"]);
});

test("keys inside the frame reach the app's shortcuts, except Tab, an IME composition, and Enter or Space on a link", () => {
  // The frame's elements live in another window: only closest() is used, never instanceof.
  const link = { closest: (selector: string) => (selector === "a[href]" ? {} : null) };
  const textInLink = { closest: (selector: string) => (selector === "a[href]" ? { tagName: "A" } : null) };
  const body = { closest: () => null };
  const key = (value: string, target: unknown, extra: Partial<KeyboardEvent> = {}) => forwardsKey({ key: value, isComposing: false, keyCode: 0, target, ...extra } as KeyboardEvent);
  assert.equal(key("Enter", link as unknown as EventTarget), false, "Enter on 「線上估價」 opens the link, never 封存");
  assert.equal(key(" ", textInLink as unknown as EventTarget), false);
  assert.equal(key("Enter", body as unknown as EventTarget), true, "Enter on the mail itself is the reader's ↵");
  assert.equal(key("e", link as unknown as EventTarget), true, "E still archives from a focused link");
  assert.equal(key("j", body as unknown as EventTarget), true);
  assert.equal(key("Tab", body as unknown as EventTarget), false);
  assert.equal(key("i", body as unknown as EventTarget, { isComposing: true }), false);
  assert.equal(key("Process", body as unknown as EventTarget, { keyCode: 229 }), false);
  assert.equal(key("Enter", null), true);
});

test("the frame takes the content's height, so it shrinks as well as grows", () => {
  // Measured in Chromium (review): a one-line reply's content is 56 px while the frame and its scrollHeight were stuck at 160.
  assert.equal(contentHeight({ rootHeight: 56, bodyTop: 0, bodyScrollHeight: 56, zoom: 1, scrollbar: 0 }), 56);
  // rv-cjk widened from 1200 to 1900 px: the content became 611 px while the old frame was 730.
  assert.equal(contentHeight({ rootHeight: 610.9375, bodyTop: 0, bodyScrollHeight: 611, zoom: 1, scrollbar: 0 }), 611);
  // A zoomed 720 px sale mail on a phone: rects are zoomed, the body's scroll height is not.
  assert.equal(contentHeight({ rootHeight: 179.2, bodyTop: 0, bodyScrollHeight: 358, zoom: 0.5, scrollbar: 0 }), 179.2);
  // A relatively positioned block pushed 400 px below the body still counts, and a sideways scrollbar is added.
  assert.equal(contentHeight({ rootHeight: 191.2, bodyTop: 0, bodyScrollHeight: 766, zoom: 0.5, scrollbar: 0 }), 383);
  assert.equal(contentHeight({ rootHeight: 300, bodyTop: 0, bodyScrollHeight: 300, zoom: 1, scrollbar: 15 }), 315);
});
