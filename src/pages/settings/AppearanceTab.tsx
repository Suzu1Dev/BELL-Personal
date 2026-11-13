/**
 * 連線與設定 › 外觀 (SPEC-ux §3.3): theme and 單鍵快捷鍵 (the shell's
 * AppearanceControls, shared with the topbar toggle and the key guard) and
 * 一週從星期一開始.
 */
import { commonCopy } from "../../copy/common";
import { AppearanceControls } from "../../app/AppearanceControls";
import { Card } from "../../components/Card";
import { Switch } from "../../components/Field";
import type { AppSettingsState } from "./useAppSettings";

export function AppearanceTab({ app }: { app: AppSettingsState }) {
  const { APPEARANCE } = commonCopy();
  return (
    <div className="settings-stack">
      <Card className="settings-card">
        <AppearanceControls />
        <Switch
          label={APPEARANCE.weekStartsMonday}
          hint={APPEARANCE.weekStartsMondayHint}
          checked={app.settings?.weekStartsMonday ?? true}
          disabled={!app.settings}
          onChange={(on) => void app.save({ weekStartsMonday: on })}
        />
      </Card>
    </div>
  );
}
