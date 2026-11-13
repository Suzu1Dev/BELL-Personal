/**
 * Appearance preferences: theme (system / light / dark) and the 單鍵快捷鍵
 * switch (SPEC-ux §3.3 外觀, §6.2). The server keeps both in AppSettings
 * (`theme`, `singleKeyShortcuts`, ARCHITECTURE §10.4) so they follow the
 * user to another browser; localStorage is the cache that the first paint
 * (public/theme-boot.js) and the shortcut guard read synchronously. On load
 * the server's values replace the cache (useServerPreferences); a change
 * (chooseTheme, chooseSingleKeys) is applied locally at once and written to
 * the server. The Settings 外觀 tab and the topbar share these stores.
 */
import { useEffect } from "react";
import { MAIL_BODY_VIEWS, type MailBodyView } from "../../shared/mail";
import type { AppSettings } from "../../shared/settings";
import { api, send } from "../api";
import { STORAGE_KEYS, storedValue, useStoredValue } from "./storage";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const themeStore = storedValue<ThemeMode>(
  STORAGE_KEYS.theme,
  (raw) => (raw === "light" || raw === "dark" ? raw : "system"),
  (mode) => (mode === "system" ? null : mode),
);

/** Applies a mode to <html data-theme> (public/theme-boot.js does the same before first paint). */
export function applyTheme(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** The theme actually on screen. */
export function effectiveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}

/**
 * The topbar toggle switches between light and dark (SPEC-ux: 切換深色模式 /
 * 切換淺色模式), so every click changes what is on screen. 跟隨系統 is chosen
 * in 連線與設定 › 外觀; a three-step cycle had a click that changed nothing.
 */
export function nextThemeMode(mode: ThemeMode, prefersDark: boolean): ThemeMode {
  return effectiveTheme(mode, prefersDark) === "dark" ? "light" : "dark";
}

export function setTheme(mode: ThemeMode): void {
  themeStore.set(mode);
  applyTheme(mode);
}

export function useThemeMode(): ThemeMode {
  return useStoredValue(themeStore);
}

/** 單鍵快捷鍵: on unless the user turned it off (WCAG 2.1.4). ⌘K / Ctrl K always works. */
export const singleKeyStore = storedValue<boolean>(
  STORAGE_KEYS.singleKeyShortcuts,
  (raw) => raw !== "off",
  (on) => (on ? null : "off"),
);

export function useSingleKeyShortcuts(): boolean {
  return useStoredValue(singleKeyStore);
}

/**
 * The reader's 原始版面 / 純文字 (SPEC-mail-html §5): AppSettings
 * `mail.bodyView`, switched in the reader or in 資料與隱私 and remembered;
 * cached here so the reader opens in the right view before the settings load.
 */
export const mailViewStore = storedValue<MailBodyView>(
  STORAGE_KEYS.mailView,
  (raw) => (raw === "plain" ? "plain" : "original"),
  (view) => (view === "original" ? null : view),
);

export function useMailView(): MailBodyView {
  return useStoredValue(mailViewStore);
}

type PreferenceSettings = Pick<AppSettings, "theme" | "singleKeyShortcuts"> & Partial<Pick<AppSettings, "mail.bodyView">>;

/** Bumped by every local change, so a server answer that started earlier never overwrites it. */
let localChanges = 0;

function savePreference(patch: Partial<PreferenceSettings>): Promise<void> {
  localChanges++;
  return api<AppSettings>("/settings/app", send("PUT", patch)).then(() => undefined);
}

/** A theme the user picked: on screen at once, then saved to AppSettings (rejects with a zh-TW reason). */
export function chooseTheme(mode: ThemeMode): Promise<void> {
  setTheme(mode);
  return savePreference({ theme: mode });
}

/** 單鍵快捷鍵 on/off: the guard follows at once, then saved to AppSettings (rejects with a zh-TW reason). */
export function chooseSingleKeys(on: boolean): Promise<void> {
  singleKeyStore.set(on);
  return savePreference({ singleKeyShortcuts: on });
}

/** 原始版面 / 純文字: the reader follows at once, then saved to AppSettings (rejects with a zh-TW reason). */
export function chooseMailView(view: MailBodyView): Promise<void> {
  mailViewStore.set(view);
  return savePreference({ "mail.bodyView": view });
}

/** The server's values replace the browser cache. */
export function applyServerPreferences(settings: PreferenceSettings): void {
  if (THEME_MODES.includes(settings.theme) && settings.theme !== themeStore.get()) setTheme(settings.theme);
  if (typeof settings.singleKeyShortcuts === "boolean" && settings.singleKeyShortcuts !== singleKeyStore.get()) singleKeyStore.set(settings.singleKeyShortcuts);
  const view = settings["mail.bodyView"];
  if (view && MAIL_BODY_VIEWS.includes(view) && view !== mailViewStore.get()) mailViewStore.set(view);
}

/** Once per app load: read GET /api/settings/app and apply it, unless the user changed something meanwhile. */
export function useServerPreferences(): void {
  useEffect(() => {
    const controller = new AbortController();
    const before = localChanges;
    api<AppSettings>("/settings/app", { signal: controller.signal })
      .then((settings) => { if (localChanges === before) applyServerPreferences(settings); })
      .catch(() => { /* offline: keep the cached values */ });
    return () => controller.abort();
  }, []);
}
