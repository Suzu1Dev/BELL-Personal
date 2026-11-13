import { useState } from "react";
import { BRIEF_SETTINGS } from "../../copy/settings";
import { onboardingCopy } from "../../copy/onboarding";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field, Switch, TextInput } from "../../components/Field";
import { Notice } from "../../components/Notice";
import { checkTime } from "./settings-forms";
import type { AppSettingsState } from "./useAppSettings";

export function BriefTab({ app }: { app: AppSettingsState }) {
  const copy = onboardingCopy();
  const [time, setTime] = useState<string>();
  const [timeError, setTimeError] = useState<string>();
  const settings = app.settings;
  const ai = settings?.["ai.enabled"] ?? true;

  const commitTime = () => {
    if (time === undefined) return;
    const checked = checkTime(time);
    if (!checked.ok) {
      setTimeError(checked.errors.time);
      return;
    }
    setTimeError(undefined);
    if (checked.value !== settings?.["brief.autoTime"]) void app.save({ "brief.autoTime": checked.value }).then(() => setTime(undefined));
    else setTime(undefined);
  };

  return (
    <div className="settings-stack">
      <Notice title={copy.settings.briefLink} actions={<Button variant="secondary" size="sm" href="#/settings/ai">{copy.settings.tabs.ai}</Button>} />
      <Card className="settings-card" aria-label={BRIEF_SETTINGS.title}>
        <Switch label={BRIEF_SETTINGS.aiEnabled} hint={BRIEF_SETTINGS.aiEnabledHint} checked={ai} disabled={!settings} onChange={(on) => void app.save({ "ai.enabled": on })} />
        <fieldset className="settings-group" disabled={!ai || !settings}>
          <Field label={BRIEF_SETTINGS.autoTime} hint={BRIEF_SETTINGS.autoTimeHint} error={timeError} className="sc-short">
            <TextInput type="time" value={time ?? settings?.["brief.autoTime"] ?? ""} onChange={(event) => setTime(event.target.value)} onBlur={commitTime} />
          </Field>
          <Switch label={BRIEF_SETTINGS.onFirstOpen} hint={BRIEF_SETTINGS.onFirstOpenHint} checked={settings?.["brief.onFirstOpen"] ?? true} onChange={(on) => void app.save({ "brief.onFirstOpen": on })} />
          <Switch label={BRIEF_SETTINGS.mailTriage} hint={BRIEF_SETTINGS.mailTriageHint} checked={settings?.["ai.mailTriage"] ?? true} onChange={(on) => void app.save({ "ai.mailTriage": on })} />
          <Switch label={BRIEF_SETTINGS.captureTidy} hint={BRIEF_SETTINGS.captureTidyHint} checked={settings?.["ai.captureTidy"] ?? true} onChange={(on) => void app.save({ "ai.captureTidy": on })} />
          <Switch label={BRIEF_SETTINGS.ideaTags} hint={BRIEF_SETTINGS.ideaTagsHint} checked={settings?.["ai.ideaTags"] ?? false} onChange={(on) => void app.save({ "ai.ideaTags": on })} />
        </fieldset>
      </Card>
    </div>
  );
}
