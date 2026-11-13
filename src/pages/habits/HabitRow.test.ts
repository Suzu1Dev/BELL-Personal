/**
 * The habit row's heat strip as markup (renderToStaticMarkup): every day
 * that can be changed is a toggle button around its dot, the strip is one
 * tab stop, days that cannot be changed stay plain dots, and the automatic
 * habit's strip is a picture with no buttons.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AUTO_HABIT_ID, habitSummary, type Habit } from "../../../shared/habits";
import { addDays } from "../../../shared/time";
import { HabitRow, type HabitRowActions } from "./HabitRow";

const MONDAY = "2026-10-12";
const noop = () => {};
const actions: HabitRowActions = { toggle: noop, edit: noop, move: noop, backfill: noop, setDay: noop, archive: noop, remove: noop, autoOff: noop };
const habit = (extra: Partial<Habit> = {}, days: string[] = []) => habitSummary(
  { id: "read", name: "閱讀", cadence: "daily", targetPerDay: 1, archived: false, order: 0, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", ...extra },
  days.map((day) => ({ day, count: 1 })),
  { today: MONDAY, timeZone: "Asia/Taipei", weekStartsMonday: true, createdDay: "2026-07-01" },
);
const row = (summary: ReturnType<typeof habit>) => renderToStaticMarkup(createElement(HabitRow, { habit: summary, index: 0, count: 1, today: MONDAY, actions }));
const heat = (html: string) => /<div class="h-heat"[^>]*>(.*?)<\/div><span class="h-streak"/s.exec(html)?.[1] ?? "";
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test("a habit's heat strip: a toggle button for each day up to today, today the one tab stop, the future plain dots", () => {
  const html = row(habit({}, [addDays(MONDAY, -1), addDays(MONDAY, -3)]));
  assert.match(html, /<div class="h-heat" role="group" aria-label="閱讀，最近 5 週完成 2 天。按方向鍵選日子，按空白鍵打卡或取消">/);
  const strip = heat(html);
  assert.equal(count(strip, /<button /g), 29, "9/14 through 10/12");
  assert.equal(count(strip, /<i [^>]*aria-hidden="true"/g), 6, "10/13 through 10/18 cannot be pressed");
  assert.equal(count(strip, /tabindex="0"/g), 1);
  assert.match(strip, /<button type="button" data-day="2026-10-12" tabindex="0" aria-pressed="false" aria-label="10\/12（今天） 打卡" title="10\/12 沒做到"><i class="t"><\/i><\/button>/);
  assert.match(strip, /data-day="2026-10-11" tabindex="-1" aria-pressed="true" aria-label="10\/11 打卡" title="10\/11 完成"><i class="y"><\/i>/);
  assert.match(strip, /data-day="2026-10-09" tabindex="-1" aria-pressed="true"/);
  assert.match(strip, /data-day="2026-10-10" tabindex="-1" aria-pressed="false"/);
  assert.doesNotMatch(strip, /data-day="2026-10-13"/);
});

test("rest days are buttons that say so; the automatic habit's strip stays a picture", () => {
  // Twice a week, met on 9/14 and 9/15: the rest of that week is not needed, and can still be checked in.
  const weekly = heat(row(habit({ cadence: "weekly", timesPerWeek: 2 }, ["2026-09-14", "2026-09-15"])));
  assert.match(weekly, /data-day="2026-09-16" tabindex="-1" aria-pressed="false" aria-label="9\/16 打卡（這天不用做）" title="9\/16 這天不用做"><i class="rest"><\/i>/);
  assert.match(weekly, /data-day="2026-09-15" tabindex="-1" aria-pressed="true"/);

  const auto = row(habit({ id: AUTO_HABIT_ID, name: "GitHub 有貢獻" }, [addDays(MONDAY, -1)]));
  assert.match(auto, /<div class="h-heat" role="img" aria-label="最近 5 週完成 1 天">/);
  assert.equal(count(heat(auto), /<button /g), 0);
  assert.doesNotMatch(auto, /<button[^>]*class="hcheck"/, "nor its check");
});
