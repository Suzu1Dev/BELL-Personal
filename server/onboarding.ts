import { FEATURE_IDS, isFeatureVisible, normalizeRoles, PROFILE_ROLES, visibleFeatures, type FeatureOverrides, type ProfileRole } from "../shared/profile.js";
import { PRE_ONBOARDING_DEFAULTS, type AppSettingKey, type AppSettings } from "../shared/settings.js";
import { logEvent } from "./log.js";
import type { CoreServices } from "./services.js";
import { appSettingSchemas } from "./stores/app-settings.js";

/** Personal tables only the user fills (an install that merely ran has none of these rows). */
const USER_TABLES = ["todos", "projects", "habits", "ideas", "manual_events", "event_feeds", "local_assignments", "item_state", "action_log"] as const;
const LMS_VAULT_RECORDS = ["moodle.token", "canvas.token"];

export type OnboardingMigration =
  | { outcome: "already" }
  | { outcome: "fresh" }
  | { outcome: "migrated"; roles: ProfileRole[]; overrides: FeatureOverrides; completedAt: string };

/**
 * The one-time legacy migration for 初次設定 (design v3 onboarding 04 L1).
 * Runs at startup, before the server listens and before any source syncs;
 * the `onboarding.completedAt` row is its run-once marker.
 *
 * - The row exists: nothing to do (already migrated, a fresh install that
 *   already wrote its marker, or the user finished or redid 初次設定).
 * - No user data (fresh install): write `onboarding.completedAt: null`, so
 *   the browser runs 初次設定 and this never runs again.
 * - User data from a build before 初次設定: tick the roles its connections
 *   imply (LMS → student, GitHub → developer, CTFtime switched on or
 *   a CTF row acted on → ctf), keep any
 *   roles or overrides already saved, and set `completedAt`, so the user
 *   skips 初次設定. Every feature that was shown before (a build without
 *   roles showed them all) and that the inferred roles would hide gets a
 *   manual "on" override, so the upgrade shows exactly what it showed
 *   before; the user narrows it in 設定 › 身分與功能. Saved roles keep what
 *   they showed, so a second run (or one after them) adds nothing. Every
 *   default 初次設定 changed (PRE_ONBOARDING_DEFAULTS) that the install
 *   never saved gets its old value written, so CTFtime stays on unless the
 *   user had turned it off; a fresh install keeps the new defaults.
 *
 * Raw SQL on purpose: it reads tables that feature modules own without
 * loading them. It never throws for a read it cannot make (an unreadable
 * vault counts as no LMS token): failing to start the server would be worse
 * than one wrong guess the user fixes in 設定 › 身分與功能.
 */
export async function migrateLegacyOnboarding(services: Pick<CoreServices, "db" | "vault" | "settings" | "now">): Promise<OnboardingMigration> {
  const { db } = services;
  const stored = storedSettings(services);
  if (stored.has("onboarding.completedAt")) return { outcome: "already" };

  const vaultNames = await vaultRecords(services);
  const has = (database: "personal" | "sources" | "settings", sql: string, ...params: string[]) =>
    db[database].db.prepare(`SELECT EXISTS (${sql}) AS found`).get(...params)?.found === 1;
  const rows = (table: string) => has("personal", `SELECT 1 FROM ${table}`);

  const student = vaultNames.some((name) => LMS_VAULT_RECORDS.includes(name))
    || has("sources", "SELECT 1 FROM source_items WHERE source IN ('moodle', 'canvas')")
    || rows("local_assignments");
  const developer = Boolean(githubLogin(db.sources.db.prepare("SELECT cursor FROM sync_state WHERE source = 'github'").get()?.cursor))
    || has("sources", "SELECT 1 FROM source_items WHERE source = 'github'");
  // CTFtime was on by default, so an install that never touched the switch has no row: for the role, count
  // it as "on" only when it was switched on by hand or the user acted on a CTF row (要參加, 略過, snooze).
  // The switch itself keeps its old value below either way.
  const ctf = stored.get("ctftime.enabled") === true
    || has("personal", "SELECT 1 FROM item_state WHERE item_id LIKE 'ctftime:%'")
    || has("personal", "SELECT 1 FROM action_log WHERE item_id LIKE 'ctftime:%' AND undone = 0");
  const legacy = student || developer || ctf
    || stored.size > 0
    || has("settings", "SELECT 1 FROM provider_settings")
    || vaultNames.length > 0
    || USER_TABLES.some(rows);

  if (!legacy) {
    services.settings.update({ "onboarding.completedAt": null });
    logEvent("onboarding.fresh");
    return { outcome: "fresh" };
  }

  const savedRoles = readable("profile.roles", stored);
  const roles = savedRoles ?? normalizeRoles(PROFILE_ROLES.filter((role) => ({ student, developer, ctf })[role]));
  const savedOverrides = readable("features.overrides", stored);
  const overrides: FeatureOverrides = { ...savedOverrides };
  // What this install showed before: unanswered roles (no row, or a legacy null) show everything.
  const shown = visibleFeatures(savedRoles ?? null, savedOverrides);
  for (const feature of FEATURE_IDS) if (shown[feature] && !isFeatureVisible(feature, roles, overrides)) overrides[feature] = true;
  // The value this install ran with for every default 初次設定 changed: a saved row already is it; no row
  // (or one the store could not read, which fell back to the default) meant the old default.
  const keptDefaults = Object.fromEntries(Object.entries(PRE_ONBOARDING_DEFAULTS)
    .filter(([key]) => !appSettingSchemas[key as AppSettingKey].safeParse(stored.get(key)).success));
  const completedAt = services.now().toISOString();
  services.settings.update({ ...keptDefaults, "profile.roles": roles, "features.overrides": overrides, "onboarding.completedAt": completedAt });
  logEvent("onboarding.migrated", { roles, overrides: Object.keys(overrides), keptRoles: savedRoles !== undefined, keptDefaults: Object.keys(keptDefaults) });
  return { outcome: "migrated", roles, overrides, completedAt };
}

/** Raw app_settings rows (JSON-decoded; an unreadable row maps to undefined). */
function storedSettings(services: Pick<CoreServices, "db">): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const row of services.db.settings.db.prepare("SELECT key, json FROM app_settings").all()) {
    let value: unknown;
    try { value = JSON.parse(String(row.json)); } catch { value = undefined; }
    out.set(String(row.key), value);
  }
  return out;
}

/** A stored value the settings schema accepts (a legacy `null` roles row is "not answered"), else undefined. */
function readable<K extends "profile.roles" | "features.overrides">(key: K, stored: Map<string, unknown>): AppSettings[K] | undefined {
  const parsed = appSettingSchemas[key].safeParse(stored.get(key));
  return parsed.success ? (parsed.data as AppSettings[K]) : undefined;
}

async function vaultRecords(services: Pick<CoreServices, "vault">): Promise<string[]> {
  if (!services.vault.enabled) return [];
  try {
    return (await services.vault.list()).map((record) => record.name);
  } catch (error) {
    logEvent("onboarding.vault_unreadable", { errorClass: error instanceof Error ? error.name : typeof error });
    return [];
  }
}

function githubLogin(cursor: unknown): string | undefined {
  if (typeof cursor !== "string" || !cursor) return undefined;
  try {
    const value = JSON.parse(cursor) as { login?: unknown } | null;
    return value && typeof value.login === "string" && value.login ? value.login : undefined;
  } catch { return undefined; }
}
