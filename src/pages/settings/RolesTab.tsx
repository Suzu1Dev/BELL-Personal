import { FEATURE_IDS, ROLE_FEATURES, isFeatureVisible, normalizeRoles, type FeatureId, type ProfileRole } from "../../../shared/profile";
import { joinList, onboardingCopy } from "../../copy/onboarding";
import { Icon, RotateCcw } from "../../components/Icon";
import { Switch } from "../../components/Field";
import { TextLink } from "../../components/Link";
import { useAppSettings } from "../../lib/app-settings";
import { RoleCards } from "../setup/RoleCards";

export function RolesTab() {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const roles = normalizeRoles(app.settings?.["profile.roles"] ?? []);
  const changeRoles = (next: ProfileRole[]) => void app.save({ "profile.roles": next });
  return (
    <div className="onboarding-settings settings-stack">
      <section className="settings-section">
        <SectionHead title={copy.settings.roles.title} hint={copy.settings.roles.hint} />
        <RoleCards roles={roles} onChange={changeRoles} compact />
      </section>
      <section className="settings-section">
        <SectionHead title={copy.settings.feats.title} hint={copy.settings.feats.hint} />
        <div className="group feat">
          {FEATURE_IDS.map((feature) => <FeatureRow key={feature} feature={feature} roles={roles} />)}
        </div>
        <p className="fine"><TextLink href="#/setup"><Icon icon={RotateCcw} />{copy.settings.rerun}</TextLink></p>
      </section>
    </div>
  );
}

function FeatureRow({ feature, roles }: { feature: FeatureId; roles: ProfileRole[] }) {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const visible = isFeatureVisible(feature, roles, app.overrides);
  const custom = app.overrides[feature] !== undefined;
  const content = copy.settings.features[feature];
  const tag = custom ? (app.overrides[feature] ? copy.settings.custom : copy.settings.customOff) : joinList(ROLE_FEATURES[feature].map((role) => copy.roles[role].name), copy);
  return (
    <div className="opt">
      <span><span className="opt-title">{content.name}<span className={custom ? "by-tag custom" : "by-tag"}>{tag}</span>{custom ? <button type="button" className="link restore" onClick={() => void app.saveOverride(feature, undefined)}>{copy.settings.restore}</button> : null}</span><span className="opt-meta">{content.meta}</span></span>
      <span className="opt-end"><Switch label={<span className="sr-only">{content.name}</span>} checked={visible} onChange={(on) => void app.saveOverride(feature, on)} /></span>
    </div>
  );
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return <div className="sec-head"><h2>{title}</h2><p className="hint">{hint}</p></div>;
}
