/**
 * The school connect form (SPEC-ux §3.4 step 2, 帳號與來源 cards): Moodle
 * takes the site, 學號 and 密碼 (the password is exchanged once for a token
 * and never stored); Canvas takes the site and a personal access token.
 * Used on the source cards and in #/setup.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ERRORS } from "../../copy/common";
import { SETTINGS, SOURCES } from "../../copy/settings";
import { Button } from "../../components/Button";
import { Field, TextInput } from "../../components/Field";
import { useToast } from "../../components/toast/ToastProvider";
import { useStatus } from "../../lib/status";
import { settingsApi } from "./settings-api";
import { DEFAULT_MOODLE_URL, checkCanvas, checkMoodle, type FieldErrors } from "./settings-forms";

export type LmsKind = "moodle" | "canvas";

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

export interface LmsConnectFormProps {
  kind: LmsKind;
  /** After a successful connect. */
  onDone: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
  /** Focus the site field on mount (the form replaced the button that opened it). */
  autoFocus?: boolean;
  className?: string;
  labels?: { schoolId: string; passwordHint: string; password?: string; submit?: string; baseUrl?: string; token?: string; tokenHint?: string };
  actionEnd?: ReactNode;
  passwordHintOutside?: boolean;
}

export function LmsConnectForm({ kind, onDone, onCancel, cancelLabel = SETTINGS.cancel, autoFocus, className, labels, actionEnd, passwordHintOutside }: LmsConnectFormProps) {
  const copy = kind === "moodle" ? {
    ...SOURCES.moodle,
    username: labels?.schoolId ?? SOURCES.moodle.username,
    submit: labels?.submit ?? SOURCES.moodle.submit,
  } : {
    ...SOURCES.canvas,
    baseUrl: labels?.baseUrl ?? SOURCES.canvas.baseUrl,
    submit: labels?.submit ?? SOURCES.canvas.submit,
  };
  const toast = useToast();
  const status = useStatus();
  const [busy, setBusy] = useState(false);
  const [baseUrl, setBaseUrl] = useState(kind === "moodle" ? DEFAULT_MOODLE_URL : "https://");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"baseUrl" | "username" | "password" | "token">>({});
  const siteRef = useRef<HTMLInputElement>(null);
  const passwordHintId = useId();
  useEffect(() => {
    if (autoFocus) siteRef.current?.focus();
    // Only when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Validates, then sends the credentials once; undefined when a field needs fixing. */
  const connect = () => {
    if (kind === "moodle") {
      const checked = checkMoodle({ baseUrl, username, password: secret });
      if (!checked.ok) return void setErrors(checked.errors);
      return settingsApi.connectMoodle(checked.value);
    }
    const checked = checkCanvas({ baseUrl, token: secret });
    if (!checked.ok) return void setErrors(checked.errors);
    return settingsApi.connectCanvas(checked.value);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    const request = connect();
    if (!request) return;
    setBusy(true);
    try {
      const response = await request;
      toast.success(copy.connected(response.account.name ?? response.account.username ?? ""));
      setSecret("");
      onDone();
      void status.refresh();
    } catch (cause) {
      toast.error(ERRORS.actionFailed(copy.connect, reasonOf(cause)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={className ? `sc-form ${className}` : "sc-form"} onSubmit={submit} noValidate>
      <Field label={copy.baseUrl} error={errors.baseUrl}>
        <TextInput ref={siteRef} type="url" inputMode="url" autoComplete="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
      </Field>
      {kind === "moodle" ? (
        <>
          <Field label={labels?.schoolId ?? SOURCES.moodle.username} error={errors.username}>
            <TextInput autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <Field label={labels?.password ?? SOURCES.moodle.password} hint={passwordHintOutside ? undefined : labels?.passwordHint ?? SOURCES.moodle.passwordHint} error={errors.password}>
            <TextInput type="password" autoComplete="current-password" aria-describedby={passwordHintOutside ? passwordHintId : undefined} value={secret} onChange={(event) => setSecret(event.target.value)} />
          </Field>
          {passwordHintOutside ? <p className="field-hint sc-form-hint" id={passwordHintId}>{labels?.passwordHint ?? SOURCES.moodle.passwordHint}</p> : null}
        </>
      ) : (
        <Field label={labels?.token ?? SOURCES.canvas.token} hint={labels?.tokenHint ?? SOURCES.canvas.tokenHint} error={errors.token}>
          <TextInput type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </Field>
      )}
      <div className="sc-form-acts">
        <Button variant="primary" type="submit" disabled={busy}>{copy.submit}</Button>
        {onCancel ? <Button variant="ghost" onClick={() => { setErrors({}); setSecret(""); onCancel(); }}>{cancelLabel}</Button> : null}
        {actionEnd ? <span className="sc-form-act-end">{actionEnd}</span> : null}
      </div>
    </form>
  );
}
