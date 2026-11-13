import { GUIDE_SHARED, SHORTCUT_LABELS } from "../copy/guide";
import { SHORTCUTS, type ShortcutScope } from "../lib/shortcuts";
import { Keys } from "./Kbd";
import { useAppSettings } from "../lib/app-settings";
import { isSectionVisible } from "../../shared/profile";
import "./ShortcutList.css";

const SCOPES: ShortcutScope[] = ["everywhere", "list", "inbox", "habits", "toast"];

export function ShortcutList() {
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  const visible = (id: string) => id !== "goWork" && id !== "goEvents" || isSectionVisible(id === "goWork" ? "work" : "events", roles, app.overrides);
  return (
    <div className="shortcut-list">
      {SCOPES.map((scope) => (
        <section key={scope} aria-label={GUIDE_SHARED.help.scopes[scope]}>
          <h3>{GUIDE_SHARED.help.scopes[scope]}</h3>
          <dl>
            {SHORTCUTS.filter((item) => item.scope === scope && visible(item.id)).map((item) => (
              <div key={item.id}>
                <dt>
                  {item.keys.map((keys, index) => (
                    <span key={keys.join("+")} className="sc-keys">
                      {index > 0 ? <span className="sc-or">/</span> : null}
                      {keys.length === 2 && keys[0] === "G" ? <><Keys keys={["G"]} /><span className="sc-then">{GUIDE_SHARED.help.then}</span><Keys keys={[keys[1]]} /></> : <Keys keys={keys} />}
                    </span>
                  ))}
                </dt>
                <dd>{SHORTCUT_LABELS[item.id].label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
