/**
 * 連線與設定 › 資料與隱私 (SPEC-ux §3.3, SPEC-mail-html §6): 信件顯示 (預設顯示方式,
 * 信任的寄件者), mail retention, 清除快取的信件 (confirmed: it cannot be
 * undone), 匯出資料 (GET /api/export, never the vault) and the privacy policy.
 */
import { useRef, useState, type FormEvent } from "react";
import type { MailBodyView } from "../../../shared/mail";
import { ERRORS } from "../../copy/common";
import { MAIL_DISPLAY_SETTINGS, PRIVACY_SETTINGS } from "../../copy/settings";
import { SegmentedControl } from "../../components/SegmentedControl";
import { mailViewStore } from "../../lib/preferences";
import { forgetMailBodies } from "../inbox/useMailBody";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Checkbox } from "../../components/Checkbox";
import { Dialog } from "../../components/Dialog";
import { Field, TextInput } from "../../components/Field";
import { Download, Plus, Trash2 } from "lucide-react";
import { TextLink } from "../../components/Link";
import { useToast } from "../../components/toast/ToastProvider";
import { settingsApi } from "./settings-api";
import { checkRetention, checkTrustedSender } from "./settings-forms";
import type { AppSettingsState } from "./useAppSettings";

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

/** 信件顯示: the reader's default view and the senders whose remote images load without asking. */
export function MailDisplayCard({ app }: { app: AppSettingsState }) {
  const toast = useToast();
  const [entry, setEntry] = useState("");
  const [entryError, setEntryError] = useState<string>();
  const listRef = useRef<HTMLUListElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const view = app.settings?.["mail.bodyView"];
  const trusted = app.settings?.["mail.trustedImageSenders"] ?? [];

  const chooseView = (next: MailBodyView) => {
    void app.save({ "mail.bodyView": next }).then((saved) => { if (saved) mailViewStore.set(next); });
  };
  const saveList = (next: string[]) => app.save({ "mail.trustedImageSenders": next }).then((saved) => {
    if (saved) forgetMailBodies();
    return saved;
  });

  const add = (event: FormEvent) => {
    event.preventDefault();
    const checked = checkTrustedSender(entry, trusted);
    if (!checked.ok) {
      setEntryError(checked.errors.entry);
      inputRef.current?.focus();
      return;
    }
    setEntryError(undefined);
    void saveList([...trusted, checked.value]).then((saved) => {
      if (!saved) return;
      setEntry("");
      toast.success(MAIL_DISPLAY_SETTINGS.added(checked.value));
    });
  };

  const remove = (item: string) => {
    const before = trusted;
    const index = before.indexOf(item);
    // Focus goes to the next entry's 移除 (or the field), never to <body>.
    const next = before[index + 1] ?? before[index - 1];
    void saveList(before.filter((value) => value !== item)).then((saved) => {
      if (!saved) return;
      const target = next ? listRef.current?.querySelector<HTMLButtonElement>(`[data-entry="${CSS.escape(next)}"]`) : null;
      (target ?? inputRef.current)?.focus();
      toast.undo(MAIL_DISPLAY_SETTINGS.removed(item), () => { void saveList(before); });
    });
  };

  return (
    <Card className="settings-card" aria-label={MAIL_DISPLAY_SETTINGS.title}>
      <div className="settings-action">
        <div>
          <span className="settings-label">{MAIL_DISPLAY_SETTINGS.bodyView}</span>
          <p className="field-hint kp">{MAIL_DISPLAY_SETTINGS.bodyViewHint}</p>
        </div>
        {view ? (
          <SegmentedControl
            label={MAIL_DISPLAY_SETTINGS.bodyView}
            value={view}
            onChange={chooseView}
            options={[{ value: "original", label: MAIL_DISPLAY_SETTINGS.original }, { value: "plain", label: MAIL_DISPLAY_SETTINGS.plain }]}
          />
        ) : null}
      </div>
      <div className="trusted-senders">
        <span className="settings-label" id="trusted-senders-title">{MAIL_DISPLAY_SETTINGS.trusted}</span>
        <p className="field-hint kp">{MAIL_DISPLAY_SETTINGS.trustedHint}</p>
        {app.settings && !trusted.length ? <p className="sc-note">{MAIL_DISPLAY_SETTINGS.trustedEmpty}</p> : null}
        {trusted.length ? (
          <ul className="feed-list" aria-labelledby="trusted-senders-title" ref={listRef}>
            {trusted.map((item) => (
              <li key={item}>
                <div>
                  <b>{item}</b>
                  <span>{item.includes("@") ? MAIL_DISPLAY_SETTINGS.address : MAIL_DISPLAY_SETTINGS.domain}</span>
                </div>
                <Button variant="ghost" size="sm" data-entry={item} aria-label={MAIL_DISPLAY_SETTINGS.removeLabel(item)} onClick={() => remove(item)}>
                  {MAIL_DISPLAY_SETTINGS.remove}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="sc-form trusted-form" onSubmit={add} noValidate>
          <Field label={MAIL_DISPLAY_SETTINGS.addField} hint={MAIL_DISPLAY_SETTINGS.addHint} error={entryError}>
            <TextInput
              ref={inputRef}
              type="text"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              maxLength={254}
              value={entry}
              placeholder={MAIL_DISPLAY_SETTINGS.placeholder}
              disabled={!app.settings}
              onChange={(event) => setEntry(event.target.value)}
            />
          </Field>
          <div className="sc-form-acts">
            <Button variant="secondary" type="submit" icon={Plus} disabled={!app.settings}>{MAIL_DISPLAY_SETTINGS.add}</Button>
          </div>
        </form>
      </div>
    </Card>
  );
}

export function PrivacyTab({ app }: { app: AppSettingsState }) {
  const toast = useToast();
  const [days, setDays] = useState<string>();
  const [daysError, setDaysError] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [includeSources, setIncludeSources] = useState(false);
  const saved = app.settings?.["mail.retentionDays"];

  const commitDays = () => {
    if (days === undefined) return;
    const checked = checkRetention(days);
    if (!checked.ok) {
      setDaysError(checked.errors.days);
      return;
    }
    setDaysError(undefined);
    if (checked.value === saved) setDays(undefined);
    else void app.save({ "mail.retentionDays": checked.value }).then(() => setDays(undefined));
  };

  const purge = () => {
    settingsApi.purgeMail()
      .then((result) => toast.success(PRIVACY_SETTINGS.purged(result.removed)))
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(PRIVACY_SETTINGS.purge, reasonOf(cause))));
  };

  return (
    <div className="settings-stack">
      <MailDisplayCard app={app} />
      <Card className="settings-card">
        <p className="settings-lead kp">{PRIVACY_SETTINGS.local}</p>
        <Field label={PRIVACY_SETTINGS.retention} hint={PRIVACY_SETTINGS.retentionHint} error={daysError} className="sc-short">
          <TextInput
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            value={days ?? (saved !== undefined ? String(saved) : "")}
            disabled={!app.settings}
            onChange={(event) => setDays(event.target.value)}
            onBlur={commitDays}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) commitDays(); }}
          />
        </Field>
        <div className="settings-action">
          <div>
            <span className="settings-label">{PRIVACY_SETTINGS.purge}</span>
            <p className="field-hint kp">{PRIVACY_SETTINGS.purgeHint}</p>
          </div>
          <Button variant="danger" size="sm" icon={Trash2} onClick={() => setConfirm(true)}>{PRIVACY_SETTINGS.purge}</Button>
        </div>
        <div className="settings-action">
          <div>
            <span className="settings-label">{PRIVACY_SETTINGS.export}</span>
            <p className="field-hint kp">{PRIVACY_SETTINGS.exportHint}</p>
            <Checkbox checked={includeSources} onChange={setIncludeSources} label={PRIVACY_SETTINGS.exportSources} />
          </div>
          <Button variant="secondary" size="sm" icon={Download} href={includeSources ? "/api/export?include=sources" : "/api/export"} download>
            {PRIVACY_SETTINGS.exportButton}
          </Button>
        </div>
        <div className="settings-action">
          <div>
            <span className="settings-label">{PRIVACY_SETTINGS.privacy}</span>
            <p className="field-hint kp">{PRIVACY_SETTINGS.privacyHint}</p>
          </div>
          <TextLink href="/privacy" external>{PRIVACY_SETTINGS.privacyLink}</TextLink>
        </div>
      </Card>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={PRIVACY_SETTINGS.purgeTitle}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{PRIVACY_SETTINGS.purgeKeep}</Button>
            <Button variant="danger" onClick={() => { setConfirm(false); purge(); }}>{PRIVACY_SETTINGS.purgeConfirm}</Button>
          </>
        )}
      >
        <p className="kp">{PRIVACY_SETTINGS.purgeBody}</p>
      </Dialog>
    </div>
  );
}
