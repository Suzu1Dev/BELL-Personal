/** Today's agenda card: weekly rows carry the calendar's repeat mark with a label a screen reader reads. */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockupToday } from "../../lib/today.fixture";
import { AgendaCard, weeklyRepeat } from "./AgendaCard";

const noop = () => {};

test("the weekly repeat is the last meta segment the server adds (「… · 每週一」)", () => {
  assert.equal(weeklyRepeat("工程三館 EC115 · 林志明 · 每週一"), "每週一");
  assert.equal(weeklyRepeat("每週日"), "每週日");
  assert.equal(weeklyRepeat("工程三館 EC115 · 林志明"), undefined);
  assert.equal(weeklyRepeat(""), undefined);
  assert.equal(weeklyRepeat("每週一讀書會 · 圖書館"), undefined, "a title-like note is not the repeat");
  assert.equal(weeklyRepeat("每週 3 次"), undefined);
});

test("a weekly agenda row shows the repeat icon (decorative) and reads 「每週重複」; a one-off row does not", () => {
  const payload = mockupToday();
  payload.agenda.items = [
    { ...payload.agenda.items[0], meta: "工程三館 EC115 · 林志明 · 每週一" },
    payload.agenda.items[1],
  ];
  const html = renderToStaticMarkup(createElement(AgendaCard, { payload, onAdd: noop, onSchedule: noop, onToggleHabit: noop, onSyncSources: noop }));
  const rows = html.split('class="tl-row').slice(1);
  const weekly = rows.find((row) => row.includes("作業系統"))!;
  const once = rows.find((row) => row.includes("OS 讀書會"))!;
  assert.match(weekly, /<svg[^>]*class="[^"]*tl-repeat[^"]*"[^>]*aria-hidden="true"/);
  assert.match(weekly, /<span class="sr-only">每週重複，<\/span>工程三館 EC115 · 林志明 · 每週一/);
  assert.doesNotMatch(once, /tl-repeat|每週重複/);
});
