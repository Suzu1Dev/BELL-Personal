import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APP_SETTINGS } from "../../../shared/settings";
import { completionPatch, ctfTimeSwitchState, needsOnboarding } from "./setup-state";
import { localizedCityName } from "./SetupPage";
import type { OnboardingCopy } from "../../copy/onboarding";

test("only a null completion timestamp starts onboarding", () => {
  assert.equal(needsOnboarding(DEFAULT_APP_SETTINGS), true);
  assert.equal(needsOnboarding({ ...DEFAULT_APP_SETTINGS, "onboarding.completedAt": "2026-11-10T00:00:00.000Z" }), false);
});

test("finishing writes an ISO completion timestamp", () => {
  const patch = completionPatch(DEFAULT_APP_SETTINGS);
  assert.ok(Number.isFinite(Date.parse(patch["onboarding.completedAt"]!)));
});

test("CTFtime stays neutral while loading and follows the saved setting", () => {
  assert.deepEqual(ctfTimeSwitchState(undefined), { checked: false, disabled: true });
  assert.deepEqual(ctfTimeSwitchState(DEFAULT_APP_SETTINGS), { checked: false, disabled: false });
  assert.deepEqual(ctfTimeSwitchState({ ...DEFAULT_APP_SETTINGS, "ctftime.enabled": true }), { checked: true, disabled: false });
});

test("weather cities match saved coordinates across locales", () => {
  const copy = { src: { cities: { taipei: "Taipei", hsinchu: "Hsinchu" } } } as OnboardingCopy;
  assert.equal(localizedCityName({ name: "新竹", latitude: 24.8138, longitude: 120.9675, timezone: "Asia/Taipei" }, copy), "Hsinchu");
  assert.equal(localizedCityName({ name: "Custom", latitude: 0, longitude: 0, timezone: "UTC" }, copy), "Custom");
});
