/**
 * The reader's 用 AI 處理: where it is offered, what the toast says once the
 * model answered, and the button and progress line as markup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxMessage, InboxThread } from "../../../shared/mail";
import { offersProcess, processNotice } from "./inbox-model";
import { MailReader, type MailReaderProps } from "./MailReader";

const noop = () => {};
const message: InboxMessage = {
  id: "m1", from: { name: "SITCON", email: "contact@sitcon.org" }, receivedAt: "2026-10-12T00:00:00Z", unread: true,
  snippet: "報名成功", excerpt: "10/25 13:30 在中研院人文館舉行。", mine: false,
};
const thread = {
  threadId: "t1", messageId: "m1", itemId: "gmail:m1", from: message.from, subject: "SITCON 秋季交流會報名成功", title: "SITCON 秋季交流會報名成功", meta: [],
  summarySource: "rule", category: "invitation", inQueue: false, receivedAt: message.receivedAt, when: { label: "08:00", mono: true }, unread: true, count: 1,
  actions: [], replied: false, webUrl: "https://mail.google.com/mail/u/0/#all/t1", location: "inbox",
} as InboxThread;

const render = (processMail: MailReaderProps["processMail"]) => {
  const props: MailReaderProps = {
    thread, detail: { thread, messages: [message], suggestions: [] }, state: "ready", onRetry: noop, onRun: noop, onSuggestion: noop, hiddenSuggestions: new Set(),
    snooze: { open: false, now: new Date(), sheet: false, onPick: noop, onClose: noop }, snoozeButtonRef: createRef(), touch: false, timeZone: "Asia/Taipei",
    bodyView: "plain", onBodyView: noop, imagesAsked: new Map(), onShowImages: noop, onTrust: noop, processMail,
  };
  return renderToStaticMarkup(createElement(MailReader, props));
};

test("用 AI 處理 is offered on cached mail when AI can run, never on live or trashed conversations", () => {
  assert.equal(offersProcess(thread, true), true);
  assert.equal(offersProcess(thread, false), false, "AI off or the CLI signed out");
  assert.equal(offersProcess({ ...thread, live: true }, true), false, "read live from Gmail: not cached, so its suggestions could outlive the retention window");
  assert.equal(offersProcess({ ...thread, trashed: true }, true), false);
});

test("the toast says what was added, or why nothing was", () => {
  assert.deepEqual(processNotice({ threadId: "t1", found: 3, added: 2, pending: 3 }), { kind: "success", message: "AI 找到 2 個項目，請在下方「從這封信找到」確認要不要加入。" });
  assert.deepEqual(processNotice({ threadId: "t1", found: 2, added: 0, pending: 2 }), { kind: "success", message: "AI 沒有找到新的項目，先前找到的都列在下方。" });
  assert.deepEqual(processNotice({ threadId: "t1", found: 2, added: 0, pending: 0 }), { kind: "success", message: "AI 找到的項目先前都已經加入或略過了。" });
  assert.deepEqual(processNotice({ threadId: "t1", found: 0, added: 0, pending: 0 }), { kind: "success", message: "AI 看過了，這封信沒有要加入行事曆、待辦或作業的事。" });
  assert.deepEqual(processNotice({ error: "AI 處理逾時，請再試一次。" }), { kind: "error", message: "AI 沒有處理這封信：AI 處理逾時，請再試一次。" });
});

test("the reader's 用 AI 處理 button, and its progress line while the model works", () => {
  assert.doesNotMatch(render(undefined), /用 AI 處理/, "not offered: no button");

  const idle = render({ running: false, progress: "", onStart: noop });
  assert.match(idle, /<button class="btn btn-secondary btn-sm" type="button" title="AI 讀這封信，找出要加入行事曆、待辦或作業的事，由你確認後才加入。"><svg[^>]*>.*?<\/svg>用 AI 處理<\/button><a[^>]*>在 Gmail 開啟/);
  assert.doesNotMatch(idle, /is-processing/);

  const running = render({ running: true, progress: "正在用 AI 處理這封信…正在思考（已進行 5 秒）。", onStart: noop });
  assert.match(running, /aria-disabled="true" aria-busy="true"><svg[^>]*>.*?<\/svg>處理中…<\/button>/);
  assert.doesNotMatch(running, /<button[^>]* disabled=""/, "a disabled button would drop keyboard focus to <body>");
  assert.match(running, /<p class="mr-state is-processing"><span class="sr-only" role="status">AI 正在讀這封信，找出要加入行事曆、待辦或作業的事…<\/span><span aria-hidden="true">正在用 AI 處理這封信…正在思考（已進行 5 秒）。<\/span><\/p>/);
  assert.match(render({ running: true, progress: "", onStart: noop }), /<span aria-hidden="true">AI 正在讀這封信/, "before the first progress line");
});
