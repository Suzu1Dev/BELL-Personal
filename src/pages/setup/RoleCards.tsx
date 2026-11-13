import { PROFILE_ROLES, type ProfileRole } from "../../../shared/profile";
import { onboardingCopy } from "../../copy/onboarding";
import { Check, CodeXml, Flag, GraduationCap, Icon } from "../../components/Icon";
import { cx } from "../../lib/cx";

const ICONS = { student: GraduationCap, developer: CodeXml, ctf: Flag } as const;

export function RoleCards({ roles, onChange, compact = false }: { roles: readonly ProfileRole[]; onChange: (roles: ProfileRole[]) => void; compact?: boolean }) {
  const copy = onboardingCopy();
  const toggle = (role: ProfileRole) => onChange(roles.includes(role) ? roles.filter((item) => item !== role) : PROFILE_ROLES.filter((item) => [...roles, role].includes(item)));
  return (
    <div className={cx("roles", compact && "compact")} role="group" aria-label={copy.a11y.roles}>
      {PROFILE_ROLES.map((role) => {
        const checked = roles.includes(role);
        return (
          <button key={role} type="button" className="role" role="checkbox" aria-checked={checked} onClick={() => toggle(role)}>
            <span className="ob-tile"><Icon icon={ICONS[role]} /></span>
            <span><span className="role-name">{copy.roles[role].name}</span>{compact ? null : <span className="role-gets">{copy.roles[role].gets}</span>}</span>
            <span className="check" aria-hidden="true"><Icon icon={Check} /></span>
          </button>
        );
      })}
    </div>
  );
}
