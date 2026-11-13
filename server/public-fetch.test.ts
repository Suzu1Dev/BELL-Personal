import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkPublicUrl, isPrivateHostname, isPublicAddress, pinnedRequest, publicFetch, PublicFetchError, resolverLookup,
  type DnsResolver, type PinnedTarget, type PublicNetwork, type PublicResponse, type ResolvedAddress,
} from "./public-fetch.js";

/**
 * The SSRF guard of the mail image proxy (SPEC-mail-html §4.2): the address
 * table, the URL policy before any lookup, DNS rebinding, redirects into a
 * private network, size and time caps — all with an injected network — and
 * one real socket proving the connection goes to the checked address only.
 */

test("only public unicast addresses pass: loopback, private, link-local, CGNAT (the tailnet), ULA, multicast, documentation and mapped forms are refused", () => {
  const refused = [
    "127.0.0.1", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.100.100.100", "100.127.255.254", "192.0.0.8", "192.0.2.1", "198.18.0.1",
    "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "192.88.99.1",
    "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::ffff:100.64.1.1",
    "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::808:808", "fc00::1", "fd00:ec2::254", "fd7a:115c:a1e0::1", "fe80::1", "fe80::1%eth0",
    "fec0::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "2001::1", "2001:0:4136:e378::1", "3fff::1", "[::1]", "not-an-ip", "",
    "1.2.3", "1.2.3.4.5", "256.1.1.1",
  ];
  for (const address of refused) assert.equal(isPublicAddress(address), false, address);
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "::ffff:8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2400:cb00::1"];
  for (const address of allowed) assert.equal(isPublicAddress(address), true, address);
});

test("the URL policy refuses private names, IP literals in any spelling, credentials, other ports and other schemes before any lookup", () => {
  const blocked = [
    "http://localhost/x.png", "http://LOCALHOST./x.png", "http://foo.localhost/x.png", "http://printer.local/x.png", "http://db.internal/x.png",
    "http://nas/x.png", "http://box.tailone.ts.net/x.png", "http://router.lan/x.png", "http://x.home.arpa/", "http://1.0.0.127.in-addr.arpa/",
    "http://127.0.0.1/x.png", "http://2130706433/x.png", "http://0177.0.0.1/x.png", "http://0x7f.1/x.png", "http://127.1/x.png", "http://0/x.png",
    "http://[::1]/x.png", "http://[::ffff:127.0.0.1]/x.png", "http://[::ffff:7f00:1]/x.png", "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.100/", "http://[fd7a:115c:a1e0::1]/", "http://3232235777/", "http://evil.example/x.png",
  ];
  for (const url of blocked) assert.throws(() => checkPublicUrl(url), (error: unknown) => error instanceof PublicFetchError && error.reason === "blocked-address", url);
  const invalid = [
    "ftp://img.example.com/x.png", "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AAAA", "gopher://a.com/", "https://user:pw@img.ithome.com.tw/x.png",
    "https://img.ithome.com.tw:8443/x.png", "http://img.ithome.com.tw:22/", "not a url", "//img.ithome.com.tw/x.png",
  ];
  for (const url of invalid) assert.throws(() => checkPublicUrl(url), (error: unknown) => error instanceof PublicFetchError && error.reason === "invalid-url", url);
  assert.equal(checkPublicUrl("https://img.ithome.com.tw:443/a.png").href, "https://img.ithome.com.tw/a.png", "the default port is fine");
  assert.equal(checkPublicUrl("http://8.8.8.8/a.png").hostname, "8.8.8.8");
  assert.equal(isPrivateHostname("img.ithome.com.tw"), false);
});

interface Call { kind: "lookup" | "request"; host?: string; address?: string; url?: string; headers?: Record<string, string> }

/**
 * Keeps the event loop alive until `release()` or the end of the test, as a
 * real query or connection that is still waiting does (c-ares keeps its
 * socket and timer, a stalled request its socket). A bare pending promise
 * holds nothing, and publicFetch's deadline is an AbortSignal.timeout(),
 * whose timer is unref'd: with nothing else alive the loop drains before the
 * deadline fires, and node:test on Node 22 then cancels every pending test
 * (Node 24's runner keeps the loop alive for pending tests, which hid this).
 */
function holdEventLoop(t: TestContext): () => void {
  const keepAlive = setInterval(() => {}, 2 ** 31 - 1); // never fires: a handle, not a wait
  const release = () => clearInterval(keepAlive);
  t.after(release);
  return release;
}

/** A server that took the connection and never answers: never settles, holds the loop until the request's signal aborts (pinnedRequest destroys the socket then). */
function stalledRequest(t: TestContext, signal: AbortSignal): Promise<PublicResponse> {
  signal.addEventListener("abort", holdEventLoop(t), { once: true });
  return new Promise<PublicResponse>(() => {});
}

function response(status: number, body: Buffer | string = "", headers: Record<string, string> = {}): PublicResponse {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status, headers: { "content-length": String(bytes.length), ...headers },
    body: (async function* () { if (bytes.length) yield bytes; })(),
    cancel: () => {},
  };
}

/** A network whose answers a test writes: lookups by name (one answer list per call), responses by URL. */
function fakeNetwork(lookups: Record<string, ResolvedAddress[][]>, respond: (target: PinnedTarget, signal: AbortSignal) => PublicResponse | Promise<PublicResponse>) {
  const calls: Call[] = [];
  const seen: Record<string, number> = {};
  const network: PublicNetwork = {
    lookup: async (host) => {
      calls.push({ kind: "lookup", host });
      const answers = lookups[host];
      if (!answers) throw new Error("ENOTFOUND");
      const index = Math.min(seen[host] ?? 0, answers.length - 1);
      seen[host] = (seen[host] ?? 0) + 1;
      return answers[index];
    },
    request: async (target, init) => {
      calls.push({ kind: "request", address: target.address, url: target.url.href, headers: init.headers });
      return respond(target, init.signal);
    },
  };
  return { network, calls };
}

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const options = { maxBytes: 1000, timeoutMs: 2000, maxRedirects: 3, accept: "image/*" };

test("DNS rebinding cannot redirect the connection: the request is pinned to the one address that was checked", async () => {
  // A resolver that answers public first and the metadata address afterwards.
  const { network, calls } = fakeNetwork({ "img.rebind.com": [[PUBLIC], [{ address: "169.254.169.254", family: 4 }]] }, () => response(200, "ok"));
  const result = await publicFetch(network, "https://img.rebind.com/a.png", options);
  assert.equal(result.body.toString(), "ok");
  assert.deepEqual(calls.map((call) => call.kind), ["lookup", "request"], "one lookup, one request: nothing resolves the name again");
  assert.equal(calls[1].address, "93.184.216.34");
  assert.deepEqual(calls[1].headers, { accept: "image/*", "accept-encoding": "identity", "user-agent": "Mozilla/5.0" }, "no cookie, no referer, a generic UA");

  // The next fetch sees the private answer and sends nothing.
  await assert.rejects(publicFetch(network, "https://img.rebind.com/a.png", options), (error: unknown) => error instanceof PublicFetchError && error.reason === "blocked-address");
  assert.equal(calls.filter((call) => call.kind === "request").length, 1);
});

test("every resolved address must be public: one private answer among public ones refuses the fetch", async () => {
  const { network, calls } = fakeNetwork({ "mixed.com": [[PUBLIC, { address: "10.0.0.5", family: 4 }]], "v6.com": [[{ address: "::ffff:192.168.0.1", family: 6 }]] }, () => response(200, "x"));
  await assert.rejects(publicFetch(network, "https://mixed.com/a.png", options), (error: unknown) => (error as PublicFetchError).reason === "blocked-address");
  await assert.rejects(publicFetch(network, "https://v6.com/a.png", options), (error: unknown) => (error as PublicFetchError).reason === "blocked-address");
  assert.equal(calls.filter((call) => call.kind === "request").length, 0);
});

test("redirects are followed at most three times and every hop is checked again", async () => {
  const hops: Record<string, PublicResponse> = {};
  const { network, calls } = fakeNetwork({
    "a.com": [[PUBLIC]], "b.com": [[PUBLIC]], "inside.com": [[{ address: "192.168.1.10", family: 4 }]],
  }, (target) => hops[target.url.href] ?? response(404));
  hops["https://a.com/1"] = response(302, "", { location: "https://b.com/2" });
  hops["https://b.com/2"] = response(301, "", { location: "/3" });
  hops["https://b.com/3"] = response(200, "image");
  const ok = await publicFetch(network, "https://a.com/1", options);
  assert.deepEqual([ok.body.toString(), ok.url, ok.redirects], ["image", "https://b.com/3", 2]);

  hops["https://a.com/to-private"] = response(302, "", { location: "http://127.0.0.1/admin" });
  hops["https://a.com/to-private-name"] = response(307, "", { location: "https://inside.com/x" });
  hops["https://a.com/to-metadata"] = response(308, "", { location: "http://[::ffff:169.254.169.254]/latest" });
  hops["https://a.com/to-file"] = response(302, "", { location: "file:///etc/passwd" });
  for (const path of ["to-private", "to-private-name", "to-metadata"]) {
    await assert.rejects(publicFetch(network, `https://a.com/${path}`, options), (error: unknown) => (error as PublicFetchError).reason === "blocked-address", path);
  }
  await assert.rejects(publicFetch(network, "https://a.com/to-file", options), (error: unknown) => (error as PublicFetchError).reason === "invalid-url");
  assert.ok(!calls.some((call) => call.kind === "request" && /127\.0\.0\.1|inside\.com|169\.254/.test(call.url ?? "")), "no request ever left for a private target");

  for (let index = 0; index < 5; index++) hops[`https://a.com/loop${index}`] = response(302, "", { location: `https://a.com/loop${index + 1}` });
  await assert.rejects(publicFetch(network, "https://a.com/loop0", options), (error: unknown) => (error as PublicFetchError).reason === "too-many-redirects");
});

test("the caller's checkUrl judges every hop before anything is sent to it (a redirect into a tracker is not followed)", async () => {
  const { network, calls } = fakeNetwork({ "links.shop.com": [[PUBLIC]], "u1.ct.sendgrid.net": [[PUBLIC]] }, (target) => (
    target.url.hostname === "links.shop.com" ? response(302, "", { location: "https://u1.ct.sendgrid.net/wf/open?upn=abc" }) : response(200, "GIF89a")
  ));
  const checkUrl = (url: URL) => !url.hostname.endsWith("sendgrid.net");
  await assert.rejects(publicFetch(network, "https://links.shop.com/o/u123", { ...options, checkUrl }), (error: unknown) => error instanceof PublicFetchError && error.reason === "refused-url");
  assert.deepEqual(calls.map((call) => `${call.kind} ${call.host ?? call.url}`), ["lookup links.shop.com", "request https://links.shop.com/o/u123"], "the tracker was never looked up or asked");
  await assert.rejects(publicFetch(network, "https://u1.ct.sendgrid.net/wf/open", { ...options, checkUrl }), (error: unknown) => (error as PublicFetchError).reason === "refused-url", "the first URL too");
  assert.equal(calls.length, 2);
});

/** A resolver whose answers a test controls; it records cancel(). */
function fakeResolver(t: TestContext, answers: { v4?: string[] | Error | "hang"; v6?: string[] | Error | "hang" }) {
  const state = { cancelled: 0, created: 0 };
  const resolve = (answer: string[] | Error | "hang" | undefined) => new Promise<string[]>((done, fail) => {
    if (answer === "hang") return; // only cancel() ends it
    if (answer instanceof Error) fail(answer);
    else if (answer) done(answer);
    else fail(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
  });
  const create = (): DnsResolver => {
    state.created++;
    // Like c-ares: a query still waiting holds the event loop, and cancel() fails (and releases) every one on this resolver.
    const waiting: Array<(error: Error) => void> = [];
    const hanging = (answer: string[] | Error | "hang" | undefined) => (answer === "hang"
      ? new Promise<string[]>((_done, fail) => {
        const release = holdEventLoop(t);
        waiting.push((error) => { release(); fail(error); });
      })
      : resolve(answer));
    return {
      resolve4: () => hanging(answers.v4),
      resolve6: () => hanging(answers.v6),
      cancel: () => {
        state.cancelled++;
        for (const fail of waiting.splice(0)) fail(Object.assign(new Error("ECANCELLED"), { code: "ECANCELLED" }));
      },
    };
  };
  return { create, state };
}

test("lookups use their own c-ares resolver: both families, one empty family is fine, and an abort cancels the query", async (t) => {
  const both = fakeResolver(t, { v4: ["93.184.216.34"], v6: ["2606:4700::1"] });
  assert.deepEqual(await resolverLookup(both.create)("img.com"), [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1", family: 6 }]);
  const v6only = fakeResolver(t, { v6: ["2606:4700::1"] });
  assert.deepEqual(await resolverLookup(v6only.create)("img.com"), [{ address: "2606:4700::1", family: 6 }]);
  const none = fakeResolver(t, { v4: Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }) });
  await assert.rejects(resolverLookup(none.create)("nowhere.com"), /ENOTFOUND/);

  // A zone that never answers: the fetch's deadline aborts the lookup and the resolver is cancelled, so nothing keeps waiting.
  const slow = fakeResolver(t, { v4: "hang", v6: "hang" });
  const controller = new AbortController();
  const pending = resolverLookup(slow.create)("slow.attacker.com", controller.signal);
  controller.abort(new Error("deadline"));
  await assert.rejects(pending, /ECANCELLED/);
  assert.equal(slow.state.cancelled, 1);
  const network: PublicNetwork = { lookup: resolverLookup(slow.create), request: async () => response(200, "x") };
  const started = Date.now();
  await assert.rejects(publicFetch(network, "https://slow.attacker.com/a.png", { ...options, timeoutMs: 50 }), (error: unknown) => (error as PublicFetchError).reason === "timeout");
  assert.ok(Date.now() - started < 1000);
  assert.equal(slow.state.cancelled, 2, "the deadline cancelled the second lookup too");
  await assert.rejects(resolverLookup(slow.create)("x.com", AbortSignal.abort(new Error("gone"))), /gone/, "an aborted fetch does not even start one");
  assert.equal(slow.state.created, 2);
});

test("size, time and status caps: declared and streamed oversize, a stalled answer, non-2xx and unreachable hosts", async (t) => {
  const big = Buffer.alloc(1500, 1);
  const { network } = fakeNetwork({ "img.com": [[PUBLIC]] }, (target, signal) => {
    if (target.url.pathname === "/declared") return response(200, big);
    if (target.url.pathname === "/streamed") return { status: 200, headers: {}, body: (async function* () { for (let i = 0; i < 10; i++) yield Buffer.alloc(200, 2); })(), cancel: () => {} };
    if (target.url.pathname === "/slow") return stalledRequest(t, signal);
    if (target.url.pathname === "/gone") return response(404);
    return response(200, "ok");
  });
  await assert.rejects(publicFetch(network, "https://img.com/declared", options), (error: unknown) => (error as PublicFetchError).reason === "too-large");
  await assert.rejects(publicFetch(network, "https://img.com/streamed", options), (error: unknown) => (error as PublicFetchError).reason === "too-large");
  await assert.rejects(publicFetch(network, "https://img.com/slow", { ...options, timeoutMs: 50 }), (error: unknown) => (error as PublicFetchError).reason === "timeout");
  await assert.rejects(publicFetch(network, "https://img.com/gone", options), (error: unknown) => (error as PublicFetchError).reason === "status" && (error as PublicFetchError).status === 404);
  await assert.rejects(publicFetch(network, "https://unknown-host.com/a.png", options), (error: unknown) => (error as PublicFetchError).reason === "unreachable");
});

test("a pinned request connects to the checked address even when the name resolves nowhere, and sends the URL's Host", async (t) => {
  const seen: Array<{ host?: string; path?: string; cookie?: string; referer?: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, path: req.url, cookie: req.headers.cookie, referer: req.headers.referer });
    res.writeHead(200, { "content-type": "image/png" });
    res.end("pinned");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  // `pinned.invalid` has no DNS answer anywhere: only the pinned lookup can make this connect.
  const answer = await pinnedRequest(
    { url: new URL(`http://pinned.invalid:${port}/img.png?x=1`), address: "127.0.0.1", family: 4 },
    { headers: { accept: "image/*" }, signal: AbortSignal.timeout(2000) },
  );
  const chunks: Buffer[] = [];
  for await (const chunk of answer.body) chunks.push(Buffer.from(chunk));
  assert.equal(answer.status, 200);
  assert.equal(Buffer.concat(chunks).toString(), "pinned");
  assert.deepEqual(seen, [{ host: `pinned.invalid:${port}`, path: "/img.png?x=1", cookie: undefined, referer: undefined }]);
});
