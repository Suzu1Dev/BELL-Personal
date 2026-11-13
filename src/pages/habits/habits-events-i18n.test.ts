import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cadenceText, habitSummary, streakUnit, type Habit, type HabitSummary } from "../../../shared/habits";
import { dayLabel, durationText, monthDayWeek } from "../../../shared/today-format";
import type { EventListItem } from "../../../shared/events";
import { syncedLabel } from "../calendar/calendar-model";
import { EventCard } from "../events/EventsPage";
import { dateBlock, explainEventText, metaLine, timeText, untilText } from "../events/events-model";
import { EVENT_SHARED, EVENTS, eventServerError, eventsCopy } from "../../copy/events";
import { HABIT_DIALOG, HABIT_ERRORS, HABITS, HABIT_TOASTS, habitServerError, habitsCopy } from "../../copy/habits";
import { format } from "../../copy/onboarding";
import strings from "../../copy/habits-events-strings.json";
import { HabitRow, type HabitRowActions } from "./HabitRow";
import { formFromSummary, weekdayHeads } from "./model";

const CJK = /[㐀-鿿豈-﫿]/u;
const TZ = "Asia/Taipei";
const DAY = "2026-10-12";
const NOW = Date.parse("2026-10-12T08:42:00+08:00");
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();

type Locale = "zh-TW" | "en";
type Leaf = [path: string, value: string];

function leaves(value: unknown, path = ""): Leaf[] {
  if (typeof value === "string") return [[path, value]];
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.entries(value).flatMap(([key, entry]) => leaves(entry, path ? `${path}.${key}` : key));
}

function get(value: unknown, path: string): unknown {
  return path.split(".").reduce((current, key) => {
    assert.ok(current && typeof current === "object", path);
    return (current as Record<string, unknown>)[key];
  }, value);
}

function call(copy: unknown, path: string, args: unknown[]): string {
  const fn = get(copy, path);
  assert.equal(typeof fn, "function", path);
  return (fn as (...values: unknown[]) => string)(...args);
}

function samples(path: string, locale: Locale): Record<string, string | number> {
  const one = path.endsWith("One");
  return {
    done: one ? 1 : 2,
    total: 3,
    name: "Read",
    key: 1,
    streak: one ? 1 : 2,
    unit: locale === "en" ? (one ? "day" : "days") : "天",
    day: "11/3",
    state: locale === "en" ? "Done" : "完成",
    count: one ? 1 : 2,
    n: one ? 1 : 2,
    fallback: "Read",
    habit: "Read",
    reason: "Network error",
    time: "08:00",
    times: one ? 1 : 3,
    cadence: "Daily",
    hint: "Before bed",
    max: 30,
    origin: "Receipt mail",
    weight: 55,
    duration: locale === "en" ? "2 hr" : "2 小時",
    days: one ? 1 : 2,
    source: locale === "en" ? "Event feeds" : "活動訂閱",
    title: "Hack.lu",
    date: "11/3",
    place: "Online",
    label: "Going",
    weekday: "Sat",
    m: one ? 1 : 30,
    h: one ? 1 : 2,
  };
}

const expected = (template: string, path: string, locale: Locale) => format(template, samples(path, locale));

function wiredValue(copy: unknown, path: string, locale: Locale): string {
  const one = path.endsWith("One");
  const count = one ? 1 : 2;
  switch (path) {
    case "habits.boardCountLabel": return call(copy, "habits.boardCountLabel", [2, 3]);
    case "habits.checkDoneWithKey": return call(copy, "habits.checkLabel", ["Read", true, 1]);
    case "habits.checkDone": return call(copy, "habits.checkLabel", ["Read", true]);
    case "habits.checkTodoWithKey": return call(copy, "habits.checkLabel", ["Read", false, 1]);
    case "habits.checkTodo": return call(copy, "habits.checkLabel", ["Read", false]);
    case "habits.autoCheckDone": return call(copy, "habits.autoCheckLabel", ["Read", true]);
    case "habits.autoCheckPending": return call(copy, "habits.autoCheckLabel", ["Read", false]);
    case "habits.streakLabel": return call(copy, "habits.streakLabel", [count, samples(path, locale).unit]);
    case "habits.heatLabelOne":
    case "habits.heatLabel": return call(copy, "habits.heatLabel", [count]);
    case "habits.heatGroupLabelOne":
    case "habits.heatGroupLabel": return call(copy, "habits.heatGroupLabel", ["Read", count]);
    case "habits.heatCellLabel": return call(copy, "habits.heatCellLabel", ["11/3", { today: false, rest: false }]);
    case "habits.heatCellTodayLabel": return call(copy, "habits.heatCellLabel", ["11/3", { today: true, rest: false }]);
    case "habits.heatCellRestLabel": return call(copy, "habits.heatCellLabel", ["11/3", { today: false, rest: true }]);
    case "habits.heatCellTodayRestLabel": return call(copy, "habits.heatCellLabel", ["11/3", { today: true, rest: true }]);
    case "habitMenu.open": return call(copy, "habitMenu.open", ["Read"]);
    case "habitArchive.toggleOpenOne":
    case "habitArchive.toggleOpen": return call(copy, "habitArchive.toggle", [count, true]);
    case "habitArchive.toggleClosedOne":
    case "habitArchive.toggleClosed": return call(copy, "habitArchive.toggle", [count, false]);
    case "habitDialog.timesOptionOne":
    case "habitDialog.timesOption": return call(copy, "habitDialog.timesOption", [count]);
    case "habitDialog.shortHint": return call(copy, "habitDialog.shortHint", ["Read"]);
    case "habitToasts.created":
    case "habitToasts.saved":
    case "habitToasts.archived":
    case "habitToasts.restored":
    case "habitToasts.deleted":
    case "habitToasts.backfilled":
    case "habitToasts.unbackfilled": return call(copy, path, ["Read"]);
    case "habitToasts.dayChecked":
    case "habitToasts.dayUnchecked": return call(copy, path, ["Read", "11/3"]);
    case "habitToasts.todayUnchecked": return call(copy, path, ["Read"]);
    case "habitErrors.save":
    case "habitErrors.action": return call(copy, path, ["Network error"]);
    case "habitModel.cellTitle": return call(copy, path, ["11/3", samples(path, locale).state]);
    case "habitModel.cadenceText.doneAt": return call(copy, path, ["08:00"]);
    case "habitModel.cadenceText.weeklyOne":
    case "habitModel.cadenceText.weekly": return call(copy, "habitModel.cadenceText.weekly", [one ? 1 : 3, samples(path, locale).done]);
    case "habitModel.cadenceText.withHint": return call(copy, path, ["Daily", "Before bed"]);
    case "events.from": return call(copy, path, ["Receipt mail"]);
    case "events.weight": return call(copy, path, [55.3]);
    case "events.starts": return call(copy, path, ["08:00"]);
    case "events.lasts": return call(copy, path, ["08:00", samples(path, locale).duration]);
    case "events.allDaysOne":
    case "events.allDays": return call(copy, "events.allDays", [count]);
    case "events.daysLeftOne":
    case "events.daysLeft": return call(copy, "events.daysLeft", [count]);
    case "events.tomorrow":
    case "events.today":
    case "events.showingAt": return call(copy, path, ["08:00"]);
    case "events.staleSource": return call(copy, path, [samples(path, locale).source, "08:00"]);
    case "events.addedToGoogle": return call(copy, path, ["Hack.lu"]);
    case "events.cardAria": return call(copy, path, ["Hack.lu", "11/3"]);
    case "events.explain.place": return call(copy, path, ["Online"]);
    case "events.explain.organizer": return call(copy, path, ["Read"]);
    case "events.explain.source": return call(copy, path, ["Going"]);
    case "events.countLabelOne":
    case "events.countLabel": return call(copy, "events.countLabel", [count]);
    case "eventModel.monthDayWeek": return call(copy, path, ["11/3", "Sat"]);
    case "eventModel.duration.minutesOne": return call(copy, "eventModel.duration", [1]);
    case "eventModel.duration.minutes": return call(copy, "eventModel.duration", [30]);
    case "eventModel.duration.hoursOne": return call(copy, "eventModel.duration", [60]);
    case "eventModel.duration.hours": return call(copy, "eventModel.duration", [120]);
    case "eventModel.duration.hoursMinutes": return call(copy, "eventModel.duration", [150]);
    case "eventModel.syncedAt.yesterdayAt": return call(copy, path, ["08:00"]);
    case "eventModel.syncedAt.dateAt": return call(copy, path, ["11/3", "08:00"]);
    case "eventShared.actionToasts.going":
    case "eventShared.actionToasts.calendar":
    case "eventShared.actionToasts.dismiss": return call(copy, path, ["Hack.lu"]);
    case "eventShared.actionFailed": return call(copy, path, ["Going", "Network error"]);
    case "eventShared.undoFailed": return call(copy, path, ["Network error"]);
    case "eventShared.staleShowing": return call(copy, path, ["08:00"]);
    default: {
      const value = get(copy, path);
      assert.equal(typeof value, "string", path);
      return expected(value as string, path, locale);
    }
  }
}

test("224/224 signed-off keys have locale and placeholder parity, with no CJK in English", () => {
  const zh = leaves(strings["zh-TW"]);
  const en = leaves(strings.en);
  assert.equal(zh.length, 224);
  assert.equal(en.length, 224);
  assert.deepEqual(en.map(([path]) => path), zh.map(([path]) => path));
  en.forEach(([path, value], index) => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    assert.deepEqual(placeholders(value), placeholders(zh[index][1]), path);
    assert.doesNotMatch(value, CJK, path);
  });
});

test("all 224 keys are wired through the runtime copy helpers with byte-for-byte zh-TW parity", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const copy = { ...habitsCopy(locale), ...eventsCopy(locale) };
    for (const [path, template] of leaves(strings[locale])) {
      const actual = wiredValue(copy, path, locale);
      assert.equal(actual, expected(template, path, locale), `${locale}:${path}`);
      if (locale === "en") assert.doesNotMatch(actual, CJK, path);
    }
  }
  assert.equal(strings["zh-TW"].habitDialog.shortHint, "2–4 個字，顯示在今天頁的打卡按鈕；留空會用「{fallback}」。");
  assert.equal(strings["zh-TW"].habitDialog.shortHintTodayPlace, "2–4 個字，顯示在今日頁的打卡按鈕；留空會用「{fallback}」。");
});

test("reactive exports follow onboardingLocale, including singulars and client server-error mapping", (t) => {
  const scope = globalThis as { window?: { location: { search: string } } };
  const previous = scope.window;
  scope.window = { location: { search: "?lang=en" } };
  t.after(() => {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  });

  assert.equal(HABITS.boardTitle, "Habit check-ins");
  assert.equal(HABITS.heatLabel(1), "Completed 1 day in the last 5 weeks");
  assert.equal(HABIT_DIALOG.timesOption(1), "1 time a week");
  assert.equal(HABIT_TOASTS.todayUnchecked("Read"), "Undid check-in for “Read”");
  assert.equal(HABIT_ERRORS.save(strings["zh-TW"].habitServerErrors.notFound), `Couldn't save: ${strings.en.habitServerErrors.notFound}`);
  assert.equal(habitServerError(format(strings["zh-TW"].habitServerErrors.maxActiveAdd, { max: 30 })), format(strings.en.habitServerErrors.maxActiveAdd, { max: 30 }));
  assert.equal(habitServerError(strings["zh-TW"].eventShared.offline), strings.en.eventShared.offline);
  assert.equal(eventServerError(strings["zh-TW"].eventShared.offline), strings.en.eventShared.offline);
  assert.equal(EVENTS.countLabel(1), "1 event");
  assert.equal(EVENT_SHARED.actionFailed("Going", "Network error"), "Going failed: Network error");
  assert.equal(eventServerError("無法讀取這個訂閱，稍後會自動重試。"), strings.en.eventServerErrors.allFeedsFailedOne.replace("{count}", "1"));
  assert.equal(eventServerError("3 個訂閱都無法讀取，稍後會自動重試。"), strings.en.eventServerErrors.allFeedsFailed.replace("{count}", "3"));

  scope.window.location.search = "?lang=zh-TW";
  assert.equal(HABITS.boardTitle, "習慣打卡");
  assert.equal(HABIT_DIALOG.timesOption(1), "每週 1 次");
  assert.equal(EVENTS.countLabel(1), "1 個活動");
  assert.equal(eventServerError("3 個訂閱都無法讀取，稍後會自動重試。"), "3 個訂閱都無法讀取，稍後會自動重試。");
});

test("shared and model formatters support English without changing zh-TW defaults", () => {
  assert.equal(dayLabel(TZ, at("2026-10-13T08:00"), new Date(NOW), "en"), "Tmrw");
  assert.equal(dayLabel(TZ, at("2026-10-13T08:00"), new Date(NOW)), "明天");
  assert.equal(monthDayWeek(TZ, at("2026-10-17T08:00"), "en"), "10/17 (Sat)");
  assert.equal(monthDayWeek(TZ, at("2026-10-17T08:00")), "10/17（六）");
  assert.equal(durationText(1, "en"), "1 min");
  assert.equal(durationText(60, "en"), "1 hr");
  assert.equal(durationText(150, "en"), "2 hr 30 min");
  assert.equal(durationText(150), "2 小時 30 分鐘");
  assert.equal(syncedLabel(at("2026-10-11T22:10"), DAY, TZ, "en"), "yesterday at 22:10");
  assert.equal(syncedLabel(at("2026-10-11T22:10"), DAY, TZ), "昨天 22:10");
  assert.deepEqual(weekdayHeads(true, "en"), ["M", "T", "W", "T", "F", "S", "S"]);
  assert.deepEqual(weekdayHeads(true), ["一", "二", "三", "四", "五", "六", "日"]);

  const weekly = { id: "read", cadence: "weekly" as const, timesPerWeek: 1 };
  assert.equal(cadenceText(weekly, { doneToday: false, weekDone: 0, timeZone: TZ }, "en"), "1 time a week · 0/1");
  assert.equal(cadenceText(weekly, { doneToday: false, weekDone: 0, timeZone: TZ }), "每週 1 次 · 0/1");
  assert.equal(streakUnit("daily", 1, "en"), "day");
  assert.equal(streakUnit("weekly", 2, "en"), "weeks");
  assert.equal(streakUnit("daily", 1), "天");

  assert.deepEqual(dateBlock(at("2026-10-13T08:00"), NOW, TZ, "en"), { date: "10/13", label: "Tmrw" });
  assert.deepEqual(untilText({ start: at("2026-10-13T08:00") }, NOW, TZ, "en"), { label: "Tomorrow 08:00", muted: false });
  assert.equal(timeText({ start: at("2026-10-13T08:00"), end: at("2026-10-13T10:00"), allDay: false }, TZ, "en"), "08:00 for 2 hr");
});

const baseHabit = (extra: Partial<Habit> = {}): Habit => ({
  id: "read",
  name: "Read",
  cadence: "daily",
  targetPerDay: 1,
  archived: false,
  order: 0,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...extra,
});

const summary = (extra: Partial<Habit> = {}, days: string[] = []): HabitSummary => habitSummary(
  baseHabit(extra),
  days.map((day) => ({ day, count: 1 })),
  { today: DAY, timeZone: TZ, weekStartsMonday: true, createdDay: "2026-07-01" },
);

const event: EventListItem = {
  id: "ctftime:hacklu",
  category: "ctf",
  origin: "ctftime",
  title: "Hack.lu CTF",
  start: at("2026-10-13T08:00"),
  end: at("2026-10-13T10:00"),
  allDay: false,
  online: true,
  url: "https://ctftime.org/event/1/",
  sourceLabel: "CTFtime",
  format: "Jeopardy",
  weight: 55.3,
  going: false,
  inGoogle: false,
};

test("English event metadata, source labels, and Explain text match the signed-off copy", () => {
  const entry = { type: "event" as const, id: event.id, start: event.start, end: event.end, item: event };
  assert.equal(metaLine(entry, TZ, "en"), "08:00 for 2 hr · Online · Jeopardy · Weight 55 · CTFtime");
  assert.equal(explainEventText(entry, TZ, "en"), "Hack.lu CTF\n\n10/13 (Tue) 08:00 for 2 hr\nLocation: Online\nJeopardy\nSource: CTFtime");
  assert.equal(eventsCopy("en").eventModel.sourceLabels.feeds, "Event feeds");
  assert.equal(eventsCopy().eventModel.sourceLabels.feeds, "活動訂閱");
  assert.equal(formFromSummary(summary({ keywords: ["Gym", "Run"] }), "en").keywords, "Gym, Run");
  assert.equal(formFromSummary(summary({ keywords: ["健身", "跑步"] })).keywords, "健身、跑步");
});

test("rendered Habit and Event components contain no CJK under ?lang=en", (t) => {
  const scope = globalThis as { window?: { location: { search: string } } };
  const previous = scope.window;
  scope.window = { location: { search: "?lang=en" } };
  t.after(() => {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  });
  const noop = () => {};
  const actions: HabitRowActions = { toggle: noop, edit: noop, move: noop, backfill: noop, setDay: noop, archive: noop, remove: noop, autoOff: noop };

  const habitHtml = renderToStaticMarkup(createElement(HabitRow, {
    habit: summary({}, [DAY]),
    index: 0,
    count: 1,
    today: DAY,
    actions,
  }));
  assert.match(habitHtml, /Done today/);
  assert.match(habitHtml, /aria-label="1 day in a row"/);
  assert.match(habitHtml, /Check in for 10\/12 \(today\)/);
  assert.match(habitHtml, /More actions for “Read”/);
  assert.doesNotMatch(habitHtml, CJK, habitHtml);

  const eventHtml = renderToStaticMarkup(createElement(EventCard, {
    entry: { type: "event", id: event.id, start: event.start, end: event.end, item: event },
    now: NOW,
    timeZone: TZ,
    canWrite: false,
    onDecide: noop,
    onAddToGoogle: noop,
  }));
  assert.match(eventHtml, /<span class="dblock" aria-hidden="true"><b>10\/13<\/b><span>Tmrw<\/span><\/span>/);
  assert.match(eventHtml, /Tomorrow 08:00/);
  assert.match(eventHtml, /08:00 for 2 hr/);
  assert.match(eventHtml, />Going</);
  assert.doesNotMatch(eventHtml, CJK, eventHtml);
});
