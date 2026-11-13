/**
 * 新增習慣 / 編輯習慣 (SPEC-ux §3.3): name, cadence 每天 / 每週 N 次, an
 * optional 2–4 character short label for the Today chips, an optional note
 * (「每天 · 睡前」) and agenda keywords for the event-linked check-in. The
 * automatic GitHub habit only edits its name and short label.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { defaultShort, HABIT_LIMITS, type HabitCadence, type HabitSummary } from "../../../shared/habits";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field, Select, TextInput } from "../../components/Field";
import { Notice } from "../../components/Notice";
import { SegmentedControl } from "../../components/SegmentedControl";
import { HABIT_DIALOG } from "../../copy/habits";
import { isComposing } from "../../lib/keys";
import { emptyHabitForm, formFromSummary, validateHabitForm, type HabitForm } from "./model";

export interface HabitDialogProps {
  open: boolean;
  /** The habit being edited; undefined for 新增習慣. */
  habit?: HabitSummary;
  onClose: () => void;
  /** Saves; rejects with a localized message to keep the dialog open. */
  onSubmit: (form: HabitForm) => Promise<void>;
}

const TIMES = Array.from({ length: HABIT_LIMITS.timesPerWeekMax - 1 }, (_, index) => index + 1);

export function HabitDialog({ open, habit, onClose, onSubmit }: HabitDialogProps) {
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<HabitForm>(emptyHabitForm);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setForm(habit ? formFromSummary(habit) : emptyHabitForm());
    setShowErrors(false);
    setSaving(false);
    setFailure(undefined);
  }, [open, habit]);

  const errors = validateHabitForm(form);
  const auto = habit?.auto === true;
  const cadenceOptions: { value: HabitCadence; label: string }[] = [
    { value: "daily", label: HABIT_DIALOG.daily },
    ...(form.cadence === "weekdays" ? [{ value: "weekdays" as const, label: HABIT_DIALOG.weekdays }] : []),
    { value: "weekly", label: HABIT_DIALOG.weekly },
  ];
  const fallbackShort = form.name.trim() ? defaultShort(form.name) : "";
  const set = <K extends keyof HabitForm>(key: K, value: HabitForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (Object.keys(errors).length) {
      setShowErrors(true);
      (errors.name ? nameRef.current : document.getElementById(`${formId}-short`))?.focus();
      return;
    }
    setSaving(true);
    setFailure(undefined);
    try {
      await onSubmit(form);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  // Enter that commits an IME composition must not submit the form.
  const guardEnter = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && isComposing(event.nativeEvent)) event.preventDefault();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={habit ? HABIT_DIALOG.editTitle : HABIT_DIALOG.newTitle}
      className="habit-dialog"
      initialFocus={() => nameRef.current}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{HABIT_DIALOG.cancel}</Button>
          <Button variant="primary" type="submit" form={formId} disabled={saving}>
            {saving ? HABIT_DIALOG.saving : habit ? HABIT_DIALOG.save : HABIT_DIALOG.create}
          </Button>
        </>
      )}
    >
      <form id={formId} className="habit-form" onSubmit={submit} onKeyDown={guardEnter} noValidate>
        {failure ? <Notice tone="error" title={failure} role="alert" /> : null}
        {auto ? <p className="habit-form-note kp">{HABIT_DIALOG.autoNote}</p> : null}
        <Field label={HABIT_DIALOG.name} error={showErrors && errors.name ? HABIT_DIALOG.nameRequired : undefined}>
          <TextInput
            ref={nameRef}
            value={form.name}
            maxLength={HABIT_LIMITS.name}
            placeholder={HABIT_DIALOG.namePlaceholder}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        {auto ? null : (
          <div className="habit-form-cadence">
            <div className="field">
              <span className="habit-form-label" id={`${formId}-cadence`}>{HABIT_DIALOG.cadence}</span>
              <SegmentedControl label={HABIT_DIALOG.cadence} options={cadenceOptions} value={form.cadence} onChange={(value) => set("cadence", value)} />
            </div>
            {form.cadence === "weekly" ? (
              <Field label={HABIT_DIALOG.times}>
                <Select value={String(form.timesPerWeek)} onChange={(event) => set("timesPerWeek", Number(event.target.value))}>
                  {TIMES.map((times) => <option key={times} value={times}>{HABIT_DIALOG.timesOption(times)}</option>)}
                </Select>
              </Field>
            ) : null}
          </div>
        )}
        <Field
          label={HABIT_DIALOG.short}
          hint={fallbackShort ? HABIT_DIALOG.shortHint(fallbackShort) : HABIT_DIALOG.shortHintEmpty}
          error={showErrors && errors.short ? HABIT_DIALOG.shortInvalid : undefined}
        >
          <TextInput
            id={`${formId}-short`}
            className="habit-form-short"
            value={form.short}
            maxLength={8}
            placeholder={fallbackShort || undefined}
            autoComplete="off"
            onChange={(event) => set("short", event.target.value)}
          />
        </Field>
        {auto ? null : (
          <>
            <Field label={HABIT_DIALOG.hint} hint={HABIT_DIALOG.hintHelp}>
              <TextInput value={form.hint} maxLength={HABIT_LIMITS.hint} placeholder={HABIT_DIALOG.hintPlaceholder} autoComplete="off" onChange={(event) => set("hint", event.target.value)} />
            </Field>
            <Field label={HABIT_DIALOG.keywords} hint={HABIT_DIALOG.keywordsHelp}>
              <TextInput value={form.keywords} maxLength={240} placeholder={HABIT_DIALOG.keywordsPlaceholder} autoComplete="off" onChange={(event) => set("keywords", event.target.value)} />
            </Field>
          </>
        )}
      </form>
    </Dialog>
  );
}
