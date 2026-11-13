import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type MouseEvent, type RefObject } from "react";
import {
  AI_KEY_METHOD,
  type AiConnection,
  type AiConnectionMethod,
  type AiConnectionsResponse,
  type AiKeyProvider,
  type AiLoginMethod,
  type AiLoginPrompt,
} from "../../../shared/ai-connections";
import { ApiError } from "../../api";
import { format, onboardingCopy, type OnboardingCopy } from "../../copy/onboarding";
import { useAppSettings } from "../../lib/app-settings";
import { useStatus } from "../../lib/status";
import { Button } from "../Button";
import { Field, TextInput } from "../Field";
import { Icon, Check, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Copy, ExternalLink, Eye, Info, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, UserRound } from "../Icon";
import { keyErrorForStatus, loginFailureKind, shouldClearKey, type KeyError } from "./ai-connect-model";
import { Notice } from "../Notice";
import { Pill } from "../Pill";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton } from "../Skeleton";
import { settingsApi } from "../../pages/settings/settings-api";
import "./AiConnect.css";

type View = "choose" | "login" | "key" | "done";

interface AiConnectProps {
  variant?: "onboarding" | "dialog";
  initialMethod?: AiLoginMethod | AiKeyProvider;
  onBack?: () => void;
  onSkip?: () => void;
  onNext?: () => void;
  onClose?: () => void;
}

const LOGIN_METHODS: readonly AiLoginMethod[] = ["chatgpt", "claude"];
const KEY_PROVIDERS: readonly AiKeyProvider[] = ["openai", "anthropic"];

function providerName(provider: AiKeyProvider): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function methodName(method: AiConnectionMethod, copy: OnboardingCopy): string {
  if (method === "chatgpt") return copy.ai.chatgpt.name;
  if (method === "claude") return copy.ai.claude.name;
  return providerName(method === "openai-key" ? "openai" : "anthropic");
}

function accountLine(method: AiConnectionMethod, copy: OnboardingCopy, source?: AiConnection["source"]): string {
  if (method === "chatgpt") return `${copy.ai.signedIn} · ${copy.settings.viaCodex}`;
  if (method === "claude") return `${copy.ai.signedIn} · ${copy.settings.viaClaude}`;
  const provider = method === "openai-key" ? "openai" : "anthropic";
  const via = source === "cli" ? (method === "openai-key" ? copy.settings.viaCodex : copy.settings.viaClaude) : providerName(provider);
  return `${copy.ai.signedIn} · ${via}`;
}

export function claudePasteFlowVisible(connection: AiConnection | undefined, prompt: AiLoginPrompt | undefined): boolean {
  const failure = loginFailureKind(connection, prompt);
  return failure === undefined || failure === "code_rejected";
}

export function claudeSubmitVisible(connection: AiConnection | undefined, prompt: AiLoginPrompt | undefined): boolean {
  return loginFailureKind(connection, prompt) === undefined;
}

export function shouldFocusLoginFailure(previous: ReturnType<typeof loginFailureKind>, current: ReturnType<typeof loginFailureKind>, busy: boolean): boolean {
  return !busy && current !== undefined && previous === undefined;
}

export function AiConnect({ variant = "onboarding", initialMethod, onBack, onSkip, onNext, onClose }: AiConnectProps) {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const status = useStatus();
  const [data, setData] = useState<AiConnectionsResponse>();
  const [view, setView] = useState<View>(initialMethod ? initialMethod === "chatgpt" || initialMethod === "claude" ? "login" : "key" : "choose");
  const [loginMethod, setLoginMethod] = useState<AiLoginMethod>(initialMethod === "claude" ? "claude" : "chatgpt");
  const [keyProvider, setKeyProvider] = useState<AiKeyProvider>(initialMethod === "anthropic" ? "anthropic" : "openai");
  const [hasKey, setHasKey] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const [showKey, setShowKey] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyError, setKeyError] = useState<KeyError>(null);
  const [lastPrompt, setLastPrompt] = useState<AiLoginPrompt>();
  const [loadError, setLoadError] = useState(false);
  const currentView = useRef(view);
  const currentLogin = useRef(loginMethod);
  const viewHeading = useRef<HTMLHeadingElement>(null);
  currentView.current = view;
  currentLogin.current = loginMethod;
  useEffect(() => {
    if (view === "key" || view === "done") viewHeading.current?.focus({ preventScroll: true });
  }, [view]);

  const clearKey = useCallback(() => {
    if (keyInput.current) keyInput.current.value = "";
    setHasKey(false);
  }, []);
  useEffect(() => () => {
    if (keyInput.current) keyInput.current.value = "";
  }, []);

  const selected = data?.connections.find((item) => item.method === (view === "key" ? AI_KEY_METHOD[keyProvider] : loginMethod));
  const loginPrompt = selected?.prompt ?? lastPrompt;
  const pasteFlowVisible = claudePasteFlowVisible(selected, loginPrompt);
  const activeStatus = status.data?.ai.connection;
  const selectedReason = activeStatus && selected && activeStatus.method === selected.method && !activeStatus.ready ? activeStatus.reason : selected?.reason;
  const vaultDisabled = selectedReason === "vault_disabled" || data?.vault.enabled === false;
  useEffect(() => {
    if (view === "login" && loginMethod === "claude" && !pasteFlowVisible) setCode("");
  }, [view, loginMethod, pasteFlowVisible]);
  const detected = useMemo(() => {
    if (!data) return undefined;
    const active = data.connections.find((item) => item.method === data.active && item.state === "detected");
    return active ?? data.connections.find((item) => LOGIN_METHODS.includes(item.method as AiLoginMethod) && item.state === "detected") ?? data.connections.find((item) => item.state === "detected");
  }, [data]);

  const refresh = useCallback(async () => {
    try {
      const next = await settingsApi.aiConnections();
      setData(next);
      setLoadError(false);
      const prompt = next.connections.find((item) => item.method === currentLogin.current)?.prompt;
      if (prompt) setLastPrompt(prompt);
      return next;
    } catch {
      setLoadError(true);
      return undefined;
    }
  }, []);

  useEffect(() => {
    void refresh().then(async (next) => {
      if (!next || !initialMethod) return;
      if (initialMethod === "chatgpt" || initialMethod === "claude") {
        const connection = next.connections.find((item) => item.method === initialMethod);
        if (connection?.state === "pending") setLastPrompt(connection.prompt);
        else if (connection?.state !== "detected") await startLogin(initialMethod);
      }
    });
    // The initial method is fixed for one mounted flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = useCallback(async (method: AiConnectionMethod) => {
    const ok = await app.save({ "ai.enabled": true, "ai.connection": method });
    if (!ok) return false;
    await refresh();
    void status.refresh();
    setView("done");
    return true;
  }, [app, refresh, status]);

  useEffect(() => {
    if (view !== "login" || selected?.state !== "detected") return;
    void finish(loginMethod);
  }, [view, selected?.state, loginMethod, finish]);

  useEffect(() => {
    if (view !== "login" || selected?.state !== "pending") return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [view, selected?.state, refresh]);

  const cancelLogin = useCallback(async () => {
    if (currentView.current !== "login") return;
    await settingsApi.cancelAiLogin(currentLogin.current).catch(() => undefined);
  }, []);

  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(leaveTimer.current);
    const onPageHide = () => {
      if (currentView.current !== "login") return;
      void fetch(`/api/ai/connections/${currentLogin.current}/login`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      leaveTimer.current = window.setTimeout(() => void cancelLogin(), 0);
    };
  }, [cancelLogin]);

  const startLogin = async (method: AiLoginMethod) => {
    setLoginMethod(method);
    setView("login");
    setLastPrompt(undefined);
    setCode("");
    setBusy(true);
    try {
      const connection = await settingsApi.startAiLogin(method);
      setLastPrompt(connection.prompt);
      await refresh();
    } catch {
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const backToChoices = async () => {
    await cancelLogin();
    clearKey();
    setView("choose");
    setKeyError(null);
    await refresh();
  };

  const skip = async () => {
    await cancelLogin();
    clearKey();
    if (await app.save({ "ai.enabled": false, "ai.connection": null })) onSkip?.();
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await settingsApi.submitClaudeCode(code);
      await finish("claude");
    } catch {
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const submitKey = async (event: FormEvent) => {
    event.preventDefault();
    const value = keyInput.current?.value ?? "";
    if (!value.trim() || vaultDisabled) return;
    setBusy(true);
    setKeyError(null);
    try {
      await settingsApi.saveAiKey(keyProvider, value);
      clearKey();
      await finish(AI_KEY_METHOD[keyProvider]);
    } catch (cause) {
      const error = keyErrorForStatus(cause instanceof ApiError ? cause.status : 0, cause instanceof ApiError ? cause.code : undefined, selectedReason);
      if (shouldClearKey(error)) {
        clearKey();
        if (error === "network") keyInput.current?.focus();
      }
      setKeyError(error);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (variant === "dialog") onClose?.();
    else onNext?.();
  };

  const main = view === "choose"
    ? <Choose copy={copy} data={data} detected={detected} loadError={loadError} onRetry={() => void refresh()} onLogin={(method) => void startLogin(method)} onKey={() => setView("key")} onUse={(method) => void finish(method)} />
    : view === "login"
      ? <LoginFlow copy={copy} method={loginMethod} connection={selected} prompt={loginPrompt} busy={busy} code={code} onCode={setCode} onSubmitCode={submitCode} onRetry={() => void startLogin(loginMethod)} onBack={() => void backToChoices()} onUseKey={() => void backToChoices().then(() => setView("key"))} />
      : view === "key"
        ? <KeyFlow copy={copy} provider={keyProvider} onProvider={(provider) => { clearKey(); setKeyProvider(provider); setKeyError(null); }} inputRef={keyInput} headingRef={viewHeading} onInput={(hasValue) => { setHasKey(hasValue); setKeyError(null); }} show={showKey} onShow={() => setShowKey((value) => !value)} busy={busy} error={keyError} vaultDisabled={vaultDisabled} onSubmit={submitKey} onBack={() => void backToChoices()} />
        : <Done copy={copy} method={data?.active ?? loginMethod} source={data?.connections.find((item) => item.method === data.active)?.source} headingRef={viewHeading} />;

  const submitButton = view === "login" && loginMethod === "claude" && loginPrompt?.kind === "paste_code" && claudeSubmitVisible(selected, loginPrompt)
    ? <Button variant="primary" type="submit" form="claude-code-form" disabled={busy || !code.trim()}>{busy ? copy.ai.login.checking : copy.ai.login.finish}</Button>
    : view === "key"
      ? <Button variant="primary" type="submit" form="api-key-form" className={busy ? "busy" : undefined} icon={busy ? LoaderCircle : undefined} disabled={busy || !hasKey || vaultDisabled}>{busy ? copy.ai.keyFlow.checking : copy.ai.keyFlow.submit}</Button>
      : null;

  if (variant === "dialog") {
    return <div className="ai-connect"><div className="ai-connect-dialog-body">{main}</div><div className="ai-connect-dialog-foot">{view === "done" ? <Button variant="primary" onClick={next}>{copy.next}</Button> : <><Button variant="ghost" onClick={onClose}>{copy.settings.removeKey.cancel}</Button>{submitButton}</>}</div></div>;
  }

  return (
    <>
      <main className="ob-body"><div className="ob-grid single"><div className="ob-main">{main}</div></div></main>
      <footer className="ob-foot"><div className="ob-foot-inner single">
        <Button variant="ghost" className="ob-back" icon={ChevronLeft} aria-label={copy.back} onClick={view === "choose" ? onBack : () => void backToChoices()}><span className="back-label">{copy.back}</span></Button>
        {view !== "done" ? <span className="note">{copy.ai.skipHint}</span> : null}
        <span className="spacer" />
        {view === "done" ? <Button variant="primary" onClick={next}>{copy.next}</Button> : (
          <span className="ob-foot-actions">
            <Button variant="ghost" onClick={() => void skip()}>{copy.ai.skip}</Button>
            {view === "choose" && detected ? <Button variant="primary" onClick={() => void finish(detected.method)}>{format(copy.ai.use, { name: methodName(detected.method, copy) })}</Button> : null}
            {submitButton}
          </span>
        )}
      </div></footer>
    </>
  );
}

export function Choose({ copy, data, detected, loadError, onRetry, onLogin, onKey, onUse }: {
  copy: OnboardingCopy;
  data: AiConnectionsResponse | undefined;
  detected: AiConnection | undefined;
  loadError: boolean;
  onRetry: () => void;
  onLogin: (method: AiLoginMethod) => void;
  onKey: () => void;
  onUse: (method: AiConnectionMethod) => void;
}) {
  if (!data && !loadError) return <><Head title={copy.ai.title} lead={copy.ai.lead} /><Skeleton className="ai-choice-skeleton" /></>;
  if (loadError) return <><Head title={copy.ai.title} lead={copy.ai.lead} /><Notice tone="error" title={copy.ai.errors.loadFailedTitle} actions={<Button variant="secondary" icon={RefreshCw} onClick={onRetry}>{copy.ai.errors.retry}</Button>}>{copy.ai.errors.networkBody}</Notice></>;
  const connections = data?.connections ?? [];
  const noCli = LOGIN_METHODS.every((method) => !connections.find((item) => item.method === method)?.installed);
  const method = (id: AiLoginMethod) => connections.find((item) => item.method === id);
  return (
    <>
      <Head title={copy.ai.title} lead={copy.ai.lead} />
      {detected ? <div className="found" role="status"><span className="ob-tile"><Icon icon={CircleCheck} /></span><div><p className="found-title">{format(copy.ai.found, { name: methodName(detected.method, copy) })}</p><p className="found-meta">{format(copy.ai.foundMeta, { account: accountLine(detected.method, copy, detected.source) })}</p><Button variant="secondary" className="found-use" onClick={() => onUse(detected.method)}>{format(copy.ai.use, { name: methodName(detected.method, copy) })}</Button></div></div> : null}
      {noCli ? <Notice tone="warn" title={copy.ai.errors.noAiTitle}>{copy.ai.errors.noAiBody}</Notice> : (
        <>
          <p className="group-label">{detected ? copy.ai.otherLabel : copy.ai.subLabel}</p>
          <div className="group">
            {LOGIN_METHODS.filter((id) => id !== detected?.method).map((id) => {
              const connection = method(id);
              const content = id === "chatgpt" ? copy.ai.chatgpt : copy.ai.claude;
              const unavailable = connection?.reason === "cli_not_installed";
              const meta = unavailable ? format(copy.ai.errors.notInstalled, { app: id === "chatgpt" ? "Codex" : "Claude Code" }) : connection?.state === "detected" ? accountLine(id, copy, connection?.source) : content.meta;
              return <Option key={id} icon={UserRound} title={content.name} meta={meta} signedIn={connection?.state === "detected"} onClick={() => onLogin(id)} />;
            })}
            {detected && data?.vault.enabled !== false ? <Option icon={KeyRound} title={copy.ai.key.name} meta={copy.ai.key.meta} onClick={onKey} /> : null}
          </div>
          {detected && data?.vault.enabled === false ? <Notice tone="warn" title={copy.ai.key.name}>{copy.settings.vaultDisabled}</Notice> : null}
        </>
      )}
      {!noCli && !detected ? <><p className="group-label">{copy.ai.keyLabel}</p>{data?.vault.enabled === false ? <Notice tone="warn" title={copy.ai.key.name}>{copy.settings.vaultDisabled}</Notice> : <div className="group"><Option icon={KeyRound} title={copy.ai.key.name} meta={copy.ai.key.meta} onClick={onKey} /></div>}</> : null}
      <p className="fine"><Icon icon={LockKeyhole} />{copy.ai.privacy}</p>
    </>
  );
}

export function LoginFlow({ copy, method, connection, prompt, busy, code, onCode, onSubmitCode, onRetry, onBack, onUseKey }: {
  copy: OnboardingCopy;
  method: AiLoginMethod;
  connection: AiConnection | undefined;
  prompt: AiLoginPrompt | undefined;
  busy: boolean;
  code: string;
  onCode: (value: string) => void;
  onSubmitCode: (event: FormEvent) => void;
  onRetry: () => void;
  onBack: () => void;
  onUseKey: () => void;
}) {
  const login = copy.ai.login;
  const title = method === "chatgpt" ? login.chatgptTitle : login.claudeTitle;
  const lead = method === "chatgpt" ? login.chatgptLead : login.claudeLead;
  const starting = busy || (connection?.state === "pending" && !prompt) || (!connection && !prompt);
  const failure = loginFailureKind(connection, prompt);
  const failed = failure !== undefined;
  const expired = failure === "timed_out";
  const unavailable = connection?.reason === "cli_not_installed";
  const denied = failure === "denied";
  const badCode = method === "claude" && failure === "code_rejected";
  const openDisabled = !prompt || expired || badCode;
  const provider = method === "chatgpt" ? copy.ai.chatgpt.name : copy.ai.claude.name;
  const failureTitle = denied ? copy.ai.errors.cancelledTitle : failure === "cli_error" ? copy.ai.errors.cliErrorTitle : copy.ai.errors.failedTitle;
  const failureBody = denied ? copy.ai.errors.cancelledBody : format(failure === "cli_error" ? copy.ai.errors.cliErrorBody : copy.ai.errors.failedBody, { provider });
  const promptExpired = expired && !!prompt && Date.parse(prompt.expiresAt) <= Date.now();
  const retryButton = useRef<HTMLButtonElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const retrying = useRef(false);
  const previousFailure = useRef(failure);
  useEffect(() => {
    if (shouldFocusLoginFailure(previousFailure.current, failure, busy)) retryButton.current?.focus({ preventScroll: true });
    if (!busy) previousFailure.current = failure;
  }, [failure, busy]);
  useEffect(() => {
    if (!retrying.current || starting || busy) return;
    retrying.current = false;
    if (!failed && method === "claude") codeInput.current?.focus({ preventScroll: true });
  }, [starting, busy, failed, method]);
  const retry = () => {
    if (retrying.current || busy) return;
    retrying.current = true;
    onRetry();
  };
  return (
    <>
      <BackLink copy={copy} onClick={onBack} />
      <Head title={title} lead={lead} />
      {unavailable ? <Notice tone="warn" title={format(copy.ai.errors.notInstalled, { app: method === "chatgpt" ? "Codex" : "Claude Code" })} actions={<Button variant="secondary" onClick={onUseKey}>{copy.ai.errors.useKeyInstead}</Button>}>{copy.ai.errors.notInstalledHint}</Notice> : null}
      {failed && !expired && !unavailable && !badCode ? <Notice tone="error" role="alert" title={failureTitle} actions={<Button ref={retryButton} variant="secondary" icon={RefreshCw} disabled={busy} onClick={retry}>{copy.ai.errors.retry}</Button>}>{failureBody}</Notice> : null}
      {expired ? <Notice tone="error" role="alert" title={promptExpired ? login.expiredTitle : copy.ai.errors.timedOutTitle} actions={<Button ref={retryButton} variant="secondary" icon={RefreshCw} disabled={busy} onClick={retry}>{promptExpired ? login.retry : copy.ai.errors.retry}</Button>}>{promptExpired ? login.expiredBody : copy.ai.errors.timedOutBody}</Notice> : null}
      <div className="flow" hidden={failed && !badCode}>
        <div className="flow-step"><span className="flow-n">{prompt ? <Icon icon={Check} /> : "1"}</span><div>
          <p className="flow-title">{method === "chatgpt" ? login.openChatgpt : login.openClaude}</p>
          <p className="flow-hint">{method === "chatgpt" ? login.openChatgptHint : login.openClaudeHint}</p>
          <div className="flow-act">{starting ? <Skeleton className="ai-button-skeleton" /> : <Button variant="secondary" icon={ExternalLink} href={prompt?.url ?? ""} external aria-disabled={openDisabled || undefined} onClick={(event: MouseEvent<HTMLAnchorElement>) => { if (openDisabled) event.preventDefault(); }}>{login.open}</Button>}</div>
        </div></div>
        {method === "chatgpt" ? (
          <div className="flow-step"><span className="flow-n">2</span><div>
            <p className="flow-title">{login.enterCode}</p><p className="flow-hint">{login.enterCodeHint}</p>
            <div className="flow-act">{starting ? <Skeleton className="ai-code-skeleton" /> : prompt?.kind === "device_code" ? <><span className={expired ? "code is-expired" : "code"}><b className="mono" aria-label={format(copy.a11y.code, { spelled: prompt.code.replace(/-/g, "").split("").join(" ") })}>{prompt.code}</b>{!expired ? <Button variant="icon" icon={Copy} aria-label={login.copy} title={login.copy} onClick={() => void navigator.clipboard?.writeText(prompt.kind === "device_code" ? prompt.code : "")} /> : null}</span>{expired ? <Pill tone="danger">{login.expired}</Pill> : null}</> : null}</div>
          </div></div>
        ) : (
          <form id="claude-code-form" onSubmit={onSubmitCode}><div className="flow-step"><span className="flow-n">2</span><div>
            <Field label={login.pasteCode} hint={badCode ? undefined : login.pasteCodeHint} error={badCode ? copy.ai.errors.pasteInvalid : undefined}>
              <TextInput ref={codeInput} className="mono" aria-label={copy.a11y.paste} placeholder={login.pastePlaceholder} autoComplete="off" value={code} disabled={busy || starting || expired || failed} onChange={(event) => onCode(event.target.value)} />
            </Field>
            {badCode ? <div className="flow-act"><Button ref={retryButton} variant="secondary" icon={RefreshCw} disabled={busy} onClick={retry}>{copy.ai.errors.retry}</Button></div> : null}
          </div></div></form>
        )}
        {(starting || (method === "chatgpt" && connection?.state === "pending" && !expired)) ? <div className="waiting" role="status" aria-live="polite"><Icon icon={LoaderCircle} className="spin" />{starting ? login.preparing : login.waiting}</div> : null}
      </div>
      {prompt?.kind === "device_code" && !expired ? <p className="fine"><Icon icon={Info} />{format(login.otherDevice, { url: new URL(prompt.url).host + new URL(prompt.url).pathname })}</p> : null}
    </>
  );
}

function KeyFlow({ copy, provider, onProvider, inputRef, headingRef, onInput, show, onShow, busy, error, vaultDisabled, onSubmit, onBack }: {
  copy: OnboardingCopy;
  provider: AiKeyProvider;
  onProvider: (provider: AiKeyProvider) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onInput: (hasValue: boolean) => void;
  show: boolean;
  onShow: () => void;
  busy: boolean;
  error: KeyError;
  vaultDisabled: boolean;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
}) {
  const name = providerName(provider);
  const keyCopy = copy.ai.keyFlow;
  const inputId = useId();
  const errorText = error === "network" ? format(copy.ai.errors.networkKey, { provider: name }) : error === "credit" ? format(copy.ai.errors.noCredit, { provider: name }) : error === "invalid" ? format(keyCopy.invalid, { provider: name }) : undefined;
  const errorId = errorText ? `${inputId}-error` : undefined;
  return (
    <>
      <BackLink copy={copy} onClick={onBack} />
      <Head title={keyCopy.title} lead={keyCopy.lead} headingRef={headingRef} />
      {vaultDisabled ? <Notice tone="warn" title={keyCopy.title}>{copy.settings.vaultDisabled}</Notice> : null}
      <SegmentedControl className="ai-provider-seg" label={copy.a11y.provider} options={KEY_PROVIDERS.map((id) => ({ value: id, label: providerName(id) }))} value={provider} onChange={onProvider} />
      <form id="api-key-form" className="key-form" onSubmit={onSubmit}>
        <div className={errorText ? "field has-error" : "field"}>
          <label htmlFor={inputId}>{format(keyCopy.label, { provider: name })}</label>
          <span className="input-wrap"><TextInput ref={inputRef} id={inputId} className="mono" type={show ? "text" : "password"} autoComplete="off" disabled={vaultDisabled} readOnly={busy} aria-invalid={errorText ? true : undefined} aria-describedby={errorId} onChange={(event) => onInput(!!event.currentTarget.value.trim())} /><Button variant="icon" icon={Eye} aria-label={keyCopy.show} title={keyCopy.show} disabled={vaultDisabled} onClick={onShow} /></span>
          {errorText ? <p className="field-error kp" id={errorId} role="alert"><Icon icon={CircleAlert} />{errorText}</p> : null}
        </div>
        <p className="hint key-hint"><a className="link" href={provider === "openai" ? "https://platform.openai.com/api-keys" : "https://console.anthropic.com/settings/keys"} target="_blank" rel="noopener noreferrer">{format(keyCopy.create, { provider: name })}<Icon icon={ExternalLink} /></a><span>{format(keyCopy.stored, { provider: name })}</span></p>
      </form>
    </>
  );
}

function Done({ copy, method, source, headingRef }: { copy: OnboardingCopy; method: AiConnectionMethod; source?: AiConnection["source"]; headingRef: RefObject<HTMLHeadingElement | null> }) {
  return <><div className="result" role="status"><div className="result-mark"><Icon icon={Check} /></div><h1 ref={headingRef} tabIndex={-1}>{format(copy.ai.done.title, { name: methodName(method, copy) })}</h1><p className="lead">{format(copy.ai.done.lead, { account: accountLine(method, copy, source) })}</p></div><p className="fine centered">{copy.ai.done.later}</p></>;
}

function Head({ title, lead, headingRef }: { title: string; lead?: string; headingRef?: RefObject<HTMLHeadingElement | null> }) {
  return <div className="ob-head"><h1 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h1>{lead ? <p className="lead">{lead}</p> : null}</div>;
}

function BackLink({ copy, onClick }: { copy: OnboardingCopy; onClick: () => void }) {
  return <Button variant="ghost" className="back-link" icon={ChevronLeft} onClick={onClick}>{copy.ai.otherWays}</Button>;
}

function Option({ icon, title, meta, onClick, disabled, signedIn }: { icon: typeof UserRound; title: string; meta: string; onClick: () => void; disabled?: boolean; signedIn?: boolean }) {
  return <button type="button" className="opt" disabled={disabled} onClick={onClick}><span className="ob-tile"><Icon icon={icon} /></span><span><span className="opt-title">{title}</span><span className="opt-meta">{meta}</span></span><span className="opt-end">{signedIn ? <Pill tone="ok">{onboardingCopy().ai.signedIn}</Pill> : <Icon icon={ChevronRight} />}</span></button>;
}
