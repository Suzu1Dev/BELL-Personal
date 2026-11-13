/** ctftime: CTFtime API. feed: RSS/Atom (e.g. KKTIX). ics: an iCal feed of events. mail: extracted from a message (after confirmation). */
export const EXTERNAL_EVENT_ORIGINS = ["ctftime", "feed", "ics", "mail"] as const;
export type ExternalEventOrigin = (typeof EXTERNAL_EVENT_ORIGINS)[number];

/** An upcoming event from outside the user's calendar. Marking 要參加 creates a ManualEvent with a sourceRef. */
export interface ExternalEvent {
  /** "<origin>:<feed id>:<external id>". */
  id: string;
  origin: ExternalEventOrigin;
  /** Which subscription it came from (feeds and ics). */
  feedId?: string;
  feedName?: string;
  title: string;
  start: string;
  end?: string | null;
  allDay?: boolean;
  location?: string;
  url?: string;
  organizer?: string;
  /** CTFtime only: "Jeopardy", "Attack-Defense"… */
  format?: string;
  /** CTFtime only: the event weight (0–100). */
  weight?: number;
  /** Online event (CTFtime onsite = false). */
  online?: boolean;
  /** Plain text, truncated; never HTML. */
  description?: string;
  updatedAt: string;
}

export const FEED_KINDS = ["rss", "atom", "ics"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/**
 * Where a subscription's items appear. events: #/events (ExternalEvent, source
 * `feeds`, 要參加 / 略過). calendar: the agenda (CalendarEvent, source `ics`),
 * for a personal calendar such as Google's secret iCal address. iCal only;
 * RSS/Atom feeds are always events. Detected from the URL when not given.
 */
export const FEED_TARGETS = ["events", "calendar"] as const;
export type FeedTarget = (typeof FEED_TARGETS)[number];

/**
 * A user subscription to an RSS/Atom/iCal feed of events. A secret URL (a
 * Google "secret iCal address", a URL with a token) lives in the vault as
 * `ics.<id>` and `url` keeps only a display form; see shared/connect.ts.
 */
export interface FeedSubscription {
  id: string;
  /** The user's name for it (「g0v 行事曆」); shown in meta lines. */
  label: string;
  url: string;
  kind: FeedKind;
  enabled: boolean;
  /** The URL is stored in the vault, not here. */
  secret?: boolean;
  /** Default "events". */
  target?: FeedTarget;
  createdAt: string;
  /** Last successful fetch of this feed. */
  lastSyncedAt?: string | null;
  /** zh-TW, redacted; null after a success. */
  lastError?: string | null;
  updatedAt?: string;
}

/** CTFtime: events within this many days are fetched (the API's finish parameter). */
export const CTFTIME_WINDOW_DAYS = 30;
/** event.decide rows: CTFs and feed events starting within this many days. */
export const EVENT_DECIDE_DAYS = 7;

/* ---------------------------------------------------------------------------
 * #/events: GET /api/events
 * ------------------------------------------------------------------------- */

/** Filter chips 全部 · 要參加 · CTF · 社群 · 從信件找到. */
export const EVENT_FILTERS = ["all", "going", "ctf", "community", "mail"] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

/** One EventCard: a CTF or a feed event, undecided or marked 要參加. */
export interface EventListItem {
  /** The queue item id: `ctftime:<CTFtime id>` or `feed:<feed id>:<key>`; POST /api/actions takes it. */
  id: string;
  category: "ctf" | "community";
  origin: ExternalEventOrigin;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  online?: boolean;
  url?: string;
  organizer?: string;
  /** 「CTFtime」 or the feed's label. */
  sourceLabel: string;
  format?: string;
  weight?: number;
  going: boolean;
  /** The local event 要參加 created. */
  manualEventId?: string;
  /** That local event is also in Google Calendar (or its insert is pending). */
  inGoogle: boolean;
}

/** An event found in a mail (a pending AI suggestion of kind event): 加入行事曆 / 略過. */
export interface EventSuggestionItem {
  /** `ai:<suggestion id>` for POST /api/actions. */
  id: string;
  suggestionId: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
  /** 「KKTIX 報名成功信」 */
  origin?: string;
  /** The mail in Gmail. */
  url?: string;
  createdAt: string;
}

export interface EventSourceState {
  id: "ctftime" | "feeds";
  label: string;
  state: "ok" | "syncing" | "stale" | "error" | "reconnect" | "off";
  lastSyncedAt?: string;
  message?: string;
}

/** GET /api/events */
export interface EventsResponse {
  now: string;
  today: string;
  /** BELLPERSONAL_TZ: the zone days and times on the page are counted in. */
  timeZone: string;
  /** Upcoming (and ongoing) events, nearest first; dismissed (略過) ones are left out. */
  events: EventListItem[];
  suggestions: EventSuggestionItem[];
  sources: EventSourceState[];
  settings: { ctftimeEnabled: boolean; minWeight: number; addToGoogle: boolean };
  google: { canWrite: boolean };
  /** Event feeds subscribed (target events). */
  feeds: number;
}
