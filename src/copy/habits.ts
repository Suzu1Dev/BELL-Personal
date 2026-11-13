import { HABIT_LIMITS } from "../../shared/habits";
import { format, onboardingLocale, type OnboardingLocale } from "./onboarding";
import strings from "./habits-events-strings.json";

export function habitServerError(reason: string, locale: OnboardingLocale = onboardingLocale()): string {
  if (locale === "zh-TW") return reason;
  const zh = strings["zh-TW"].habitServerErrors;
  const en = strings.en.habitServerErrors;
  if (reason === zh.notFound) return en.notFound;
  if (reason === format(zh.maxActiveAdd, { max: HABIT_LIMITS.active })) return format(en.maxActiveAdd, { max: HABIT_LIMITS.active });
  if (reason === format(zh.maxActiveRestore, { max: HABIT_LIMITS.active })) return format(en.maxActiveRestore, { max: HABIT_LIMITS.active });
  if (reason === zh.autoEditRestricted) return en.autoEditRestricted;
  if (reason === zh.autoDeleteRestricted) return en.autoDeleteRestricted;
  if (reason === zh.autoCheckRestricted) return en.autoCheckRestricted;
  if (reason === strings["zh-TW"].eventShared.offline) return strings.en.eventShared.offline;
  return reason;
}

export function habitsCopy(locale: OnboardingLocale = onboardingLocale()) {
  const t = strings[locale];
  const one = (n: number) => locale === "en" && n === 1;

  return {
    habitsPageHead: t.habitsPageHead,
    habits: {
      ...t.habits,
      boardCountLabel: (done: number, total: number) => format(t.habits.boardCountLabel, { done, total }),
      checkLabel: (name: string, done: boolean, key?: number) => {
        const template = done
          ? key ? t.habits.checkDoneWithKey : t.habits.checkDone
          : key ? t.habits.checkTodoWithKey : t.habits.checkTodo;
        return format(template, { name, key: key ?? "" });
      },
      autoCheckLabel: (name: string, done: boolean) => format(done ? t.habits.autoCheckDone : t.habits.autoCheckPending, { name }),
      streakLabel: (streak: number, unit: string) => format(t.habits.streakLabel, { streak, unit }),
      heatLabel: (done: number) => format(one(done) ? t.habits.heatLabelOne : t.habits.heatLabel, { done }),
      heatGroupLabel: (name: string, done: number) => format(one(done) ? t.habits.heatGroupLabelOne : t.habits.heatGroupLabel, { name, done }),
      heatCellLabel: (day: string, options: { today: boolean; rest: boolean }) => {
        const template = options.today
          ? options.rest ? t.habits.heatCellTodayRestLabel : t.habits.heatCellTodayLabel
          : options.rest ? t.habits.heatCellRestLabel : t.habits.heatCellLabel;
        return format(template, { day });
      },
    },
    habitMenu: {
      ...t.habitMenu,
      open: (name: string) => format(t.habitMenu.open, { name }),
    },
    habitArchive: {
      ...t.habitArchive,
      toggle: (count: number, open: boolean) => {
        const template = open
          ? one(count) ? t.habitArchive.toggleOpenOne : t.habitArchive.toggleOpen
          : one(count) ? t.habitArchive.toggleClosedOne : t.habitArchive.toggleClosed;
        return format(template, { count });
      },
    },
    habitDialog: {
      ...t.habitDialog,
      timesOption: (n: number) => format(one(n) ? t.habitDialog.timesOptionOne : t.habitDialog.timesOption, { n }),
      shortHint: (fallback: string) => format(t.habitDialog.shortHint, { fallback }),
    },
    habitAuto: t.habitAuto,
    habitToasts: {
      ...t.habitToasts,
      created: (name: string) => format(t.habitToasts.created, { name }),
      saved: (name: string) => format(t.habitToasts.saved, { name }),
      archived: (name: string) => format(t.habitToasts.archived, { name }),
      restored: (name: string) => format(t.habitToasts.restored, { name }),
      deleted: (name: string) => format(t.habitToasts.deleted, { name }),
      backfilled: (name: string) => format(t.habitToasts.backfilled, { name }),
      unbackfilled: (name: string) => format(t.habitToasts.unbackfilled, { name }),
      dayChecked: (name: string, day: string) => format(t.habitToasts.dayChecked, { name, day }),
      dayUnchecked: (name: string, day: string) => format(t.habitToasts.dayUnchecked, { name, day }),
      todayUnchecked: (habit: string) => format(t.habitToasts.todayUnchecked, { habit }),
    },
    habitErrors: {
      ...t.habitErrors,
      save: (reason: string) => format(t.habitErrors.save, { reason: habitServerError(reason, locale) }),
      action: (reason: string) => format(t.habitErrors.action, { reason: habitServerError(reason, locale) }),
    },
    habitModel: {
      ...t.habitModel,
      cellTitle: (day: string, state: string) => format(t.habitModel.cellTitle, { day, state }),
      cadenceText: {
        ...t.habitModel.cadenceText,
        doneAt: (time: string) => format(t.habitModel.cadenceText.doneAt, { time }),
        weekly: (times: number, done: number) => format(one(times) ? t.habitModel.cadenceText.weeklyOne : t.habitModel.cadenceText.weekly, { times, done }),
        withHint: (cadence: string, hint: string) => format(t.habitModel.cadenceText.withHint, { cadence, hint }),
      },
    },
    habitServerErrors: t.habitServerErrors,
  };
}

type HabitsCopy = ReturnType<typeof habitsCopy>;

function localized<T extends object>(select: (copy: HabitsCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(select(habitsCopy()), property),
  });
}

export const HABITS_PAGE_HEAD = localized((copy) => copy.habitsPageHead);
export const HABITS = localized((copy) => copy.habits);
export const HABIT_MENU = localized((copy) => copy.habitMenu);
export const HABIT_ARCHIVE = localized((copy) => copy.habitArchive);
export const HABIT_DIALOG = localized((copy) => copy.habitDialog);
export const HABIT_AUTO = localized((copy) => copy.habitAuto);
export const HABIT_TOASTS = localized((copy) => copy.habitToasts);
export const HABIT_ERRORS = localized((copy) => copy.habitErrors);
export const HABIT_MODEL = localized((copy) => copy.habitModel);
export const HABIT_SERVER_ERRORS = localized((copy) => copy.habitServerErrors);
