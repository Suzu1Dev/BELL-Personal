/**
 * The appearance preferences of 連線與設定 › 外觀: theme (跟隨系統 /
 * 淺色 / 深色) and 單鍵快捷鍵, saved to AppSettings and cached in the
 * browser (src/lib/preferences.ts). Shell-owned because the topbar toggle
 * and the shortcut dispatcher read the same stores; the settings page embeds it.
 */
import { APPEARANCE, ERRORS, commonCopy } from "../copy/common";
import { Switch } from "../components/Field";
import { SegmentedControl } from "../components/SegmentedControl";
import { useToast } from "../components/toast/ToastProvider";
import { THEME_MODES, chooseSingleKeys, chooseTheme, useSingleKeyShortcuts, useThemeMode, type ThemeMode } from "../lib/preferences";
import "./AppearanceControls.css";

export function AppearanceControls() {
  const { THEME, APPEARANCE, ERRORS } = commonCopy();
  const mode = useThemeMode();
  const singleKeys = useSingleKeyShortcuts();
  const toast = useToast();
  const failed = (cause: unknown) => toast.error(ERRORS.actionFailed(APPEARANCE.save, cause instanceof Error ? cause.message : ERRORS.offline));
  return (
    <div className="appearance-controls">
      <div className="switch-row">
        <div className="switch-text">
          <span className="appearance-label">{APPEARANCE.theme}</span>
          <p className="field-hint kp">{APPEARANCE.themeHint}</p>
        </div>
        <SegmentedControl<ThemeMode>
          label={APPEARANCE.theme}
          options={THEME_MODES.map((value) => ({ value, label: THEME.options[value] }))}
          value={mode}
          onChange={(next) => { chooseTheme(next).catch(failed); }}
        />
      </div>
      <Switch
        label={APPEARANCE.singleKey}
        hint={APPEARANCE.singleKeyHint}
        checked={singleKeys}
        onChange={(on) => { chooseSingleKeys(on).catch(failed); }}
      />
    </div>
  );
}
