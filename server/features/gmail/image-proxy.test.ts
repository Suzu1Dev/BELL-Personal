import test from "node:test";
import assert from "node:assert/strict";
import type { PublicNetwork, PublicResponse } from "../../public-fetch.js";
import { demoPublicNetwork, PIXEL_GIF, pngImage } from "./fixtures/html-mail.js";
import { ImageProxy, ImageSigner, PROXY_CONCURRENCY, PROXY_MESSAGE_SLOTS, WindowLimiter } from "./image-proxy.js";
import { LiveMail } from "./live.js";

/**
 * The proxy's own rules (SPEC-mail-html §4.2): signatures, budgets, one fetch
 * per URL at a time, the server's prefetch as the only thing that goes
 * upstream, trackers behind redirects, decompression bombs, and slots shared
 * fairly between messages.
 */

test("signatures bind the message and the URL to this process's key", () => {
  const signer = new ImageSigner(Buffer.alloc(32, 1));
  const other = new ImageSigner(Buffer.alloc(32, 2));
  const signature = signer.sign("m1", "https://a.com/x.png");
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(signer.verify("m1", "https://a.com/x.png", signature), true);
  assert.equal(signer.verify("m2", "https://a.com/x.png", signature), false);
  assert.equal(signer.verify("m1", "https://a.com/y.png", signature), false);
  assert.equal(other.verify("m1", "https://a.com/x.png", signature), false, "a restart (new key) invalidates old URLs");
  assert.equal(signer.verify("m1", "https://a.com/x.png", signature.slice(1)), false);
  assert.equal(signer.path("m1", "https://a.com/x.png?a=1&b=2"), `/api/mail-images/proxy?m=m1&u=https%3A%2F%2Fa.com%2Fx.png%3Fa%3D1%26b%3D2&s=${signer.sign("m1", "https://a.com/x.png?a=1&b=2")}`);
});

test("each message and the server have a fetch budget per window; held images and repeats do not spend it", async (t) => {
  let now = 0;
  const network = demoPublicNetwork({ answer: () => ({ status: 200, body: pngImage(4, 4, () => [1, 2, 3]) }) });
  const live = new LiveMail(() => now);
  t.after(() => live.close());
  const proxy = new ImageProxy({ network, live, clock: () => now, limits: { perMessage: 3, global: 6 } });
  for (let index = 0; index < 3; index++) assert.equal((await proxy.fetch("m1", `https://a.com/${index}.png`)).kind, "image");
  assert.deepEqual(await proxy.fetch("m1", "https://a.com/3.png"), { kind: "refused", reason: "rate-limited" });
  assert.equal((await proxy.fetch("m1", "https://a.com/0.png")).kind, "image", "a held image is free");
  assert.equal((await proxy.fetch("m2", "https://a.com/9.png")).kind, "image");
  assert.equal((await proxy.fetch("m3", "https://a.com/8.png")).kind, "image");
  // A fetch that ends in a refusal gives its share of the server-wide budget back (a hostile mail cannot spend it for everyone).
  const failing = new ImageProxy({ network: demoPublicNetwork({ answer: () => ({ status: 404 }) }), live, clock: () => now, limits: { perMessage: 10, global: 2 } });
  for (let index = 0; index < 5; index++) assert.deepEqual(await failing.fetch("hostile", `https://bad.com/${index}.png`), { kind: "refused", reason: "status" });
  assert.equal((await failing.fetch("hostile", "https://bad.com/5.png")).kind, "refused");
  assert.equal((await proxy.fetch("m3", "https://a.com/6.png")).kind, "image");
  assert.deepEqual(await proxy.fetch("m4", "https://a.com/7.png"), { kind: "refused", reason: "rate-limited" }, "the global budget");
  now += 5 * 60_000;
  assert.equal((await proxy.fetch("m1", "https://a.com/3.png")).kind, "image", "a new window");

  const same = await Promise.all([proxy.fetch("m5", "https://a.com/same.png"), proxy.fetch("m5", "https://a.com/same.png")]);
  assert.deepEqual(same.map((outcome) => outcome.kind), ["image", "image"]);
  assert.equal(network.requests.filter((request) => request.url.endsWith("same.png")).length, 1, "one fetch for both");
});

test("the window limiter forgets expired keys", () => {
  let now = 0;
  const limiter = new WindowLimiter(1, 1000, () => now);
  assert.equal(limiter.take("a"), true);
  assert.equal(limiter.take("a"), false);
  now = 1000;
  assert.equal(limiter.take("a"), true);
});

/** A network whose requests wait until the test lets them answer. */
function heldNetwork() {
  const waiting: Array<{ url: string; answer: (response: PublicResponse) => void }> = [];
  const network: PublicNetwork = {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: (target) => new Promise((answer) => { waiting.push({ url: target.url.href, answer }); }),
  };
  const png = pngImage(4, 4, () => [1, 2, 3]);
  const ok: PublicResponse = { status: 200, headers: { "content-length": String(png.length) }, body: (async function* () { yield png; })(), cancel: () => {} };
  const release = (count = waiting.length) => { for (const entry of waiting.splice(0, count)) entry.answer({ ...ok, body: (async function* () { yield png; })() }); };
  return { network, waiting, release };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("only the server's prefetch goes upstream: the browser is answered from it, and a URL nobody prefetched is never fetched", async (t) => {
  const network = demoPublicNetwork({ answer: (url) => ({ status: 200, body: pngImage(8, 8, () => [url.pathname.length, 0, 0]) }) });
  const live = new LiveMail();
  t.after(() => live.close());
  const proxy = new ImageProxy({ network, live });
  const urls = ["https://a.com/shown.png", "https://a.com/hover.png", "https://a.com/phone.png"];
  const done = proxy.prefetch("m1", urls);
  // Registered before prefetch returns: a browser request right after the body joins the fetch.
  const joined = await proxy.serve("https://a.com/hover.png");
  assert.equal(joined.kind, "image");
  assert.deepEqual((await done).map((outcome) => outcome.kind), ["image", "image", "image"]);
  assert.deepEqual(network.requests.map((request) => request.url), urls, "every image of the body, in order, whatever the browser shows");
  // Later (a :hover rule, a phone-width @media): answered from memory, nothing new upstream.
  assert.equal((await proxy.serve("https://a.com/phone.png")).kind, "image");
  assert.deepEqual(await proxy.serve("https://a.com/never-prefetched.png"), { kind: "refused", reason: "expired" });
  assert.equal(network.requests.length, 3);
  // A second build of the same body fetches nothing again.
  await proxy.prefetch("m1", urls);
  assert.equal(network.requests.length, 3);
  // Refusals are held too, so the browser's request does not try again.
  const refusing = new ImageProxy({ network: demoPublicNetwork({ answer: () => ({ status: 200, body: Buffer.from("<svg onload=alert(1)>") }) }), live });
  await refusing.prefetch("m2", ["https://b.com/x.png"]);
  assert.deepEqual(await refusing.serve("https://b.com/x.png"), { kind: "refused", reason: "not-image" });
  // 清除快取的信件 drops them with everything else held.
  live.clear();
  assert.deepEqual(await refusing.serve("https://b.com/x.png"), { kind: "refused", reason: "expired" });
  assert.deepEqual(await proxy.serve("https://a.com/phone.png"), { kind: "refused", reason: "expired" });
});

test("a redirect into a known tracker is not followed, and a decompression bomb is refused", async (t) => {
  const bomb = Buffer.from(pngImage(4, 4, () => [0, 0, 0]));
  bomb.writeUInt32BE(23_000, 16);
  bomb.writeUInt32BE(23_000, 20);
  const network = demoPublicNetwork({
    answer: (url) => (url.hostname === "links.shop.com" ? { status: 302, headers: { location: "https://u123.ct.sendgrid.net/wf/open?upn=abc" } }
      : url.pathname === "/bomb.png" ? { status: 200, body: bomb }
        : url.pathname === "/open/u123.gif" ? { status: 200, body: PIXEL_GIF } : undefined),
  });
  const live = new LiveMail();
  t.after(() => live.close());
  const proxy = new ImageProxy({ network, live });
  const outcomes = await proxy.prefetch("m1", ["https://links.shop.com/o/u123", "https://img.shop.com/bomb.png", "https://img.shop.com/open/u123.gif"]);
  assert.deepEqual(outcomes, [{ kind: "pixel", tracker: true }, { kind: "refused", reason: "too-large" }, { kind: "pixel" }]);
  assert.ok(!network.requests.some((request) => request.url.includes("sendgrid")), "the tracker host was never asked");
  assert.ok(!network.lookups.some((host) => host.includes("sendgrid")));
  assert.deepEqual(await proxy.serve("https://links.shop.com/o/u123"), { kind: "pixel", tracker: true });
  assert.deepEqual(await proxy.serve("https://img.shop.com/bomb.png"), { kind: "refused", reason: "too-large" });
});

test("one message holds at most four of the six slots, and a fetch that waits too long for one gives up", async (t) => {
  const { network, waiting, release } = heldNetwork();
  const live = new LiveMail();
  t.after(() => live.close());
  const proxy = new ImageProxy({ network, live, limits: { queueMs: 200 } });
  const hostile = proxy.prefetch("hostile", Array.from({ length: 18 }, (_, index) => `https://slow${index}.attacker.com/x.png`));
  await tick();
  await tick();
  assert.equal(waiting.length, PROXY_MESSAGE_SLOTS, "the hostile mail's slow hosts take four slots, not six");
  const normal = proxy.prefetch("newsletter", ["https://img.ok.com/a.png", "https://img.ok.com/b.png"]);
  await tick();
  await tick();
  assert.equal(waiting.length, PROXY_CONCURRENCY, "another mail starts at once");
  const ours = waiting.filter((entry) => entry.url.includes("img.ok.com"));
  for (const entry of ours) waiting.splice(waiting.indexOf(entry), 1);
  for (const entry of ours) entry.answer({ status: 200, headers: {}, body: (async function* () { yield pngImage(4, 4, () => [1, 1, 1]); })(), cancel: () => {} });
  assert.deepEqual((await normal).map((outcome) => outcome.kind), ["image", "image"], "the newsletter never waited behind the hostile mail");
  // The hostile mail's queue: no slot comes within the wait, so the rest give up instead of holding the queue for minutes.
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  const outcomes = await hostile;
  assert.equal(outcomes.filter((outcome) => outcome.kind === "refused" && outcome.reason === "timeout").length, 18 - PROXY_MESSAGE_SLOTS, "queued fetches time out");
  assert.equal(outcomes.filter((outcome) => outcome.kind === "image").length, PROXY_MESSAGE_SLOTS);
  assert.equal(waiting.length, 0, "nothing was started after giving up");
});
