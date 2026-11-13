/**
 * 新增作業 / 編輯作業 (SPEC-mail-assignments §5.8) in a native <dialog>:
 * 作業名稱 (required), 課程, 截止日期 + 截止時間 (a date alone is 23:59),
 * 繳交方式, 連結 (https only) and 備註. Native rows only (from a teacher's mail
 * or added here); LMS rows are the school's. 刪除作業 is reversible (trash +
 * undo toast), so it needs no confirmation.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { AssignmentView } from "../../../shared/assignments";
import { ASSIGNMENT_LIMITS } from "../../../shared/assignments";
import { api, send } from "../../api";
import { assignmentFormCopy } from "../../copy/work";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field, TextInput, Textarea } from "../../components/Field";
import { TextLink } from "../../components/Link";
import { useAppSettings } from "../../lib/app-settings";
import { isComposing } from "../../lib/keys";
import { reasonOf } from "./useWork";
import { assignmentBody, assignmentForm, moduleHiddenMessage, validateAssignmentForm, type AssignmentFormErrors, type AssignmentFormState } from "./work-model";

export interface AssignmentDialogProps {
  open: boolean;
  /** Absent: 新增作業. */
  row?: AssignmentView;
  timeZone: string;
  onClose: () => void;
  onSaved: (saved: AssignmentView, created: boolean) => void;
  onDelete?: (row: AssignmentView) => void;
}

/** Enter that commits an IME composition (注音) must not submit the form. */
function guardEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter" && isComposing(event.nativeEvent)) event.preventDefault();
}

export function AssignmentDialog({ open, row, timeZone, onClose, onSaved, onDelete }: AssignmentDialogProps) {
  const [form, setForm] = useState<AssignmentFormState>(() => assignmentForm(row, timeZone));
  const [errors, setErrors] = useState<AssignmentFormErrors & { form?: ReactNode }>({});
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const app = useAppSettings();
  const copy = assignmentFormCopy();

  useEffect(() => {
    if (open) { setForm(assignmentForm(row, timeZone)); setErrors({}); setSaving(false); }
  }, [open, row, timeZone]);

  const set = <K extends keyof AssignmentFormState>(key: K, value: AssignmentFormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const found = validateAssignmentForm(form);
    setErrors(found);
    if (Object.keys(found).length) {
      if (found.title) titleRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      const body = assignmentBody(form, timeZone, !!row);
      const saved = row
        ? await api<AssignmentView>(`/lms/assignments/${encodeURIComponent(row.externalId)}`, send("PATCH", body))
        : await api<AssignmentView>("/lms/assignments", send("POST", body));
      onSaved(saved, !row);
    } catch (cause) {
      const hidden = moduleHiddenMessage(cause, "lms", app.overrides.assignments === false);
      setErrors({ form: <>{copy.saveFailed(hidden ?? reasonOf(cause))}{hidden ? <> <TextLink href="#/settings/roles" onClick={onClose}>{copy.openRoles}</TextLink></> : null}</> });
      setSaving(false);
    }
  };

  const mail = row?.origin === "mail" && row.mailRef ? row.mailRef : undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={row ? copy.editTitle : copy.createTitle}
      className="project-dialog assignment-dialog"
      closeLabel={copy.dialogClose}
      initialFocus={() => titleRef.current}
      footer={(
        <>
          {row && onDelete ? <Button variant="ghost" className="dialog-foot-start is-danger" onClick={() => onDelete(row)}>{copy.delete}</Button> : null}
          <Button variant="ghost" onClick={onClose}>{copy.cancel}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>{copy.save}</Button>
        </>
      )}
    >
      <form className="project-form assignment-form" onSubmit={(event) => void submit(event)} noValidate>
        {mail ? (
          <p className="assignment-source">
            <span>{row?.mailSender ? copy.fromMail(row.mailSender) : copy.fromMailUnknown}</span>
            <span className="sep" aria-hidden="true">·</span>
            <TextLink href={`#/inbox/${encodeURIComponent(mail.threadId)}`} accent onClick={onClose}>{copy.openMail}</TextLink>
          </p>
        ) : null}
        <Field label={copy.title} error={errors.title}>
          <TextInput
            ref={titleRef}
            value={form.title}
            maxLength={ASSIGNMENT_LIMITS.title}
            placeholder={copy.titlePlaceholder}
            required
            aria-required="true"
            onChange={(event) => set("title", event.target.value)}
            onKeyDown={guardEnter}
          />
        </Field>
        <Field label={copy.course}>
          <TextInput value={form.courseName} maxLength={ASSIGNMENT_LIMITS.courseName} placeholder={copy.coursePlaceholder} onChange={(event) => set("courseName", event.target.value)} onKeyDown={guardEnter} />
        </Field>
        <div className="assignment-due">
          <Field label={copy.date}>
            <TextInput type="date" value={form.date} onChange={(event) => set("date", event.target.value)} />
          </Field>
          <Field label={copy.time} hint={copy.timeHint} error={errors.time}>
            <TextInput type="time" value={form.time} onChange={(event) => set("time", event.target.value)} />
          </Field>
        </div>
        <Field label={copy.submitHint}>
          <TextInput value={form.submitHint} maxLength={ASSIGNMENT_LIMITS.submitHint} placeholder={copy.submitHintPlaceholder} onChange={(event) => set("submitHint", event.target.value)} onKeyDown={guardEnter} />
        </Field>
        <Field label={copy.url} hint={copy.urlHint} error={errors.url}>
          <TextInput type="url" inputMode="url" value={form.url} maxLength={ASSIGNMENT_LIMITS.url} placeholder="https://" spellCheck={false} onChange={(event) => set("url", event.target.value)} onKeyDown={guardEnter} />
        </Field>
        <Field label={copy.notes}>
          <Textarea value={form.notes} maxLength={ASSIGNMENT_LIMITS.notes} rows={2} onChange={(event) => set("notes", event.target.value)} />
        </Field>
        {errors.form ? <p className="field-error" role="alert">{errors.form}</p> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
