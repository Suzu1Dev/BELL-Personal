import type { OnboardingLocale } from "./onboarding";
import strings from "./calendar-guide-strings.json";

function resolveOnboardingLocale(search: string): OnboardingLocale {
  return new URLSearchParams(search).get("lang") === "en" ? "en" : "zh-TW";
}

export function guideCopy(locale: OnboardingLocale = resolveOnboardingLocale(typeof window === "undefined" ? "" : window.location.search)) {
  const t = strings[locale];
  const fixes = t.todayPlaceFixes;
  return {
    guidePageHead: { eyebrow: "", title: t.guidePageHead.title, sub: "" },
    guide: {
      ...t.guide,
      daily: {
        ...t.guide.daily,
        steps: Object.values({ ...t.guide.daily.steps, step1: { ...t.guide.daily.steps.step1, title: fixes.guideOpenTodayTitle } }),
      },
      ai: { ...t.guide.ai, points: Object.values(t.guide.ai.points) },
      privacy: { ...t.guide.privacy, points: Object.values(t.guide.privacy.points) },
    },
    guideShared: {
      ...t.guideShared,
      help: {
        ...t.guideShared.help,
        scopes: {
          ...t.guideShared.help.scopes,
          list: fixes.helpScopeList,
          habits: fixes.helpScopeHabits,
        },
      },
    },
    shortcutLabels: {
      ...t.shortcutLabels,
      capture: { ...t.shortcutLabels.capture, label: fixes.shortcutCaptureLabel },
      goToday: { label: fixes.shortcutGoTodayLabel, short: fixes.shortcutGoTodayShort },
      goBot: locale === "en"
        ? { label: "Go to Personal Bot", short: "Bot" }
        : { label: "前往 Personal Bot", short: "Bot" },
    },
    todayPlaceFixes: fixes,
  };
}

type GuideCopy = ReturnType<typeof guideCopy>;

function localized<T extends object>(select: (copy: GuideCopy) => T): T {
  return new Proxy({} as T, {
    get: (_target, property) => Reflect.get(select(guideCopy()), property),
  });
}

export const GUIDE_PAGE_HEAD = localized((copy) => copy.guidePageHead);
export const GUIDE = localized((copy) => copy.guide);
export const GUIDE_SHARED = localized((copy) => copy.guideShared);
export const SHORTCUT_LABELS = localized((copy) => copy.shortcutLabels);
