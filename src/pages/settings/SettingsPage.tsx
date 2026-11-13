/**
 * #/settings/:tab (帳號與來源 · 每日摘要 · 外觀 · 資料與隱私) and the Google
 * guide #/settings/sources/google (SPEC-ux §3.3, §3.4). The localized
 * settings lead is the page subline.
 * Coming back from Google (`?google=connected|error`) shows a toast once.
 */
import { useEffect } from "react";
import { settingsCopy } from "../../copy/settings";
import { Button } from "../../components/Button";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { Tabs } from "../../components/Tabs";
import { useToast } from "../../components/toast/ToastProvider";
import { SETTINGS_TABS, routeHref, type RouteOf } from "../../lib/router";
import { useStatus } from "../../lib/status";
import { AppearanceTab } from "./AppearanceTab";
import { AiTab } from "./AiTab";
import { BriefTab } from "./BriefTab";
import { RolesTab } from "./RolesTab";
import { onboardingCopy } from "../../copy/onboarding";
import { GoogleGuide } from "./GoogleGuide";
import { PrivacyTab } from "./PrivacyTab";
import { SourcesTab } from "./SourcesTab";
import { settingsApi } from "./settings-api";
import { missingScopeNames } from "./settings-forms";
import { googleReturn } from "./settings-view";
import { useAppSettings } from "./useAppSettings";
import "./SettingsPage.css";

export default function SettingsPage({ route }: { route: RouteOf<"settings"> | RouteOf<"google-guide"> }) {
  useGoogleReturn();
  if (route.name === "google-guide") return <GoogleGuide />;
  return <SettingsTabs tab={route.tab} />;
}

function SettingsTabs({ tab }: { tab: RouteOf<"settings">["tab"] }) {
  const app = useAppSettings();
  const copy = onboardingCopy();
  const { SETTINGS } = settingsCopy();
  return (
    <>
      <PageHead title={copy.settings.title} sub={copy.settings.lead} />
      <Tabs
        label={copy.settings.tabsAria}
        value={tab}
        items={SETTINGS_TABS.map((value) => ({ value, label: copy.settings.tabs[value], href: routeHref({ name: "settings", tab: value }) }))}
      />
      {app.error && !app.settings ? (
        <Notice
          className="settings-notice"
          tone="error"
          role="alert"
          title={SETTINGS.loadFailed}
          actions={<Button variant="secondary" size="sm" onClick={app.reload}>{SETTINGS.retry}</Button>}
        >
          {app.error}
        </Notice>
      ) : null}
      {tab === "sources" ? <SourcesTab app={app} />
        : tab === "roles" ? <RolesTab />
          : tab === "ai" ? <AiTab />
            : tab === "brief" ? <BriefTab app={app} />
              : tab === "appearance" ? <AppearanceTab app={app} />
                : <PrivacyTab app={app} />}
    </>
  );
}

/** The hashes already reported, so StrictMode and re-renders show the toast once. */
const reported = new Set<string>();

/** `?google=connected[&missing=…]` / `?google=error&reason=…` from the OAuth callback (ARCHITECTURE §10.5). */
export function useGoogleReturn(onReturned?: () => void) {
  const toast = useToast();
  const status = useStatus();
  const { GOOGLE_RETURN, GOOGLE_RETURN_ERRORS, SCOPE_LABELS, SOURCES, listSep } = settingsCopy();
  useEffect(() => {
    const hash = window.location.hash;
    const result = googleReturn(hash);
    if (!result || reported.has(hash)) return;
    reported.add(hash);
    onReturned?.();
    if (result.kind === "connected") {
      const missing = missingScopeNames(new URLSearchParams(hash.split("?")[1]).get("missing"), SCOPE_LABELS, listSep);
      toast.success(missing ? SOURCES.google.connectedMissing(missing) : SOURCES.google.connected);
      settingsApi.sync(["gmail", "google-calendar"]).catch(() => { /* the cards show the source state */ });
      void status.refresh();
    } else {
      toast.error(GOOGLE_RETURN.failed(result.reason ? GOOGLE_RETURN_ERRORS[result.reason] : GOOGLE_RETURN.unknown));
    }
    // Drop the parameters so a reload does not report again.
    window.history.replaceState(window.history.state, "", hash.replace(/\?.*$/, ""));
  }, [toast, status, onReturned]);
}
