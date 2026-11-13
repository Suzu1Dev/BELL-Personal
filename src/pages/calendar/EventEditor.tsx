/**
 * The structured event editor & creator of #/calendar:
 * - Edit mode (`item`): edits any local event OR two-way Google Calendar event
 *   (title, date, all-day, start/end time, location, notes, and local weekly repeat).
 * - Create mode (`create`): creates a structured event right on the calendar with
 *   1-click Google Calendar sync toggle (`同步至 Google 行事曆`) and a quick-capture
 *   shortcut for natural-language syntax.
 * Renders as an opaque anchored popover on desktop and a bottom sheet at ≤720px.
 */
import { Sparkles } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { CalendarEventCreateRequest, CalendarItem, FreeSlot } from "../../../shared/calendar";
import type { DayKey } from "../../../shared/time";
import { Button } from "../../components/Button";
import { Field, Switch, Textarea, TextInput } from "../../components/Field";
import { ArrowUpRight, CalendarPlus, Icon, Trash2 } from "../../components/Icon";
import { CALENDAR } from "../../copy/calendar";
import { cx } from "../../lib/cx";
import { isComposing } from "../../lib/keys";
import { createFields, editorFields, planCreate, planEdit, withAllDay, withDay, type EditorFields, type EventEdit } from "./event-editor";
import type { RemoveScope } from "./RemoveMenu";

export interface EventEditorProps {
  /** Edit mode: the row opened for editing. */
  item?: CalendarItem;
  /** Create mode: the initial date and optional free slot. */
  create?: { day: DayKey; slot?: Pick<FreeSlot, "start" | "end"> };
  timeZone: string;
  /** Whether Google Calendar is connected with write permission. */
  googleCanWrite?: boolean;
  /** Default value of 同步至 Google 行事曆 in create mode. */
  defaultAddToGoogle?: boolean;
  /** The pencil, block, or button the popover anchors to. */
  anchor: HTMLElement | null;
  /** ≤720: a bottom sheet. */
  sheet: boolean;
  /** Edit mode save. */
  onSave?: (edit: EventEdit) => void;
  /** Create mode submit. */
  onCreate?: (body: CalendarEventCreateRequest) => void;
  /** Edit mode delete. */
  onRemove?: (scope: RemoveScope) => void;
  /** 1-click push of a local-only event to Google Calendar. */
  onPushToGoogle?: () => void;
  /** Opens natural-language quick capture palette (`+...`). */
  onQuickCapture?: () => void;
  onClose: (options?: { focus?: boolean }) => void;
}

export function EventEditor({
  item,
  create,
  timeZone,
  googleCanWrite = false,
  defaultAddToGoogle = true,
  anchor,
  sheet,
  onSave,
  onCreate,
  onRemove,
  onPushToGoogle,
  onQuickCapture,
  onClose,
}: EventEditorProps) {
  const isCreate = !item;
  const ref = useRef<HTMLFormElement>(null);
  const headId = useId();
  const [base] = useState<EditorFields>(() => (
    item ? editorFields(item, timeZone) : createFields(create?.day ?? "2026-01-01", timeZone, create?.slot)
  ));
  const [fields, setFields] = useState<EditorFields>(base);
  const [addToGoogle, setAddToGoogle] = useState<boolean>(() => googleCanWrite && defaultAddToGoogle);
  const [error, setError] = useState<{ message: string; field?: keyof EditorFields }>();
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });

  const series = !!item?.repeat;
  const nativeGoogle = !!item && item.origin === "google" && !item.manualId;
  const canRepeat = isCreate || !!item?.manualId;
  const multiDay = fields.endDay !== fields.day;
  const dirty = (Object.keys(base) as Array<keyof EditorFields>).some((key) => base[key] !== fields[key]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const set = (patch: Partial<EditorFields>) => {
    setFields((current) => ({ ...current, ...patch }));
    setError(undefined);
  };
  const errorOf = (field: keyof EditorFields) => (error?.field === field ? error.message : undefined);

  useLayoutEffect(() => {
    if (sheet) {
      setPosition({});
      return;
    }
    const place = () => {
      const popover = ref.current;
      if (!popover) return;
      if (!anchor || !anchor.isConnected) {
        const left = Math.max(12, Math.round((window.innerWidth - popover.offsetWidth) / 2));
        const top = Math.max(24, Math.round((window.innerHeight - popover.offsetHeight) / 3));
        setPosition({ top, left });
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - popover.offsetWidth - 12, rect.right - popover.offsetWidth));
      const below = rect.bottom + 6;
      const top = below + popover.offsetHeight > window.innerHeight - 12 ? rect.top - popover.offsetHeight - 6 : below;
      setPosition({ top: Math.max(12, Math.min(top, window.innerHeight - popover.offsetHeight - 12)), left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, sheet, fields.allDay, fields.repeat, multiDay, series, error]);

  useEffect(() => {
    const title = ref.current?.querySelector<HTMLInputElement>('input[name="title"]');
    title?.focus();
    if (!isCreate) title?.select();
  }, [isCreate]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (dirtyRef.current || target.closest?.(".ev-scrim") || anchor?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) onCloseRef.current({ focus: false });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (isCreate) {
      const plan = planCreate(fields, timeZone, googleCanWrite && addToGoogle);
      if (!plan.ok) {
        setError({ message: plan.error, field: plan.field });
        if (plan.field) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[name="${plan.field}"]`)?.focus());
        return;
      }
      onCreate?.(plan.body);
      return;
    }
    const plan = planEdit(item!, base, fields, timeZone);
    if (!plan.ok) {
      setError({ message: plan.error, field: plan.field });
      if (plan.field) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[name="${plan.field}"]`)?.focus());
      return;
    }
    if (plan.edit) onSave?.(plan.edit);
    else onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    event.stopPropagation();
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  const repeatNote = series
    ? (fields.repeat ? CALENDAR.editor.seriesNote : CALENDAR.editor.repeatOffNote)
    : fields.repeat
      ? CALENDAR.editor.repeatOnNote
      : undefined;

  const syncNote = !repeatNote && !isCreate && googleCanWrite && item?.inGoogle
    ? (nativeGoogle ? CALENDAR.editor.nativeGoogleNote : CALENDAR.editor.syncedTwoWayNote)
    : undefined;

  const note = repeatNote ?? syncNote;

  const canPushToGoogle = !isCreate && !!item?.manualId && !item.inGoogle && !fields.repeat && googleCanWrite && !!onPushToGoogle;

  const allDaySwitch = <Switch checked={fields.allDay} onChange={(allDay) => set(withAllDay(fields, allDay))} label={CALENDAR.editor.allDay} />;

  return createPortal(
    <>
      {sheet ? <div className="ev-scrim" aria-hidden="true" onClick={() => { if (!dirtyRef.current) onCloseRef.current({ focus: false }); }} /> : null}
      <form ref={ref} className={cx("ev-pop", sheet && "is-sheet")} role="dialog" aria-labelledby={headId} style={position} noValidate onSubmit={submit} onKeyDown={onKeyDown}>
        <div className="ev-head-row">
          <p className="ev-head" id={headId}>{isCreate ? CALENDAR.editor.createHeading : CALENDAR.editor.heading}</p>
          {!isCreate && item?.inGoogle && googleCanWrite ? (
            <span className="ev-sync-badge">
              <span className="ev-sync-dot" aria-hidden="true" />
              {CALENDAR.sync.twoWay}
            </span>
          ) : null}
          {isCreate && onQuickCapture ? (
            <button type="button" className="ev-quick-btn" onClick={onQuickCapture}>
              <Icon icon={Sparkles} size="xs" />
              {CALENDAR.editor.quickCapture}
            </button>
          ) : null}
        </div>

        <Field label={CALENDAR.editor.title} error={errorOf("title")}>
          <TextInput
            name="title"
            value={fields.title}
            maxLength={200}
            autoComplete="off"
            placeholder={isCreate ? CALENDAR.editor.titlePlaceholder : undefined}
            onChange={(event) => set({ title: event.target.value })}
          />
        </Field>

        <div className={cx("ev-row", multiDay ? "is-two" : "is-date")}>
          <Field label={CALENDAR.editor.date} error={errorOf("day")}>
            <TextInput name="day" type="date" value={fields.day} onChange={(event) => set(withDay(fields, event.target.value))} />
          </Field>
          {multiDay ? (
            <Field label={CALENDAR.editor.endDate} error={errorOf("endDay")}>
              <TextInput name="endDay" type="date" value={fields.endDay} onChange={(event) => set({ endDay: event.target.value })} />
            </Field>
          ) : allDaySwitch}
        </div>
        {multiDay ? allDaySwitch : null}

        {fields.allDay ? null : (
          <div className="ev-row is-two">
            <Field label={CALENDAR.editor.start} error={errorOf("start")}>
              <TextInput name="start" type="time" value={fields.start} onChange={(event) => set({ start: event.target.value })} />
            </Field>
            <Field label={CALENDAR.editor.end} error={errorOf("end")}>
              <TextInput name="end" type="time" value={fields.end} onChange={(event) => set({ end: event.target.value })} />
            </Field>
          </div>
        )}

        <Field label={CALENDAR.editor.location}>
          <TextInput name="location" value={fields.location} maxLength={200} autoComplete="off" placeholder={CALENDAR.editor.locationPlaceholder} onChange={(event) => set({ location: event.target.value })} />
        </Field>

        <Field label={CALENDAR.editor.notes}>
          <Textarea
            name="notes"
            rows={2}
            value={fields.notes}
            maxLength={4000}
            placeholder={CALENDAR.editor.notesPlaceholder}
            onChange={(event) => set({ notes: event.target.value })}
          />
        </Field>

        {canRepeat ? (
          <Switch checked={fields.repeat} onChange={(repeat) => set({ repeat })} label={CALENDAR.editor.repeat} />
        ) : null}

        {canRepeat && fields.repeat ? (
          <Field label={CALENDAR.editor.until} hint={CALENDAR.editor.untilHint} error={errorOf("until")}>
            <TextInput name="until" type="date" value={fields.until} onChange={(event) => set({ until: event.target.value })} />
          </Field>
        ) : null}

        {isCreate && googleCanWrite && !fields.repeat ? (
          <Switch checked={addToGoogle} onChange={setAddToGoogle} label={CALENDAR.editor.syncToGoogle} />
        ) : null}

        {note ? <p className="ev-note kp">{note}</p> : null}

        <div className="ev-actions">
          <Button type="submit" variant="primary" size="sm">{isCreate ? CALENDAR.editor.createSave : CALENDAR.editor.save}</Button>
          <Button variant="secondary" size="sm" onClick={() => onClose()}>{CALENDAR.editor.cancel}</Button>
          {canPushToGoogle ? (
            <Button variant="ghost" size="sm" icon={CalendarPlus} onClick={onPushToGoogle}>{CALENDAR.editor.pushToGoogle}</Button>
          ) : null}
          {!isCreate && item?.url ? <Button variant="ghost" size="sm" icon={ArrowUpRight} href={item.url} external>{CALENDAR.editor.open}</Button> : null}
          {!isCreate && !series && onRemove ? (
            <Button variant="ghost" size="sm" icon={Trash2} className="ev-del" onClick={() => onRemove("series")}>{CALENDAR.remove}</Button>
          ) : null}
        </div>

        {!isCreate && series && onRemove ? (
          <div className="ev-remove">
            <Button variant="ghost" size="sm" icon={Trash2} className="ev-del" onClick={() => onRemove("occurrence")}>{CALENDAR.removeOne}</Button>
            <Button variant="ghost" size="sm" className="ev-del" onClick={() => onRemove("series")}>{CALENDAR.removeSeries}</Button>
          </div>
        ) : null}
      </form>
    </>,
    document.body,
  );
}
