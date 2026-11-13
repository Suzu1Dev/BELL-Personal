import test from "node:test";
import assert from "node:assert/strict";
import type { EventListItem, EventSuggestionItem } from "../../../shared/events";
import { allEntries, bucketOf, dateBlock, explainEventText, filterCounts, groupEntries, matchesFilter, metaLine, timeText, untilText } from "./events-model";

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const NOW = Date.parse(at("2026-10-12T08:42")); // Monday

const ctf = (id: string, start: string, hours: number, extra: Partial<EventListItem> = {}): EventListItem => ({
  id, category: "ctf", origin: "ctftime", title: id, start: at(start), end: new Date(Date.parse(at(start)) + hours * 3_600_000).toISOString(),
  allDay: false, online: true, url: "https://ctftime.org/event/1/", sourceLabel: "CTFtime", format: "Jeopardy", weight: 55.3, going: false, inGoogle: false, ...extra,
});
const suggestion: EventSuggestionItem = {
  id: "ai:sg", suggestionId: "sg", title: "SITCON 秋季交流會", start: at("2026-10-25T13:30"), end: at("2026-10-25T17:30"), allDay: false,
  location: "中研院人文館", origin: "KKTIX 報名成功信", createdAt: at("2026-10-11T21:35"),
};

test("entries are sorted by start; filters and counts follow SPEC chips", () => {
  const data = {
    events: [
      ctf("ctftime:hitcon", "2026-10-31T10:00", 48),
      ctf("ctftime:balsn", "2026-10-17T08:00", 48, { going: true }),
      { ...ctf("feed:g0v", "2026-10-24T09:00", 8), category: "community" as const, origin: "feed" as const, online: false, location: "中研院", sourceLabel: "g0v 行事曆訂閱", organizer: "g0v" },
    ],
    suggestions: [suggestion],
  };
  const entries = allEntries(data);
  assert.deepEqual(entries.map((entry) => entry.id), ["ctftime:balsn", "feed:g0v", "ai:sg", "ctftime:hitcon"]);
  assert.deepEqual(filterCounts(entries), { all: 4, going: 1, ctf: 2, community: 1, mail: 1 });
  assert.equal(matchesFilter(entries[2], "mail"), true);
  assert.equal(matchesFilter(entries[2], "going"), false);

  assert.deepEqual(groupEntries(entries, NOW, TZ).map((group) => [group.bucket, group.entries.length]), [["week", 1], ["next", 2], ["later", 1]]);
  assert.equal(metaLine(entries[0], TZ), "08:00 起 48 小時 · 線上 · Jeopardy · 權重 55 · CTFtime");
  assert.equal(metaLine(entries[1], TZ), "09:00 起 8 小時 · 中研院 · g0v 行事曆訂閱", "the organizer named in the feed label is not repeated");
  assert.equal(metaLine(entries[2], TZ), "13:30 起 4 小時 · 中研院人文館 · 來自 KKTIX 報名成功信");
});

test("buckets, the date block and the right-hand phrase", () => {
  assert.equal(bucketOf({ start: at("2026-10-12T08:00") }, NOW, TZ), "now");
  assert.equal(bucketOf({ start: at("2026-10-18T23:00") }, NOW, TZ), "week", "Sunday is still this week");
  assert.equal(bucketOf({ start: at("2026-10-19T00:30") }, NOW, TZ), "next");
  assert.equal(bucketOf({ start: at("2026-10-26T09:00") }, NOW, TZ), "later");
  assert.deepEqual(dateBlock(at("2026-10-17T08:00"), NOW, TZ), { date: "10/17", label: "週六" });
  assert.deepEqual(dateBlock(at("2026-10-13T09:00"), NOW, TZ), { date: "10/13", label: "明天" });
  assert.deepEqual(untilText({ start: at("2026-10-17T08:00") }, NOW, TZ), { label: "還有 5 天", muted: true });
  assert.deepEqual(untilText({ start: at("2026-10-13T08:00") }, NOW, TZ), { label: "明天 08:00", muted: false });
  assert.deepEqual(untilText({ start: at("2026-10-12T19:00") }, NOW, TZ), { label: "今天 19:00", muted: false });
  assert.deepEqual(untilText({ start: at("2026-10-12T08:00") }, NOW, TZ), { label: "進行中", muted: false });
  assert.equal(timeText({ start: at("2026-10-30T00:00"), end: at("2026-10-31T00:00"), allDay: true }, TZ), "整天");
  assert.equal(timeText({ start: at("2026-10-30T00:00"), end: at("2026-11-02T00:00"), allDay: true }, TZ), "連續 3 天");
  assert.equal(timeText({ start: at("2026-10-30T19:00"), allDay: false }, TZ), "19:00 起");
});

test("解釋這個 gets the event as plain text: title, then date and time, place and source", () => {
  const event = ctf("ctftime:2871", "2026-10-17T08:00", 48, { title: "Hack.lu CTF 2026", organizer: "FluxFingers" });
  assert.equal(
    explainEventText({ type: "event", id: event.id, start: event.start, end: event.end, item: event }, TZ),
    "Hack.lu CTF 2026\n\n10/17（六） 08:00 起 48 小時\n地點：線上\n主辦：FluxFingers\nJeopardy\n來源：CTFtime",
  );
  assert.equal(
    explainEventText({ type: "suggestion", id: suggestion.id, start: suggestion.start, end: suggestion.end, item: suggestion }, TZ),
    "SITCON 秋季交流會\n\n10/25（日） 13:30 起 4 小時\n地點：中研院人文館\n來自 KKTIX 報名成功信",
  );
});
