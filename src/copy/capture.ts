import type { CaptureType } from "../../shared/connect";
import { weeklyLabel } from "../../shared/calendar";
import { weekdayOf, type DayKey } from "../../shared/time";
import { weekdayChar } from "../../shared/today-format";
import { format, onboardingLocale, type OnboardingLocale } from "./onboarding";
import strings from "./quick-capture-strings.json";

export type QuickCaptureCopy = (typeof strings)["zh-TW"];

export function quickCaptureCopy(locale: OnboardingLocale = onboardingLocale()): QuickCaptureCopy {
  return strings[locale];
}

const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function captureWeekday(day: DayKey, locale: OnboardingLocale = onboardingLocale()): string {
  return locale === "en" ? WEEKDAYS_EN[weekdayOf(day)] : weekdayChar(day);
}

export function captureWeeklyLabel(day: DayKey, locale: OnboardingLocale = onboardingLocale()): string {
  return locale === "en" ? `Every ${captureWeekday(day, locale)}` : weeklyLabel(day);
}

const withoutFinalPeriod = (reason: string) => reason.replace(/[。.]$/, "");

export const CAPTURE_TYPE_LABELS: Record<CaptureType, string> = {
  get todo() { return quickCaptureCopy().captureTypeLabels.todo; },
  get event() { return quickCaptureCopy().captureTypeLabels.event; },
  get idea() { return quickCaptureCopy().captureTypeLabels.idea; },
};

export const CAPTURE = {
  get label() { return quickCaptureCopy().capture.label; },
  get placeholder() { return quickCaptureCopy().capture.placeholder; },
  get hintIdle() { return quickCaptureCopy().capture.hintIdle; },
  preview(type: CaptureType, when?: string) {
    const copy = quickCaptureCopy();
    return format(copy.capture[when ? "previewWithWhen" : "preview"], { label: copy.captureTypeLabels[type], ...(when ? { when } : {}) });
  },
  get ideasLink() { return quickCaptureCopy().capture.ideasLink; },
  get typeGroup() { return quickCaptureCopy().capture.typeGroup; },
  get tabSwitch() { return quickCaptureCopy().capture.tabSwitch; },
  get saving() { return quickCaptureCopy().capture.saving; },
  get chipEdit() { return quickCaptureCopy().capture.chipEdit; },
  chipDuration(text: string) { return format(quickCaptureCopy().capture.chipDuration, { text }); },
  chipLocation(place: string) { return format(quickCaptureCopy().capture.chipLocation, { place }); },
  chipTags(tags: string[]) { return format(quickCaptureCopy().capture.chipTags, { tags: tags.map((tag) => `#${tag}`).join(" ") }); },
  get dateInputLabel() { return quickCaptureCopy().capture.dateInputLabel; },
  get timeInputLabel() { return quickCaptureCopy().capture.timeInputLabel; },
  get repeatOff() { return quickCaptureCopy().capture.repeatOff; },
  get repeatOffHint() { return quickCaptureCopy().capture.repeatOffHint; },
  get repeatOnHint() { return quickCaptureCopy().capture.repeatOnHint; },
  repeatRemove(label: string) { return format(quickCaptureCopy().capture.repeatRemove, { label }); },
  get repeatUntil() { return quickCaptureCopy().capture.repeatUntil; },
  get repeatUntilLabel() { return quickCaptureCopy().capture.repeatUntilLabel; },
  repeatPreview(label: string) { return format(quickCaptureCopy().capture.repeatPreview, { label }); },
  get localOnly() { return quickCaptureCopy().capture.localOnly; },
} as const;

export const PALETTE_CAPTURE = {
  get empty() { return quickCaptureCopy().paletteCapture.empty; },
  get enter() { return quickCaptureCopy().paletteCapture.enter; },
  metaTodo(when?: string) {
    const copy = quickCaptureCopy().paletteCapture;
    return format(copy[when ? "metaTodoDue" : "metaTodoNoDue"], when ? { when } : {});
  },
  metaEvent(when: string, place?: string) {
    const copy = quickCaptureCopy().paletteCapture;
    return format(copy[place ? "metaEventWithPlace" : "metaEvent"], { when, ...(place ? { place } : {}) });
  },
  metaIdea(tags: string[]) {
    const copy = quickCaptureCopy().paletteCapture;
    return format(copy[tags.length ? "metaIdeaWithTags" : "metaIdea"], tags.length ? { tags: tags.map((tag) => `#${tag}`).join(" ") } : {});
  },
  alternative(type: CaptureType, title: string) { return format(quickCaptureCopy().paletteCapture.alternative[type], { title }); },
  get calendarGoogle() { return quickCaptureCopy().paletteCapture.calendarGoogle; },
  get calendarLocal() { return quickCaptureCopy().paletteCapture.calendarLocal; },
  get aiLoading() { return quickCaptureCopy().paletteCapture.aiLoading; },
  get aiLoadingMeta() { return quickCaptureCopy().paletteCapture.aiLoadingMeta; },
  get aiFailed() { return quickCaptureCopy().paletteCapture.aiFailed; },
  get aiAsk() { return quickCaptureCopy().paletteCapture.aiAsk; },
  get aiAskMeta() { return quickCaptureCopy().paletteCapture.aiAskMeta; },
  aiBasis(basis: string) { return format(quickCaptureCopy().paletteCapture.aiBasis, { basis }); },
  get searchMeta() { return quickCaptureCopy().paletteCapture.searchMeta; },
  get searchOpen() { return quickCaptureCopy().paletteCapture.searchOpen; },
  searchPct(pct: number) { return format(quickCaptureCopy().paletteCapture.searchPct, { pct }); },
} as const;

export const CAPTURE_TOASTS = {
  todo(title: string, when?: string) {
    const copy = quickCaptureCopy().captureToasts;
    return format(copy[when ? "todoWithWhen" : "todo"], { title, ...(when ? { when } : {}) });
  },
  event(title: string, when: string) { return format(quickCaptureCopy().captureToasts.event, { title, when }); },
  eventWeekly(title: string, when: string) { return format(quickCaptureCopy().captureToasts.eventWeekly, { title, when }); },
  get idea() { return quickCaptureCopy().captureToasts.idea; },
  get failedOffline() { return quickCaptureCopy().captureToasts.failedOffline; },
  failed(reason: string) { return format(quickCaptureCopy().captureToasts.failed, { reason: withoutFinalPeriod(reason) }); },
  undoFailed(reason: string) { return format(quickCaptureCopy().captureToasts.undoFailed, { reason }); },
} as const;

export const TIDY = {
  get working() { return quickCaptureCopy().tidy.working; },
  get workingAria() { return quickCaptureCopy().tidy.workingAria; },
  get action() { return quickCaptureCopy().tidy.action; },
  actionAria(title: string) { return format(quickCaptureCopy().tidy.actionAria, { title }); },
  get actionHint() { return quickCaptureCopy().tidy.actionHint; },
  original(text: string) { return format(quickCaptureCopy().tidy.original, { text }); },
  get revert() { return quickCaptureCopy().tidy.revert; },
  revertAria(title: string) { return format(quickCaptureCopy().tidy.revertAria, { title }); },
  reverted(title: string) { return format(quickCaptureCopy().tidy.reverted, { title }); },
  undoFailed(reason: string) { return format(quickCaptureCopy().tidy.undoFailed, { reason }); },
  failed(reason: string) { return format(quickCaptureCopy().tidy.failed, { reason: withoutFinalPeriod(reason) }); },
  get reasons() { return quickCaptureCopy().tidy.reasons; },
} as const;

export const CAPTURE_DAYS = {
  get yesterday() { return quickCaptureCopy().captureDays.yesterday; },
  get today() { return quickCaptureCopy().captureDays.today; },
  get tomorrow() { return quickCaptureCopy().captureDays.tomorrow; },
  get dayAfter() { return quickCaptureCopy().captureDays.dayAfter; },
} as const;
