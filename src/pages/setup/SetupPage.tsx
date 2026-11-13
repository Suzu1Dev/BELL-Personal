import { useEffect, useState, type ReactNode } from "react";
import type { WeatherLocation } from "../../../shared/weather";
import { PROFILE_ROLES, normalizeRoles, type ProfileRole } from "../../../shared/profile";
import type { AiConnectionMethod } from "../../../shared/ai-connections";
import { format, joinList, onboardingCopy, type OnboardingCopy } from "../../copy/onboarding";
import { AiConnect } from "../../components/ai-connect/AiConnect";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Switch } from "../../components/Field";
import { CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, CloudSun, ExternalLink, Flag, Flame, FolderKanban, GraduationCap, Github, Icon, Inbox, Info, Layers, Lightbulb, ListTodo, Mail, Sparkles, Sun, Ticket, UserRound } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Pill } from "../../components/Pill";
import { navigate, type RouteOf } from "../../lib/router";
import { useAppSettings } from "../../lib/app-settings";
import { useStatus } from "../../lib/status";
import { GoogleGuide } from "../settings/GoogleGuide";
import { LmsConnectForm, type LmsKind } from "../settings/LmsConnectForm";
import { useGoogleReturn } from "../settings/SettingsPage";
import { useGoogleStatus } from "../settings/SourcesTab";
import { OAUTH_START_SETUP, settingsApi } from "../settings/settings-api";
import { cardState, googleReturn } from "../settings/settings-view";
import { RoleCards } from "./RoleCards";
import { completionPatch, ctfTimeSwitchState } from "./setup-state";
import "./SetupPage.css";

type Step = 1 | 2 | 3 | 4;

export function setupCities(copy: OnboardingCopy): WeatherLocation[] {
  return [
    { name: copy.src.cities.taipei, latitude: 25.033, longitude: 121.5654, timezone: "Asia/Taipei" },
    { name: copy.src.cities.hsinchu, latitude: 24.8138, longitude: 120.9675, timezone: "Asia/Taipei" },
  ];
}

export function localizedCityName(location: WeatherLocation, copy: OnboardingCopy): string {
  return setupCities(copy).find(city => city.latitude === location.latitude && city.longitude === location.longitude)?.name ?? location.name;
}

export default function SetupPage(_props: { route: RouteOf<"setup"> }) {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const [step, setStep] = useState<Step>(() => (typeof window !== "undefined" && googleReturn(window.location.hash) ? 3 : 1));
  const [roles, setRoles] = useState<ProfileRole[]>([]);
  const [touched, setTouched] = useState(false);
  const [googleGuide, setGoogleGuide] = useState(false);
  const settings = app.settings;
  useGoogleReturn(() => setStep(3));

  useEffect(() => {
    if (settings && !touched) setRoles(normalizeRoles(settings["profile.roles"] ?? []));
  }, [settings, touched]);

  useEffect(() => {
    const title = document.querySelector<HTMLElement>(".ob-main h1, .result h1");
    if (title) {
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }, [step, googleGuide]);

  const changeRoles = (next: ProfileRole[]) => {
    const before = roles;
    setTouched(true);
    setRoles(next);
    void app.save({ "profile.roles": next }).then((ok) => { if (!ok) setRoles(before); });
  };

  const skipAll = async () => {
    const connections = await settingsApi.aiConnections().catch(() => undefined);
    const detected = connections?.connections.find((item) => item.method === connections.active && item.state === "detected")
      ?? connections?.connections.find((item) => item.state === "detected");
    const ok = await app.save({
      "profile.roles": roles,
      "ai.enabled": !!detected,
      "ai.connection": detected?.method ?? null,
      ...(settings ? completionPatch(settings) : {}),
    });
    if (ok) navigate("#/today");
  };

  const finish = async () => {
    if (await app.save({ "profile.roles": roles, ...(settings ? completionPatch(settings) : {}) })) setStep(4);
  };

  return (
    <div className="onboarding">
      <div className="ob-panel">
        <Top step={step} copy={copy} onSkip={() => void skipAll()} />
        {step === 1 ? <RoleStep roles={roles} onChange={changeRoles} onNext={() => setStep(2)} /> : null}
        {step === 2 ? <AiConnect onBack={() => setStep(1)} onSkip={() => setStep(3)} onNext={() => setStep(3)} /> : null}
        {step === 3 && !googleGuide ? <SourcesStep roles={roles} onBack={() => setStep(2)} onFinish={() => void finish()} onGoogle={() => setGoogleGuide(true)} /> : null}
        {step === 3 && googleGuide ? <GoogleStep onBack={() => setGoogleGuide(false)} onFinish={() => void finish()} /> : null}
        {step === 4 ? <DoneStep roles={roles} /> : null}
      </div>
    </div>
  );
}

function Top({ step, copy, onSkip }: { step: Step; copy: OnboardingCopy; onSkip: () => void }) {
  const keys = ["roles", "ai", "data"] as const;
  return (
    <header className="ob-top">
      <div className="ob-brand"><span className="brand-mark"><Icon icon={Sun} /></span><span className="brand-name">{copy.brand}</span>{step < 4 ? <span className="step-compact">{format(copy.stepOf, { n: step, label: copy.steps[keys[step - 1]] })}</span> : null}</div>
      {step < 4 ? <ol className="steps" aria-label={copy.a11y.progress}>{keys.map((key, index) => {
        const number = index + 1;
        return <li key={key} className={number < step ? "done" : undefined} aria-current={number === step ? "step" : undefined}><span className="n">{number < step ? <Icon icon={Check} /> : number}</span>{copy.steps[key]}</li>;
      })}</ol> : <span />}
      {step < 4 ? <Button variant="ghost" className="ob-skip" onClick={onSkip}>{copy.skip}</Button> : <span />}
    </header>
  );
}

function RoleStep({ roles, onChange, onNext }: { roles: ProfileRole[]; onChange: (roles: ProfileRole[]) => void; onNext: () => void }) {
  const copy = onboardingCopy();
  const items = previewItems(roles, copy);
  const added = items.filter((item) => item.by.length);
  const additions = added.length ? `${format(copy.role.addsLead, { items: joinList(added.map((item) => item.label), copy) })}${roles.includes("student") ? copy.role.addsCal : ""}` : copy.role.addsNone;
  return (
    <>
      <main className="ob-body"><div className="ob-grid"><div className="ob-main">
        <Head title={copy.role.title} lead={copy.role.lead} />
        <RoleCards roles={roles} onChange={onChange} />
        <p className="adds" aria-live="polite">{additions}</p>
        <p className="base-note"><Icon icon={Info} />{copy.role.base}</p>
      </div><aside className="preview" aria-label={copy.role.previewLabel}>
        <p className="preview-label">{copy.role.previewLabel}</p><div className="preview-box"><div className="pv-brand"><span className="brand-mark"><Icon icon={Sun} /></span>{copy.brand}</div>
        {items.map((item) => <div className={item.by.length ? "pv-row added" : "pv-row"} key={item.id}><Icon icon={item.icon} /><span>{item.label}</span>{item.by.length ? <span className="by">{joinList(item.by.map((role) => copy.roles[role].name), copy)}</span> : null}</div>)}
        <p className="pv-foot">{roles.includes("student") ? copy.role.previewCalendar : added.length ? "" : copy.role.previewNone}</p></div>
      </aside></div></main>
      <Footer copy={copy} right={<Button variant="primary" onClick={onNext}>{roles.length ? copy.next : copy.role.nextNone}</Button>} />
    </>
  );
}

function previewItems(roles: readonly ProfileRole[], copy: OnboardingCopy) {
  const work = roles.some((role) => role === "student" || role === "developer");
  return [
    { id: "today", label: copy.nav.today, icon: Sun, by: [] as ProfileRole[] },
    { id: "inbox", label: copy.nav.inbox, icon: Inbox, by: [] as ProfileRole[] },
    { id: "calendar", label: copy.nav.calendar, icon: CalendarDays, by: [] as ProfileRole[] },
    { id: "tasks", label: copy.nav.tasks, icon: ListTodo, by: [] as ProfileRole[] },
    ...(work ? [{ id: "work", label: roles.includes("student") ? copy.nav.workStudent : copy.nav.workDev, icon: FolderKanban, by: PROFILE_ROLES.filter((role) => role !== "ctf" && roles.includes(role)) }] : []),
    ...(roles.includes("ctf") ? [{ id: "events", label: copy.nav.events, icon: Ticket, by: ["ctf" as ProfileRole] }] : []),
    { id: "ideas", label: copy.nav.ideas, icon: Lightbulb, by: [] as ProfileRole[] },
    { id: "habits", label: copy.nav.habits, icon: Flame, by: [] as ProfileRole[] },
  ];
}

function SourcesStep({ roles, onBack, onFinish, onGoogle }: { roles: ProfileRole[]; onBack: () => void; onFinish: () => void; onGoogle: () => void }) {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const status = useStatus();
  const { google } = useGoogleStatus();
  const [school, setSchool] = useState<LmsKind | "later">("moodle");
  const schoolConnected = cardState(status.data?.sources, ["moodle", "canvas"]).configured;
  const city = app.settings?.["weather.location"];
  const groups: Array<{ id: string; label: string; rows: ReactNode }> = [];
  if (roles.includes("student")) groups.push({ id: "student", label: copy.src.groups.student, rows: <SourceRow icon={GraduationCap} title={copy.src.school.name} meta={copy.src.school.meta} body={schoolConnected ? <Pill tone="ok">{copy.ai.signedIn}</Pill> : school === "later" ? null : <div className="src-form"><LmsConnectForm key={school} className={school} labels={{ schoolId: copy.src.schoolId, password: copy.src.schoolPw, passwordHint: copy.src.schoolPwHint, submit: copy.src.connect, baseUrl: copy.src.canvasUrl, token: copy.src.canvasToken, tokenHint: copy.src.canvasTokenHint }} kind={school} onDone={() => setSchool("later")} onCancel={() => setSchool("later")} cancelLabel={copy.src.later} passwordHintOutside actionEnd={<TextLink href="#" accent onClick={(event) => { event.preventDefault(); setSchool(school === "moodle" ? "canvas" : "moodle"); }}>{school === "moodle" ? copy.src.canvas : copy.src.moodle}</TextLink>} /></div>} /> });
  if (roles.includes("developer")) groups.push({ id: "developer", label: copy.src.groups.developer, rows: <SourceRow icon={Github} title={copy.src.github.name} meta={copy.src.github.meta} end={status.data?.github.authenticated ? <Pill tone="ok">{format(copy.src.githubFound, { login: status.data.github.login ?? "GitHub" })}</Pill> : <Pill>{copy.settings.notSignedIn}</Pill>} /> });
  if (roles.includes("ctf")) groups.push({ id: "ctf", label: copy.src.groups.ctf, rows: <SourceRow icon={Flag} title={copy.src.ctf.name} meta={copy.src.ctf.meta} end={<Switch label={<span className="sr-only">{copy.src.ctf.name}</span>} {...ctfTimeSwitchState(app.settings)} onChange={(on) => void app.save({ "ctftime.enabled": on })} />} /> });
  const connectGoogle = () => {
    if (google?.vaultEnabled === false || google?.clientKind === "desktop" || google?.clientConfigured === false) onGoogle();
    else window.location.assign(OAUTH_START_SETUP);
  };
  groups.push({ id: "all", label: copy.src.groups.all, rows: <><SourceRow icon={Mail} title={copy.src.google.name} meta={copy.src.google.meta} end={google?.connected ? <Pill tone="ok">{copy.ai.signedIn}</Pill> : <span className="chips"><Button variant="secondary" icon={ExternalLink} onClick={connectGoogle}>{copy.src.googleStart}</Button><TextLink href="#" onClick={(event) => { event.preventDefault(); onGoogle(); }}>{copy.src.google.advanced}</TextLink></span>} /><SourceRow icon={CloudSun} title={copy.src.weather.name} meta={copy.src.weather.meta} end={<Switch label={<span className="sr-only">{copy.src.weather.name}</span>} checked={app.settings?.["weather.enabled"] ?? true} onChange={(on) => void app.save({ "weather.enabled": on })} />} body={<div className="chips" role="group" aria-label={copy.a11y.cities}>{setupCities(copy).map((location) => <Chip key={location.name} label={location.name} pressed={city ? localizedCityName(city, copy) === location.name : false} disabled={!app.settings?.["weather.enabled"]} onClick={() => void app.save({ "weather.location": location })} />)}<TextLink href="#/settings/sources">{copy.src.moreCities}</TextLink></div>} /></> });
  return (
    <>
      <main className="ob-body"><div className="ob-grid single"><div className="ob-main"><Head title={copy.src.title} lead={copy.src.lead} />{groups.map((group) => <section key={group.id}><p className="group-label">{group.label}</p><div className="group">{group.rows}</div></section>)}</div></div></main>
      <Footer copy={copy} onBack={onBack} right={<Button variant="primary" onClick={onFinish}>{copy.src.finish}</Button>} />
    </>
  );
}

function GoogleStep({ onBack, onFinish }: { onBack: () => void; onFinish: () => void }) {
  const copy = onboardingCopy();
  return <><main className="ob-body"><div className="setup-google"><Button variant="ghost" icon={ChevronLeft} onClick={onBack}>{copy.back}</Button><GoogleGuide /></div></main><Footer copy={copy} onBack={onBack} right={<Button variant="primary" onClick={onFinish}>{copy.src.finish}</Button>} /></>;
}

function DoneStep({ roles }: { roles: ProfileRole[] }) {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const status = useStatus();
  const { google } = useGoogleStatus();
  const active = app.settings?.["ai.connection"];
  const sourceNames = [
    ...(roles.includes("student") && cardState(status.data?.sources, ["moodle", "canvas"]).configured ? ["NYCU E3"] : []),
    ...(roles.includes("developer") && status.data?.github.authenticated ? ["GitHub"] : []),
    ...(app.settings?.["ctftime.enabled"] && roles.includes("ctf") ? [copy.src.ctf.name] : []),
    ...(app.settings?.["weather.enabled"] ? [format(copy.src.weatherCity, { city: localizedCityName(app.settings["weather.location"], copy) })] : []),
  ];
  const missing = google?.connected ? [] : [format(copy.done.notYet, { what: "Google" })];
  const roleText = roles.length ? joinList(roles.map((role) => copy.roles[role].name), copy) : "—";
  return (
    <>
      <main className="ob-body"><div className="ob-grid single"><div className="ob-main"><div className="result"><div className="result-mark"><Icon icon={Check} /></div><h1>{copy.done.title}</h1><p className="lead">{copy.done.lead}</p></div><div className="summary"><div className="group"><SummaryRow icon={UserRound} title={copy.done.rows.roles} meta={roleText} /><SummaryRow icon={Sparkles} title={copy.done.rows.ai} meta={active ? connectionName(active, copy) : copy.ai.skip} end={active ? <Pill tone="ok">{copy.ai.signedIn}</Pill> : undefined} /><SummaryRow icon={Layers} title={copy.done.rows.data} meta={[...sourceNames, ...missing].join(copy.listSep) || "—"} /></div>{roles.includes("student") ? <><p className="group-label">{copy.done.nextLabel}</p><div className="group"><a className="opt" href="#/calendar"><span className="ob-tile"><Icon icon={CalendarClock} /></span><span><span className="opt-title">{copy.done.tipTitle}</span><span className="opt-meta">{copy.done.tipMeta}</span></span><span className="opt-end"><Icon icon={ChevronRight} /></span></a></div></> : null}<p className="fine centered">{copy.done.change}</p></div></div></div></main>
      <Footer copy={copy} right={<Button variant="primary" href="#/today">{copy.done.go}</Button>} />
    </>
  );
}

function connectionName(method: AiConnectionMethod, copy: OnboardingCopy): string {
  if (method === "chatgpt") return copy.ai.chatgpt.name;
  if (method === "claude") return copy.ai.claude.name;
  return method === "openai-key" ? "OpenAI" : "Anthropic";
}

function SummaryRow({ icon, title, meta, end }: { icon: typeof UserRound; title: string; meta: string; end?: ReactNode }) {
  return <div className="opt"><span className="ob-tile"><Icon icon={icon} /></span><span><span className="opt-title">{title}</span><span className="opt-meta">{meta}</span></span>{end ? <span className="opt-end">{end}</span> : <span />}</div>;
}

function SourceRow({ icon, title, meta, end, body }: { icon: typeof GraduationCap; title: string; meta: string; end?: ReactNode; body?: ReactNode }) {
  return <div className="opt"><span className="ob-tile"><Icon icon={icon} /></span><span><span className="opt-title">{title}</span><span className="opt-meta">{meta}</span></span>{end ? <span className="opt-end">{end}</span> : <span />}{body ? <div className="opt-body">{body}</div> : null}</div>;
}

function Head({ title, lead }: { title: string; lead: string }) {
  return <div className="ob-head"><h1>{title}</h1><p className="lead">{lead}</p></div>;
}

function Footer({ copy, onBack, right }: { copy: OnboardingCopy; onBack?: () => void; right: ReactNode }) {
  return <footer className="ob-foot"><div className="ob-foot-inner">{onBack ? <Button variant="ghost" icon={ChevronLeft} aria-label={copy.back} onClick={onBack}><span className="back-label">{copy.back}</span></Button> : null}<span className="spacer" />{right}</div></footer>;
}
