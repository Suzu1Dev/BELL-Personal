import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppSettings } from "../../shared/settings";
import type { FeatureId, FeatureOverrides } from "../../shared/profile";
import { ERRORS } from "../copy/common";
import { onboardingCopy } from "../copy/onboarding";
import { settingsApi } from "../pages/settings/settings-api";
import { useToast } from "../components/toast/ToastProvider";

export interface AppSettingsState {
  settings: AppSettings | undefined;
  error: string | undefined;
  reload: () => void;
  save: (patch: Partial<AppSettings>) => Promise<boolean>;
  overrides: FeatureOverrides;
  saveOverride: (feature: FeatureId, value: boolean | undefined) => Promise<boolean>;
}

const AppSettingsContext = createContext<AppSettingsState | null>(null);
const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

export function AppSettingsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings>();
  const [error, setError] = useState<string>();
  const current = useRef(settings);
  current.current = settings;
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    settingsApi.app(controller.signal)
      .then((value) => {
        setSettings(value);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(reasonOf(cause));
      });
    return () => controller.abort();
  }, [attempt]);

  const save = useCallback(async (patch: Partial<AppSettings>) => {
    const before = current.current;
    setSettings((value) => (value ? { ...value, ...patch } : value));
    try {
      setSettings(await settingsApi.saveApp(patch));
      return true;
    } catch (cause) {
      setSettings(before);
      toast.error(`${onboardingCopy().settings.toasts.saveFailed} ${reasonOf(cause)}`);
      return false;
    }
  }, [toast]);

  const overrides = settings?.["features.overrides"] ?? {};
  const saveOverride = useCallback(async (feature: FeatureId, value: boolean | undefined) => {
    const next = { ...overrides };
    if (value === undefined) delete next[feature];
    else next[feature] = value;
    return save({ "features.overrides": next });
  }, [save, overrides]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const value = useMemo<AppSettingsState>(() => ({ settings, error, reload, save, overrides, saveOverride }), [settings, error, reload, save, overrides, saveOverride]);
  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings(): AppSettingsState {
  const value = useContext(AppSettingsContext);
  if (!value) throw new Error("useAppSettings must be used inside AppSettingsProvider");
  return value;
}
