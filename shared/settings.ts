import type { AiConnectionMethod } from "./ai-connections.js";
import type { MailBodyView } from "./mail.js";
import type { FeatureOverrides, ProfileRole } from "./profile.js";
import type { WeatherLocation } from "./weather.js";
import { DEFAULT_WEATHER_LOCATION } from "./weather.js";

/**
 * App preferences (settings.sqlite app_settings, one row per key, synced to
 * every device). Keys are flat and namespaced by feature; adding one means
 * adding it here, to DEFAULT_APP_SETTINGS, to APP_SETTING_OWNERS and to the
 * server schema in server/stores/app-settings.ts. Read them on the server
 * with ctx.settings.value("ai.enabled"); the browser uses
 * GET/PUT /api/settings/app (any subset of keys, validated).
 *
 * Not settings: credentials (vault), event feed subscriptions (their own
 * table and vault records, /api/events/feeds), per-browser conveniences
 * (collapsed sidebar, collapsed widgets, drafts: localStorage `bell-personal.*`).
 */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const BOT_AUTONOMY_LEVELS = ["cautious", "balanced", "auto"] as const;
export type BotAutonomy = (typeof BOT_AUTONOMY_LEVELS)[number];

export interface AppSettings {
  /** 外觀 › 主題. The browser caches it in localStorage `bell-personal.theme` for the first paint (public/theme-boot.js). */
  theme: Theme;
  /** 外觀 › 單鍵快捷鍵. Off disables single-key shortcuts (J/K/E/S/N/1–9); ⌘K always works (WCAG 2.1.4). */
  singleKeyShortcuts: boolean;
  /** 外觀 › 一週從星期一開始. Calendar week view and the habits weekday header. */
  weekStartsMonday: boolean;
  /** 每日摘要 › 使用 AI. The master switch: off means no model call anywhere (brief, triage, capture parse, tags). */
  "ai.enabled": boolean;
  /** AI triage of new mail after each Gmail sync (only when ai.enabled). */
  "ai.mailTriage": boolean;
  /** Optional AI tag suggestions for new ideas (only when ai.enabled). */
  "ai.ideaTags": boolean;
  /** 每日摘要 › 自動整理快速記下的內容: after a quick capture creates a todo or event, AI rewrites its title and notes in the background (undoable; only when ai.enabled). */
  "ai.captureTidy": boolean;
  /** 每日摘要 › 自動產生時間, local "HH:MM" in BELLPERSONAL_TZ. */
  "brief.autoTime": string;
  /** 每日摘要 › 也在每天第一次打開時產生 (when today's brief is still missing). */
  "brief.onFirstOpen": boolean;
  /** 資料與隱私 › 信件保留天數: cached mail metadata, excerpts and summaries older than this are deleted. */
  "mail.retentionDays": number;
  /** Rule-fallback digest: sender domains counted as 學校公告 (SPEC §4.4). */
  "mail.schoolDomains": string[];
  /** 資料與隱私 › 預設顯示方式, and the reader's 原始版面 / 純文字 switch (SPEC-mail-html). */
  "mail.bodyView": MailBodyView;
  /** 資料與隱私 › 信任的寄件者: addresses or domains whose remote images load (through the proxy) without asking. */
  "mail.trustedImageSenders": string[];
  /** 天氣 on/off; off hides the hero weather segments and stops fetching. */
  "weather.enabled": boolean;
  /** 天氣 › 城市 (Open-Meteo geocoding result). */
  "weather.location": WeatherLocation;
  /** CTFtime source on/off. Off for a new install; an install from before 初次設定 keeps the old default, on (PRE_ONBOARDING_DEFAULTS). */
  "ctftime.enabled": boolean;
  /** CTFtime events below this weight stay out of the queue's 要參加嗎 rows (they still list on #/events). */
  "ctftime.minWeight": number;
  /** 要參加時同時加入 Google 行事曆 (SPEC §6.4), when Google is connected with calendar.events. */
  "events.addToGoogle": boolean;
  /** 新行程加到 Google 行事曆 (quick capture and 排進), when Google is connected with calendar.events. */
  "calendar.addToGoogle": boolean;
  /** The automatic habit 「GitHub 有貢獻」 driven by the contribution calendar. */
  "habits.githubAuto": boolean;
  /** Projects pinned in the sidebar PROJECTS list (up to 5); empty = the first active projects. */
  "sidebar.projectIds": string[];
  /**
   * 設定 › 連接 AI › 使用中的連線: chatgpt / claude (the CLI's own sign-in) or
   * openai-key / anthropic-key (a key saved in BELL, else the CLI's own API-key
   * login). It decides which CLI runs AI jobs and how it signs in. `null` = not
   * chosen: the provider in 設定 › AI 模型, with whatever its CLI is signed in
   * with (the behaviour before this setting). Set it with
   * PUT /api/ai/connections/active (or PUT /api/settings/app), which also
   * checks the method is ready.
   */
  "ai.connection": AiConnectionMethod | null;
  /** 初次設定 › 你是… / 設定 › 身分與功能: student / developer / ctf (shared/profile.ts). `[]` = none ticked (also before 初次設定): only the features everyone gets. Visibility only: hidden features keep their data and sync. */
  "profile.roles": ProfileRole[];
  /** 設定 › 身分與功能 › 個別功能: a feature switched on or off by hand wins over the roles (shared/profile.ts visibleFeatures); a missing entry follows the roles. Always saved as the whole object. */
  "features.overrides": FeatureOverrides;
  /** When 初次設定 was finished (ISO 8601); `null` = not yet, the browser opens #/setup. Existing installs get it from the one-time legacy migration (server/onboarding.ts). */
  "onboarding.completedAt": string | null;
  /** 設定 › AI › Personal Bot 自主權限: cautious (每次詢問) / balanced (分級權限, default) / auto (全自動). */
  "bot.autonomy": BotAutonomy;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "system",
  singleKeyShortcuts: true,
  weekStartsMonday: true,
  "ai.enabled": true,
  "ai.mailTriage": true,
  "ai.ideaTags": false,
  "ai.captureTidy": true,
  "ai.connection": null,
  "brief.autoTime": "06:30",
  "brief.onFirstOpen": true,
  "mail.retentionDays": 30,
  "mail.schoolDomains": ["nycu.edu.tw"],
  "mail.bodyView": "original",
  "mail.trustedImageSenders": [],
  "weather.enabled": true,
  "weather.location": DEFAULT_WEATHER_LOCATION,
  "ctftime.enabled": false,
  "ctftime.minWeight": 25,
  "events.addToGoogle": true,
  "calendar.addToGoogle": true,
  "habits.githubAuto": false,
  "sidebar.projectIds": [],
  "profile.roles": [],
  "features.overrides": {},
  "onboarding.completedAt": null,
  "bot.autonomy": "balanced",
};

/**
 * Every default 初次設定 changed, with the value builds from before it used.
 * Those builds never wrote a default down, so an install that relied on one
 * has no row: the one-time legacy migration (server/onboarding.ts) writes the
 * old value for each key here that the install never saved (or saved
 * unreadably), so an upgrade keeps every feature it had. A new install gets
 * DEFAULT_APP_SETTINGS. That migration runs once per install, so a default
 * changed after 初次設定 shipped needs a settings migration of its own.
 */
export const PRE_ONBOARDING_DEFAULTS: Partial<AppSettings> = {
  // CTFtime became opt-in (its switch in 初次設定 for the CTF 選手 role, and 設定 › 來源); before, it was on for everyone.
  "ctftime.enabled": true,
};

export type AppSettingKey = keyof AppSettings;

/** Limits shared by the server schema and the settings UI. */
export const APP_SETTING_LIMITS = {
  retentionDays: { min: 1, max: 365 },
  ctftimeWeight: { min: 0, max: 100 },
  schoolDomains: 20,
  sidebarProjects: 5,
} as const;

/** Which team reads each key, for docs/ARCHITECTURE.md §10.4. */
export const APP_SETTING_OWNERS: Record<AppSettingKey, string> = {
  theme: "today-settings",
  singleKeyShortcuts: "today-settings",
  weekStartsMonday: "today-settings",
  "ai.enabled": "habits-brief",
  "ai.mailTriage": "mail",
  "ai.ideaTags": "tasks",
  "ai.captureTidy": "tasks",
  "ai.connection": "today-settings",
  "brief.autoTime": "habits-brief",
  "brief.onFirstOpen": "habits-brief",
  "mail.retentionDays": "mail",
  "mail.schoolDomains": "mail",
  "mail.bodyView": "mail",
  "mail.trustedImageSenders": "mail",
  "weather.enabled": "habits-brief",
  "weather.location": "habits-brief",
  "ctftime.enabled": "calendar-events",
  "ctftime.minWeight": "calendar-events",
  "events.addToGoogle": "calendar-events",
  "calendar.addToGoogle": "calendar-events",
  "habits.githubAuto": "habits-brief",
  "sidebar.projectIds": "work",
  "profile.roles": "today-settings",
  "features.overrides": "today-settings",
  "onboarding.completedAt": "today-settings",
  "bot.autonomy": "today-settings",
};
