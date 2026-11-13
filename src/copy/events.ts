import { format, onboardingLocale, type OnboardingLocale } from "./onboarding";
import strings from "./habits-events-strings.json";

export function eventServerError(message: string, locale: OnboardingLocale = onboardingLocale()): string {
  if (locale === "zh-TW") return message;
  const count = /^(\d+) 個訂閱都無法讀取，稍後會自動重試。$/.exec(message)?.[1];
  if (count) return format(Number(count) === 1 ? strings.en.eventServerErrors.allFeedsFailedOne : strings.en.eventServerErrors.allFeedsFailed, { count });
  if (message === "無法讀取這個訂閱，稍後會自動重試。") return format(strings.en.eventServerErrors.allFeedsFailedOne, { count: 1 });
  if (message === strings["zh-TW"].eventShared.offline) return strings.en.eventShared.offline;
  return message;
}

export function eventsCopy(locale: OnboardingLocale = onboardingLocale()) {
  const t = strings[locale];
  const one = (n: number) => locale === "en" && n === 1;

  return {
    eventsPageHead: t.eventsPageHead,
    events: {
      ...t.events,
      from: (origin: string) => format(t.events.from, { origin }),
      weight: (weight: number) => format(t.events.weight, { weight: Math.round(weight) }),
      starts: (time: string) => format(t.events.starts, { time }),
      lasts: (time: string, duration: string) => format(t.events.lasts, { time, duration }),
      allDays: (days: number) => format(one(days) ? t.events.allDaysOne : t.events.allDays, { days }),
      daysLeft: (days: number) => format(one(days) ? t.events.daysLeftOne : t.events.daysLeft, { days }),
      tomorrow: (time: string) => format(t.events.tomorrow, { time }),
      today: (time: string) => format(t.events.today, { time }),
      showingAt: (time: string) => format(t.events.showingAt, { time }),
      staleSource: (source: string, time: string) => format(t.events.staleSource, { source, time }),
      addedToGoogle: (title: string) => format(t.events.addedToGoogle, { title }),
      cardAria: (title: string, date: string) => format(t.events.cardAria, { title, date }),
      explain: {
        place: (place: string) => format(t.events.explain.place, { place }),
        organizer: (name: string) => format(t.events.explain.organizer, { name }),
        source: (label: string) => format(t.events.explain.source, { label }),
      },
      countLabel: (n: number) => format(one(n) ? t.events.countLabelOne : t.events.countLabel, { n }),
    },
    eventModel: {
      ...t.eventModel,
      monthDayWeek: (date: string, weekday: string) => format(t.eventModel.monthDayWeek, { date, weekday }),
      duration: (minutes: number) => {
        if (minutes < 60) return format(one(minutes) ? t.eventModel.duration.minutesOne : t.eventModel.duration.minutes, { m: minutes });
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        if (rest) return format(t.eventModel.duration.hoursMinutes, { h: hours, m: rest });
        return format(one(hours) ? t.eventModel.duration.hoursOne : t.eventModel.duration.hours, { h: hours });
      },
      syncedAt: {
        yesterdayAt: (time: string) => format(t.eventModel.syncedAt.yesterdayAt, { time }),
        dateAt: (date: string, time: string) => format(t.eventModel.syncedAt.dateAt, { date, time }),
      },
    },
    eventShared: {
      ...t.eventShared,
      actionToasts: {
        going: (title: string) => format(t.eventShared.actionToasts.going, { title }),
        calendar: (title: string) => format(t.eventShared.actionToasts.calendar, { title }),
        dismiss: (title: string) => format(t.eventShared.actionToasts.dismiss, { title }),
      },
      actionFailed: (label: string, reason: string) => format(t.eventShared.actionFailed, { label, reason }),
      undoFailed: (reason: string) => format(t.eventShared.undoFailed, { reason }),
      staleShowing: (time: string) => format(t.eventShared.staleShowing, { time }),
    },
    eventServerErrors: t.eventServerErrors,
  };
}

type EventsCopy = ReturnType<typeof eventsCopy>;

function localized<T extends object>(select: (copy: EventsCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(select(eventsCopy()), property),
  });
}

export const EVENTS_PAGE_HEAD = localized((copy) => copy.eventsPageHead);
export const EVENTS = localized((copy) => copy.events);
export const EVENT_MODEL = localized((copy) => copy.eventModel);
export const EVENT_SHARED = localized((copy) => copy.eventShared);
export const EVENT_SERVER_ERRORS = localized((copy) => copy.eventServerErrors);
