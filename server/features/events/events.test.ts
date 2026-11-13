import test from "node:test";
import assert from "node:assert/strict";
import type { CalendarResponse } from "../../../shared/calendar.js";
import type { FeedListResponse, FeedSummary } from "../../../shared/connect.js";
import type { EventsResponse, ExternalEvent } from "../../../shared/events.js";
import type { TodayPayload } from "../../../shared/today.js";
import type { CoreServices } from "../../services.js";
import { startTestServer, testServices } from "../../test-helpers.js";
import { calendarModule } from "../calendar/index.js";
import { calendarService } from "../calendar/store.js";
import { connectGoogle, fakeNetwork, taipei, type RecordedRequest } from "../calendar/testing.js";
import { CtftimeSync, ctftimeUrl, mapCtftimeEvent } from "./ctftime.js";
import { FeedSourceSync } from "./feed-sync.js";
import { CALENDAR_FEED_MAX_BYTES, decodeFeedBody, feedStore, fetchFeed, isSecretUrl, normalizeFeedUrl, urlHint, detectTarget, type FeedHttp } from "./feeds.js";
import { ResponseTooLargeError, type HttpRequestInit } from "../../sync.js";
import { eventsModule } from "./index.js";

const NOW = new Date(taipei("2026-10-12T08:42"));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** CTFtime's API answer for the mockup week (Balsn 55, TSG 24, HITCON in 19 days). */
function ctftimeAnswer() {
  const event = (id: number, title: string, start: string, hours: number, weight: number, extra: Record<string, unknown> = {}) => ({
    id, title, start: new Date(start).toISOString().replace(".000Z", "+00:00"),
    finish: new Date(Date.parse(start) + hours * 3_600_000).toISOString().replace(".000Z", "+00:00"),
    url: `https://${title.split(" ")[0].toLowerCase()}.example/`, ctftime_url: `https://ctftime.org/event/${id}/`,
    format: "Jeopardy", weight, onsite: false, location: "", organizers: [{ id: 1, name: title.split(" ")[0] }],
    description: "<b>Prizes</b> for the top 3", logo: "", ...extra,
  });
  return [
    event(2846, "Balsn CTF 2026", taipei("2026-10-17T08:00"), 48, 55.31),
    event(2851, "TSG CTF 2026", taipei("2026-10-18T08:00"), 24, 24),
    event(2860, "HITCON CTF 2026 Quals", taipei("2026-10-31T10:00"), 48, 70, { onsite: true, location: "台北" }),
    event(2700, "Ended CTF", taipei("2026-10-10T08:00"), 24, 80),
    { id: "bad" },
  ];
}

const ics = (events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events, "END:VCALENDAR"].join("\r\n");
const G0V_ICS = ics([
  "BEGIN:VEVENT\nUID:hackath70n@g0v\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Taipei:20261024T090000\nDTEND;TZID=Asia/Taipei:20261024T170000\nSUMMARY:g0v 零時政府第柒拾次大松\nLOCATION:中研院\nURL:https://g0v.kktix.cc/events/hackath70n\nEND:VEVENT",
  "BEGIN:VEVENT\nUID:meetup@g0v\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Taipei:20261015T193000\nDTEND;TZID=Asia/Taipei:20261015T213000\nSUMMARY:g0v 小聚\nLOCATION:台北\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT",
]);
const PRIVATE_ICS = ics([
  "BEGIN:VEVENT\nUID:dentist@me\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Taipei:20261012T163000\nDTEND;TZID=Asia/Taipei:20261012T173000\nSUMMARY:看牙醫\nEND:VEVENT",
]);
const G0V_URL = "https://g0v.example.org/events.ics";
const PRIVATE_URL = "https://calendar.google.com/calendar/ical/suzu1dev%40gmail.com/private-0123456789abcdef0123456789abcdef/basic.ics";

function network(extra: (request: RecordedRequest) => Response | undefined = () => undefined) {
  const state = { failG0v: false, ctftime: ctftimeAnswer() as unknown[] };
  const fake = fakeNetwork({
    other: (request) => {
      if (request.url.host === "ctftime.org") return new Response(JSON.stringify(state.ctftime), { status: 200, headers: { "content-type": "application/json" } });
      if (request.url.toString() === G0V_URL) return state.failG0v ? new Response("gone", { status: 404 }) : new Response(G0V_ICS, { status: 200, headers: { "content-type": "text/calendar" } });
      if (request.url.toString() === PRIVATE_URL) return new Response(PRIVATE_ICS, { status: 200 });
      if (request.url.host === "html.example.org") return new Response("<!doctype html><html><body>not a feed</body></html>", { status: 200 });
      return extra(request);
    },
  });
  return { ...fake, state };
}

/** CTFtime is opt-in (shared/settings.ts): these tests are about the people who turned it on. */
function ctftimeOn(services: CoreServices): CoreServices {
  services.settings.update({ "ctftime.enabled": true });
  return services;
}

async function setup(t: test.TestContext, net = network(), commitMs = 60_000) {
  const services = ctftimeOn(testServices(t, { seams: { fetch: net.fetch, now: () => NOW } }));
  const server = await startTestServer(t, services, { modules: [calendarModule, eventsModule], today: { moduleTimeoutMs: 2_000, commitMs } });
  t.after(() => calendarService(services).dropPending());
  return { services, server, net };
}

async function syncCtftime(services: CoreServices) {
  const status = await new CtftimeSync(services).sync();
  assert.equal(status.state, "ok", status.lastError ?? "");
  return status;
}

test("CTFtime: the 30-day request with the bell-personal User-Agent, mapping and the event link", async (t) => {
  const net = network();
  const services = ctftimeOn(testServices(t, { seams: { fetch: net.fetch, now: () => NOW } }));
  const status = await syncCtftime(services);
  assert.equal(status.items, 3, "ended events and malformed rows are dropped");
  const [request] = net.requests;
  assert.equal(request.url.toString(), ctftimeUrl(NOW));
  assert.equal(request.url.searchParams.get("limit"), "100");
  assert.equal(Number(request.url.searchParams.get("finish")), Math.floor(NOW.getTime() / 1000) + 30 * 86_400);
  assert.equal(Number(request.url.searchParams.get("start")), Math.floor(NOW.getTime() / 1000) - 14 * 86_400, "back 14 days: the API filters on the start time");
  assert.equal(request.headers["user-agent"], "bell-personal/0.1 (+self-hosted)");
  const balsn = services.sourceItems.get<ExternalEvent>("ctftime", "ctftime:2846")!.value;
  assert.deepEqual(
    [balsn.title, balsn.start, balsn.end, balsn.url, balsn.weight, balsn.online, balsn.organizer, balsn.format, balsn.description],
    ["Balsn CTF 2026", taipei("2026-10-17T08:00"), taipei("2026-10-19T08:00"), "https://ctftime.org/event/2846/", 55.31, true, "Balsn", "Jeopardy", "Prizes for the top 3"],
  );
  const hitcon = services.sourceItems.get<ExternalEvent>("ctftime", "ctftime:2860")!.value;
  assert.deepEqual([hitcon.online, hitcon.location], [false, "台北"]);
  assert.equal(mapCtftimeEvent({ id: 1, title: "x", start: "not a date" }, NOW), null);

  // Cached at least an hour: background runs skip a fresh cache; turning CTFtime off stops it.
  const source = new CtftimeSync(services);
  source.schedule();
  await wait(10);
  assert.equal(net.requests.length, 1);
  services.settings.update({ "ctftime.enabled": false });
  assert.equal((await source.status()).state, "not_configured");
});

test("today(): event.decide for CTFs at or above the minimum weight and feed events within 7 days; later.events; nav.events", async (t) => {
  const { services, server } = await setup(t);
  await syncCtftime(services);
  const added = await server.call("POST", "/api/events/feeds", { body: { url: G0V_URL, label: "g0v 行事曆訂閱" } });
  assert.equal(added.status, 201, added.text);
  services.suggestions.create({ kind: "event", title: "SITCON", payload: { title: "SITCON 秋季交流會", start: taipei("2026-10-25T13:30"), allDay: false } });

  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  const later = today.queue.find((group) => group.group === "later")!;
  const decide = later.items.filter((item) => item.kind === "event.decide");
  // Soonest first (SPEC-ux §4.3): the meetup on 10/15 before Balsn on 10/17.
  assert.deepEqual(decide.map((item) => item.title), ["g0v 小聚，要參加嗎？", "Balsn CTF 2026，要參加嗎？"], "TSG (24 < 25) is left out; the core keeps the nearest two");
  const [meetup, balsn] = decide;
  assert.deepEqual([meetup.source, meetup.meta, meetup.when?.label], ["feed", ["g0v 行事曆訂閱", "10/15（四）19:30 起 2 小時", "台北"], "還有 3 天"]);
  assert.match(meetup.id, /^feed:[\w-]+:[\w-]+$/);
  assert.deepEqual(
    { title: balsn.title, subject: balsn.subject, meta: balsn.meta, when: balsn.when, actions: balsn.actions.map((action) => [action.id, action.label, action.key]), url: balsn.url, source: balsn.source },
    {
      title: "Balsn CTF 2026，要參加嗎？",
      subject: "Balsn CTF 2026",
      meta: ["CTFtime", "10/17（六）08:00 起 48 小時", "線上", "權重 55"],
      when: { label: "還有 5 天", tone: "muted", mono: false },
      actions: [["going", "要參加", "C"], ["dismiss", "略過", "E"]],
      url: "https://ctftime.org/event/2846/",
      source: "ctftime",
    },
  );
  assert.equal(today.counts.nav?.events, 1, "one event found in mail waiting for a decision");
  assert.deepEqual(today.later.events.map((event) => [event.date, event.title, event.meta]), [
    ["10/22", "g0v 小聚", "台北 · g0v 行事曆訂閱"],
    ["10/24", "g0v 零時政府第柒拾次大松", "中研院 · g0v 行事曆訂閱"],
  ], "rows open in the queue are not repeated; beyond 14 days and below the weight are left out");
});

test("要參加 creates the calendar's local event (and the Google copy after the window); 略過 hides it from #/events", async (t) => {
  const net = network();
  const { services, server } = await setup(t, net, 60);
  await connectGoogle(services);
  await syncCtftime(services);
  assert.equal((await server.call("GET", "/api/today")).status, 200);

  const going = await server.call("POST", "/api/actions", { body: { itemId: "ctftime:2846", action: "going" } });
  assert.equal(going.status, 202, going.text);
  assert.equal(going.json.label, "已標為要參加");
  const [local] = calendarService(services).events.list();
  assert.deepEqual([local.title, local.origin, local.itemId, local.location, local.notes, local.sourceRef?.source, local.sourceRef?.externalId],
    ["Balsn CTF 2026", "going", "ctftime:2846", "線上", "Jeopardy · 權重 55 · Balsn", "ctftime", "ctftime:2846"]);
  await wait(200);
  assert.equal(net.google.inserted.length, 1);
  assert.equal(net.google.inserted[0].summary, "Balsn CTF 2026");

  const list = (await server.call("GET", "/api/events")).json as EventsResponse;
  const card = list.events.find((event) => event.id === "ctftime:2846")!;
  assert.deepEqual([card.going, card.manualEventId, card.inGoogle, card.category, card.sourceLabel], [true, local.id, true, "ctf", "CTFtime"]);
  assert.ok(!list.events.some((event) => event.id === "ctftime:2851"), "below the minimum weight");
  assert.equal(list.events.find((event) => event.id === "ctftime:2860")?.going, false, "events beyond 7 days are on the page");

  const again = await server.call("POST", "/api/actions", { body: { itemId: "ctftime:2846", action: "going" } });
  assert.equal(again.status, 409);
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(today.handled?.find((entry) => entry.itemId === "ctftime:2846")?.title, "Balsn CTF 2026", "the handled list names the event, not the question");
  assert.ok(!today.queue.flatMap((group) => group.items).some((item) => item.id === "ctftime:2846"), "the decided row left the queue");
  assert.ok(today.later.events.some((event) => event.title === "08:00 Balsn CTF 2026" && event.meta === "線上 · CTFtime"), "now a calendar event in 明天與之後");

  // 略過 on an event far away (never a queue row): the core dismisses it, the page hides it.
  const skip = await server.call("POST", "/api/actions", { body: { itemId: "ctftime:2860", action: "dismiss" } });
  assert.equal(skip.status, 202, skip.text);
  const after = (await server.call("GET", "/api/events")).json as EventsResponse;
  assert.ok(!after.events.some((event) => event.id === "ctftime:2860"));
  const skipped = ((await server.call("GET", "/api/today")).json as TodayPayload).handled?.find((entry) => entry.itemId === "ctftime:2860");
  assert.deepEqual([skipped?.title, skipped?.kind], ["HITCON CTF 2026 Quals", "event.decide"], "not 「已略過」 for a row Today never served");
  const undo = await server.call("DELETE", `/api/actions/${skip.json.actionId}`, { body: {} });
  assert.equal(undo.status, 200, undo.text);
  assert.ok(((await server.call("GET", "/api/events")).json as EventsResponse).events.some((event) => event.id === "ctftime:2860"));

  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "ctftime:9999", action: "going" } })).status, 404);
  assert.equal((await server.call("POST", "/api/actions", { body: { itemId: "feed:nope:x", action: "going" } })).status, 404);
});

test("feeds: add (test fetch, detection, secret URLs in the vault), list, duplicates and errors, delete", async (t) => {
  const { services, server, net } = await setup(t);
  const added = await server.call("POST", "/api/events/feeds", { body: { url: "webcal://g0v.example.org/events.ics", label: "g0v 行事曆訂閱" } });
  assert.equal(added.status, 201, added.text);
  const summary = added.json as FeedSummary;
  assert.deepEqual([summary.kind, summary.target, summary.secret, summary.urlHint, summary.enabled, summary.lastError], ["ics", "events", false, "g0v.example.org/events.ics", true, null]);
  assert.equal(summary.events, 4, "the hackathon and three weekly meetups");
  assert.equal(net.requests.at(-1)!.url.toString(), G0V_URL, "webcal:// is fetched over https");
  const events = (await server.call("GET", "/api/events")).json as EventsResponse;
  assert.deepEqual(events.events.map((event) => [event.title, event.sourceLabel, event.category]).slice(0, 2), [["g0v 小聚", "g0v 行事曆訂閱", "community"], ["g0v 小聚", "g0v 行事曆訂閱", "community"]]);
  assert.ok(events.events.every((event) => event.id.startsWith("feed:")));
  assert.deepEqual(events.sources.map((source) => [source.id, source.state]), [["ctftime", "syncing"], ["feeds", "ok"]]);

  const duplicate = await server.call("POST", "/api/events/feeds", { body: { url: G0V_URL, label: "again" } });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.json.error, /g0v 行事曆訂閱/);
  for (const [body, status, pattern] of [
    [{ url: "http://g0v.example.org/x.ics", label: "x" }, 400, /HTTPS/],
    [{ url: "https://user:pw@g0v.example.org/x.ics", label: "x" }, 400, /帳號密碼/],
    [{ url: "https://html.example.org/", label: "x" }, 400, /不是 RSS、Atom 或 iCal/],
    [{ url: "https://missing.example.org/feed", label: "x" }, 502, /HTTP 404/],
    [{ url: G0V_URL, label: "" }, 400, /訂閱名稱/],
  ] as const) {
    const response = await server.call("POST", "/api/events/feeds", { body });
    assert.equal(response.status, status, `${JSON.stringify(body)} → ${response.text}`);
    assert.match(response.json.error, pattern);
  }

  // A secret address: the vault keeps it, the table and every response only the host; it goes on the agenda.
  const secret = await server.call("POST", "/api/events/feeds", { body: { url: PRIVATE_URL, label: "我的 Google 行事曆" } });
  assert.equal(secret.status, 201, secret.text);
  assert.deepEqual([secret.json.secret, secret.json.target, secret.json.urlHint], [true, "calendar", "calendar.google.com"]);
  assert.doesNotMatch(secret.text, /private-0123/);
  const row = services.db.personal.db.prepare("SELECT json FROM event_feeds WHERE id = ?").get(secret.json.id);
  assert.doesNotMatch(String(row?.json), /private-0123/);
  assert.equal(await services.vault.get(`ics.${secret.json.id}`), PRIVATE_URL);
  const list = (await server.call("GET", "/api/events/feeds")).json as FeedListResponse;
  assert.deepEqual(list.feeds.map((feed) => [feed.label, feed.target]), [["g0v 行事曆訂閱", "events"], ["我的 Google 行事曆", "calendar"]]);
  assert.doesNotMatch(JSON.stringify(list), /private-0123/);
  const day = (await server.call("GET", "/api/calendar")).json as CalendarResponse;
  assert.deepEqual(day.days[0].items.map((item) => [item.title, item.origin, item.sourceLabel]), [["看牙醫", "ics", "我的 Google 行事曆"]]);
  assert.equal(day.calendarFeeds, 1);

  // The ics source refetches through the vault URL.
  const icsSync = await new FeedSourceSync(services, "calendar").sync();
  assert.equal(icsSync.state, "ok", icsSync.lastError ?? "");
  assert.equal(net.requests.at(-1)!.url.toString(), PRIVATE_URL);

  const removed = await server.call("DELETE", `/api/events/feeds/${secret.json.id}`, { body: {} });
  assert.deepEqual(removed.json, { deleted: true, removedItems: 1 });
  assert.equal(await services.vault.has(`ics.${secret.json.id}`), false);
  assert.equal(services.sourceItems.count("ics"), 0);
  assert.equal((await server.call("DELETE", `/api/events/feeds/${secret.json.id}`, { body: {} })).status, 404);
});

test("feed sync: one broken feed keeps its cached events and records its error; all broken fails the source", async (t) => {
  const net = network((request) => (request.url.host === "kktix.example.org"
    ? new Response(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>KKTIX</title><entry><id>e1</id><title>SITCON 秋季交流會</title><link href="https://sitcon.kktix.cc/events/autumn"/><summary>2026/10/25 13:30 ~ 17:30 地點：中研院人文館</summary></entry></feed>`, { status: 200 })
    : undefined));
  const { services, server } = await setup(t, net);
  assert.equal((await server.call("POST", "/api/events/feeds", { body: { url: G0V_URL, label: "g0v" } })).status, 201);
  const kktix = await server.call("POST", "/api/events/feeds", { body: { url: "https://kktix.example.org/events.atom", label: "SITCON" } });
  assert.equal(kktix.status, 201, kktix.text);
  assert.deepEqual([kktix.json.kind, kktix.json.events], ["atom", 1]);

  const source = new FeedSourceSync(services, "events");
  net.state.failG0v = true;
  const partial = await source.sync();
  assert.equal(partial.state, "ok");
  assert.equal(services.sourceItems.count("feeds"), 5, "g0v's four cached events stay");
  const feeds = feedStore(services).list({ orderBy: "created_at" });
  assert.match(feeds[0].lastError ?? "", /HTTP 404/);
  assert.equal(feeds[1].lastError, null);
  const listed = (await server.call("GET", "/api/events/feeds")).json as FeedListResponse;
  assert.match(listed.feeds[0].lastError ?? "", /找不到這個訂閱/);

  await server.call("DELETE", `/api/events/feeds/${kktix.json.id}`, { body: {} });
  const failed = await source.sync();
  assert.equal(failed.state, "error");
  assert.match(failed.lastError ?? "", /HTTP 404/);
  assert.equal(services.sourceItems.count("feeds"), 4);
});

test("URL rules: secrets, hints, targets", () => {
  const url = (value: string) => normalizeFeedUrl(value);
  assert.equal(isSecretUrl(url(PRIVATE_URL)), true);
  assert.equal(isSecretUrl(url("https://outlook.office365.com/owa/calendar/0f1e2d3c4b5a69788796a5b4c3d2e1f0@nycu.edu.tw/a1b2c3d4e5f60718293a4b5c6d7e8f90/calendar.ics")), true);
  assert.equal(isSecretUrl(url("https://feeds.example.org/cal.ics?token=abc")), true);
  assert.equal(isSecretUrl(url("https://g0v.kktix.cc/events.atom")), false);
  assert.equal(isSecretUrl(url("https://www.nycu.edu.tw/calendar/2026-fall.ics")), false);
  assert.equal(urlHint(url("https://g0v.kktix.cc/events.atom"), false), "g0v.kktix.cc/events.atom");
  assert.equal(urlHint(url(PRIVATE_URL), true), "calendar.google.com");
  assert.equal(detectTarget(url(PRIVATE_URL), "ics"), "calendar");
  assert.equal(detectTarget(url(PRIVATE_URL), "rss"), "events");
  assert.equal(detectTarget(url("https://www.nycu.edu.tw/calendar.ics"), "ics"), "events");
  assert.throws(() => normalizeFeedUrl("not a url"), /格式不正確/);
});

test("feed bodies decode by BOM, Content-Type charset or the XML declaration (a Big5 RSS feed)", async () => {
  // 「資訊週 2026/10/24 09:00」 in Big5, built from its byte values.
  const title = Buffer.from([0xb8, 0xea, 0xb0, 0x54, 0xb6, 0x67]); // 資訊週
  const xml = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="big5"?><rss version="2.0"><channel><title>x</title><item><title>', "latin1"),
    title,
    Buffer.from("</title><description>2026/10/24 09:00</description></item></channel></rss>", "latin1"),
  ]);
  assert.match(decodeFeedBody(xml, "application/rss+xml"), /<title>資訊週<\/title>/);
  assert.match(decodeFeedBody(xml, "text/xml; charset=UTF-8"), /資訊週/, "a wrong UTF-8 header falls through to the declaration");
  assert.equal(decodeFeedBody(Buffer.from("\ufeffBEGIN:VCALENDAR", "utf8"), "text/calendar"), "BEGIN:VCALENDAR");
  assert.equal(decodeFeedBody(Buffer.from([0xff, 0xfe, 0x41, 0x00]), null), "A");
  const http: FeedHttp = async () => ({ status: 200, ok: true, headers: new Headers({ "content-type": "application/rss+xml" }), body: xml, text: () => xml.toString("utf8"), json: () => ({}) as never });
  const { events } = await fetchFeed(http, "https://feeds.example/rss", { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-12-12T00:00:00Z"), timeZone: "Asia/Taipei" });
  assert.deepEqual(events.map((event) => [event.title, event.start]), [["資訊週", "2026-10-24T01:00:00.000Z"]]);
});

test("a personal calendar export may be up to 30 MB; over the cap the error says what to do", async () => {
  const seen: Array<HttpRequestInit | undefined> = [];
  const tooLarge: FeedHttp = async (_url, init) => { seen.push(init); throw new ResponseTooLargeError(); };
  const range = { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-11-12T00:00:00Z"), timeZone: "Asia/Taipei" };
  await assert.rejects(fetchFeed(tooLarge, "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics", range, "ics", { calendar: true }),
    (error: Error & { status?: number }) => error.status === 413 && /行事曆太大/.test(error.message) && /連接 Google/.test(error.message));
  assert.equal(seen[0]?.maxBytes, CALENDAR_FEED_MAX_BYTES);
  await assert.rejects(fetchFeed(tooLarge, "https://feeds.example/rss", range), /訂閱的內容太大/);
  assert.equal(seen[1]?.maxBytes, undefined, "event feeds keep the default 5 MB cap");
});

test("CTFtime: a CTF that started but has not finished stays on #/events", async (t) => {
  const net = network();
  const running = { id: 3354, title: "Running CTF", start: new Date(taipei("2026-10-11T09:00")).toISOString(), finish: new Date(taipei("2026-10-13T09:00")).toISOString(), url: "https://running.example/", ctftime_url: "https://ctftime.org/event/3354/", weight: 30, onsite: false, organizers: [] };
  net.state.ctftime = [...ctftimeAnswer(), running];
  const services = ctftimeOn(testServices(t, { seams: { fetch: net.fetch, now: () => NOW } }));
  assert.equal((await syncCtftime(services)).items, 4);
  assert.ok(services.sourceItems.get<ExternalEvent>("ctftime", "ctftime:3354"), "running until tomorrow: kept");
  assert.equal(services.sourceItems.get<ExternalEvent>("ctftime", "ctftime:2700"), undefined, "finished: dropped");
});

test("a feed with more than 100 events in the next two weeks keeps the events module on Today", async (t) => {
  const busy = ics(Array.from({ length: 120 }, (_, index) => {
    const start = new Date(Date.parse(taipei("2026-10-13T09:00")) + index * 2 * 3_600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    return `BEGIN:VEVENT\nUID:busy-${index}@kktix\nDTSTAMP:20261001T000000Z\nDTSTART:${start}\nSUMMARY:活動 ${index}\nEND:VEVENT`;
  }));
  const net = network((request) => (request.url.host === "busy.example.org" ? new Response(busy, { status: 200, headers: { "content-type": "text/calendar" } }) : undefined));
  const { server } = await setup(t, net);
  assert.equal((await server.call("POST", "/api/events/feeds", { body: { url: "https://busy.example.org/events.ics", label: "熱門活動" } })).status, 201);
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  const feeds = today.sources.find((source) => source.id === "feeds");
  assert.notEqual(feeds?.state, "error", "the module is not dropped");
  assert.ok(today.queue.flatMap((group) => group.items).some((item) => item.kind === "event.decide"), "event.decide rows are still served");
  assert.ok(today.later.events.length > 0);
});

test("two 要參加 at once on the same CTF create one local event; the second is refused", async (t) => {
  const { services, server } = await setup(t);
  await connectGoogle(services);
  await syncCtftime(services);
  await server.call("GET", "/api/today");
  const [a, b] = await Promise.all([
    server.call("POST", "/api/actions", { body: { itemId: "ctftime:2846", action: "going" } }),
    server.call("POST", "/api/actions", { body: { itemId: "ctftime:2846", action: "going" } }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.equal(calendarService(services).events.list().filter((event) => event.itemId === "ctftime:2846").length, 1);
});

test("a mail event that already started is neither on #/events nor in the 活動 badge", async (t) => {
  const { services, server } = await setup(t);
  const create = (title: string, start: string) => services.suggestions.create({ kind: "event", title, payload: { title, start, allDay: false } });
  create("started yesterday", new Date(NOW.getTime() - 86_400_000).toISOString());
  create("next week", new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
  const today = (await server.call("GET", "/api/today")).json as TodayPayload;
  assert.equal(today.counts.nav?.events, 1);
  const events = (await server.call("GET", "/api/events")).json as EventsResponse;
  assert.deepEqual(events.suggestions.map((suggestion) => suggestion.title), ["next week"]);
});
