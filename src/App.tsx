/**
 * The app: providers (toasts → settings → /api/status → /api/today), the shell,
 * the routed page, the command palette and global shortcuts.
 */
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "./app/AppShell";
import { pageLabel } from "./app/nav";
import { RoutePage } from "./app/routes";
import { ShellContext, type PaletteMode, type ShellApi } from "./app/shell-context";
import { ShortcutHelp } from "./app/ShortcutHelp";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { ToastHost, ToastProvider } from "./components/toast/ToastProvider";
import { AppSettingsProvider, useAppSettings } from "./lib/app-settings";
import { isSectionVisible } from "../shared/profile";
import { commonCopy } from "./copy/common";
import { onboardingLocale } from "./copy/onboarding";
import { navigate, useRoute, type Route } from "./lib/router";
import { useServerPreferences } from "./lib/preferences";
import { needsOnboarding } from "./pages/setup/setup-state";
import { GO_CHORDS, useShortcuts } from "./lib/shortcuts";
import { StatusProvider } from "./lib/status";
import { BotProvider } from "./lib/bot-store";
import { TodayProvider } from "./lib/today";
import { MEDIA, useMediaQuery } from "./lib/useMediaQuery";

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  text?: string;
}

function Shell() {
  const route = useRoute();
  const wide = useMediaQuery(MEDIA.wide);
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  const [palette, setPalette] = useState<PaletteState>({ open: false, mode: "go" });
  const [helpOpen, setHelpOpen] = useState(false);

  const shell = useMemo<ShellApi>(() => ({
    openPalette: (mode = "go", text) => {
      setHelpOpen(false);
      setPalette({ open: true, mode, text });
    },
    closePalette: () => setPalette((current) => ({ ...current, open: false })),
    openHelp: () => setHelpOpen(true),
  }), []);

  const captureKey = () => {
    if (route.name === "today" && wide) {
      const field = document.querySelector<HTMLElement>(".bot-field textarea, .cap-field input");
      if (field) {
        field.focus();
        return;
      }
    }
    shell.openPalette("capture");
  };

  const chords = Object.fromEntries(Object.entries(GO_CHORDS)
    .filter(([, hash]) => isSectionVisible(hash.replace("#/", ""), roles, app.overrides))
    .map(([combo, hash]) => [combo, () => navigate(hash)]));
  useShortcuts({
    ...chords,
    "mod+k": () => (palette.open ? shell.closePalette() : shell.openPalette("go")),
    n: captureKey,
    "?": () => setHelpOpen(true),
  });

  useDocumentMetadata(route, roles, app.overrides);
  useServerPreferences();

  useEffect(() => {
    if (app.settings && needsOnboarding(app.settings) && route.name !== "setup" && route.name !== "google-guide") navigate("#/setup");
  }, [app.settings, route.name]);

  if (route.name === "setup") {
    return <><RoutePage route={route} /><ToastHost /></>;
  }

  return (
    <ShellContext.Provider value={shell}>
      <AppShell route={route} onCapture={() => shell.openPalette("capture")} onOpenPalette={() => shell.openPalette("go")}>
        <RoutePage route={route} />
      </AppShell>
      <CommandPalette open={palette.open} mode={palette.mode} initialText={palette.text} onClose={shell.closePalette} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </ShellContext.Provider>
  );
}

export function applyDocumentMetadata(route: Route, roles: Parameters<typeof pageLabel>[1], overrides: Parameters<typeof pageLabel>[2], target: Document = document) {
  const { META } = commonCopy();
  target.documentElement.lang = onboardingLocale() === "en" ? "en" : "zh-Hant";
  target.title = route.name === "today" ? META.title : META.titleFor(pageLabel(route, roles, overrides));
  const description = target.querySelector<HTMLMetaElement>('meta[name="description"]');
  if (description) description.content = META.description;
}

function useDocumentMetadata(route: Route, roles: Parameters<typeof pageLabel>[1], overrides: Parameters<typeof pageLabel>[2]) {
  useEffect(() => {
    applyDocumentMetadata(route, roles, overrides);
  }, [route, roles, overrides]);
}

export default function App() {
  return (
    <ToastProvider>
      <AppSettingsProvider>
        <StatusProvider>
          <TodayProvider>
            <BotProvider>
              <Shell />
            </BotProvider>
          </TodayProvider>
        </StatusProvider>
      </AppSettingsProvider>
    </ToastProvider>
  );
}
