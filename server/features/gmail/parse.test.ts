import test from "node:test";
import assert from "node:assert/strict";
import { clipUtf8, decodeBody, decodeMimeWords, extractExcerpt, gmailInboxUrl, gmailThreadUrl, htmlToText, normalizeMessage, parseAddress, stripQuoted } from "./parse.js";

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64url");

test("htmlToText drops markup, scripts, styles, comments and images, and decodes entities", () => {
  const html = `<!doctype html><html><head><title>Ignore</title><style>.a{color:red}</style></head>
    <body><!-- tracking --><script>alert("x")</script>
    <p>同學好，</p><p>請在 <b>週三&nbsp;10:00</b> 前回信 &amp; 附上提案。<br>謝謝&#xff01;</p>
    <img src="https://tracker.example/p.gif" alt="">
    <ul><li>第一點</li><li>第二點</li></ul><table><tr><td>A</td><td>B</td></tr></table></body></html>`;
  const text = htmlToText(html);
  assert.equal(text, "同學好，\n\n請在 週三 10:00 前回信 & 附上提案。\n謝謝！\n\n• 第一點\n• 第二點\nA B");
  assert.doesNotMatch(text, /[<>]|alert|color:red|tracker|Ignore/);
});

test("extractExcerpt prefers text/plain, falls back to stripped HTML, skips attachments and quoted history", () => {
  const plain = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }], body: { data: b64("請在週五前交報告。\n\nOn Mon, Prof wrote:\n> 舊的內容\n> 更舊的內容") } },
        { mimeType: "text/html", body: { data: b64("<p>HTML 版本</p>") } },
      ] },
      { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "a1" } },
    ],
  };
  assert.equal(extractExcerpt(plain), "請在週五前交報告。");

  const htmlOnly = { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<div>只有 <i>HTML</i></div><script>x()</script>") } }] };
  assert.equal(extractExcerpt(htmlOnly), "只有 HTML");

  const attachmentOnly = { mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", headers: [{ name: "Content-Disposition", value: "attachment; filename=a.txt" }], body: { data: b64("secret file") } }] };
  assert.equal(extractExcerpt(attachmentOnly), undefined);
});

test("the excerpt is cut to 8 KB of UTF-8 without splitting a character", () => {
  const long = "繳".repeat(5000); // 3 bytes each: 15 000 bytes
  const payload = { mimeType: "text/plain", body: { data: b64(long) } };
  const excerpt = extractExcerpt(payload)!;
  assert.ok(Buffer.byteLength(excerpt, "utf8") <= 8192);
  assert.equal(excerpt, "繳".repeat(2730));
  assert.equal(clipUtf8("abc", 10), "abc");
});

test("bodies decode as UTF-8 when valid, else with the declared charset (Big5)", () => {
  const big5 = new Uint8Array([0xa7, 0x41, 0xa6, 0x6e]); // 你好 in Big5
  assert.equal(decodeBody(Buffer.from(big5).toString("base64url"), "big5"), "你好");
  assert.equal(decodeBody(b64("你好"), "big5"), "你好", "already UTF-8 stays UTF-8");
});

test("addresses and encoded words", () => {
  assert.deepEqual(parseAddress("\"林志明 教授\" <CMLin@cs.nycu.edu.tw>"), { name: "林志明 教授", email: "cmlin@cs.nycu.edu.tw" });
  assert.deepEqual(parseAddress("noreply@github.com"), { email: "noreply@github.com" });
  assert.deepEqual(parseAddress("=?UTF-8?B?5Lit6I+v6Zu75L+h?= <ebill@cht.com.tw>"), { name: "中華電信", email: "ebill@cht.com.tw" });
  assert.equal(decodeMimeWords("=?utf-8?Q?=E5=B8=B3=E5=96=AE_9_=E6=9C=88?="), "帳單 9 月");
  assert.equal(stripQuoted("hi\n\n林 於 2026/10/12 寫道：\n> old"), "hi");
});

test("normalizeMessage keeps metadata, snippet and excerpt only", () => {
  const message = normalizeMessage({
    id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD", "IMPORTANT", "INBOX"], snippet: "請回信 &amp; 確認時間&#39;s",
    internalDate: String(Date.parse("2026-10-12T00:05:00Z")),
    payload: {
      mimeType: "text/html",
      headers: [{ name: "From", value: "林志明 <cmlin@cs.nycu.edu.tw>" }, { name: "Subject", value: "Re: OS 期末專題" }, { name: "List-Unsubscribe", value: "<mailto:x@y>" }],
      body: { data: b64("<p>內文 <img src=x></p>") },
    },
  });
  assert.deepEqual(message, {
    id: "m1", threadId: "t1", from: { name: "林志明", email: "cmlin@cs.nycu.edu.tw" }, subject: "Re: OS 期末專題",
    snippet: "請回信 & 確認時間's", excerpt: "內文", receivedAt: "2026-10-12T00:05:00.000Z", unread: true,
    labels: ["INBOX", "UNREAD", "IMPORTANT"], webUrl: "https://mail.google.com/mail/u/0/#all/t1", listUnsubscribe: true,
  });
  assert.doesNotMatch(JSON.stringify(message), /<p>|<img/);
});

test("a hostile body cannot hold the event loop: megabyte runs of <, <!--, <style and short lines parse in linear time", () => {
  const MB = 1_000_000;
  const bodies: Array<[string, string]> = [
    ["text/html", "<".repeat(MB)],
    ["text/html", "<!--".repeat(MB / 4)],
    ["text/html", "<style>".repeat(MB / 7)],
    ["text/html", "<li".repeat(MB / 3)],
    ["text/html", "<td x".repeat(MB / 5)],
    ["text/plain", "a\n".repeat(MB / 2)],
    ["text/plain", "x wrote:\n\n".repeat(MB / 10)],
  ];
  for (const [mimeType, body] of bodies) {
    const started = performance.now();
    normalizeMessage({ id: "m", threadId: "t", payload: { mimeType, body: { data: b64(body) } } });
    const ms = performance.now() - started;
    assert.ok(ms < 500, `${mimeType} ${JSON.stringify(body.slice(0, 8))}… took ${ms.toFixed(0)} ms`);
  }
  assert.equal(htmlToText("<p>前</p><!-- 沒有結尾 <p>後</p>"), "前", "an unclosed comment hides the rest");
  assert.equal(htmlToText("<p>前</p><style>a{} <p>後</p>"), "前", "an unclosed hidden element hides the rest");
  assert.equal(htmlToText("<STYLE>a{}</style >正文<script>x()</SCRIPT>尾"), "正文 尾");
  assert.equal(htmlToText("a < b > c <<x>> d"), "a  c  d".replace(/ {2,}/g, " "));
  assert.equal(stripQuoted("hi\n寫道：\n\n\n> old\nbye"), "hi\n\nbye");
});

test("ISO-2022-JP bodies decode with their declared charset; unsupported labels fall back to UTF-8", () => {
  const jis = Buffer.from("\x1b$B%3%s%5!<%H\x1b(B", "latin1").toString("base64url"); // コンサート
  assert.equal(decodeBody(jis, "ISO-2022-JP"), "コンサート");
  const payload = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=\"ISO-2022-JP\"" }], body: { data: jis } };
  assert.equal(extractExcerpt(payload), "コンサート");
  assert.equal(decodeBody(b64("plain ascii"), "iso-2022-kr"), "plain ascii", "a label WHATWG maps to replacement is ignored");
  assert.equal(decodeBody(b64("你好"), "us-ascii"), "你好");
  assert.equal(decodeMimeWords("=?ISO-2022-JP?B?GyRCJTMlcyU1ITwlSBsoQg==?="), "コンサート");
});

test("Gmail links open the connected account, and #all finds archived threads", () => {
  assert.equal(gmailThreadUrl("18c2e9d0a1b2c3f6", "suzu1dev@gmail.com"), "https://mail.google.com/mail/u/suzu1dev%40gmail.com/#all/18c2e9d0a1b2c3f6");
  assert.equal(gmailThreadUrl("18c2e9d0a1b2c3f6"), "https://mail.google.com/mail/u/0/#all/18c2e9d0a1b2c3f6");
  assert.equal(gmailInboxUrl("a@nycu.edu.tw"), "https://mail.google.com/mail/u/a%40nycu.edu.tw/#inbox");
  assert.equal(normalizeMessage({ id: "m", threadId: "t9" }, "suzu1dev@gmail.com").webUrl, "https://mail.google.com/mail/u/suzu1dev%40gmail.com/#all/t9");
});
