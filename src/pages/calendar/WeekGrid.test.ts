import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarDay, CalendarItem } from "../../../shared/calendar";
import { buildHoverCardModel, WeekGrid, WeekHoverCardView } from "./WeekGrid";

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const NOW = Date.parse(at("2026-10-12T09:00"));

const classRow: CalendarItem = {
  id: "manual:os:2026-10-19", kind: "event", origin: "manual", title: "作業系統", start: at("2026-10-19T10:10"), end: at("2026-10-19T12:00"), allDay: false,
  meta: "EC115 · 每週一", sourceLabel: "本機行程", manualId: "os", inGoogle: false, repeat: { freq: "weekly", day: "2026-10-19", first: "2026-09-07" },
};
const oneOff: CalendarItem = {
  id: "manual:study", kind: "event", origin: "manual", title: "讀書會", start: at("2026-10-20T19:00"), end: at("2026-10-20T20:00"), allDay: false,
  meta: "本機行程", sourceLabel: "本機行程", manualId: "study", inGoogle: false,
};
const google: CalendarItem = {
  id: "google:gym", kind: "event", origin: "google", title: "健身", start: at("2026-10-20T07:30"), end: at("2026-10-20T08:30"), allDay: false,
  meta: "", sourceLabel: "Google 行事曆", inGoogle: true,
};
const inGoogleLocal: CalendarItem = { ...oneOff, id: "manual:both", title: "已在 Google", manualId: "both", inGoogle: true, start: at("2026-10-20T15:00"), end: at("2026-10-20T16:00") };
const withLink: CalendarItem = { ...oneOff, id: "manual:going", title: "Balsn CTF", manualId: "going", start: at("2026-10-21T08:00"), end: at("2026-10-21T12:00"), url: "https://ctftime.org/event/1" };
const chip: CalendarItem = { ...oneOff, id: "manual:due", title: "停修截止", manualId: "due", allDay: true, start: at("2026-10-22T00:00"), end: at("2026-10-23T00:00") };

/** The Taipei day an item starts on (the host clock is UTC). */
const localDay = (item: CalendarItem) => new Date(Date.parse(item.start) + 8 * 3_600_000).toISOString().slice(0, 10);
const days: CalendarDay[] = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"].map((day) => ({
  day,
  items: [classRow, oneOff, google, inGoogleLocal, withLink, chip].filter((item) => localDay(item) === day),
  free: [],
}));
const render = (onEdit?: () => void) => renderToStaticMarkup(createElement(WeekGrid, { days, today: "2026-10-12", timeZone: TZ, now: NOW, onOpenDay: () => {}, ...(onEdit ? { onEdit } : {}) }));

/** The opening tag and content of the block that holds `title` (blocks do not nest). */
const block = (html: string, title: string) => html.match(new RegExp(`<(button|div|a)[^>]*class="wk-ev[^"]*"[^>]*>(?:(?!</\\1>).)*${title}(?:(?!</\\1>).)*</\\1>`))?.[0] ?? "";

test("a local event not in Google is a button that opens its editor; the weekly one shows the repeat mark", () => {
  const html = render(() => {});
  const weekly = block(html, "作業系統");
  assert.match(weekly, /^<button type="button" class="wk-ev is-edit"/);
  assert.match(weekly, /aria-label="編輯行程：10:10 作業系統 · 每週一"/);
  assert.match(weekly, /title="10:10 作業系統 · 每週一"/);
  assert.match(weekly, /data-manual="os"/);
  assert.match(weekly, /<span class="mono"><svg[^>]*class="[^"]*wk-repeat[^"]*"/, "the repeat icon sits in front of the time");
  const plain = block(html, "讀書會");
  assert.match(plain, /^<button type="button" class="wk-ev is-edit"/);
  assert.doesNotMatch(plain, /wk-repeat/, "a one-off event has no repeat mark");
  assert.match(plain, /aria-label="編輯行程：19:00 讀書會"/);
  assert.match(block(html, "Balsn CTF"), /^<button type="button"/, "a block with a link opens the editor too (the editor links to it)");
  assert.match(html, /<button type="button" class="wk-chip is-edit"[^>]*aria-label="編輯行程「停修截止」"/, "an all-day chip is a button as well");
});

test("Google events and local events already in Google stay plain without write scope, and become editable buttons with googleCanWrite", () => {
  const html = render(() => {});
  assert.match(block(html, "健身"), /^<div class="wk-ev/);
  assert.match(block(html, "已在 Google"), /^<div class="wk-ev/);
  assert.doesNotMatch(html, /編輯行程：[^"]*(健身|已在 Google)/);
  const twoWay = renderToStaticMarkup(createElement(WeekGrid, { days, today: "2026-10-12", timeZone: TZ, now: NOW, googleCanWrite: true, onOpenDay: () => {}, onEdit: () => {} }));
  assert.match(block(twoWay, "健身"), /^<button type="button" class="wk-ev is-edit"/);
  assert.match(block(twoWay, "已在 Google"), /^<button type="button" class="wk-ev is-edit"/);
  const bare = render();
  assert.doesNotMatch(bare, /is-edit|data-edit/);
  assert.match(block(bare, "Balsn CTF"), /^<a class="wk-ev[^"]*"[^>]*href="https:\/\/ctftime.org\/event\/1"/, "the link block is still a link");
  assert.match(bare, /wk-repeat/, "the weekly mark is shown either way");
});

test("hover info card reveals full title, time span, duration, location and deduplicated details for overlapping blocks", () => {
  const crowded: CalendarItem = {
    id: "manual:overlap-1",
    kind: "event",
    origin: "manual",
    title: "分散式系統期末專題架構與效能評測討論會議",
    start: at("2026-10-19T10:10"),
    end: at("2026-10-19T12:00"),
    allDay: false,
    location: "工程三館 EC115",
    meta: "工程三館 EC115 · 林志明教授 · 每週一 · 本機行程",
    sourceLabel: "本機行程",
    manualId: "overlap-1",
    inGoogle: false,
    repeat: { freq: "weekly", day: "2026-10-19", first: "2026-09-07" },
  };
  const model = buildHoverCardModel(crowded, "2026-10-19", TZ, true);
  assert.equal(model.title, crowded.title);
  assert.equal(model.source, "本機行程");
  assert.equal(model.weekly, "每週一");
  assert.equal(model.when, "10/19（一） · 10:10–12:00");
  assert.equal(model.duration, "1 小時 50 分");
  assert.equal(model.location, "工程三館 EC115");
  assert.equal(model.details, "林志明教授", "deduplicates location, weekly label and sourceLabel from meta");
  assert.equal(model.actionHint, "edit");

  const cardHtml = renderToStaticMarkup(createElement(WeekHoverCardView, { model }));
  assert.match(cardHtml, /class="wk-hover-card is-cal"/);
  assert.match(cardHtml, /分散式系統期末專題架構與效能評測討論會議/);
  assert.match(cardHtml, /工程三館 EC115/);
  assert.match(cardHtml, /林志明教授/);
  assert.match(cardHtml, /1 小時 50 分/);
  assert.match(cardHtml, /點擊方塊即可編輯行程/);
});
