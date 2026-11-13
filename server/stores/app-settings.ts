import { z } from "zod";
import { AI_CONNECTION_METHODS } from "../../shared/ai-connections.js";
import { MAIL_BODY_LIMITS, MAIL_BODY_VIEWS } from "../../shared/mail.js";
import { FEATURE_IDS, normalizeRoles, PROFILE_ROLES, type FeatureId } from "../../shared/profile.js";
import { APP_SETTING_LIMITS, BOT_AUTONOMY_LEVELS, DEFAULT_APP_SETTINGS, THEMES, type AppSettings } from "../../shared/settings.js";
import { isLocalTime } from "../../shared/time.js";
import { AppError } from "../errors.js";
import { logEvent } from "../log.js";
import type { AppDatabase } from "../db/database.js";

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** An address as mail headers carry it (lower-cased), for 信任的寄件者. */
const ADDRESS = /^(?=.{3,254}$)[^\s@<>"'(),;:\\]{1,64}@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Server-side validation for every app setting key (shared/settings.ts holds
 * the type, defaults and docs). A feature adding a key adds it in both places.
 */
export const appSettingSchemas = {
  theme: z.enum(THEMES),
  singleKeyShortcuts: z.boolean(),
  weekStartsMonday: z.boolean(),
  "ai.enabled": z.boolean(),
  "ai.mailTriage": z.boolean(),
  "ai.ideaTags": z.boolean(),
  "ai.captureTidy": z.boolean(),
  "brief.autoTime": z.string().refine(isLocalTime, { message: "請使用 HH:MM 24 小時制時間。" }),
  "brief.onFirstOpen": z.boolean(),
  "mail.retentionDays": z.number().int().min(APP_SETTING_LIMITS.retentionDays.min).max(APP_SETTING_LIMITS.retentionDays.max),
  "mail.schoolDomains": z.array(z.string().trim().toLowerCase().regex(DOMAIN, { message: "請輸入網域，例如 nycu.edu.tw。" })).max(APP_SETTING_LIMITS.schoolDomains),
  "mail.bodyView": z.enum(MAIL_BODY_VIEWS),
  "mail.trustedImageSenders": z.array(z.string().trim().toLowerCase().refine((value) => ADDRESS.test(value) || DOMAIN.test(value), { message: "請輸入寄件者的信箱或網域，例如 news@example.com 或 example.com。" }))
    .max(MAIL_BODY_LIMITS.trustedSenders)
    .transform((entries) => [...new Set(entries)]),
  "weather.enabled": z.boolean(),
  "weather.location": z.object({
    name: z.string().trim().min(1).max(80),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timezone: z.string().max(64).optional(),
  }).strict(),
  "ctftime.enabled": z.boolean(),
  "ctftime.minWeight": z.number().min(APP_SETTING_LIMITS.ctftimeWeight.min).max(APP_SETTING_LIMITS.ctftimeWeight.max),
  "events.addToGoogle": z.boolean(),
  "calendar.addToGoogle": z.boolean(),
  "habits.githubAuto": z.boolean(),
  "sidebar.projectIds": z.array(z.string().min(1).max(100)).max(APP_SETTING_LIMITS.sidebarProjects),
  "ai.connection": z.enum(AI_CONNECTION_METHODS).nullable(),
  "profile.roles": z.array(z.enum(PROFILE_ROLES)).max(PROFILE_ROLES.length * 2).transform(normalizeRoles),
  "features.overrides": z.object(Object.fromEntries(FEATURE_IDS.map((feature) => [feature, z.boolean().optional()])) as Record<FeatureId, z.ZodOptional<z.ZodBoolean>>).strict(),
  "onboarding.completedAt": z.iso.datetime({ offset: true }).nullable(),
  "bot.autonomy": z.enum(BOT_AUTONOMY_LEVELS),
} satisfies { [K in keyof AppSettings]: z.ZodType<AppSettings[K]> };

/** PUT /api/settings/app body: any subset of known keys, nothing else. */
export const appSettingsPatchSchema = z.object(appSettingSchemas).partial().strict();

/** Flat key → JSON value rows in settings.sqlite; unknown or unreadable rows fall back to defaults. */
export class AppSettingsStore {
  constructor(private readonly database: AppDatabase) {}

  get(): AppSettings {
    const values: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
    for (const row of this.database.db.prepare("SELECT key, json FROM app_settings").all()) {
      const key = String(row.key) as keyof AppSettings;
      const schema = appSettingSchemas[key] as z.ZodType | undefined;
      if (!schema) continue; // A key from a newer build: keep it, ignore it.
      try {
        const parsed = schema.safeParse(JSON.parse(String(row.json)));
        if (parsed.success) { values[key] = parsed.data; continue; }
      } catch { /* reported below */ }
      logEvent("store.unreadable", { table: "app_settings", id: key, strict: false });
    }
    return values as unknown as AppSettings;
  }

  value<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.get()[key];
  }

  /** Validates a partial patch and writes each key in one transaction. */
  update(patch: unknown): AppSettings {
    const parsed = appSettingsPatchSchema.parse(patch);
    const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);
    if (!entries.length) throw new AppError(400, "沒有要更新的設定。");
    const now = new Date().toISOString();
    this.database.transaction(() => {
      const statement = this.database.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at");
      for (const [key, value] of entries) statement.run(key, JSON.stringify(value), now);
    });
    return this.get();
  }
}
