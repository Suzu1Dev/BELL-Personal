import test from "node:test";
import assert from "node:assert/strict";
import type { MailBodyResponse } from "../../../shared/mail.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { connectGoogle, FakeGmail, type FakeMessageInput } from "./fake-gmail.js";
import { demoPublicNetwork, htmlMailFixtures, pngImage, type RemoteAnswer } from "./fixtures/html-mail.js";
import { TRANSPARENT_GIF } from "./images.js";
import { gmailModule } from "./index.js";

/**
 * The reader's original layout over HTTP (SPEC-mail-html §2–§5), against the
 * fake Gmail and an in-process network: HTML read live and never stored,
 * remote images blocked until asked or trusted, known tracking pixels never
 * loaded, cid: parts and image attachments served same-origin as checked
 * rasters (no decompression bombs), the signed proxy (no open proxy, no
 * private addresses, no SVG, pixels replaced, every image fetched by the
 * server when the body is built and never because the browser asked), the
 * fallbacks to plain text, the guard and the identity gate, and logs without
 * URLs, subjects or senders.
 */

const NOW = new Date("2026-10-15T09:00:00+08:00");
const OWNER = { "tailscale-user-login": "alice@github" };

async function setup(t: test.TestContext, options: { connect?: boolean; extra?: FakeMessageInput[]; answer?: (url: URL) => RemoteAnswer | undefined; addresses?: Record<string, string[]>; users?: string } = {}) {
  const gmail = new FakeGmail(() => NOW);
  const network = demoPublicNetwork({ answer: options.answer, addresses: options.addresses });
  const services = testServices(t, {
    seams: { fetch: gmail.fetch, now: () => NOW, publicNetwork: network },
    ...(options.users ? { env: { BELLPERSONAL_TAILSCALE_USERS: options.users } } : {}),
  });
  if (options.connect ?? true) await connectGoogle(services);
  for (const input of [...htmlMailFixtures(NOW), ...(options.extra ?? [])]) gmail.add(input, false);
  const server = await startTestServer(t, services, { modules: [gmailModule] });
  const body = async (id: string, query = "") => {
    const response = await server.call("GET", `/api/gmail/messages/${id}/body${query}`, { headers: options.users ? OWNER : {} });
    return { status: response.status, json: response.json as MailBodyResponse, text: response.text };
  };
  const get = (path: string, headers: Record<string, string> = {}) => server.call("GET", path, { headers: { ...(options.users ? OWNER : {}), ...headers } });
  return { gmail, network, services, server, body, get };
}

/** Waits until the server's prefetch has stopped sending requests. */
async function quiet(network: { requests: unknown[] }) {
  let last = -1;
  for (let round = 0; round < 200 && last !== network.requests.length; round++) {
    last = network.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** The proxy URLs a document asks for (decoded from the HTML attribute escaping). */
const proxyUrls = (document: string) => [...document.matchAll(/\/api\/mail-images\/proxy\?[^"')\s]+/g)].map((match) => match[0].replace(/&amp;/g, "&"));

test("a newsletter opens as sanitized HTML with remote images blocked and tracking pixels counted; nothing reaches the cache or the network", async (t) => {
  const { gmail, network, services, body } = await setup(t);
  const response = await body("html-ithome");
  assert.equal(response.status, 200, response.text);
  const mail = response.json;
  assert.equal(mail.kind, "html");
  assert.deepEqual(mail.images, { remote: 6, shown: false, trusted: false, trackers: 2 });
  assert.deepEqual(mail.sender, { name: "iThome 電子報", email: "newsletter@ithome.com.tw" });
  assert.match(mail.document!, /^<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';/);
  assert.match(mail.document!, /本週資安焦點：零信任架構實戰/);
  assert.doesNotMatch(mail.document!, /img\.ithome\.com\.tw|list-manage|mail-images\/proxy/, "no remote URL at all while blocked");
  assert.equal(gmail.calls("GET", /^\/messages\/html-ithome\?format=full/).length, 1, "read live with messages.get(format=full)");
  assert.equal(network.requests.length, 0, "nothing fetched from the sender");
  assert.equal(services.sourceItems.count("gmail"), 0, "never written to source_items");

  // A second open within five minutes comes from memory.
  await body("html-ithome");
  assert.equal(gmail.calls("GET", /^\/messages\/html-ithome\?format=full/).length, 1);
});

test("顯示圖片 rewrites remote images to signed proxy URLs that load through the server; pixels stay out and a decoded 1×1 is replaced", async (t) => {
  const { network, body, get } = await setup(t);
  const mail = (await body("html-ithome", "?images=1")).json;
  assert.deepEqual(mail.images, { remote: 6, shown: true, trusted: false, trackers: 2 });
  const urls = proxyUrls(mail.document!);
  assert.equal(urls.length, 6);
  for (const url of urls) assert.match(url, /^\/api\/mail-images\/proxy\?m=html-ithome&u=https%3A%2F%2Fimg\.ithome\.com\.tw%2F[^&]+&s=[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(mail.document!, /list-manage|eJxVjU1/);
  // The server fetched every image of the body when it built it, before the browser asked for any.
  await quiet(network);
  assert.deepEqual(network.requests.map((request) => request.url).sort(), urls.map((url) => new URL(url, "http://x").searchParams.get("u")!).sort());

  const hero = await get(urls.find((url) => url.includes("hero.png"))!);
  assert.equal(hero.status, 200, hero.text);
  assert.equal(hero.headers["content-type"], "image/png");
  assert.equal(hero.headers["x-content-type-options"], "nosniff");
  assert.equal(hero.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.equal(hero.headers["cache-control"], "private, max-age=300");
  assert.equal(hero.headers["cross-origin-resource-policy"], "same-origin");
  assert.match(String(hero.headers["content-disposition"]), /^inline; filename="image\.png"/);
  assert.equal(hero.body.subarray(1, 4).toString("latin1"), "PNG");
  const request = network.requests.find((entry) => entry.url.endsWith("hero.png"))!;
  assert.deepEqual([request.address, request.url], ["93.184.216.34", "https://img.ithome.com.tw/newsletter/2026/hero.png"]);
  assert.deepEqual(request.headers, { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1", "accept-encoding": "identity", "user-agent": "Mozilla/5.0" }, "no cookie, referer or product name");

  await get(urls.find((url) => url.includes("hero.png"))!);
  assert.equal(network.requests.length, 6, "held in memory: the browser's requests add nothing upstream");

  // The spacer has no size in the markup but decodes to 1×1: the sender's bytes never reach the browser.
  const spacer = await get(urls.find((url) => url.includes("spacer.gif"))!);
  assert.equal(spacer.status, 200);
  assert.deepEqual(spacer.body, TRANSPARENT_GIF);
});

test("the proxy is not open: a missing, forged or other message's signature is refused before any fetch", async (t) => {
  const { network, body, get } = await setup(t);
  const [url] = proxyUrls((await body("html-ithome", "?images=1")).json.document!);
  await quiet(network);
  const prefetched = network.requests.length;
  const parsed = new URL(url, "http://x");
  const signature = parsed.searchParams.get("s")!;
  const target = parsed.searchParams.get("u")!;
  const attempts = [
    `/api/mail-images/proxy?m=html-ithome&u=${encodeURIComponent(target)}`,
    `/api/mail-images/proxy?m=html-ithome&u=${encodeURIComponent("https://img.ithome.com.tw/other.png")}&s=${signature}`,
    `/api/mail-images/proxy?m=html-medium&u=${encodeURIComponent(target)}&s=${signature}`,
    `/api/mail-images/proxy?m=html-ithome&u=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}&s=${signature}`,
    `/api/mail-images/proxy?m=html-ithome&u=${encodeURIComponent(target)}&s=${"A".repeat(43)}`,
    `/api/mail-images/proxy?m=../../x&u=${encodeURIComponent(target)}&s=${signature}`,
  ];
  for (const attempt of attempts) {
    const response = await get(attempt);
    assert.equal(response.status, 403, attempt);
    assert.equal(response.json.error, "圖片連結無效，請重新打開這封信。");
  }
  assert.equal(network.requests.length, prefetched, "nothing fetched for any of them");
  assert.ok(!network.requests.some((request) => request.url.includes("169.254")));
  assert.equal((await get(url)).status, 200, "the real one works");
});

test("the proxy refuses private addresses, redirects into them, SVG, HTML, oversize bodies and wrong magic, with zh-TW errors", async (t) => {
  const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>");
  const answers: Record<string, RemoteAnswer> = {
    "/svg.png": { status: 200, body: svg, headers: { "content-type": "image/png" } },
    "/page.png": { status: 200, body: Buffer.from("<!doctype html><script>alert(1)</script>"), headers: { "content-type": "image/png" } },
    "/huge.png": { status: 200, body: Buffer.alloc(10_000_001, 0x89) },
    "/redirect.png": { status: 302, headers: { location: "http://10.0.0.1/admin.png" } },
    "/redirect-meta.png": { status: 301, headers: { location: "http://[::ffff:a9fe:a9fe]/latest" } },
    "/redirect-ok.png": { status: 302, headers: { location: "https://img.ithome.com.tw/newsletter/logo.png" } },
  };
  const html = Object.keys(answers).map((path) => `<img src="https://img.shop.com${path}" alt="x">`).join("")
    + `<img src="https://internal.shop.com/a.png" alt="y"><img src="https://tailnet.shop.com/b.png" alt="z">`;
  const { network, body, get } = await setup(t, {
    extra: [{ id: "html-traps", from: "Shop <news@shop.com>", subject: "traps", at: "2026-10-15T00:00:00Z", html }],
    answer: (url) => (url.hostname === "img.shop.com" ? answers[url.pathname] : undefined),
    addresses: { "internal.shop.com": ["93.184.216.34", "127.0.0.1"], "tailnet.shop.com": ["100.101.102.103"] },
  });
  const urls = proxyUrls((await body("html-traps", "?images=1")).json.document!);
  const status = async (needle: string) => {
    const response = await get(urls.find((url) => url.includes(encodeURIComponent(needle)))!);
    return [response.status, response.json?.error];
  };
  assert.deepEqual(await status("/svg.png"), [415, "這不是可以顯示的圖片。"]);
  assert.deepEqual(await status("/page.png"), [415, "這不是可以顯示的圖片。"]);
  assert.deepEqual(await status("/huge.png"), [413, "圖片太大，沒有載入。"]);
  assert.deepEqual(await status("/redirect.png"), [403, "這張圖片的位址不允許載入。"]);
  assert.deepEqual(await status("/redirect-meta.png"), [403, "這張圖片的位址不允許載入。"]);
  assert.deepEqual(await status("internal.shop.com"), [403, "這張圖片的位址不允許載入。"]);
  assert.deepEqual(await status("tailnet.shop.com"), [403, "這張圖片的位址不允許載入。"]);
  const followed = await get(urls.find((url) => url.includes(encodeURIComponent("/redirect-ok.png")))!);
  assert.equal(followed.status, 200, "a redirect to a public image is followed");
  assert.ok(!network.requests.some((request) => /10\.0\.0\.1|169\.254|127\.0\.0\.1|100\.101/.test(`${request.address} ${request.url}`)), "no request ever went to a private address");
});

test("a sender on 信任的寄件者 shows images without asking; a domain covers its subdomains; the list is validated", async (t) => {
  const { services, body, server } = await setup(t);
  services.settings.update({ "mail.trustedImageSenders": ["medium.com"] });
  const medium = (await body("html-medium")).json;
  assert.deepEqual(medium.images, { remote: 4, shown: true, trusted: true, trackers: 1 });
  assert.equal(proxyUrls(medium.document!).length, 4);
  assert.deepEqual((await body("html-ithome")).json.images.shown, false, "other senders still ask");

  const bad = await server.call("PUT", "/api/settings/app", { body: { "mail.trustedImageSenders": ["javascript:alert(1)"] } });
  assert.equal(bad.status, 400);
  const saved = await server.call("PUT", "/api/settings/app", { body: { "mail.trustedImageSenders": [" News@ITHome.com.tw ", "news@ithome.com.tw", "example.org"] } });
  assert.deepEqual(saved.json["mail.trustedImageSenders"], ["news@ithome.com.tw", "example.org"], "lower-cased, trimmed, without repeats");
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "mail.bodyView": "html" } })).status, 400);
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "mail.bodyView": "plain" } })).json["mail.bodyView"], "plain");
});

test("cid: images and image attachments come from Gmail as checked rasters; a stale attachment id is read again once", async (t) => {
  const { gmail, body, get } = await setup(t);
  gmail.rotateAttachmentIds = true;
  const mail = (await body("html-photo")).json;
  assert.equal(mail.kind, "html");
  assert.deepEqual(mail.images, { remote: 0, shown: false, trusted: false, trackers: 0 });
  assert.match(mail.document!, /<img src="\/api\/gmail\/messages\/html-photo\/inline\/arch-diagram%40cs\.nycu\.edu\.tw" alt="架構圖" width="580" height="240"/);
  assert.deepEqual(mail.attachments.map((item) => [item.filename, item.url]), [["白板照片.png", "/api/gmail/messages/html-photo/attachments/1"]], "the inline diagram and the PDF are not listed");

  // The held body's attachment ids are already stale (Gmail issued new ones on the next read): the part is read again once.
  await gmail.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/html-photo?format=full");
  const inline = await get("/api/gmail/messages/html-photo/inline/arch-diagram%40cs.nycu.edu.tw");
  assert.equal(inline.status, 200, inline.text);
  assert.equal(inline.headers["content-type"], "image/png");
  assert.equal(inline.headers["content-security-policy"], "default-src 'none'; sandbox");
  assert.match(String(inline.headers["content-disposition"]), /^inline; filename="architecture\.png"/);
  assert.equal(gmail.calls("GET", /^\/messages\/html-photo\?format=full/).length, 3, "the body, the test's read, and one re-read for fresh ids");

  const attachment = await get("/api/gmail/messages/html-photo/attachments/1");
  assert.equal(attachment.status, 200);
  assert.match(String(attachment.headers["content-disposition"]), /filename\*=UTF-8''%E7%99%BD%E6%9D%BF%E7%85%A7%E7%89%87\.png$/);
  const reads = gmail.calls("GET", /^\/messages\/html-photo\/attachments\//).length;
  await get("/api/gmail/messages/html-photo/attachments/1");
  assert.equal(gmail.calls("GET", /^\/messages\/html-photo\/attachments\//).length, reads, "the second view comes from memory");

  assert.equal((await get("/api/gmail/messages/html-photo/attachments/2")).status, 404, "the PDF is not an image part");
  assert.equal((await get("/api/gmail/messages/html-photo/attachments/x.y")).status, 404);
  assert.equal((await get("/api/gmail/messages/html-photo/inline/unknown%40x")).status, 404);
});

test("an image part that is not an image (HTML, SVG) is refused; SVG parts are never listed", async (t) => {
  const part = (mimeType: string, bytes: Buffer, filename: string) => ({
    mimeType, filename, headers: [{ name: "Content-Disposition", value: `attachment; filename="${filename}"` }], body: { size: bytes.length, data: bytes.toString("base64url") },
  });
  const { body, get } = await setup(t, {
    extra: [{
      id: "html-fake-image", from: "Someone <a@b.com>", subject: "x", at: "2026-10-15T00:00:00Z",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { size: 9, data: Buffer.from("<p>hi</p>").toString("base64url") } },
          part("image/png", Buffer.from("<!doctype html><script>alert(1)</script>"), "fake.png"),
          part("image/svg+xml", Buffer.from("<svg onload=alert(1)/>"), "x.svg"),
          part("image/gif", pngImage(2, 2, () => [0, 0, 0]), "real.gif"),
        ],
      },
    }],
  });
  const mail = (await body("html-fake-image")).json;
  assert.deepEqual(mail.attachments.map((item) => item.filename), ["fake.png", "real.gif"]);
  const fake = await get(mail.attachments[0].url);
  assert.deepEqual([fake.status, fake.json.error], [415, "這不是可以顯示的圖片。"]);
  const real = await get(mail.attachments[1].url);
  assert.equal(real.headers["content-type"], "image/png", "the type comes from the bytes, not the sender's label");
  assert.match(String(real.headers["content-disposition"]), /filename="real\.png"/);
});

test("plain text when there is no HTML, when it is too big, when Gmail is not connected; 404 for a mail Gmail no longer has", async (t) => {
  const huge = `<p>${"x".repeat(1_000_100)}</p>`;
  const { body } = await setup(t, {
    extra: [
      { id: "plain-only", from: "A <a@b.com>", subject: "plain", at: "2026-10-15T00:00:00Z", text: "只有純文字" },
      { id: "too-long", from: "A <a@b.com>", subject: "long", at: "2026-10-15T00:00:00Z", html: huge },
      { id: "too-big", from: "A <a@b.com>", subject: "big", at: "2026-10-15T00:00:00Z", html: `<p>${"y".repeat(5_200_000)}</p>` },
    ],
  });
  assert.deepEqual([(await body("plain-only")).json.kind, (await body("plain-only")).json.reason], ["text", "no-html"]);
  assert.deepEqual([(await body("too-long")).json.kind, (await body("too-long")).json.reason], ["text", "too-large"]);
  const big = await body("too-big");
  assert.deepEqual([big.status, big.json.kind, big.json.reason, big.json.sender.email], [200, "text", "too-large", "a@b.com"], "over the 5 MB answer cap: the headers alone");
  assert.equal((await body("missing-message")).status, 404);
  assert.equal((await body("../etc")).status, 404);

  const offline = await setup(t, { connect: false });
  const response = await offline.body("html-ithome");
  assert.deepEqual([response.status, response.json.kind, response.json.reason], [200, "text", "not-connected"]);
  assert.equal((await offline.get("/api/gmail/messages/html-photo/attachments/1")).status, 503);
});

test("the HTML is decoded like the plain text: a Big5 part keeps its Chinese", async (t) => {
  const big5 = Buffer.concat([Buffer.from("<p>"), Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]), Buffer.from("</p>")]);
  const { body } = await setup(t, {
    extra: [{
      id: "html-big5", from: "系辦 <office@cs.nycu.edu.tw>", subject: "big5", at: "2026-10-15T00:00:00Z",
      payload: { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=big5" }], body: { size: big5.length, data: big5.toString("base64url") } },
    }],
  });
  const mail = (await body("html-big5")).json;
  assert.equal(mail.kind, "html");
  assert.match(mail.document!, /<p>中文<\/p>/);
});

test("guard and gate: GET only, same-origin only, and only the owner's Tailscale login", async (t) => {
  const { body, server, get } = await setup(t, { users: "alice@github" });
  const mail = (await body("html-ithome", "?images=1")).json;
  const [url] = proxyUrls(mail.document!);
  for (const path of ["/api/gmail/messages/html-ithome/body", url, "/api/gmail/messages/html-photo/attachments/1"]) {
    assert.equal((await server.call("GET", path)).status, 403, `${path}: no login`);
    assert.equal((await server.call("GET", path, { headers: { ...OWNER, "sec-fetch-site": "cross-site" } })).status, 403, `${path}: cross-site`);
    assert.equal((await server.call("GET", path, { headers: { ...OWNER, origin: "https://evil.example" } })).status, 403, `${path}: foreign origin`);
    assert.notEqual((await server.call("POST", path, { headers: OWNER, body: {} })).status, 200, `${path}: not a write endpoint`);
  }
  assert.equal((await get(url, { "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" })).status, 200, "the frame's own image request");
});

test("logs carry counts and outcomes only: no URL, subject, sender or Content-ID", async (t) => {
  const { body, get } = await setup(t);
  const lines: string[] = [];
  const previous = process.env.BELLPERSONAL_LOG;
  process.env.BELLPERSONAL_LOG = "on";
  t.after(() => { process.env.BELLPERSONAL_LOG = previous; });
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
  const mail = (await body("html-ithome", "?images=1")).json;
  for (const url of proxyUrls(mail.document!)) await get(url);
  await body("html-photo");
  await get("/api/gmail/messages/html-photo/inline/arch-diagram%40cs.nycu.edu.tw");
  await get("/api/gmail/messages/html-photo/inline/missing%40secret-sender.com");
  t.mock.restoreAll();
  process.env.BELLPERSONAL_LOG = previous;
  const text = lines.join("");
  assert.doesNotMatch(text, /ithome|newsletter|零信任|nycu|cmlin|secret-sender|arch-diagram|https?:|%3A%2F%2F/i);
  const events = lines.map((line) => JSON.parse(line));
  const html = events.find((entry) => entry.event === "gmail.body" && entry.outcome === "html");
  assert.deepEqual(Object.keys(html).sort(), ["attachments", "chars", "event", "inline", "ms", "outcome", "remote", "shown", "time", "trackers", "trusted"]);
  assert.ok(events.some((entry) => entry.event === "mail.image" && entry.source === "remote" && entry.outcome === "pixel"));
  assert.ok(events.some((entry) => entry.event === "http" && entry.status === 404 && entry.path === "/api/gmail/messages/html-photo/inline/…"), "the Content-ID is cut from the request log");
});

test("清除快取的信件 also drops held bodies and images", async (t) => {
  const { gmail, body, server } = await setup(t);
  await body("html-ithome");
  await server.call("POST", "/api/gmail/purge", { body: {} });
  await body("html-ithome");
  assert.equal(gmail.calls("GET", /^\/messages\/html-ithome\?format=full/).length, 2, "read from Gmail again");
});

test("what the browser renders never decides what reaches the sender: hover and device-only images are fetched with the body, and a URL the server did not prefetch is not fetched", async (t) => {
  const IMG = "https://img.ithome.com.tw/newsletter/2026/";
  const html = `<style>.x{width:240px;height:80px}@media (pointer:coarse){.x{background:url(${IMG}t1.png)}}@media (max-width:480px){.y{background:url(${IMG}t2.png)}}`
    + `.cta:hover{background:url(${IMG}t3.png)}</style><div class="x"></div><div class="y"></div><a class="cta" href="https://www.ithome.com.tw/">go</a><img src="${IMG}hero.png" alt="hero">`;
  const { network, body, get, server } = await setup(t, { extra: [{ id: "html-hover", from: "iThome 電子報 <newsletter@ithome.com.tw>", subject: "hover", at: "2026-10-15T00:00:00Z", html }] });
  const blocked = (await body("html-hover")).json;
  assert.equal(blocked.images.remote, 4);
  await quiet(network);
  assert.equal(network.requests.length, 0, "blocked: nothing at all");
  const shown = (await body("html-hover", "?images=1")).json;
  const urls = proxyUrls(shown.document!);
  assert.equal(urls.length, 4, "the @media and :hover backgrounds are proxied like the rest");
  await quiet(network);
  assert.deepEqual(network.requests.map((request) => request.url.split("/").pop()).sort(), ["hero.png", "t1.png", "t2.png", "t3.png"], "all of them, before the browser asked for one");
  // The browser asks for the hover image only when the owner hovers, minutes later: answered from memory.
  const hover = await get(urls.find((url) => url.includes("t3.png"))!);
  assert.equal(hover.status, 200);
  assert.equal(network.requests.length, 4);
  // A signed URL whose fetch is no longer held (清除快取的信件 here; five minutes or a full image cache in life) is not fetched again
  // for the browser: the reader asks for the body again, which fetches again.
  await server.call("POST", "/api/gmail/purge", { body: {} });
  const expired = await get(urls.find((url) => url.includes("t1.png"))!);
  assert.deepEqual([expired.status, expired.json.error], [410, "圖片連結無效，請重新打開這封信。"]);
  assert.equal(network.requests.length, 4, "nothing upstream because the browser asked");
});

test("an image part or attachment that declares too many pixels is refused, whatever its byte size", async (t) => {
  const bomb = Buffer.from(pngImage(4, 4, () => [0, 0, 0]));
  bomb.writeUInt32BE(23_000, 16);
  bomb.writeUInt32BE(23_000, 20);
  const part = (filename: string, bytes: Buffer, headers: Array<{ name: string; value: string }>) => ({
    mimeType: "image/png", filename, headers: [{ name: "Content-Type", value: `image/png; name="${filename}"` }, ...headers], body: { size: bytes.length, data: bytes.toString("base64url") },
  });
  const { body, get } = await setup(t, {
    extra: [{
      id: "html-bomb", from: "Shop <news@shop.com>", subject: "bomb", at: "2026-10-15T00:00:00Z",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/html", headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }], body: { size: 40, data: Buffer.from(`<p>Invoice</p><img src="cid:bomb@x" alt="b">`).toString("base64url") } },
          part("inline.png", bomb, [{ name: "Content-ID", value: "<bomb@x>" }, { name: "Content-Disposition", value: "inline; filename=\"inline.png\"" }]),
          part("statement.png", bomb, [{ name: "Content-Disposition", value: "attachment; filename=\"statement.png\"" }]),
        ],
      },
    }],
  });
  const mail = (await body("html-bomb")).json;
  assert.equal(mail.kind, "html");
  const inline = await get("/api/gmail/messages/html-bomb/inline/bomb%40x");
  assert.deepEqual([inline.status, inline.json.error], [415, "這不是可以顯示的圖片。"]);
  const attachment = await get(mail.attachments[0].url);
  assert.deepEqual([attachment.status, attachment.json.error], [415, "這不是可以顯示的圖片。"], "the strip under the message is the app's own document: refused there too");
});

test("a remote image that redirects into a known tracker is never asked for; the browser gets a transparent pixel", async (t) => {
  const html = `<img src="https://links.shop.com/o/u123" alt="logo" width="120" height="40">`;
  const { network, body, get } = await setup(t, {
    extra: [{ id: "html-redirect-pixel", from: "Shop <news@shop.com>", subject: "r", at: "2026-10-15T00:00:00Z", html }],
    answer: (url) => (url.hostname === "links.shop.com" ? { status: 302, headers: { location: "https://u123.ct.sendgrid.net/wf/open?upn=abc" } } : undefined),
  });
  const [url] = proxyUrls((await body("html-redirect-pixel", "?images=1")).json.document!);
  const pixel = await get(url);
  assert.equal(pixel.status, 200);
  assert.deepEqual(pixel.body, TRANSPARENT_GIF);
  await quiet(network);
  assert.deepEqual(network.requests.map((request) => request.url), ["https://links.shop.com/o/u123"], "the tracker host was never asked");
});
