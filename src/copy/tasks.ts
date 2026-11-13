import type { TodoOrigin } from "../../shared/todos";
import type { TaskGroupKey } from "../pages/tasks/model";
import { format, onboardingLocale, type OnboardingLocale } from "./onboarding";
import strings from "./tasks-strings.json";

export function tasksCopy(locale: OnboardingLocale = onboardingLocale()) {
  const t = strings[locale].tasks;
  const one = (n: number) => locale === "en" && n === 1;

  return {
    PAGE_HEAD_TITLE: t.pageHead.title,
    TASKS: {
      addLabel: t.addLabel,
      addPlaceholder: t.addPlaceholder,
      addHint: t.addHint,
      groupsLabel: t.groupsLabel,
      groups: t.groups satisfies Record<TaskGroupKey, string>,
      doneToday: (n: number) => format(t.doneToday, { n }),
      show: t.show,
      hide: t.hide,
      emptyTitle: t.emptyTitle,
      emptyHint: t.emptyHint,
      loadErrorTitle: t.loadErrorTitle,
      checkLabel: (title: string, done: boolean) => format(done ? t.checkDone : t.checkTodo, { title }),
      countLabel: (n: number) => format(one(n) ? t.countLabelOne : t.countLabel, { n }),
      overdueDays: (n: number) => format(one(n) ? t.overdueDaysOne : t.overdueDays, { n }),
      overdueHours: (n: number) => format(one(n) ? t.overdueHoursOne : t.overdueHours, { n }),
      dueSuffix: t.dueSuffix,
      estimate: (text: string) => format(t.estimate, { text }),
      important: t.important,
      edit: t.edit,
      schedule: {
        button: t.schedule.button,
        buttonLabel: (title: string) => format(t.schedule.buttonLabel, { title }),
        title: t.schedule.title,
        today: t.schedule.today,
        todayInSentence: t.schedule.todayInSentence,
        tomorrow: t.schedule.tomorrow,
        tomorrowInSentence: t.schedule.tomorrowInSentence,
        weekend: t.schedule.weekend,
        nextWeekend: t.schedule.nextWeekend,
        nextMonday: t.schedule.nextMonday,
        pick: t.schedule.pick,
        pickLabel: t.schedule.pickLabel,
        pickSubmit: t.schedule.pickSubmit,
        pickInvalid: t.schedule.pickInvalid,
      },
      toasts: {
        deleted: (title: string) => format(t.toasts.deleted, { title }),
        reopened: (title: string) => format(t.toasts.reopened, { title }),
        scheduled: (title: string, when: string) => format(t.toasts.scheduled, { title, when }),
        saveFailed: t.toasts.saveFailed,
        deleteFailed: t.toasts.deleteFailed,
        completeFailed: t.toasts.completeFailed,
        reopenFailed: t.toasts.reopenFailed,
        scheduleFailed: t.toasts.scheduleFailed,
      },
      linked: {
        missingTitle: t.linked.missingTitle,
        missingHint: t.linked.missingHint,
        back: t.linked.back,
        loadErrorTitle: t.linked.loadErrorTitle,
        label: t.linked.label,
        done: t.linked.done,
        doneAt: (time: string) => format(t.linked.doneAt, { time }),
        reopen: t.linked.reopen,
      },
      keysHint: t.keysHint,
      keysHintSchedule: t.keysHintSchedule,
    },
    TODO_ORIGIN_LABELS: t.origins satisfies Record<TodoOrigin, string>,
    TIDY: {
      working: t.tidy.working,
      workingAria: t.tidy.workingAria,
      action: t.tidy.action,
      actionAria: (title: string) => format(t.tidy.actionAria, { title }),
      actionHint: t.tidy.actionHint,
      original: (text: string) => format(t.tidy.original, { text }),
      revert: t.tidy.revert,
      revertAria: (title: string) => format(t.tidy.revertAria, { title }),
      reverted: (title: string) => format(t.tidy.reverted, { title }),
      undoFailed: (reason: string) => format(t.tidy.undoFailed, { reason }),
      failed: (reason: string) => format(t.tidy.failed, { reason: reason.replace(/[。.]+$/, "") }),
      reasons: t.tidy.reasons,
    },
    DUE_FORMAT: t.dueFormat,
  };
}

type TasksCopy = ReturnType<typeof tasksCopy>;

function localized<T extends object>(select: (copy: TasksCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(select(tasksCopy()), property),
  });
}

export const TASKS = localized((copy) => copy.TASKS);
export const TODO_ORIGIN_LABELS = localized((copy) => copy.TODO_ORIGIN_LABELS);
export const TIDY = localized((copy) => copy.TIDY);
export const DUE_FORMAT = localized((copy) => copy.DUE_FORMAT);
