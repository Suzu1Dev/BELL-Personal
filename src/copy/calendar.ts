import { weekdayOf } from "../../shared/time";
import { format, type OnboardingLocale } from "./onboarding";
import strings from "./calendar-guide-strings.json";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function resolveOnboardingLocale(search: string): OnboardingLocale {
  return new URLSearchParams(search).get("lang") === "en" ? "en" : "zh-TW";
}

function createdWhen(when: string, locale: OnboardingLocale): string {
  if (locale === "zh-TW") return when;
  const t = strings.en;
  const weekly = /^每週([日一二三四五六])(?: (.*))?$/.exec(when);
  if (weekly) {
    const index = "日一二三四五六".indexOf(weekly[1]);
    return `${t.calendarModel.weeklyLabels[WEEKDAYS[index]]}${weekly[2] ? ` ${weekly[2]}` : ""}`;
  }
  const today = /^今天(?: (.*))?$/.exec(when);
  if (today) return `${t.calendar.today}${today[1] ? ` ${today[1]}` : ""}`;
  const tomorrow = /^明天(?: (.*))?$/.exec(when);
  if (tomorrow) return tomorrow[1] ? format(t.calendarModel.relativeStart.tomorrowAt, { time: tomorrow[1] }) : "Tomorrow";
  const dated = /^(\d+\/\d+)（([日一二三四五六])）(?: (.*))?$/.exec(when);
  if (dated) {
    const index = "日一二三四五六".indexOf(dated[2]);
    const day = format(t.calendarModel.dayTitle, { date: dated[1], weekday: t.calendarModel.weekdaysShort[WEEKDAYS[index]] });
    return `${day}${dated[3] ? ` ${dated[3]}` : ""}`;
  }
  return when;
}

export function calendarServerError(reason: string, locale: OnboardingLocale = resolveOnboardingLocale(typeof window === "undefined" ? "" : window.location.search)): string {
  if (locale === "zh-TW") return reason;
  const zh = strings["zh-TW"];
  const en = strings.en;
  if (reason === zh.calendarShared.offline) return en.calendarShared.offline;

  const weekly = /^已加入每週行程「(.*)」· (.*)$/.exec(reason);
  if (weekly) return format(en.calendarServerErrors.createdWeekly, { title: weekly[1], when: createdWhen(weekly[2], locale) });
  const created = /^已加入行程「(.*)」· (.*)$/.exec(reason);
  if (created) return format(en.calendarServerErrors.createdEvent, { title: created[1], when: createdWhen(created[2], locale) });

  for (const [prefix, max] of [["title", 200], ["location", 200], ["notes", 4000]] as const) {
    const many = `${prefix}TooLong` as const;
    if (reason === format(zh.calendarServerErrors[many], { max })) return format(en.calendarServerErrors[many], { max });
  }
  for (const key of Object.keys(zh.calendarServerErrors) as Array<keyof typeof zh.calendarServerErrors>) {
    if (key.endsWith("One") || key === "createdEvent" || key === "createdWeekly") continue;
    if (reason === zh.calendarServerErrors[key]) return en.calendarServerErrors[key];
  }
  return reason;
}

export function calendarCopy(locale: OnboardingLocale = resolveOnboardingLocale(typeof window === "undefined" ? "" : window.location.search)) {
  const t = strings[locale];
  const fixes = t.todayPlaceFixes;
  const one = (n: number) => locale === "en" && n === 1;
  const calendar = { ...t.calendar, backToToday: fixes.calendarBackToToday };

  const en = locale === "en";
  const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

  return {
    calendarPageHead: { eyebrow: "", title: t.calendarPageHead.title, sub: "" },
    calendar: {
      ...calendar,
      views: {
        ...calendar.views,
        month: en ? "Month" : "月",
      },
      prev: {
        ...calendar.prev,
        month: en ? "Previous month" : "上個月",
      },
      next: {
        ...calendar.next,
        month: en ? "Next month" : "下個月",
      },
      monthTitle: en ? "This month" : "本月行程",
      monthGridLabel: en ? "Monthly calendar" : "整月行事曆",
      monthHeading: (year: number, month: number) => (en ? `${EN_MONTHS[month - 1] ?? month} ${year}` : `${year} 年 ${month} 月`),
      moreCount: (n: number) => (en ? `+${n} more` : `+${n} 筆`),
      selectDayAria: (date: string, count: number) => (en ? `${date}, ${count} ${count === 1 ? "event" : "events"}` : `${date}，共 ${count} 個行程`),
      addOnDayAria: (date: string) => (en ? `Add event on ${date}` : `在 ${date} 新增行程`),
      openDayTimeline: en ? "Day timeline" : "單日檢視",
      sync: {
        twoWay: en ? "Google 2-way sync" : "Google 雙向同步",
        readOnly: en ? "Google read-only" : "Google 唯讀同步",
        localOnly: en ? "Connect Google sync" : "連接 Google 雙向同步",
        syncNow: en ? "Sync now" : "立即同步",
        syncing: en ? "Syncing…" : "同步中…",
        syncedToast: en ? "Synced with Google Calendar" : "已與 Google 行事曆完成同步",
        pushedToGoogle: (title: string) => (en ? `Added "${title}" to Google Calendar` : `已將「${title}」排入 Google 行事曆同步`),
        pushAction: en ? "Sync to Google" : "同步至 Google",
      },
      editor: {
        ...calendar.editor,
        createHeading: en ? "New event" : "新增行程",
        createSave: en ? "Create" : "建立行程",
        titlePlaceholder: en ? "e.g. Lab meeting, Dentist, Workout" : "例如：教授 meeting、牙醫、健身",
        notes: en ? "Notes" : "備註",
        notesPlaceholder: en ? "Meeting link, agenda, or details" : "會議連結、準備事項或說明（選填）",
        syncToGoogle: en ? "Sync to Google Calendar" : "同步至 Google 行事曆",
        syncedTwoWayNote: en ? "2-way synced with Google Calendar. Saving updates Google directly." : "已與 Google 行事曆雙向連結，儲存後會直接同步更新。",
        nativeGoogleNote: en ? "Google Calendar event. Edits sync straight back to Google." : "Google 行事曆行程，修改或刪除會直接雙向同步回 Google。",
        pushToGoogle: en ? "Send to Google" : "同步至 Google",
        quickCapture: en ? "Quick syntax (N)" : "自然語意快記 (N)",
      },
      dayTitle: (date: string) => format(calendar.dayTitle, { date }),
      weekOf: (from: string, to: string) => format(calendar.weekOf, { from, to }),
      countLabel: (n: number) => format(one(n) ? calendar.countLabelOne : calendar.countLabel, { n }),
      nowAria: (time: string) => format(calendar.nowAria, { time }),
      gapHours: (hours: string) => format(one(Number(hours)) ? calendar.gapHoursOne : calendar.gapHours, { hours }),
      gapRange: (start: string, end: string) => format(calendar.gapRange, { start, end }),
      scheduleAria: (label: string) => format(calendar.scheduleAria, { label }),
      addInGapAria: (start: string, end: string) => format(calendar.addInGapAria, { start, end }),
      pastFold: (n: number) => format(one(n) ? calendar.pastFoldOne : calendar.pastFold, { n }),
      habitAfter: (habit: string) => format(calendar.habitAfter, { habit }),
      checkIn: (habit: string) => format(calendar.checkIn, { habit }),
      openEvent: (title: string) => format(calendar.openEvent, { title }),
      removeAria: (title: string) => format(calendar.removeAria, { title }),
      removed: (title: string) => format(calendar.removed, { title }),
      removeMenu: (title: string) => format(calendar.removeMenu, { title }),
      removedOne: (title: string, date: string) => format(calendar.removedOne, { title, date }),
      removedSeries: (title: string) => format(calendar.removedSeries, { title }),
      openDay: (date: string) => format(calendar.openDay, { date }),
      yesterdayAt: (time: string) => format(calendar.yesterdayAt, { time }),
      dateAt: (date: string, time: string) => format(calendar.dateAt, { date, time }),
      editAria: (title: string) => format(calendar.editAria, { title }),
      editBlockAria: (when: string, title: string, meta: string) => format(meta ? calendar.editBlockAriaWithMeta : calendar.editBlockAria, { when, title, meta }),
      updated: (title: string) => format(calendar.updated, { title }),
    },
    calendarPrefill: {
      ...t.calendarPrefill,
      day: (date: string) => format(t.calendarPrefill.day, { date }),
      slot: (date: string, start: string, end: string) => format(t.calendarPrefill.slot, { date, start, end }),
    },
    calendarModel: {
      ...t.calendarModel,
      dayTitle: (date: string, weekday: string) => format(t.calendarModel.dayTitle, { date, weekday }),
      weekday: (day: string) => t.calendarModel.weekdaysShort[WEEKDAYS[weekdayOf(day)]],
      weeklyLabel: (day: string) => t.calendarModel.weeklyLabels[WEEKDAYS[weekdayOf(day)]],
      weekEventTooltip: {
        oneOff: (time: string, title: string) => format(t.calendarModel.weekEventTooltip.oneOff, { time, title }),
        weekly: (time: string, title: string, weekly: string) => format(t.calendarModel.weekEventTooltip.weekly, { time, title, weekly }),
      },
      relativeStart: {
        minutes: (m: number) => format(one(m) ? t.calendarModel.relativeStart.minutesOne : t.calendarModel.relativeStart.minutes, { m }),
        hours: (h: number) => format(one(h) ? t.calendarModel.relativeStart.hoursOne : t.calendarModel.relativeStart.hours, { h }),
        hoursMinutes: (h: number, m: number) => format(t.calendarModel.relativeStart.hoursMinutes, { h, m }),
        tomorrowAt: (time: string) => format(t.calendarModel.relativeStart.tomorrowAt, { time }),
        dateAt: (date: string, time: string) => format(t.calendarModel.relativeStart.dateAt, { date, time }),
      },
      dueItemTitle: (title: string) => format(t.calendarModel.dueItemTitle, { title }),
    },
    calendarShared: {
      ...t.calendarShared,
      actionToasts: { schedule: (title: string) => format(t.calendarShared.actionToasts.schedule, { title }) },
      actionFailed: (label: string, reason: string) => format(t.calendarShared.actionFailed, { label, reason: calendarServerError(reason, locale) }),
      undoFailed: (reason: string) => format(t.calendarShared.undoFailed, { reason: calendarServerError(reason, locale) }),
      staleShowing: (time: string) => format(t.calendarShared.staleShowing, { time }),
      tidy: {
        ...t.calendarShared.tidy,
        actionAria: (title: string) => format(t.calendarShared.tidy.actionAria, { title }),
        revertAria: (title: string) => format(t.calendarShared.tidy.revertAria, { title }),
      },
    },
    calendarServerErrors: {
      ...t.calendarServerErrors,
      titleTooLong: (max: number) => format(one(max) ? t.calendarServerErrors.titleTooLongOne : t.calendarServerErrors.titleTooLong, { max }),
      locationTooLong: (max: number) => format(one(max) ? t.calendarServerErrors.locationTooLongOne : t.calendarServerErrors.locationTooLong, { max }),
      notesTooLong: (max: number) => format(one(max) ? t.calendarServerErrors.notesTooLongOne : t.calendarServerErrors.notesTooLong, { max }),
      createdEvent: (title: string, when: string) => format(t.calendarServerErrors.createdEvent, { title, when }),
      createdWeekly: (title: string, when: string) => format(t.calendarServerErrors.createdWeekly, { title, when }),
    },
  };
}

type CalendarCopy = ReturnType<typeof calendarCopy>;

function localized<T extends object>(select: (copy: CalendarCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(select(calendarCopy()), property),
  });
}

export const CALENDAR_PAGE_HEAD = localized((copy) => copy.calendarPageHead);
export const CALENDAR = localized((copy) => copy.calendar);
export const CALENDAR_PREFILL = localized((copy) => copy.calendarPrefill);
export const CALENDAR_MODEL = localized((copy) => copy.calendarModel);
export const CALENDAR_SHARED = localized((copy) => copy.calendarShared);
export const CALENDAR_SERVER_ERRORS = localized((copy) => copy.calendarServerErrors);
