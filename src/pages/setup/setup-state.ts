import type { AppSettings } from "../../../shared/settings";

export function needsOnboarding(settings: AppSettings): boolean {
  return settings["onboarding.completedAt"] === null;
}

export function completionPatch(_settings: AppSettings): Partial<AppSettings> {
  return { "onboarding.completedAt": new Date().toISOString() };
}

export function ctfTimeSwitchState(settings: AppSettings | undefined) {
  return { checked: settings?.["ctftime.enabled"] ?? false, disabled: !settings };
}
