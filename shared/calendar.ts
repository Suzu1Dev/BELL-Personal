import type { DayKey } from "./time.js";
import type { SourceRef } from "./sources.js";
import { weekdayChar } from "./today-format.js";

/** google: Calendar API. ics: a subscribed iCal URL. manual: a local event (manual_events). */
export const CALENDAR_ORIGINS = ["google", "ics", "manual"] as const;
export type CalendarOrigin = (typeof CALENDAR_ORIGINS)[number];

export const CALENDAR_EVENT_STATUSES = ["confirmed", "tentative", "cancelled"] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

/**
 * One occurrence on the agenda, normalised from every calendar source.
 * Timed events: start/end are ISO instants. All-day events: start/end are
 * local DayKeys and end is exclusive (a one-day event ends the next day).
 * Recurring events are expanded into occurrences before they get here.
 */
export interface CalendarEvent {
  /** Stable across syncs: "<origin>:<calendar>:<external id>[:<occurrence start>]". */
  id: string;
  origin: CalendarOrigin;
  calendarId?: string;
  calendarName?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** Link to open the event at its source (Google htmlLink, feed URL). */
  url?: string;
  /** Plain text, truncated; never HTML. */
  description?: string;
  status: CalendarEventStatus;
  /** Shown as free (Google 「顯示為有空」, iCal TRANSP:TRANSPARENT): listed, but it does not take up free time. */
  transparent?: boolean;
  /** Whether the connected user owns or can write to this Google calendar (false for read-only holiday/subscribed calendars). */
  editable?: boolean;
  updatedAt: string;
}

/**
 * A local event that happens every week (the 課表 without a Google or iCal
 * feed): on the weekday of its `start` (the first occurrence), at the same
 * local wall-clock time, until `until` (inclusive, a local day) or for ever.
 * No other recurrence exists on purpose: two weekly meetings are two events.
 */
export interface EventRepeatInput {
  freq: "weekly";
  /** The last local day an occurrence may start on (inclusive). */
  until?: DayKey;
}

/** The stored repeat: what the owner asked for, plus the single occurrences they deleted. */
export interface EventRepeat extends EventRepeatInput {
  /** Local days (of the occurrence's start) that do not happen: 停課, 國定假日. */
  skip?: DayKey[];
}

/** Most days one event may skip, and the most occurrences one calendar read expands (a huge `until` or window never grows the work). */
export const REPEAT_LIMITS = { skipDays: 200, occurrencesPerRead: 500 } as const;

/** 「每週一」: how a weekly event reads on the local day an occurrence starts on. */
export function weeklyLabel(day: DayKey): string {
  return `每週${weekdayChar(day)}`;
}

/** A local event the user created or confirmed (from a suggestion or an external event marked 要參加). */
export interface ManualEvent {
  id: string;
  title: string;
  /** The first occurrence when `repeat` is set. */
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  url?: string;
  notes?: string;
  sourceRef?: SourceRef;
  /** Set once the event was also added to Google Calendar (never for a repeating event). */
  googleEventId?: string;
  /**
   * Makes this row a weekly series; every reader sees its occurrences, not the row.
   * It lives only in BELL: a series is never inserted into Google Calendar (that
   * would need a recurrence rule this app does not model), so it has no googleEventId.
   */
  repeat?: EventRepeat;
  /** How it was made: capture/palette, 要參加 on #/events, an accepted mail suggestion, 排進 a free slot. */
  origin?: ManualEventOrigin;
  /** The Today queue item it came from (`ctftime:2846`, `ai:<suggestion id>`, `moodle:30512`). */
  itemId?: string;
  /** What the user typed in quick capture, when the title is not the whole sentence (kept by 自動整理). */
  originalText?: string;
  /** When 自動整理 (or 整理) last rewrote the title, notes or location. */
  tidiedAt?: string;
  /** The title, notes and place before that rewrite, for 復原整理 (only while the event is not in Google Calendar). */
  pretidy?: ManualEventPretidy;
  createdAt: string;
  updatedAt: string;
}

/** What 自動整理 replaced on a local event. */
export interface ManualEventPretidy {
  title: string;
  notes?: string;
  location?: string;
}

export const MANUAL_EVENT_ORIGINS = ["capture", "going", "suggestion", "schedule"] as const;
export type ManualEventOrigin = (typeof MANUAL_EVENT_ORIGINS)[number];

export const MANUAL_EVENT_LIMITS = { title: 200, location: 200, notes: 4000, originalText: 500 } as const;

/** The local day an agenda item starts on. */
export type AgendaDay = DayKey;

/* ---------------------------------------------------------------------------
 * #/calendar: GET /api/calendar?view=day|week|month&day=YYYY-MM-DD
 * ------------------------------------------------------------------------- */

export const CALENDAR_PAGE_VIEWS = ["day", "week", "month"] as const;
export type CalendarPageView = (typeof CALENDAR_PAGE_VIEWS)[number];

/**
 * Free slots on #/calendar: gaps of at least `minMinutes` between `startHour`
 * and `endHour` local time (from now on for today). Today's single 排進 slot
 * on #/today follows the core rule (≥ 90 min, ending by 22:00).
 */
export const FREE_SLOT_WINDOW = { startHour: 7, endHour: 23, minMinutes: 90 } as const;

/** Range limits of GET /api/calendar and POST /api/calendar/events. */
export const CALENDAR_LIMITS = { maxEventHours: 24 * 14, pastDays: 400, futureDays: 400 } as const;

/** One row on the calendar page: an event (any origin) or an assignment deadline. */
export interface CalendarItem {
  /** CalendarEvent id, `manual:<id>` for a local event, `manual:<id>:<local day>` for one occurrence of a weekly one, or `due:<assignment id>`. */
  id: string;
  kind: "event" | "due";
  origin: CalendarOrigin | "assignment";
  title: string;
  /** ISO instant; all-day items start at local midnight. */
  start: string;
  /** ISO instant; all-day items end at the next local midnight (exclusive). */
  end?: string;
  allDay: boolean;
  /** 「地點 · 備註」 or, for deadlines, 「課程 · NYCU E3」. */
  meta: string;
  location?: string;
  /** Plain-text description or notes for editing inside BELL Personal. */
  notes?: string;
  url?: string;
  /** 「Google 行事曆」, a feed's label or 「本機行程」. */
  sourceLabel: string;
  /** Name of the habit this event checks in (健身 → 運動) and its id. */
  habitLink?: string;
  habitId?: string;
  /** A local event (manual_events): DELETE /api/calendar/events/:manualId removes it (the whole series for a weekly one). */
  manualId?: string;
  /**
   * An occurrence of a weekly local event: `day` is the local day it starts on (the key of POST /api/calendar/events/:manualId/skip),
   * `first` the series' first day, `until` and `skip` its stored repeat. The editor shifts `first` by the days an occurrence moved
   * and restores `skip` when it undoes an edit.
   */
  repeat?: { freq: "weekly"; day: DayKey; first: DayKey; until?: DayKey; skip?: DayKey[] };
  /** Also in Google Calendar (a local event inserted there, or a Google event). */
  inGoogle: boolean;
  /** True when a native Google Calendar event lives on a calendar the user has write access to. */
  googleEditable?: boolean;
  /** Marked 要參加 on #/events. */
  going?: boolean;
  /** Shown as free at its source: does not block free slots. */
  transparent?: boolean;
  /** A local event the owner typed (quick capture, 新增行程): 整理 may rewrite it while it is not in Google. */
  typed?: boolean;
  /** A local event 自動整理 rewrote that 復原整理 can still put back (it has the fields from before). */
  tidied?: boolean;
}

export interface FreeSlot {
  start: string;
  end: string;
  minutes: number;
}

export interface CalendarDay {
  day: DayKey;
  items: CalendarItem[];
  free: FreeSlot[];
}

/** The calendar sources' state, in the Today `sources[]` vocabulary. */
export interface CalendarSourceState {
  id: "google-calendar" | "ics";
  label: string;
  state: "ok" | "syncing" | "stale" | "error" | "reconnect" | "off";
  lastSyncedAt?: string;
  message?: string;
}

/** GET /api/calendar */
export interface CalendarResponse {
  view: CalendarPageView;
  /** First and last day shown (inclusive). */
  from: DayKey;
  to: DayKey;
  /** The day the request asked for (the anchor of prev/next). */
  day: DayKey;
  today: DayKey;
  now: string;
  timeZone: string;
  weekStartsMonday: boolean;
  days: CalendarDay[];
  sources: CalendarSourceState[];
  google: { connected: boolean; canWrite: boolean };
  /** iCal subscriptions shown on the calendar (feeds with target "calendar"). */
  calendarFeeds: number;
}

/**
 * POST /api/calendar/events → 201 CalendarEventCreateResponse (quick capture,
 * the palette's 建立行程). A local event is created at once; when Google is
 * connected with calendar.events and `calendar.addToGoogle` is on (or
 * `addToGoogle` says so), the Google copy is inserted ACTION_COMMIT_MS later
 * unless DELETE `undoPath` comes first.
 */
export interface CalendarEventCreateRequest {
  title: string;
  /** ISO instant, or a DayKey for an all-day event. */
  start: string;
  /** ISO instant (default start + 1 h), or the last DayKey of an all-day event. */
  end?: string;
  allDay?: boolean;
  location?: string;
  notes?: string;
  url?: string;
  /** Overrides the `calendar.addToGoogle` setting for this event (ignored with `repeat`: a weekly event stays in BELL). */
  addToGoogle?: boolean;
  /** Every week on the weekday of `start` (a day or a time on a Monday: every Monday), optionally until a local day. Never inserted into Google. */
  repeat?: EventRepeatInput;
}

export interface CalendarEventCreateResponse {
  event: ManualEvent;
  /** pending: the Google insert waits for the undo window; none: local only (always for a weekly event). */
  google: "pending" | "none";
  /** 復原 = send("DELETE") to this path. */
  undoPath: string;
  /** The toast line: 「已加入行程「讀書會」· 明天 14:00」. */
  message: string;
}

/** DELETE /api/calendar/events/:id → 200. The undo token restores the local copy (POST /api/trash/restore). */
export interface CalendarEventDeleteResponse {
  deleted: true;
  undoToken?: string;
  /** The Google copy was deleted too (or its pending insert cancelled). */
  google: boolean;
}

/**
 * PATCH /api/calendar/events/:id → 200 ManualEvent: any subset of the fields below, the rest stays. 404 when the event is gone;
 * 409 when it is in Google Calendar or its insert is pending or on its way (there is no Google update path: edit it there).
 * A weekly event is edited as a whole: its `start` is the first occurrence and gives the weekday for every week.
 */
export interface CalendarEventUpdateRequest {
  title?: string;
  /** ISO instant, or a DayKey for an all-day event (as in the create request). Omitted: the start stays. */
  start?: string;
  /** ISO instant, the last DayKey of an all-day event, or null for an event with no end. Omitted: the end stays. */
  end?: string | null;
  allDay?: boolean;
  /** null or "" clears it. */
  location?: string | null;
  notes?: string | null;
  /**
   * Every week on the weekday of `start`, or null for a one-off event. Replaces the stored repeat: no `until` is for ever;
   * no `skip` keeps the deleted occurrences, a list replaces them (復原 sends it back). Skipped days that are not on the weekday of `start` are dropped.
   */
  repeat?: EventRepeat | null;
}

/**
 * POST /api/calendar/events/:id/skip { day } → 200: one occurrence of a weekly
 * event does not happen (停課). DELETE `undoPath` puts it back.
 */
export interface CalendarEventSkipResponse {
  skipped: DayKey;
  /** 復原 = send("DELETE") to this path. */
  undoPath: string;
}

/** POST /api/calendar/events/:id/google → 202: insert a local event into Google after the undo window. */
export interface CalendarGoogleInsertResponse {
  pending: true;
  undoPath: string;
}

/** PATCH /api/calendar/google-events → 200 CalendarEvent: direct two-way edit of a native Google Calendar event. */
export interface GoogleCalendarEventUpdateRequest {
  id: string;
  title?: string;
  start?: string;
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
  notes?: string | null;
}

/** DELETE /api/calendar/google-events → 200: deletes a native Google Calendar event and returns its snapshot for Undo. */
export interface GoogleCalendarEventDeleteResponse {
  deleted: true;
  snapshot?: CalendarEvent;
}
