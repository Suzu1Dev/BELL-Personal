import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import ical from "node-ical";
import { detectFeedKind, findDateRange, findLocation, parseIcs, parseRssAtom, plainText, RRULE_STEP_LIMIT, type ParsedFeedEvent, type ParseWindow } from "./feed-parse.js";

const TZ = "Asia/Taipei";
const window = (from: string, to: string, timeZone = TZ) => ({ from: new Date(from), to: new Date(to), timeZone });

const NEW_YORK = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZNAME:EDT
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZNAME:EST
END:STANDARD
END:VTIMEZONE`;

const calendar = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//bell-personal test//EN", NEW_YORK, ...events, "END:VCALENDAR"].join("\r\n");

test("iCal: a weekly event keeps its wall-clock time across the DST change, EXDATE removes one, RECURRENCE-ID moves one", () => {
  const text = calendar(
    "BEGIN:VEVENT\nUID:standup@test\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=America/New_York:20261019T090000\nDTEND;TZID=America/New_York:20261019T100000\nRRULE:FREQ=WEEKLY;COUNT=5\nEXDATE;TZID=America/New_York:20261026T090000\nSUMMARY:Standup\nLOCATION:Room 1\nEND:VEVENT",
    "BEGIN:VEVENT\nUID:standup@test\nDTSTAMP:20261001T000000Z\nRECURRENCE-ID;TZID=America/New_York:20261109T090000\nDTSTART;TZID=America/New_York:20261109T110000\nDTEND;TZID=America/New_York:20261109T120000\nSUMMARY:Standup (moved)\nEND:VEVENT",
  );
  const events = parseIcs(text, window("2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z"));
  assert.deepEqual(events.map((event) => [event.title, event.start, event.end]), [
    ["Standup", "2026-10-19T13:00:00.000Z", "2026-10-19T14:00:00.000Z"], // EDT, UTC−4
    ["Standup", "2026-11-02T14:00:00.000Z", "2026-11-02T15:00:00.000Z"], // EST after 11/1, still 09:00 local
    ["Standup (moved)", "2026-11-09T16:00:00.000Z", "2026-11-09T17:00:00.000Z"],
    ["Standup", "2026-11-16T14:00:00.000Z", "2026-11-16T15:00:00.000Z"],
  ]);
  assert.equal(events[0].location, "Room 1");
  assert.equal(new Set(events.map((event) => event.key)).size, 4, "each occurrence has its own stable key");
  assert.deepEqual(parseIcs(text, window("2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z")).map((event) => event.key), events.map((event) => event.key));
});

test("iCal: the spring-forward week and a daily UNTIL rule", () => {
  const text = calendar(
    "BEGIN:VEVENT\nUID:gym@test\nDTSTAMP:20260101T000000Z\nDTSTART;TZID=America/New_York:20260306T183000\nDURATION:PT1H\nRRULE:FREQ=DAILY;UNTIL=20260309T235959Z\nSUMMARY:Gym\nEND:VEVENT",
  );
  const events = parseIcs(text, window("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z"));
  assert.deepEqual(events.map((event) => event.start), [
    "2026-03-06T23:30:00.000Z", "2026-03-07T23:30:00.000Z", // EST
    "2026-03-08T22:30:00.000Z", "2026-03-09T22:30:00.000Z", // EDT from 3/8
  ]);
  assert.ok(events.every((event) => Date.parse(event.end!) - Date.parse(event.start) === 3_600_000));
});

test("iCal: all-day events land on their local day, cancelled ones and events outside the window are dropped", () => {
  const text = calendar(
    "BEGIN:VEVENT\nUID:withdraw@nycu\nDTSTAMP:20261001T000000Z\nDTSTART;VALUE=DATE:20261030\nDTEND;VALUE=DATE:20261031\nSUMMARY:停修申請截止\nURL:https://www.nycu.edu.tw/calendar\nEND:VEVENT",
    "BEGIN:VEVENT\nUID:break@nycu\nDTSTAMP:20261001T000000Z\nDTSTART;VALUE=DATE:20261009\nDTEND;VALUE=DATE:20261012\nSUMMARY:連假\nEND:VEVENT",
    "BEGIN:VEVENT\nUID:cancelled@test\nDTSTAMP:20261001T000000Z\nDTSTART:20261020T010000Z\nDTEND:20261020T020000Z\nSTATUS:CANCELLED\nSUMMARY:取消的活動\nEND:VEVENT",
    "BEGIN:VEVENT\nUID:old@test\nDTSTAMP:20261001T000000Z\nDTSTART:20250101T010000Z\nSUMMARY:去年的活動\nEND:VEVENT",
    "BEGIN:VEVENT\nUID:g0v@test\nDTSTAMP:20261001T000000Z\nDTSTART;TZID=Asia/Taipei:20261024T090000\nDTEND;TZID=Asia/Taipei:20261024T170000\nSUMMARY:g0v 大松\nDESCRIPTION:<p>報名請見 <b>KKTIX</b></p>\nORGANIZER;CN=g0v:mailto:hi@g0v.tw\nEND:VEVENT",
  );
  const events = parseIcs(text, window("2026-10-11T16:00:00Z", "2026-12-10T16:00:00Z"));
  assert.deepEqual(events.map((event) => event.title), ["g0v 大松", "停修申請截止"]);
  const [g0v, withdraw] = events;
  assert.deepEqual([withdraw.start, withdraw.end, withdraw.allDay], ["2026-10-29T16:00:00.000Z", "2026-10-30T16:00:00.000Z", true]);
  assert.equal(withdraw.url, "https://www.nycu.edu.tw/calendar");
  assert.deepEqual([g0v.start, g0v.end, g0v.allDay], ["2026-10-24T01:00:00.000Z", "2026-10-24T09:00:00.000Z", false]);
  assert.equal(g0v.description, "報名請見 KKTIX");
  assert.equal(g0v.organizer, "g0v");

  const wider = parseIcs(text, window("2026-10-01T00:00:00Z", "2026-12-10T16:00:00Z"));
  const holiday = wider.find((event) => event.title === "連假")!;
  assert.deepEqual([holiday.start, holiday.end], ["2026-10-08T16:00:00.000Z", "2026-10-11T16:00:00.000Z"], "a three-day all-day event ends at the local midnight after its last day");
});

test("iCal: events without a usable start are skipped, never thrown", () => {
  const text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:沒有時間\nEND:VEVENT\nEND:VCALENDAR";
  assert.deepEqual(parseIcs(text, window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")), []);
});

test("RSS: the event module dates, HTML stripped, items without an event date skipped", () => {
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ev="http://purl.org/rss/1.0/modules/event/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>COSCUP 活動</title>
  <item><title>COSCUP 小聚 &amp; 交流</title><link>https://coscup.org/meetup/1</link><guid>meetup-1</guid>
    <ev:startdate>2026-10-20T19:00:00+08:00</ev:startdate><ev:enddate>2026-10-20T21:00:00+08:00</ev:enddate><ev:location>台北 Mozilla 空間</ev:location>
    <description><![CDATA[<p>一起聊開源 <a href="https://x">報名</a></p>]]></description></item>
  <item><title>部落格文章：年度回顧</title><link>https://coscup.org/blog/1</link><pubDate>Mon, 12 Oct 2026 08:00:00 +0800</pubDate><description>沒有活動日期的文章。</description></item>
  <item><title>工作坊</title><link>https://coscup.org/ws</link><content:encoded><![CDATA[<p>時間：2026/11/03（二）14:00 ~ 17:30</p><p>地點：台大社科院 403</p>]]></content:encoded></item>
</channel></rss>`;
  const result = parseRssAtom(rss, window("2026-10-12T00:00:00Z", "2026-12-31T00:00:00Z"));
  assert.equal(result.kind, "rss");
  assert.deepEqual(result.events.map((event) => [event.title, event.start, event.end, event.location]), [
    ["COSCUP 小聚 & 交流", "2026-10-20T11:00:00.000Z", "2026-10-20T13:00:00.000Z", "台北 Mozilla 空間"],
    ["工作坊", "2026-11-03T06:00:00.000Z", "2026-11-03T09:30:00.000Z", "台大社科院 403"],
  ]);
  assert.equal(result.events[0].url, "https://coscup.org/meetup/1");
  assert.equal(result.events[0].description, "一起聊開源 報名");
  assert.equal(result.events[0].organizer, "COSCUP 活動");
});

test("Atom: a KKTIX-style entry with the date and place in the content", () => {
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>g0v 零時政府</title>
  <entry><id>tag:kktix.com,2026:hackath70n</id><title>g0v 零時政府第柒拾次大松</title>
    <link rel="alternate" type="text/html" href="https://g0v.kktix.cc/events/hackath70n"/>
    <published>2026-09-30T10:00:00+08:00</published>
    <summary type="html">&lt;p&gt;2026/10/24(六) 09:00(+0800) ~ 17:00(+0800)&lt;/p&gt;&lt;p&gt;地點：中研院人文館&lt;/p&gt;</summary>
    <author><name>g0v</name></author></entry>
  <entry><id>tag:kktix.com,2026:past</id><title>上個月的松</title><link href="https://g0v.kktix.cc/events/past"/>
    <summary>2026/09/05 09:00 ~ 17:00</summary></entry>
</feed>`;
  const result = parseRssAtom(atom, window("2026-10-11T00:00:00Z", "2026-12-31T00:00:00Z"));
  assert.equal(result.kind, "atom");
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.deepEqual([event.title, event.start, event.end, event.allDay], ["g0v 零時政府第柒拾次大松", "2026-10-24T01:00:00.000Z", "2026-10-24T09:00:00.000Z", false]);
  assert.equal(event.location, "中研院人文館");
  assert.equal(event.url, "https://g0v.kktix.cc/events/hackath70n");
  assert.equal(event.organizer, "g0v");
});

test("XML with entity declarations is refused; detection by content", () => {
  assert.throws(() => parseRssAtom(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel><title>&a;</title></channel></rss>`, window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z")), /格式不受支援/);
  assert.equal(detectFeedKind("﻿BEGIN:VCALENDAR\r\nVERSION:2.0"), "ics");
  assert.equal(detectFeedKind(`<?xml version="1.0"?>\n<rss version="2.0">`), "rss");
  assert.equal(detectFeedKind(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">`), "atom");
  assert.equal(detectFeedKind("<!doctype html><html><body>hi</body></html>"), null);
  assert.equal(detectFeedKind("{\"json\":true}"), null);
});

test("date ranges in free text", () => {
  const start = (text: string) => findDateRange(text, TZ);
  assert.deepEqual(start("2026-10-24 09:00 – 2026-10-25 18:00"), { start: "2026-10-24T01:00:00.000Z", end: "2026-10-25T10:00:00.000Z", allDay: false });
  assert.deepEqual(start("活動日期：2026年11月7日"), { start: "2026-11-06T16:00:00.000Z", end: "2026-11-07T16:00:00.000Z", allDay: true });
  assert.deepEqual(start("2026/11/07 ~ 2026/11/08"), { start: "2026-11-06T16:00:00.000Z", end: "2026-11-08T16:00:00.000Z", allDay: true });
  assert.deepEqual(start("2026/10/24 13:30 (UTC+09:00)"), { start: "2026-10-24T04:30:00.000Z", allDay: false });
  assert.equal(start("沒有日期"), undefined);
  assert.equal(start("2026/02/30 10:00"), undefined, "an impossible date is not an event date");
  assert.equal(findLocation("時間：…\n地點：中研院人文館\n費用：免費"), "中研院人文館");
  assert.equal(plainText("<b>a</b>&amp;&lt;b&gt;&#x4E2D;&#25991;", 40), "a&<b>中文");
  assert.equal(plainText("x".repeat(30), 10), `${"x".repeat(9)}…`);
});

const vevent = (uid: string, lines: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTAMP:20261001T000000Z\nSUMMARY:T\n${lines}\nEND:VEVENT`;
/** 3000 rules stepping every second since 2020: about 2×10^8 steps each to reach the window. */
const secondly = (prefix: string, length = 3000) => Array.from({ length }, (_, index) => vevent(`${prefix}${index}`, "DTSTART:20200101T000000Z\nRRULE:FREQ=SECONDLY"));
const HOSTILE_WINDOW = window("2026-10-12T00:00:00Z", "2026-12-12T00:00:00Z");

test("a hostile feed cannot hold the event loop: huge unbalanced markup, dense RRULEs and thousands of empty rules", () => {
  // CPU time of this thread, the one a parse holds, so other load on the host is not counted; the
  // wall clock only bounds a parse that never ends (a hang would also hit the runner's timeout).
  const timed = (label: string, run: () => unknown) => {
    const cpu = process.threadCpuUsage(), started = performance.now();
    const result = run();
    const used = process.threadCpuUsage(cpu), ms = (used.user + used.system) / 1000, wall = performance.now() - started;
    assert.ok(ms < 500 && wall < 30_000, `${label} took ${ms.toFixed(0)} ms CPU, ${wall.toFixed(0)} ms wall`);
    return result;
  };
  const range = HOSTILE_WINDOW;

  const huge = timed("1 MB of < in a DESCRIPTION", () => parseIcs(calendar(vevent("a", `DTSTART:20261020T010000Z\nDESCRIPTION:${"<".repeat(1_000_000)}`)), range)) as ReturnType<typeof parseIcs>;
  assert.equal(huge.length, 1);
  const hourly = timed("an HOURLY rule with a 50 KB description", () => parseIcs(calendar(vevent("b", `DTSTART:20261001T010000Z\nRRULE:FREQ=HOURLY\nDESCRIPTION:${"<".repeat(50_000)}`)), range)) as ReturnType<typeof parseIcs>;
  assert.ok(hourly.length > 1000, "a recent HOURLY rule still expands inside the window");
  // 3000 SECONDLY rules from 2020: the next two tests, by work done and by CPU time.
  const counted = parseIcs(calendar(vevent("c", "DTSTART:20261013T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=30;COUNT=3")), range);
  assert.equal(counted.length, 3, "a bounded sub-hourly rule is still read");
  const rss = `<rss><channel><title>x</title><item><title>a</title><description><![CDATA[2026/10/24 09:00 ${"<".repeat(1_000_000)}]]></description></item></channel></rss>`;
  assert.equal((timed("1 MB of < in an RSS item", () => parseRssAtom(rss, range)) as ReturnType<typeof parseRssAtom>).events.length, 1);
  assert.equal(plainText("a <b>粗體</b> << c &lt;3", 100), "a 粗體 c <3", "stray brackets go, escaped ones stay");
});

test("3000 SECONDLY rules from 2020 are each skipped before node-ical expands them, and the rules after them still are", (t) => {
  assert.ok((HOSTILE_WINDOW.to.getTime() - Date.UTC(2020, 0, 1)) / 1000 > 8000 * RRULE_STEP_LIMIT, "each rule is far over the step limit");
  // The time budget is frozen, so only the step limit can skip a rule: the bounded rules after the 3000 show the loop reached them.
  t.mock.method(performance, "now", () => 0);
  const expanded: string[] = [];
  const expand = ical.expandRecurringEvent;
  t.mock.method(ical, "expandRecurringEvent", (...args: Parameters<typeof expand>) => {
    expanded.push(String(args[0].uid));
    // Refused rather than iterated, so a regression fails here at once instead of hanging.
    if (String(args[0].uid).startsWith("s")) throw new Error("a SECONDLY rule from 2020 was expanded");
    return expand(...args);
  });
  const events = parseIcs(calendar(...secondly("s"),
    vevent("hourly", "DTSTART:20261001T010000Z\nRRULE:FREQ=HOURLY;UNTIL=20261012T020000Z"),
    vevent("counted", "DTSTART:20261013T000000Z\nRRULE:FREQ=MINUTELY;INTERVAL=30;COUNT=3")), HOSTILE_WINDOW);
  assert.deepEqual(expanded, ["hourly", "counted"], "no SECONDLY rule reached the expansion");
  assert.equal(events.length, 3 + 3, "00:00, 01:00 and 02:00 of the first day in the window, and the three counted half-hours");
});

/**
 * Parses `text` once in a fresh Node process and measures its main thread, the thread a parse
 * holds: CPU time (process.threadCpuUsage, user + system) counts neither other processes on the
 * host nor the wait for a core, nor V8's background compiler and GC threads, which
 * process.cpuUsage adds. One small parse first warms the parser up, as in a running server.
 */
function parseInFreshProcess(text: string, warmUp: string, range: ParseWindow) {
  const script = [
    `const { parseIcs } = await import(${JSON.stringify(new URL("./feed-parse.ts", import.meta.url).href)});`,
    "let input = \"\";",
    "process.stdin.setEncoding(\"utf8\");",
    "for await (const chunk of process.stdin) input += chunk;",
    "const { text, warmUp, from, to, timeZone } = JSON.parse(input);",
    "const range = { from: new Date(from), to: new Date(to), timeZone };",
    "parseIcs(warmUp, range);",
    "const thread = process.threadCpuUsage(), whole = process.cpuUsage(), started = performance.now();",
    "const events = parseIcs(text, range);",
    "const main = process.threadCpuUsage(thread), all = process.cpuUsage(whole);",
    "process.stdout.write(JSON.stringify({ events, mainMs: (main.user + main.system) / 1000, processMs: (all.user + all.system) / 1000, wallMs: performance.now() - started }));",
  ].join("\n");
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script], {
    input: JSON.stringify({ text, warmUp, from: range.from.toISOString(), to: range.to.toISOString(), timeZone: range.timeZone }),
    encoding: "utf8", env, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(child.error, undefined, `the parse did not finish within 30 s: ${child.error?.message}`);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as { events: ParsedFeedEvent[]; mainMs: number; processMs: number; wallMs: number };
}

test("3000 SECONDLY rules from 2020 cost the parsing thread under 500 ms of CPU and finish well within 30 s", () => {
  const result = parseInFreshProcess(calendar(...secondly("s")), calendar(...secondly("w", 100)), HOSTILE_WINDOW);
  assert.deepEqual(result.events, [], "rules that would step millions of times are skipped");
  const report = `main thread ${result.mainMs.toFixed(0)} ms CPU, whole process ${result.processMs.toFixed(0)} ms CPU, ${result.wallMs.toFixed(0)} ms wall`;
  assert.ok(result.mainMs < 500, report);
  console.log(`# 3000 SECONDLY rules: ${report}`);
});

test("a large personal calendar export is cut to the VEVENTs that can touch the window before parsing", () => {
  const range = window("2026-10-12T00:00:00Z", "2026-11-12T00:00:00Z");
  const old = Array.from({ length: 8000 }, (_, index) => {
    const day = new Date(Date.UTC(2015, 0, 1) + index * 3_600_000 * 9).toISOString().slice(0, 10).replace(/-/g, "");
    return `BEGIN:VEVENT\r\nUID:old-${index}\r\nDTSTAMP:20150101T000000Z\r\nDTSTART:${day}T010000Z\r\nDTEND:${day}T020000Z\r\nSUMMARY:舊行程 ${index}\r\nDESCRIPTION:${"說明".repeat(40)}\r\nEND:VEVENT`;
  });
  const current = [
    "BEGIN:VEVENT\r\nUID:now\r\nDTSTAMP:20261001T000000Z\r\nDTSTART;TZID=Asia/Taipei:20261020T140000\r\nDTEND;TZID=Asia/Taipei:20261020T150000\r\nSUMMARY:系上會議\r\nEND:VEVENT",
    "BEGIN:VEVENT\r\nUID:weekly\r\nDTSTAMP:20150101T000000Z\r\nDTSTART:20150105T010000Z\r\nRRULE:FREQ=WEEKLY;UNTIL=20261031T000000Z\r\nSUMMARY:每週例會\r\nEND:VEVENT",
    "BEGIN:VEVENT\r\nUID:span\r\nDTSTAMP:20261001T000000Z\r\nDTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261015\r\nSUMMARY:跨到窗口的展覽\r\nEND:VEVENT",
  ];
  const text = calendar(...old, ...current);
  assert.ok(text.length > 1_000_000);
  const started = performance.now();
  const events = parseIcs(text, range);
  assert.ok(performance.now() - started < 1000, `took ${(performance.now() - started).toFixed(0)} ms`);
  assert.deepEqual([...new Set(events.map((event) => event.title))].sort(), ["每週例會", "系上會議", "跨到窗口的展覽"]);
  assert.equal(events.filter((event) => event.title === "每週例會").length, 3, "the recurring master is kept and expanded");
});
