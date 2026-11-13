/**
 * 初次設定 › 你是… (multi-select) and 設定 › 身分與功能. Roles and feature
 * switches only decide what is shown: a hidden feature keeps its data, its
 * connection and its sync, and comes back as it was when it is turned on again.
 *
 * Settings (shared/settings.ts):
 * - `profile.roles`: the roles ticked, `[]` until answered (only the features
 *   everyone gets).
 * - `features.overrides`: a feature the user switched on or off by hand; it
 *   wins over the roles, and removing the entry follows the roles again.
 * - `onboarding.completedAt`: when 初次設定 was finished (or the legacy
 *   migration in server/onboarding.ts answered it for an existing install).
 *
 * `roles === null` is still accepted by every function here and shows
 * everything: the browser's "settings not loaded yet" state.
 */
export const PROFILE_ROLES = ["student", "developer", "ctf"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];

/** Features a role turns on (01-FLOW 身分對應的功能); 課表 is the calendar's weekly-repeat events. */
export const FEATURE_IDS = ["assignments", "timetable", "projects", "github", "events"] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
export type FeatureOverrides = Partial<Record<FeatureId, boolean>>;

/** Which roles turn each feature on. */
export const ROLE_FEATURES: Record<FeatureId, readonly ProfileRole[]> = {
  assignments: ["student"],
  timetable: ["student"],
  projects: ["student", "developer"],
  github: ["developer"],
  events: ["ctf"],
};

/**
 * Server feature modules (server/features/*, ModuleHost names) gated by a
 * feature; any module not listed is for everyone. 課表 has no module of its
 * own (calendar is for everyone), so it is shown or hidden by the browser only.
 */
export const MODULE_FEATURES: Readonly<Record<string, FeatureId>> = {
  lms: "assignments",
  projects: "projects",
  github: "github",
  events: "events",
};

/** Sidebar sections (src/app/nav.ts) gated by features; #/work holds 學校作業, 專案 and GitHub. */
export const SECTION_FEATURES: Readonly<Record<string, readonly FeatureId[]>> = {
  work: ["assignments", "projects", "github"],
  events: ["events"],
};

function perRole(pick: (role: ProfileRole) => string[]): Record<ProfileRole, readonly string[]> {
  const out = {} as Record<ProfileRole, readonly string[]>;
  for (const role of PROFILE_ROLES) out[role] = pick(role);
  return out;
}

/** Gated modules per role, derived from ROLE_FEATURES (kept for older callers). */
export const ROLE_MODULES = perRole((role) => Object.keys(MODULE_FEATURES).filter((name) => ROLE_FEATURES[MODULE_FEATURES[name]!].includes(role)));

/** Gated sidebar sections per role, derived from ROLE_FEATURES. */
export const ROLE_SECTIONS = perRole((role) => Object.keys(SECTION_FEATURES).filter((section) => SECTION_FEATURES[section]!.some((feature) => ROLE_FEATURES[feature].includes(role))));

/** A manual answer wins; otherwise any ticked role that owns the feature turns it on. */
export function isFeatureVisible(feature: FeatureId, roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): boolean {
  const override = overrides[feature];
  if (override !== undefined) return override;
  if (roles === null) return true;
  return ROLE_FEATURES[feature].some((role) => roles.includes(role));
}

/** Every feature's visibility for these roles and overrides: the one rule the server and the browser share. */
export function visibleFeatures(roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): Record<FeatureId, boolean> {
  return Object.fromEntries(FEATURE_IDS.map((feature) => [feature, isFeatureVisible(feature, roles, overrides)])) as Record<FeatureId, boolean>;
}

/** Whether a server module's Today rows, source chips and writes are on. */
export function isModuleVisible(name: string, roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): boolean {
  const feature = MODULE_FEATURES[name];
  return feature === undefined || isFeatureVisible(feature, roles, overrides);
}

/** Whether a sidebar / palette / quickbar section shows. */
export function isSectionVisible(section: string, roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): boolean {
  const features = SECTION_FEATURES[section];
  return features === undefined || features.some((feature) => isFeatureVisible(feature, roles, overrides));
}

/** Gated modules these roles and overrides hide (empty for `null` roles without overrides). */
export function hiddenModules(roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): string[] {
  return Object.keys(MODULE_FEATURES).filter((name) => !isModuleVisible(name, roles, overrides));
}

/** Canonical form: known roles, no duplicates, PROFILE_ROLES order. */
export function normalizeRoles(roles: readonly ProfileRole[]): ProfileRole[] {
  return PROFILE_ROLES.filter((role) => roles.includes(role));
}
