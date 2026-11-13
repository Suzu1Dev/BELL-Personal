import { useEffect } from "react";
import { AiTag } from "../../components/AiTag";
import { Card, CardHead } from "../../components/Card";
import { Keyboard, ShieldCheck } from "lucide-react";
import { Compass, Sparkles } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { PageHead } from "../../components/PageHead";
import { ShortcutList } from "../../components/ShortcutList";
import { GUIDE, GUIDE_PAGE_HEAD, GUIDE_SHARED } from "../../copy/guide";
import type { RouteOf } from "../../lib/router";
import "./GuidePage.css";

export default function GuidePage(_props: { route: RouteOf<"guide"> }) {
  useEffect(() => {
    if (window.location.hash.endsWith("#keys")) document.getElementById("keys")?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <>
      <PageHead eyebrow={GUIDE_PAGE_HEAD.eyebrow} title={GUIDE_PAGE_HEAD.title} sub={GUIDE_PAGE_HEAD.sub} />
      <div className="guide-page">
        <Card className="guide-card" aria-labelledby="guide-daily-title">
          <CardHead title={GUIDE.daily.title} titleId="guide-daily-title" icon={Compass} tone="accent" />
          <ol className="guide-flow">
            {GUIDE.daily.steps.map((step, index) => (
              <li key={step.title}>
                <span className="guide-n mono" aria-hidden="true">{index + 1}</span>
                <div>
                  <b>{step.title}</b>
                  <p className="kp">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="guide-card guide-keys" id="keys" aria-labelledby="guide-keys-title">
          <CardHead title={GUIDE.keys.title} titleId="guide-keys-title" icon={Keyboard} tone="info" link={{ href: "#/settings/appearance", label: GUIDE.keys.settings }} />
          <p className="guide-intro kp">{GUIDE_SHARED.help.intro}</p>
          <ShortcutList />
        </Card>

        <Card className="guide-card" aria-labelledby="guide-ai-title">
          <CardHead title={GUIDE.ai.title} titleId="guide-ai-title" icon={Sparkles} tone="accent" link={{ href: "#/settings/brief", label: GUIDE.ai.settings }} />
          <ul className="guide-points">
            {GUIDE.ai.points.map((point) => <li key={point} className="kp">{point}</li>)}
          </ul>
          <h3 className="guide-sub">{GUIDE.ai.tagsTitle}</h3>
          <dl className="guide-tags">
            <div><dt><AiTag kind="summary" /></dt><dd className="kp">{GUIDE.ai.tagAi}</dd></div>
            <div><dt><AiTag kind="rule" /></dt><dd className="kp">{GUIDE.ai.tagRule}</dd></div>
          </dl>
        </Card>

        <Card className="guide-card" aria-labelledby="guide-privacy-title">
          <CardHead title={GUIDE.privacy.title} titleId="guide-privacy-title" icon={ShieldCheck} tone="ok" link={{ href: "#/settings/privacy", label: GUIDE.privacy.settings }} />
          <ul className="guide-points">
            {GUIDE.privacy.points.map((point) => <li key={point} className="kp">{point}</li>)}
          </ul>
          <TextLink href="/privacy" external>{GUIDE.privacy.policy}</TextLink>
        </Card>
      </div>
    </>
  );
}
