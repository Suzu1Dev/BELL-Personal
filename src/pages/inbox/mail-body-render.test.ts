/**
 * The reader's original layout as markup (renderToStaticMarkup;
 * SPEC-mail-html §5–§6): the frame's sandbox, the blocked-images notice and
 * its actions, the notes after images are shown, the plain-text fallbacks,
 * the attachment strip and the 原始版面 / 純文字 switch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxMessage, InboxThread, MailBodyResponse } from "../../../shared/mail";
import { MailFrame, FRAME_SANDBOX } from "./MailFrame";
import { OriginalBody } from "./MailBody";
import { framed, MailReader, type MailReaderProps } from "./MailReader";
import { holdMailBody, MAIL_BODY_TTL_MS, peekMailBody, forgetMailBodies, type MailBodyState } from "./useMailBody";

const message: InboxMessage = {
  id: "m1", from: { name: "iThome 電子報", email: "newsletter@ithome.com.tw" }, receivedAt: "2026-10-15T00:00:00Z", unread: true,
  snippet: "本週資安焦點", excerpt: "本週資安焦點：零信任架構實戰", mine: false,
};
const noop = () => {};

function response(extra: Partial<MailBodyResponse> = {}): MailBodyResponse {
  return {
    messageId: "m1", kind: "html", document: "<!doctype html><p>x</p>", sender: message.from, attachments: [],
    images: { remote: 6, shown: false, trusted: false, trackers: 2 }, ...extra,
  };
}
const state = (data?: MailBodyResponse, extra: Partial<MailBodyState> = {}): MailBodyState => ({ state: data ? "ready" : "loading", ...(data ? { data } : {}), retry: noop, ...extra });
const render = (body: MailBodyState, keyHint = true) => renderToStaticMarkup(createElement(OriginalBody, { message, body, onShowImages: noop, onTrust: noop, keyHint }));

test("the frame is sandboxed without scripts, forms or top navigation, and sends no referrer", () => {
  assert.equal(FRAME_SANDBOX, "allow-same-origin allow-popups allow-popups-to-escape-sandbox");
  const html = renderToStaticMarkup(createElement(MailFrame, { document: "<!doctype html><p>hi</p>", title: "信件內容" }));
  assert.match(html, /<div class="mr-paper is-measuring"><iframe class="mr-frame" title="信件內容" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc="&lt;!doctype html&gt;&lt;p&gt;hi&lt;\/p&gt;"><\/iframe><\/div>/);
  assert.doesNotMatch(html, /allow-scripts|allow-forms|allow-top-navigation|allow-modals/);
});

test("blocked images: a calm notice with 顯示圖片 I, 一律顯示「寄件者」的圖片 and the tracking-pixel count", () => {
  const html = render(state(response()));
  assert.match(html, /<div class="notice mr-images">/, "neutral tone: no warn or error colours");
  assert.match(html, /<b>已封鎖外部圖片，保護你的隱私。<\/b><p>已擋下 2 個追蹤像素。<\/p>/);
  assert.match(html, /顯示圖片<kbd>I<\/kbd><\/button>/);
  assert.match(html, /aria-label="之後一律顯示「newsletter@ithome\.com\.tw」寄來的信中的圖片" title="[^"]+">一律顯示「newsletter@ithome\.com\.tw」的圖片<\/button>/, "the address it will trust, not a display name anyone can set");
  assert.match(html, /class="mr-frame"/);
  assert.doesNotMatch(render(state(response()), false), /<kbd>I<\/kbd>/, "no key hint on touch or older messages");
});

test("shown images say they came through the owner's server; a trusted sender links to 管理; no notice without remote images", () => {
  const asked = render(state(response({ images: { remote: 6, shown: true, trusted: false, trackers: 2 } })));
  assert.doesNotMatch(asked, /已封鎖外部圖片/);
  assert.match(asked, /<p class="mr-note mr-shown" tabindex="-1">圖片經由你的伺服器載入：寄件者看不到你的裝置或瀏覽器，但會看到伺服器的 IP 位址。 已擋下 2 個追蹤像素。<\/p>/, "true for a self-hosted server: its address is the owner's connection");
  assert.doesNotMatch(asked, /看不到你的 IP/);
  const trusted = render(state(response({ images: { remote: 4, shown: true, trusted: true, trackers: 0 } })));
  assert.match(trusted, /你信任「iThome 電子報」，圖片會自動經由你的伺服器載入。 <a class="link" href="#\/settings\/privacy">管理<\/a>/);
  const none = render(state(response({ images: { remote: 0, shown: false, trusted: false, trackers: 1 } })));
  assert.doesNotMatch(none, /notice/);
  assert.match(none, /<p class="mr-note">已擋下 1 個追蹤像素。<\/p>/);
});

test("fallbacks show the plain text with a note: too large, unsafe, not connected, a failed load with 重試; no note for plain mail", () => {
  for (const [reason, note] of [["too-large", "這封信的版面太大，先顯示純文字。"], ["unsafe", "這封信的版面無法安全顯示，先顯示純文字。"], ["not-connected", "Gmail 尚未連接，只能顯示純文字。"]] as const) {
    const html = render(state(response({ kind: "text", reason, document: undefined })));
    assert.match(html, new RegExp(`<p class="mr-note mr-fallback">${note}</p><div class="mr-text">本週資安焦點：零信任架構實戰</div>`), reason);
    assert.doesNotMatch(html, /iframe/);
  }
  const plain = render(state(response({ kind: "text", reason: "no-html", document: undefined })));
  assert.equal(plain, "<div class=\"mr-text\">本週資安焦點：零信任架構實戰</div>");
  const failed = render(state(undefined, { state: "error", error: "Gmail 回應逾時" }));
  assert.match(failed, /原始版面暫時無法載入，先顯示純文字。 <button[^>]*>重試<\/button>/);
  assert.match(failed, /<div class="mr-text">本週資安焦點：零信任架構實戰<\/div>/);
  const loading = render(state());
  assert.match(loading, /aria-busy="true"><p class="sr-only" role="status">正在載入原始版面…<\/p>/);
});

test("image attachments: a strip of named thumbnails that open the image in a new tab", () => {
  const html = render(state(response({ attachments: [{ partId: "1", filename: "白板照片.png", size: 48_128, url: "/api/gmail/messages/m1/attachments/1" }] })));
  assert.match(html, /<ul class="mr-attachments" aria-label="圖片附件"><li><a class="mr-att" href="\/api\/gmail\/messages\/m1\/attachments\/1" target="_blank" rel="noopener noreferrer" aria-label="開啟圖片「白板照片.png」"><img src="\/api\/gmail\/messages\/m1\/attachments\/1" alt="" loading="lazy" decoding="async"\/><span class="mr-att-name">白板照片.png<\/span><span class="mr-att-size mono">47 KB<\/span><\/a><\/li><\/ul>/);
});

test("the reader carries the 原始版面 / 純文字 switch and the notes of the view it is in", () => {
  const thread = {
    threadId: "t1", messageId: "m1", itemId: "gmail:m1", from: message.from, subject: "本週資安焦點", title: "本週資安焦點", meta: [], summarySource: "rule",
    category: "newsletter", inQueue: false, receivedAt: message.receivedAt, when: { label: "08:00", mono: true }, unread: true, count: 1, actions: [],
    replied: false, webUrl: "https://mail.google.com/mail/u/0/#all/t1", location: "inbox",
  } as InboxThread;
  const props = (bodyView: "original" | "plain"): MailReaderProps => ({
    thread, detail: { thread, messages: [message], suggestions: [] }, state: "ready", onRetry: noop, onRun: noop, onSuggestion: noop, hiddenSuggestions: new Set(),
    snooze: { open: false, now: new Date(), sheet: false, onPick: noop, onClose: noop }, snoozeButtonRef: createRef(), touch: false, timeZone: "Asia/Taipei",
    bodyView, onBodyView: noop, imagesAsked: new Map(), onShowImages: noop, onTrust: noop,
  });
  const original = renderToStaticMarkup(createElement(MailReader, props("original")));
  assert.match(original, /<div class="mr-viewbar"><div class="seg mr-view" role="group" aria-label="顯示方式"><button type="button" aria-pressed="true">原始版面<\/button><button type="button" aria-pressed="false">純文字<\/button><\/div><\/div>/);
  assert.match(original, /原始版面在不能執行程式的框架中顯示；外部圖片要經過你的伺服器才會載入。/);
  assert.match(original, /正在載入原始版面…/, "the newest message loads its layout");
  const plain = renderToStaticMarkup(createElement(MailReader, props("plain")));
  assert.match(plain, /aria-pressed="false">原始版面<\/button><button type="button" aria-pressed="true">純文字/);
  assert.match(plain, /<div class="mr-text">本週資安焦點：零信任架構實戰<\/div>/);
  assert.match(plain, /只顯示純文字內容，不載入圖片與連結預覽。/);
});

test("a failed image load keeps the blocked layout and says so with 重試 (顯示圖片 and I ask again)", () => {
  const html = render(state(response(), { state: "error", error: "Gmail 暫時無法連線，請稍後再試。" }));
  assert.match(html, /<div class="notice mr-images">/, "the notice stays, its 顯示圖片 asks again");
  assert.match(html, /<p class="mr-note mr-fallback" role="status">外部圖片沒有載入：Gmail 暫時無法連線，請稍後再試。 <button[^>]*>重試<\/button><\/p>/);
  assert.match(html, /class="mr-frame"/, "the blocked layout stays on screen");
  assert.doesNotMatch(render(state(response())), /外部圖片沒有載入/);
});

test("the reader's note speaks of a frame only when a message has a layout", () => {
  const messages = [message, { ...message, id: "m2" }];
  assert.equal(framed(messages, new Map()), true, "still loading: the newest message may have one");
  assert.equal(framed(messages, new Map([["m2", "text"]])), false, "plain-text mail: the plain-text note");
  assert.equal(framed(messages, new Map([["m1", "html"], ["m2", "text"]])), true, "an older message with a layout");
  assert.equal(framed(messages, new Map([["m2", "html"]])), true);
});

test("a held answer with proxied images expires with the server's copy of them; one without stays for the session", () => {
  forgetMailBodies();
  const now = Date.now();
  holdMailBody(response({ messageId: "p1", images: { remote: 4, shown: true, trusted: false, trackers: 0 } }), true, now - MAIL_BODY_TTL_MS - 1);
  holdMailBody(response({ messageId: "p2", images: { remote: 4, shown: true, trusted: false, trackers: 0 } }), true, now - 1000);
  holdMailBody(response({ messageId: "p3" }), false, now - MAIL_BODY_TTL_MS * 10);
  assert.equal(peekMailBody("p1", true), undefined, "after five minutes (or a server restart) its signed URLs no longer load: asked for again");
  assert.ok(peekMailBody("p2", true));
  assert.ok(peekMailBody("p3"), "blocked images and cid: parts do not expire");
  forgetMailBodies();
});
