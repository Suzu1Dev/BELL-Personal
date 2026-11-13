import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_APP_SETTINGS, PRE_ONBOARDING_DEFAULTS, type AppSettings } from "./settings.js";

/** DEFAULT_APP_SETTINGS of the last build before 初次設定 (main b32d2f2), frozen. */
const BEFORE_ONBOARDING = {
  theme: "system",
  singleKeyShortcuts: true,
  weekStartsMonday: true,
  "ai.enabled": true,
  "ai.mailTriage": true,
  "ai.ideaTags": false,
  "ai.captureTidy": true,
  "brief.autoTime": "06:30",
  "brief.onFirstOpen": true,
  "mail.retentionDays": 30,
  "mail.schoolDomains": ["nycu.edu.tw"],
  "mail.bodyView": "original",
  "mail.trustedImageSenders": [],
  "weather.enabled": true,
  "weather.location": { name: "台北", latitude: 25.033, longitude: 121.5654, timezone: "Asia/Taipei" },
  "ctftime.enabled": true,
  "ctftime.minWeight": 25,
  "events.addToGoogle": true,
  "calendar.addToGoogle": true,
  "habits.githubAuto": false,
  "sidebar.projectIds": [],
} satisfies Partial<AppSettings>;

test("every default 初次設定 changed is in PRE_ONBOARDING_DEFAULTS with its old value, so an upgrade keeps it", () => {
  const changed = Object.fromEntries(Object.entries(BEFORE_ONBOARDING)
    .filter(([key, old]) => JSON.stringify(DEFAULT_APP_SETTINGS[key as keyof AppSettings]) !== JSON.stringify(old)));
  assert.deepEqual(PRE_ONBOARDING_DEFAULTS, changed);
  assert.deepEqual(changed, { "ctftime.enabled": true }, "CTFtime is opt-in for a new install");
});
