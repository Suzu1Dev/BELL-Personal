import type { FeatureId } from "../../shared/profile";
import { onboardingCopy } from "../copy/onboarding";
import { useAppSettings } from "../lib/app-settings";
import { Button } from "./Button";
import { Notice } from "./Notice";

export function HiddenFeature({ feature }: { feature: FeatureId }) {
  const copy = onboardingCopy();
  const app = useAppSettings();
  return <Notice tone="warn" title={copy.hidden.title} actions={<Button variant="secondary" onClick={() => void app.saveOverride(feature, true)}>{copy.hidden.open}</Button>}>{copy.hidden.body}</Notice>;
}
