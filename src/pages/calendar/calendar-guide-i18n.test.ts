import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarDay, CalendarItem, FreeSlot } from "../../../shared/calendar";
import { AppSettingsProvider } from "../../lib/app-settings";
import { inboxLegendItems } from "../../lib/shortcuts";
import { ShellContext } from "../../app/shell-context";
import { StatusProvider } from "../../lib/status";
import { TodayProvider } from "../../lib/today";
import { ToastProvider } from "../../components/toast/ToastProvider";
import GuidePage from "../guide/GuidePage";
import CalendarPage from "./CalendarPage";
import { calendarCopy, calendarServerError } from "../../copy/calendar";
import { guideCopy } from "../../copy/guide";
import { format } from "../../copy/onboarding";
import strings from "../../copy/calendar-guide-strings.json";
import { AgendaTimeline } from "./AgendaTimeline";
import { prefillText, timelineRows } from "./calendar-model";
import { WeekGrid } from "./WeekGrid";

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();

function englishWindow(): () => void {
  const before = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "?lang=en" } } });
  return () => {
    if (before === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: before });
  };
}

function leaves(value: unknown, path: string[] = [], out: Array<{ path: string[]; value: string }> = []): typeof out {
  if (typeof value === "string") out.push({ path, value });
  else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) leaves(entry, [...path, key], out);
  return out;
}

function atPath(root: unknown, path: string[]): unknown {
  let value = root;
  for (const key of path) {
    if (Array.isArray(value) && /^(step|point)\d+$/.test(key)) value = value[Number(key.slice(-1)) - 1];
    else value = (value as Record<string, unknown>)[key];
  }
  return value;
}

const samples: Record<string, string | number> = {
  date: "10/12", from: "10/12", to: "10/18", n: 2, time: "15:30", hours: "1.5", start: "15:30", end: "16:30",
  label: "Focus", habit: "Move", title: "Study", when: "10/12 15:30", meta: "Every Mon", weekday: "Mon", weekly: "Every Mon",
  m: 5, h: 2, reason: "Offline", max: 200,
};

function argumentsFor(path: string, one: boolean): Array<string | number> {
  const values: Record<string, string | number> = { ...samples, ...(one ? { n: 1, hours: "1", m: 1, h: 1, max: 1 } : {}) };
  const args: Record<string, string[]> = {
    "calendar.dayTitle": ["date"], "calendar.weekOf": ["from", "to"], "calendar.countLabel": ["n"], "calendar.nowAria": ["time"],
    "calendar.gapHours": ["hours"], "calendar.gapRange": ["start", "end"], "calendar.scheduleAria": ["label"], "calendar.addInGapAria": ["start", "end"],
    "calendar.pastFold": ["n"], "calendar.habitAfter": ["habit"], "calendar.checkIn": ["habit"], "calendar.openEvent": ["title"],
    "calendar.removeAria": ["title"], "calendar.removed": ["title"], "calendar.removeMenu": ["title"], "calendar.removedOne": ["title", "date"],
    "calendar.removedSeries": ["title"], "calendar.openDay": ["date"], "calendar.yesterdayAt": ["time"], "calendar.dateAt": ["date", "time"],
    "calendar.editAria": ["title"], "calendar.updated": ["title"], "calendarPrefill.day": ["date"], "calendarPrefill.slot": ["date", "start", "end"],
    "calendarModel.dayTitle": ["date", "weekday"], "calendarModel.weekEventTooltip.oneOff": ["time", "title"],
    "calendarModel.weekEventTooltip.weekly": ["time", "title", "weekly"], "calendarModel.relativeStart.minutes": ["m"],
    "calendarModel.relativeStart.hours": ["h"], "calendarModel.relativeStart.hoursMinutes": ["h", "m"],
    "calendarModel.relativeStart.tomorrowAt": ["time"], "calendarModel.relativeStart.dateAt": ["date", "time"], "calendarModel.dueItemTitle": ["title"],
    "calendarShared.actionToasts.schedule": ["title"], "calendarShared.actionFailed": ["label", "reason"], "calendarShared.undoFailed": ["reason"],
    "calendarShared.staleShowing": ["time"], "calendarShared.tidy.actionAria": ["title"], "calendarShared.tidy.revertAria": ["title"],
    "calendarServerErrors.titleTooLong": ["max"], "calendarServerErrors.locationTooLong": ["max"], "calendarServerErrors.notesTooLong": ["max"],
    "calendarServerErrors.createdEvent": ["title", "when"], "calendarServerErrors.createdWeekly": ["title", "when"],
  };
  if (path === "calendar.editBlockAria" || path === "calendar.editBlockAriaWithMeta") return [String(values.when), String(values.title), path.endsWith("WithMeta") ? String(values.meta) : ""];
  return (args[path] ?? []).map((key) => values[key]);
}

const placeOverrides: Record<string, string> = {
  "calendar.backToToday": "calendarBackToToday",
  "guide.daily.steps.step1.title": "guideOpenTodayTitle",
  "guideShared.help.scopes.list": "helpScopeList",
  "guideShared.help.scopes.habits": "helpScopeHabits",
  "shortcutLabels.capture.label": "shortcutCaptureLabel",
  "shortcutLabels.goToday.label": "shortcutGoTodayLabel",
  "shortcutLabels.goToday.short": "shortcutGoTodayShort",
};

for (const locale of ["zh-TW", "en"] as const) {
  test(`${locale}: all 294 spec leaves are wired byte-for-byte`, () => {
    const spec = strings[locale];
    const runtime = { ...calendarCopy(locale), ...guideCopy(locale) };
    const all = leaves(spec);
    assert.equal(all.length, 294);
    for (const { path, value: template } of all) {
      const joined = path.join(".");
      const expectedTemplate = placeOverrides[joined] ? atPath(spec.todayPlaceFixes, [placeOverrides[joined]]) as string : template;
      const one = /(?:countLabel|gapHours|pastFold|minutes|hours|titleTooLong|locationTooLong|notesTooLong)One$/.test(joined);
      const runtimePath = (one ? joined.slice(0, -3) : joined).replace("editBlockAriaWithMeta", "editBlockAria");
      const actual = atPath(runtime, runtimePath.split("."));
      if (typeof actual === "function") {
        const args = argumentsFor(one ? joined.slice(0, -3) : joined, one);
        assert.equal(actual(...args), format(expectedTemplate, { ...samples, ...(one ? { n: 1, hours: "1", m: 1, h: 1, max: 1 } : {}) }), joined);
      } else {
        assert.equal(actual, expectedTemplate, joined);
      }
      if (locale === "en") assert.doesNotMatch(String(actual), CJK, joined);
    }
  });
}

test("SSR defaults to zh-TW and English maps dynamic server messages", () => {
  assert.equal(calendarCopy().calendar.today, "今天");
  const zh = calendarCopy("zh-TW").calendarServerErrors;
  const en = calendarCopy("en").calendarServerErrors;
  assert.equal(calendarServerError(zh.titleTooLong(200), "en"), en.titleTooLong(200));
  assert.equal(calendarServerError(zh.locationTooLong(200), "en"), en.locationTooLong(200));
  assert.equal(calendarServerError(zh.notesTooLong(4000), "en"), en.notesTooLong(4000));
  assert.equal(calendarServerError("已加入行程「Study」· 明天 14:00", "en"), "Added to Calendar “Study” · Tomorrow 14:00");
  assert.equal(calendarServerError("已加入每週行程「Study」· 每週一 10:10", "en"), "Added weekly event “Study” · Every Mon 10:10");
  assert.equal(calendarServerError(zh.notFound, "en"), en.notFound);
});

const localEvent: CalendarItem = {
  id: "manual:os:2026-10-12", kind: "event", origin: "manual", title: "Operating systems", start: at("2026-10-12T10:10"), end: at("2026-10-12T12:00"),
  allDay: false, meta: "EC115 · 每週一", sourceLabel: "本機行程", manualId: "os", inGoogle: false, typed: true,
  repeat: { freq: "weekly", day: "2026-10-12", first: "2026-09-07" },
};

test("English Calendar renders no CJK in the week grid or agenda states", () => {
  const restore = englishWindow();
  try {
    const days: CalendarDay[] = [{ day: "2026-10-12", items: [localEvent], free: [] }];
    const week = renderToStaticMarkup(createElement(WeekGrid, { days, today: "2026-10-12", timeZone: TZ, now: Date.parse(at("2026-10-12T09:00")), onOpenDay: () => {}, onEdit: () => {} }));
    assert.match(week, /Every Mon/);
    assert.doesNotMatch(week, CJK);

    const past = (id: string, hour: number): CalendarItem => ({ ...localEvent, id, title: id, start: at(`2026-10-12T0${hour}:00`), end: at(`2026-10-12T0${hour + 1}:00`), repeat: undefined });
    const future = { ...localEvent, start: at("2026-10-12T19:30"), end: at("2026-10-12T20:30"), habitLink: "Move", habitId: "move" };
    const free: FreeSlot = { start: at("2026-10-12T15:30"), end: at("2026-10-12T19:30"), minutes: 240 };
    const gap = { start: free.start, end: free.end, hours: 4, forItemId: "task:1", label: "Focus" };
    const rows = timelineRows({ day: "2026-10-12", today: "2026-10-12", items: [past("One", 5), past("Two", 6), past("Three", 7), future], free: [free], now: Date.parse(at("2026-10-12T08:42")), timeZone: TZ, gap });
    const agenda = renderToStaticMarkup(createElement(AgendaTimeline, { rows, timeZone: TZ, onSchedule: () => {}, onRemove: () => {}, onEdit: () => {}, onTidy: () => {}, tidying: () => false, onShowPast: () => {} }));
    assert.match(agenda, /3 ended · Show|3 ended/);
    assert.match(agenda, /4 hours free/);
    assert.match(agenda, /Every Mon|Local event/);
    assert.doesNotMatch(agenda, CJK);
    assert.equal(prefillText("2026-10-12", "2026-10-12", TZ, free), "+today 15:30-16:30 ");
  } finally {
    restore();
  }
});

test("English Guide renders all sections and shortcut labels without CJK", () => {
  const restore = englishWindow();
  try {
    const html = renderToStaticMarkup(createElement(ToastProvider, null,
      createElement(AppSettingsProvider, null, createElement(GuidePage, { route: { name: "guide" } })),
    ));
    assert.match(html, /Get into an easy rhythm\./);
    assert.match(html, /Keyboard shortcuts/);
    assert.match(html, /Quick summary/);
    assert.match(html, /Go to Today/);
    assert.doesNotMatch(html, CJK);
    assert.ok(inboxLegendItems().every((item) => !CJK.test(item.label)));
  } finally {
    restore();
  }
});

test("English Calendar page renders its loading state without CJK", () => {
  const restore = englishWindow();
  try {
    const shell = { openPalette: () => {}, closePalette: () => {}, openHelp: () => {} };
    const html = renderToStaticMarkup(createElement(ToastProvider, null,
      createElement(StatusProvider, null,
        createElement(TodayProvider, null,
          createElement(ShellContext.Provider, { value: shell }, createElement(CalendarPage, { route: { name: "calendar", view: "day" } })),
        ),
      ),
    ));
    assert.match(html, /Plan today just right\./);
    assert.match(html, /Add event/);
    assert.match(html, /Today&#x27;s schedule|Today's schedule/);
    assert.doesNotMatch(html, CJK);
  } finally {
    restore();
  }
});
