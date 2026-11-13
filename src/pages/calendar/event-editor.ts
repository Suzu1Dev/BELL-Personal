/**
 * The pure rules behind the event editor (tested in event-editor.test.ts): the
 * form's fields from a calendar row, the PATCH /api/calendar/events/:id body
 * for what the user changed (and its 復原), the row as it will read once
 * saved (the optimistic update) and the checks that refuse a form before
 * anything is sent. Days are local `YYYY-MM-DD` in the server's time zone,
 * converted with shared/time.ts: never the browser's zone.
 */
import {
  CALENDAR_LIMITS, weeklyLabel,
  type CalendarDay, type CalendarEventCreateRequest, type CalendarEventUpdateRequest, type CalendarItem, type FreeSlot,
} from "../../../shared/calendar";
import { addDays, dayBounds, dayKey, daysBetween, isDayKey, isLocalTime, localTime, weekdayOf, zonedTimeToUtc, type DayKey } from "../../../shared/time";
import { CALENDAR, CALENDAR_MODEL } from "../../copy/calendar";

/** What the editor's inputs hold. */
export interface EditorFields {
  title: string;
  /** The local day the event (for a weekly one: the occurrence that was opened) starts on. */
  day: string;
  /** The local day it ends on (all-day: its last day); `day` for most events. */
  endDay: string;
  /** HH:MM; "" for an all-day event. */
  start: string;
  /** HH:MM; "" for an event with no end time. */
  end: string;
  allDay: boolean;
  location: string;
  notes: string;
  repeat: boolean;
  /** 直到: a day, or "" for ever. */
  until: string;
}

/**
 * Whether a row can be edited inside BELL Personal:
 * - Local events (`manualId`) are editable when local-only, OR when synced to Google and `googleCanWrite` is true.
 * - Native Google Calendar events (`origin === "google"`) are editable when `googleCanWrite` is true and `googleEditable !== false`.
 */
export function isEditable(
  item: Pick<CalendarItem, "kind" | "manualId" | "inGoogle"> & Partial<Pick<CalendarItem, "origin" | "googleEditable">>,
  googleCanWrite = false,
): boolean {
  if (item.kind !== "event") return false;
  if (item.manualId) return !item.inGoogle || googleCanWrite;
  if (item.origin === "google") return googleCanWrite && item.googleEditable !== false;
  return false;
}

/** Whether a row can be deleted inside BELL Personal (local events when local-only or writable in Google; native Google events when writable). */
export function isRemovable(
  item: Pick<CalendarItem, "kind" | "manualId" | "inGoogle"> & Partial<Pick<CalendarItem, "origin" | "googleEditable">>,
  googleCanWrite = false,
): boolean {
  if (item.kind !== "event") return false;
  if (item.manualId) return !item.inGoogle || googleCanWrite;
  if (item.origin === "google") return googleCanWrite && item.googleEditable !== false;
  return false;
}

export function editorFields(item: CalendarItem, timeZone: string): EditorFields {
  const day = dayKey(timeZone, item.start);
  const longer = !!item.end && Date.parse(item.end) > Date.parse(item.start);
  const common = {
    title: item.title,
    day,
    location: item.location ?? "",
    notes: item.notes ?? "",
    repeat: !!item.repeat,
    until: item.repeat?.until ?? "",
  };
  if (item.allDay) {
    // The row ends at the local midnight after its last day.
    const last = longer ? dayKey(timeZone, Date.parse(item.end!) - 1) : day;
    return { ...common, endDay: last < day ? day : last, start: "", end: "", allDay: true };
  }
  return { ...common, endDay: longer ? dayKey(timeZone, item.end!) : day, start: localTime(timeZone, item.start), end: longer ? localTime(timeZone, item.end!) : "", allDay: false };
}

export function createFields(day: DayKey, timeZone: string, slot?: Pick<FreeSlot, "start" | "end">): EditorFields {
  if (slot) {
    const startMs = Date.parse(slot.start);
    const endMs = Math.min(Date.parse(slot.end), startMs + 3_600_000);
    return {
      title: "",
      day,
      endDay: dayKey(timeZone, endMs),
      start: localTime(timeZone, startMs),
      end: localTime(timeZone, endMs),
      allDay: false,
      location: "",
      notes: "",
      repeat: false,
      until: "",
    };
  }
  return {
    title: "",
    day,
    endDay: day,
    start: "09:00",
    end: "10:00",
    allDay: false,
    location: "",
    notes: "",
    repeat: false,
    until: "",
  };
}

/** A new day for the form: the end moves with it, so the event keeps its length in days. */
export function withDay(fields: EditorFields, day: string): EditorFields {
  const span = isDayKey(fields.day) && isDayKey(fields.endDay) ? daysBetween(fields.day, fields.endDay) : 0;
  return { ...fields, day, endDay: isDayKey(day) ? addDays(day, span) : day };
}

/** 全天 on or off: turning it off for an all-day event offers a usual hour to start from. */
export function withAllDay(fields: EditorFields, allDay: boolean): EditorFields {
  if (allDay) return { ...fields, allDay };
  return { ...fields, allDay, start: fields.start || "09:00", end: fields.end || (fields.start ? "" : "10:00") };
}

/** What 儲存 sends and 復原 sends back, and the row as it reads once saved. */
export interface EventEdit {
  patch: CalendarEventUpdateRequest;
  undo: CalendarEventUpdateRequest;
  next: CalendarItem;
}

export type EditPlan = { ok: true; edit: EventEdit | null } | { ok: false; error: string; field?: keyof EditorFields };
export type CreatePlan = { ok: true; body: CalendarEventCreateRequest } | { ok: false; error: string; field?: keyof EditorFields };

export function planCreate(form: EditorFields, timeZone: string, addToGoogle: boolean): CreatePlan {
  const title = form.title.trim();
  if (!title) return { ok: false, error: CALENDAR.editor.titleRequired, field: "title" };
  const refusal = refuseTimes(form, timeZone);
  if (refusal) return { ok: false, ...refusal };
  if (form.repeat && form.until && !isDayKey(form.until)) return { ok: false, error: CALENDAR.editor.untilInvalid, field: "until" };
  if (form.repeat && form.until && form.until < form.day) return { ok: false, error: CALENDAR.editor.untilBeforeFirst, field: "until" };
  const times = requested(form, form.day, timeZone);
  const location = form.location.trim();
  const notes = form.notes.trim();
  return {
    ok: true,
    body: {
      title,
      start: times.start,
      ...(times.end ? { end: times.end } : {}),
      allDay: form.allDay,
      ...(location ? { location } : {}),
      ...(notes ? { notes } : {}),
      ...(form.repeat
        ? { repeat: { freq: "weekly", ...(form.until ? { until: form.until } : {}) } }
        : { addToGoogle }),
    },
  };
}

const instant = (timeZone: string, day: DayKey, time: string): string => {
  const [hour, minute] = time.split(":").map(Number);
  return zonedTimeToUtc(timeZone, day, hour, minute).toISOString();
};

/** The start and end a request states for fields whose event starts on `first` (all-day: days, the end inclusive; timed: instants). */
function requested(fields: EditorFields, first: DayKey, timeZone: string): { start: string; end: string | null } {
  const last = addDays(first, daysBetween(fields.day, fields.endDay));
  if (fields.allDay) return { start: first, end: last };
  return { start: instant(timeZone, first, fields.start), end: fields.end ? instant(timeZone, last, fields.end) : null };
}

/**
 * What a form change comes to. `base` is the form as it was opened and `form`
 * as it is now. Only changed fields go into `patch`; nothing changed is
 * `edit: null`. A weekly row's date is the occurrence's: the whole series moves
 * by the same days (its first day shifts), which is what every week following
 * the edit means; turning 每週重複 off leaves the one event on the opened day.
 * `undo` has the previous value of every field `patch` names, and a series'
 * whole previous repeat whenever its start or repeat changed, because a move to
 * another weekday forgets its deleted days and 復原 must bring them back.
 */
export function planEdit(item: CalendarItem, base: EditorFields, form: EditorFields, timeZone: string): EditPlan {
  const title = form.title.trim();
  if (!title) return { ok: false, error: CALENDAR.editor.titleRequired, field: "title" };

  const series = item.repeat;
  const keepsSeries = !!series && form.repeat;
  // The day the stored event starts on, before and after: a series stores its first occurrence.
  const firstBefore = series ? series.first : base.day;
  const firstAfter = keepsSeries ? addDays(series!.first, daysBetween(base.day, form.day)) : form.day;

  const timeChanged = form.day !== base.day || form.endDay !== base.endDay || form.start !== base.start || form.end !== base.end || form.allDay !== base.allDay;
  if (timeChanged) {
    const refusal = refuseTimes(form, timeZone);
    if (refusal) return { ok: false, ...refusal };
  }
  if (form.repeat && form.until && !isDayKey(form.until)) return { ok: false, error: CALENDAR.editor.untilInvalid, field: "until" };
  if (form.repeat && form.until && form.until < firstAfter) return { ok: false, error: CALENDAR.editor.untilBeforeFirst, field: "until" };

  const before = requested(base, firstBefore, timeZone);
  const after = requested(form, firstAfter, timeZone);
  const previous: CalendarEventUpdateRequest = {
    title: base.title,
    start: before.start,
    end: before.end,
    allDay: base.allDay,
    location: base.location.trim() || null,
    notes: base.notes.trim() || null,
    repeat: series ? { freq: "weekly", ...(series.until ? { until: series.until } : {}), skip: series.skip ?? [] } : null,
  };

  const patch: CalendarEventUpdateRequest = {};
  if (title !== base.title.trim()) patch.title = title;
  if (form.location.trim() !== base.location.trim()) patch.location = form.location.trim() || null;
  if (form.notes.trim() !== base.notes.trim()) patch.notes = form.notes.trim() || null;
  if (form.allDay !== base.allDay) {
    // The days and the instants mean different things: all three go together.
    patch.allDay = form.allDay;
    patch.start = after.start;
    patch.end = after.end;
  } else {
    if (after.start !== before.start) patch.start = after.start;
    if (after.end !== before.end) patch.end = after.end;
  }
  if (form.repeat !== base.repeat || (form.repeat && form.until !== base.until)) {
    patch.repeat = form.repeat ? { freq: "weekly", ...(form.until ? { until: form.until } : {}) } : null;
  }
  if (!Object.keys(patch).length) return { ok: true, edit: null };

  const undo: CalendarEventUpdateRequest = {};
  for (const key of Object.keys(patch) as Array<keyof CalendarEventUpdateRequest>) (undo as Record<string, unknown>)[key] = previous[key];
  if (series && ("start" in patch || "repeat" in patch)) undo.repeat = previous.repeat;

  return { ok: true, edit: { patch, undo, next: editedItem(item, base, form, firstAfter, series?.skip, timeZone) } };
}

/** What makes the times of a form unusable, as a message for the field that holds it. */
function refuseTimes(form: EditorFields, timeZone: string): { error: string; field: keyof EditorFields } | undefined {
  if (!isDayKey(form.day)) return { error: CALENDAR.editor.dateRequired, field: "day" };
  if (!isDayKey(form.endDay)) return { error: CALENDAR.editor.dateRequired, field: "endDay" };
  if (form.endDay < form.day) return { error: CALENDAR.editor.endDayBeforeStart, field: "endDay" };
  const maxMs = CALENDAR_LIMITS.maxEventHours * 3_600_000;
  if (form.allDay) {
    const length = Date.parse(dayBounds(timeZone, form.endDay).end) - Date.parse(dayBounds(timeZone, form.day).start);
    return length > maxMs ? { error: CALENDAR.editor.tooLong, field: "endDay" } : undefined;
  }
  if (!isLocalTime(form.start)) return { error: CALENDAR.editor.startRequired, field: "start" };
  if (!form.end) return form.endDay === form.day ? undefined : { error: CALENDAR.editor.endRequired, field: "end" };
  if (!isLocalTime(form.end)) return { error: CALENDAR.editor.endRequired, field: "end" };
  const length = Date.parse(instant(timeZone, form.endDay, form.end)) - Date.parse(instant(timeZone, form.day, form.start));
  if (length <= 0) return { error: CALENDAR.editor.endBeforeStart, field: "end" };
  if (length > maxMs) return { error: CALENDAR.editor.tooLong, field: "end" };
  return undefined;
}

/**
 * The row as the server will return it for the occurrence the user opened:
 * 「地點 · 備註 · 每週一」 is rebuilt from the new place and weekday; the note
 * stays what it was. Other occurrences of a series follow once the list reloads.
 */
function firstNoteLine(note: string): string | undefined {
  const first = note.split("\n").map((line) => line.trim()).find(Boolean);
  return first && first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

function editedItem(item: CalendarItem, base: EditorFields, form: EditorFields, first: DayKey, skip: DayKey[] | undefined, timeZone: string): CalendarItem {
  const title = form.title.trim();
  const location = form.location.trim();
  const notes = form.notes.trim();
  const notesChanged = notes !== base.notes.trim();
  const times = form.allDay
    ? { start: dayBounds(timeZone, form.day).start, end: dayBounds(timeZone, form.endDay).end }
    : (() => {
      const start = instant(timeZone, form.day, form.start);
      return { start, end: form.end ? instant(timeZone, form.endDay, form.end) : start };
    })();
  // Rewording ends 復原整理 (the server drops what it would put back); the deleted days of a series only mean something on its weekday.
  const { repeat: _repeat, location: _location, notes: _notes, tidied, ...rest } = item;
  const reworded = title !== item.title || location !== (item.location ?? "") || notesChanged;
  const kept = skip?.filter((day) => weekdayOf(day) === weekdayOf(first));
  const label = form.repeat ? CALENDAR_MODEL.weeklyLabel(form.day) : undefined;
  const noteMeta = notesChanged || item.notes !== undefined ? firstNoteLine(notes) : noteOf(item);
  return {
    ...rest,
    id: item.manualId ? (form.repeat ? `manual:${item.manualId}:${form.day}` : `manual:${item.manualId}`) : item.id,
    title,
    ...times,
    allDay: form.allDay,
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    meta: [location, noteMeta, label].filter(Boolean).join(" · "),
    ...(tidied && !reworded ? { tidied } : {}),
    ...(form.repeat ? { repeat: { freq: "weekly" as const, day: form.day, first, ...(form.until ? { until: form.until } : {}), ...(kept?.length ? { skip: kept } : {}) } } : {}),
  };
}

/** What 「地點 · 備註 · 每週一」 holds besides the place and the weekly label: the first line of the note. */
function noteOf(item: CalendarItem): string {
  let meta = item.meta;
  if (item.location) {
    if (meta === item.location) meta = "";
    else if (meta.startsWith(`${item.location} · `)) meta = meta.slice(item.location.length + 3);
  }
  const labels = item.repeat ? [weeklyLabel(item.repeat.day), CALENDAR_MODEL.weeklyLabel(item.repeat.day)] : [];
  for (const label of labels) {
    if (meta === label) meta = "";
    else if (meta.endsWith(` · ${label}`)) meta = meta.slice(0, -(label.length + 3));
  }
  return meta;
}

/**
 * The days with the edited rows in place (the optimistic update): a row that
 * moved to another day leaves its old one for the day it starts on, and a
 * multi-day row shows on every day it covers, as the server lists it.
 * `edits` maps the id of the row as it was to the row as it will read; once a
 * reloaded list holds the edited row itself, it is not shown twice.
 */
export function withEdits(days: CalendarDay[], edits: ReadonlyMap<string, CalendarItem>, timeZone: string): CalendarDay[] {
  if (!edits.size) return days;
  const replaced = new Set([...edits.keys(), ...[...edits.values()].map((item) => item.id)]);
  return days.map((entry) => {
    const { start, end } = dayBounds(timeZone, entry.day);
    const from = Date.parse(start);
    const to = Date.parse(end);
    const kept = entry.items.filter((item) => !replaced.has(item.id));
    const placed = [...edits.values()].filter((item) => {
      const itemStart = Date.parse(item.start);
      const itemEnd = Date.parse(item.end ?? item.start);
      return itemStart < to && (itemEnd > from || (itemEnd === itemStart && itemStart >= from));
    });
    return placed.length || kept.length !== entry.items.length ? { ...entry, items: [...kept, ...placed] } : entry;
  });
}
