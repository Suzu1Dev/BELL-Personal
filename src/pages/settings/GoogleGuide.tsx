/**
 * #/settings/sources/google (SPEC-ux §3.4): the numbered checklist (ticks
 * kept in this browser), the redirect URI with 複製, the client ID and
 * secret (masked once saved), 連接 Google, the 「Google 不接受這個網址？」
 * paste fallback, and the connected state with the account, the granted
 * scopes and 中斷連線. Every step says why; no environment variable names.
 */
import { useState, type FormEvent } from "react";
import type { GoogleStatus } from "../../../shared/connect";
import { settingsCopy } from "../../copy/settings";
import { format } from "../../copy/onboarding";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { Checkbox } from "../../components/Checkbox";
import { Dialog } from "../../components/Dialog";
import { Field, TextInput, Textarea } from "../../components/Field";
import { ArrowRight, Check, Copy, Link2, Mail } from "lucide-react";
import { Icon } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { useToast } from "../../components/toast/ToastProvider";
import { cx } from "../../lib/cx";
import { useStatus } from "../../lib/status";
import { storedValue, useStoredValue } from "../../lib/storage";
import { OAUTH_START, OAUTH_START_PASTE, settingsApi } from "./settings-api";
import { checkGoogleClient, checkPasteUrl, type FieldErrors } from "./settings-forms";
import { syncPhrase } from "./settings-view";
import { missingCapabilities, useGoogleStatus } from "./SourcesTab";
import "./GoogleGuide.css";

/** Ticked steps, per browser (SPEC-ux §3.4 "persisted"). */
export const guideSteps = storedValue<string[]>(
  "bell-personal.google-guide.steps",
  (raw) => {
    try {
      const value: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  },
  (list) => (list.length ? JSON.stringify(list) : null),
);

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : settingsCopy().ERRORS.offline);
const origin = () => (typeof window === "undefined" ? "" : window.location.origin);

export function GoogleGuide() {
  const { GOOGLE_GUIDE, SETTINGS } = settingsCopy();
  const { google, error, reload, set } = useGoogleStatus();
  const done = useStoredValue(guideSteps);
  const toggle = (id: string, on: boolean) => guideSteps.set(on ? [...new Set([...done, id])] : done.filter((entry) => entry !== id));
  const steps = GOOGLE_GUIDE.steps;
  const finished = steps.filter((step) => done.includes(step.id)).length;

  return (
    <>
      <PageHead
        eyebrow=""
        title={GOOGLE_GUIDE.title}
        sub={GOOGLE_GUIDE.sub}
        actions={<Button variant="ghost" href="#/settings/sources">{GOOGLE_GUIDE.back}</Button>}
      />
      {error ? <Notice tone="error" title={SETTINGS.loadFailed} actions={<Button variant="secondary" size="sm" onClick={reload}>{SETTINGS.retry}</Button>}>{error}</Notice> : null}
      {google && !google.vaultEnabled ? (
        <Notice tone="warn" title={GOOGLE_GUIDE.vaultOffTitle} className="guide-notice">
          {GOOGLE_GUIDE.vaultOffBody}
        </Notice>
      ) : null}
      {google?.connected ? <ConnectedCard google={google} onChanged={reload} /> : <QuickConnectCard google={google} onSaved={set} />}
      <Card className="guide-advanced">
        <details open={google?.clientSource === "settings" || google?.clientConfigured === false}>
          <summary>{GOOGLE_GUIDE.advancedSummary}</summary>
          <div className="guide-layout guide-advanced-body">
            <Card className="guide-steps" aria-labelledby="guide-steps-title">
              <CardHead title={GOOGLE_GUIDE.stepsLabel} titleId="guide-steps-title" icon={Check} tone="ok">
                <span className="count">{GOOGLE_GUIDE.progress(finished, steps.length)}</span>
              </CardHead>
              <p className="guide-intro kp">{GOOGLE_GUIDE.intro}</p>
              <ol className="guide-list">
                {steps.map((step, index) => {
                  const ticked = done.includes(step.id);
                  return (
                    <li key={step.id} className={cx("guide-step", ticked && "is-done")}>
                      <Checkbox checked={ticked} onChange={(on) => toggle(step.id, on)} ariaLabel={GOOGLE_GUIDE.stepDone(step.title)} />
                      <div className="guide-step-body">
                        <h3><span className="mono">{index + 1}</span>{step.title}</h3>
                        <p className="kp">{step.why}</p>
                        {"link" in step && step.link ? <TextLink href={step.link.href} external>{step.link.label}</TextLink> : null}
                        {step.id === "consent" ? (
                          <div className="guide-urls">
                            <CopyField label={GOOGLE_GUIDE.homeUrl} value={`${origin()}/`} />
                            <CopyField label={GOOGLE_GUIDE.privacyUrl} value={`${origin()}/privacy`} />
                          </div>
                        ) : null}
                        {step.id === "redirect" && google ? <CopyField label={GOOGLE_GUIDE.redirectLabel} value={google.redirectUri} /> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
            <div className="guide-side">
              <ClientCard google={google} onSaved={set} />
              <FallbackCard google={google} onSaved={set} onConnected={reload} />
            </div>
          </div>
        </details>
      </Card>
    </>
  );
}

function QuickConnectCard({ google, onSaved }: { google: GoogleStatus | undefined; onSaved: (status: GoogleStatus) => void }) {
  const { GOOGLE_GUIDE, ERRORS } = settingsCopy();
  const toast = useToast();
  const [resetting, setResetting] = useState(false);
  const custom = google?.clientSource === "settings";
  const vaultEnabled = google?.vaultEnabled ?? true;
  const canDirectConnect = vaultEnabled && google?.clientKind !== "desktop" && google?.clientConfigured !== false;

  const resetBuiltin = async () => {
    setResetting(true);
    try {
      onSaved(await settingsApi.clearGoogleClient());
      toast.success(GOOGLE_GUIDE.clientReset);
    } catch (cause) {
      toast.error(ERRORS.actionFailed(GOOGLE_GUIDE.resetBuiltin, reasonOf(cause)));
    } finally {
      setResetting(false);
    }
  };

  return (
    <Card className="guide-quick" aria-labelledby="guide-quick-title">
      <CardHead title={GOOGLE_GUIDE.quickTitle} titleId="guide-quick-title" icon={Mail} tone="mail" />
      <p className="kp guide-quick-body">{GOOGLE_GUIDE.quickBody}</p>
      <p className="kp guide-quick-scopes">{GOOGLE_GUIDE.quickScopes}</p>
      {custom && google?.clientIdHint ? (
        <p className="guide-note kp"><Icon icon={Check} size="sm" />{GOOGLE_GUIDE.clientSavedHint(google.clientIdHint)}</p>
      ) : null}
      <div className="sc-form-acts guide-quick-acts">
        <Button variant="primary" icon={ArrowRight} disabled={!canDirectConnect} onClick={() => window.location.assign(OAUTH_START)}>
          {GOOGLE_GUIDE.connect}
        </Button>
        {custom ? (
          <Button variant="ghost" size="sm" disabled={resetting} onClick={() => void resetBuiltin()}>
            {GOOGLE_GUIDE.resetBuiltin}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** A mono read-only field with 複製 (the redirect URI, the home and privacy URLs). */
export function CopyField({ label, value }: { label: string; value: string }) {
  const { GOOGLE_GUIDE } = settingsCopy();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      toast.error(GOOGLE_GUIDE.copyFailed);
    }
  };
  return (
    <div className="copy-row">
      <Field label={label} className="copy-field">
        <TextInput readOnly value={value} className="mono" onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <Button variant="secondary" size="sm" icon={copied ? Check : Copy} onClick={() => void copy()} aria-label={format(GOOGLE_GUIDE.copyAria, { label })}>
        {copied ? GOOGLE_GUIDE.copied : GOOGLE_GUIDE.copy}
      </Button>
    </div>
  );
}

function ClientForm({ kind, submitLabel, onSaved }: { kind: "web" | "desktop"; submitLabel: string; onSaved: (status: GoogleStatus) => void }) {
  const { GOOGLE_GUIDE, ERRORS } = settingsCopy();
  const toast = useToast();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"clientId" | "clientSecret">>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const checked = checkGoogleClient({ clientId, clientSecret }, kind);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      onSaved(await settingsApi.saveGoogleClient(checked.value));
      setClientSecret("");
      toast.success(GOOGLE_GUIDE.clientSaved);
    } catch (cause) {
      toast.error(ERRORS.actionFailed(submitLabel, reasonOf(cause)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="sc-form" onSubmit={submit} noValidate>
      <Field label={GOOGLE_GUIDE.clientId} error={errors.clientId}>
        <TextInput className="mono" autoComplete="off" spellCheck={false} placeholder={GOOGLE_GUIDE.clientIdPlaceholder} value={clientId} onChange={(event) => setClientId(event.target.value)} />
      </Field>
      <Field label={GOOGLE_GUIDE.clientSecret} error={errors.clientSecret}>
        <TextInput type="password" autoComplete="off" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
      </Field>
      <div className="sc-form-acts">
        <Button variant="secondary" type="submit" disabled={busy}>{submitLabel}</Button>
      </div>
    </form>
  );
}

function ClientCard({ google, onSaved }: { google: GoogleStatus | undefined; onSaved: (status: GoogleStatus) => void }) {
  const { GOOGLE_GUIDE } = settingsCopy();
  const [replacing, setReplacing] = useState(false);
  const fromServer = google?.clientSource === "env";
  const fromBuiltin = google?.clientSource === "builtin";
  const saved = google?.clientSource === "settings" && google.clientKind === "web" && !replacing;
  const canConnect = !!google?.clientConfigured && google.clientKind !== "desktop" && google.vaultEnabled;
  return (
    <Card className="guide-client" aria-labelledby="guide-client-title">
      <CardHead title={GOOGLE_GUIDE.clientTitle} titleId="guide-client-title" icon={Link2} tone="mail" />
      {fromServer ? (
        <p className="guide-note kp">{GOOGLE_GUIDE.clientFromServer}{google?.clientIdHint ? ` ${GOOGLE_GUIDE.clientSavedHint(google.clientIdHint)}` : ""}</p>
      ) : fromBuiltin && !replacing ? (
        <div className="guide-saved">
          <p className="guide-note kp"><Icon icon={Check} size="sm" />{GOOGLE_GUIDE.clientBuiltin}</p>
          <Button variant="ghost" size="sm" disabled={google?.connected} onClick={() => setReplacing(true)}>{GOOGLE_GUIDE.replaceClient}</Button>
        </div>
      ) : saved ? (
        <div className="guide-saved">
          <p className="guide-note kp"><Icon icon={Check} size="sm" />{GOOGLE_GUIDE.clientSavedHint(google?.clientIdHint ?? "")}</p>
          <Button variant="ghost" size="sm" disabled={google?.connected} onClick={() => setReplacing(true)}>{GOOGLE_GUIDE.replaceClient}</Button>
        </div>
      ) : (
        <ClientForm kind="web" submitLabel={GOOGLE_GUIDE.saveClient} onSaved={(status) => { setReplacing(false); onSaved(status); }} />
      )}
      <div className="guide-connect">
        <p className="kp">{canConnect ? GOOGLE_GUIDE.connectHint : GOOGLE_GUIDE.needClient}</p>
        <Button variant="primary" icon={ArrowRight} disabled={!canConnect || google?.connected} onClick={() => window.location.assign(OAUTH_START)}>
          {GOOGLE_GUIDE.connect}
        </Button>
      </div>
    </Card>
  );
}

function FallbackCard({ google, onSaved, onConnected }: { google: GoogleStatus | undefined; onSaved: (status: GoogleStatus) => void; onConnected: () => void }) {
  const { GOOGLE_GUIDE, SOURCES, ERRORS } = settingsCopy();
  const toast = useToast();
  const status = useStatus();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const desktop = google?.clientKind === "desktop" && google.clientSource !== "env";

  const paste = async (event: FormEvent) => {
    event.preventDefault();
    const checked = checkPasteUrl(url);
    if (!checked.ok) {
      setError(checked.errors.url);
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const result = await settingsApi.pasteGoogle(checked.value.url);
      setUrl("");
      toast.success(result.email ? `${SOURCES.google.connected} · ${result.email}` : SOURCES.google.connected);
      settingsApi.sync(["gmail", "google-calendar"]).catch(() => {});
      onConnected();
      void status.refresh();
    } catch (cause) {
      toast.error(ERRORS.actionFailed(GOOGLE_GUIDE.pasteSubmit, reasonOf(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="guide-fallback">
      <details open={desktop}>
        <summary>{GOOGLE_GUIDE.fallbackSummary}</summary>
        <p className="guide-note kp">{GOOGLE_GUIDE.fallbackIntro}</p>
        <ol className="guide-fallback-steps">
          {GOOGLE_GUIDE.fallbackSteps.map((step) => <li key={step} className="kp">{step}</li>)}
        </ol>
        {desktop ? null : <ClientForm kind="desktop" submitLabel={GOOGLE_GUIDE.saveDesktopClient} onSaved={onSaved} />}
        <div className="sc-form-acts guide-paste-start">
          <Button
            variant="secondary"
            disabled={!desktop || google?.connected}
            onClick={() => window.open(OAUTH_START_PASTE, "_blank", "noopener")}
          >
            {GOOGLE_GUIDE.pasteStart}
          </Button>
        </div>
        <form className="sc-form" onSubmit={paste} noValidate>
          <Field label={GOOGLE_GUIDE.pasteLabel} error={error}>
            <Textarea className="mono" rows={3} spellCheck={false} placeholder={GOOGLE_GUIDE.pastePlaceholder} value={url} onChange={(event) => setUrl(event.target.value)} />
          </Field>
          <div className="sc-form-acts">
            <Button variant="primary" type="submit" disabled={busy || !desktop || google?.connected}>{GOOGLE_GUIDE.pasteSubmit}</Button>
          </div>
        </form>
      </details>
    </Card>
  );
}

function ConnectedCard({ google, onChanged }: { google: GoogleStatus; onChanged: () => void }) {
  const { GOOGLE_GUIDE, SETTINGS, SOURCES, ERRORS, listSep } = settingsCopy();
  const toast = useToast();
  const status = useStatus();
  const [confirm, setConfirm] = useState(false);
  const missing = missingCapabilities(google, SOURCES.google.scopes);
  const disconnect = () => {
    settingsApi.disconnectGoogle()
      .then((result) => {
        toast.success(result.revoked ? SOURCES.google.disconnected : SOURCES.google.disconnectedLocal);
        onChanged();
        void status.refresh();
      })
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(SETTINGS.disconnect, reasonOf(cause))));
  };
  return (
    <Card className="guide-connected" aria-labelledby="guide-connected-title">
      <CardHead title={GOOGLE_GUIDE.connectedTitle} titleId="guide-connected-title" icon={Mail} tone="ok" />
      <p className="guide-account">
        <b>{google.email ? GOOGLE_GUIDE.connectedAs(google.email) : SOURCES.google.connected}</b>
        {google.connectedAt ? <span>{GOOGLE_GUIDE.connectedAt(syncPhrase(google.connectedAt))}</span> : null}
      </p>
      <dl className="guide-scopes">
        <dt>{GOOGLE_GUIDE.grantedLabel}</dt>
        <dd>{google.grantedScopes.map((scope) => GOOGLE_GUIDE.scopeNames[scope] ?? scope).join(listSep)}</dd>
        {missing.length ? (
          <>
            <dt>{GOOGLE_GUIDE.missingLabel}</dt>
            <dd>{missing.join(listSep)}</dd>
          </>
        ) : null}
      </dl>
      <div className="sc-form-acts">
        <Button variant="ghost" onClick={() => setConfirm(true)}>{SETTINGS.disconnect}</Button>
        <Button variant="secondary" href="#/settings/sources">{GOOGLE_GUIDE.back}</Button>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={SOURCES.google.disconnectTitle}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{SOURCES.google.disconnectKeep}</Button>
            <Button variant="danger" onClick={() => { setConfirm(false); disconnect(); }}>{SOURCES.google.disconnectConfirm}</Button>
          </>
        )}
      >
        <p className="kp">{SOURCES.google.disconnectBody}</p>
      </Dialog>
    </Card>
  );
}
