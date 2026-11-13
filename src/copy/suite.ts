import { format, onboardingLocale, type OnboardingLocale } from "./onboarding";
import strings from "./suite-strings.json";

export type SuiteLocale = OnboardingLocale;
export type ToastCopy = (typeof strings)["zh-TW"]["personalToast"];
export const currentLocale = onboardingLocale;

export function toastCopy(locale: SuiteLocale = currentLocale()): ToastCopy {
  return strings[locale].personalToast;
}

export function suiteCopy(locale: SuiteLocale = currentLocale()) {
  const copy = strings[locale];
  return {
    ...copy,
    explainCard: {
      ...copy.explainCard,
      toReview: (n: string) => format(copy.explainCard.toReview, { n }),
      headline: (total: string, due: string, fresh: string) => format(copy.explainCard.headline, { total, due, fresh }),
      due: (n: string) => format(copy.explainCard.due, { n }),
      fresh: (n: string) => format(copy.explainCard.fresh, { n }),
      updated: (time: string) => format(copy.explainCard.updated, { time }),
      stale: (minutes: number) => format(copy.explainCard.stale, { minutes }),
    },
    prCard: {
      ...copy.prCard,
      needsYou: (n: string) => format(copy.prCard.needsYou, { n }),
      waiting: (n: string) => format(copy.prCard.waiting, { n }),
      headline: (needsYou: string, waiting: string) => format(copy.prCard.headline, { needsYou, waiting }),
      updated: (time: string) => format(copy.prCard.updated, { time }),
      stale: (minutes: number) => format(copy.prCard.stale, { minutes }),
    },
    taskDraft: {
      ...copy.taskDraft,
      back: (name: string) => format(copy.taskDraft.back, { name }),
      failed: (reason: string) => format(copy.taskDraft.failed, { reason }),
      fromSource: (name: string) => format(copy.taskDraft.fromSource, { name }),
      fromSourceKind: (name: string, kind: string) => format(copy.taskDraft.fromSourceKind, { name, kind }),
    },
  };
}

/** The products in their fixed order (SPEC §4.1). */
export const SUITE_APPS = suiteCopy("zh-TW").apps;

export const SWITCHER = {
  label: "切換 BELL 產品",
  menuLabel: "BELL 產品",
  current: "目前",
  unlinked: "尚未連結",
  loading: "正在載入產品清單…",
  failed: "無法載入產品清單",
  retry: "重試",
} as const;

/** Source states in 來源詳情 (SPEC §4.5, contracts v1 §4). */
export const SOURCE_STATUS = suiteCopy("zh-TW").sourceStatus;
export const EXPLAIN_CARD = suiteCopy("zh-TW").explainCard;
export const PR_CARD = suiteCopy("zh-TW").prCard;
export const SOURCE_DETAILS = suiteCopy("zh-TW").sourceDetails;
export const TASK_DRAFT = suiteCopy("zh-TW").taskDraft;
export const EXPLAIN_THIS = suiteCopy("zh-TW").explainThis;
export const PERSONAL_TOAST = suiteCopy("zh-TW").personalToast;
