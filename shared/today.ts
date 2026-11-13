import type { AppSettings } from "./settings.js";
import type { DayKey } from "./time.js";

/**
 * The Today page data contract (docs/design/SPEC-ux.md §12). `GET /api/today`
 * returns a `TodayPayload`; its `counts` are the single source of truth for the
 * H1, nav badges, quickbar badge, progress meter and queue footer.
 *
 * Two halves:
 *  - TodayPayload: what the browser receives (built by the core).
 *  - TodayContribution: what each feature module's `today()` returns. The core
 *    merges every contribution, applies item state (snoozed, dismissed,
 *    handled), groups and caps the queue and computes the counts with the pure
 *    rules in shared/today-logic.ts. Modules never set a group or a count.
 *
 * Field names may grow (new fields optional) but keep these semantics.
 */
export const QUEUE_GROUPS = ["now", "today", "later"] as const; // 最重要 / 今天內 / 可以等
export type QueueGroup = (typeof QUEUE_GROUPS)[number];

/** Rows shown per group before the 「還有 N 件 · 顯示全部」 row (SPEC §4.3). */
export const QUEUE_GROUP_CAPS: Record<QueueGroup, number> = { now: 5, today: 5, later: 3 };
/** event.decide rows kept in the queue at all (nearest first); the rest stay on #/events. */
export const EVENT_DECIDE_LIMIT = 2;

export const QUEUE_KINDS = [
  "mail.reply", "mail.bill", "mail.action", "assignment", "review", "pr.changes",
  "todo", "suggestion.event", "suggestion.todo", "suggestion.assignment", "event.decide",
] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export const ACTION_IDS = [
  "reply", "open", "archive", "read", "todo", "snooze", "done", "submitted",
  "reviewed", "calendar", "going", "dismiss", "schedule",
  // SPEC-mail-assignments §1.3: 刪除 (Gmail trash), 移回收件匣, 轉成作業 / 加入作業.
  "trash", "unarchive", "assignment",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

/**
 * The prefix of every queue item id (`${source}:${sourceId}`) and the key the
 * core routes actions by. Owners: gmail → gmail module; moodle, canvas → lms;
 * github → github; native → todos; ctftime, feed → events; ai → the core
 * (pending AI suggestions, accepted through `suggestionActions`); assignment →
 * lms (assignments from mail or added by hand, `assignment:<uuid>`).
 */
export const QUEUE_SOURCES = ["gmail", "moodle", "canvas", "github", "native", "ctftime", "feed", "ai", "assignment"] as const;
export type QueueSource = (typeof QUEUE_SOURCES)[number];

/** The kbd a row action advertises (SPEC-ux §6.2; `#` 刪除 and `A` 轉成作業 from SPEC-mail-assignments §6). */
export const QUEUE_ACTION_KEYS = ["Enter", "E", "S", "T", "C", "#", "A"] as const;
export type QueueActionKey = (typeof QUEUE_ACTION_KEYS)[number];

export interface QueueAction {
  id: ActionId;
  label: string;
  touchLabel: string;
  key?: QueueActionKey;
}

export type WhenTone = "hot" | "warm" | "muted";

export interface QueueItem {
  /** `${source}:${sourceId}`, stable across syncs. */
  id: string;
  kind: QueueKind;
  group: QueueGroup;
  source: QueueSource;
  title: string;
  /**
   * What the row is about when `title` is a question (event.decide: the event
   * name for 「Balsn CTF 2026，要參加嗎？」), for toasts and the handled list.
   */
  subject?: string;
  /** The UI joins meta with " · ". */
  meta: string[];
  /** mail.reply from a person */
  avatar?: { initial: string };
  /** The right-column phrase (SPEC §10 time phrasing); `mono` for HH:MM. No tone = the default `.when` style. */
  when?: { label: string; tone?: WhenTone; mono: boolean };
  summary?: string;
  summarySource?: "ai" | "rule";
  /** actions[0] is the primary action. */
  actions: QueueAction[];
  /** External open target. */
  url?: string;
  /** ISO; latest allowed snooze (deadline − 2 h). Snoozing past it is refused. */
  snoozeLimit?: string;
  /** mail.reply after 回覆: the row stays, marked 回覆中…, until the mail module sees the sent reply. */
  replying?: boolean;
  /** review / pr.changes: lines added and removed (rendered as `.add` / `.del`). */
  diff?: { add: number; del: number };
}

export interface TodayAgendaItem {
  start: string;
  end?: string;
  title: string;
  meta: string;
  kind: "event" | "due";
  /** Name of the habit this event checks in (健身 → 運動). */
  habitLink?: string;
  /** The habit's id, so 「打卡「運動」」 can toggle it. */
  habitId?: string;
  /** Set by the core: the item ended (or, for a deadline, passed) before now. */
  past: boolean;
  allDay?: boolean;
  /** A queue item the row belongs to (a deadline row for an assignment). */
  itemId?: string;
  /** Shown as free at its source (顯示為有空): listed, but it does not shorten the free slot. */
  transparent?: boolean;
}

export interface TodayHabit {
  id: string;
  name: string;
  /** 2–4 characters for the ≤1080 chips. */
  short: string;
  /** 「今天 07:50 完成」 / 「每週 3 次 · 0/3」 / 「每天 · 睡前」 */
  cadence: string;
  doneToday: boolean;
  /** Seven days ending today (oldest first): done, missed, or not required that day. */
  week: ("y" | "n" | "rest")[];
  streak: number;
  streakUnit: "天" | "週";
  /** False when nothing is expected today (weekly goal met, weekend for weekday habits). Default true. */
  due?: boolean;
}

export type TodaySourceState = "ok" | "syncing" | "stale" | "error" | "reconnect" | "off";

export interface TodaySource {
  /** A SourceId (gmail, google-calendar…) or, for a module without a source whose today() failed, the module name. */
  id: string;
  label: string;
  state: TodaySourceState;
  lastSyncedAt?: string;
  /** zh-TW, redacted; set for error and reconnect. */
  message?: string;
}

export type BriefState = "ready" | "generating" | "fallback" | "off";

/** The four reasons the fallback note may give (SPEC §4.2). */
/** SPEC §4.2 reasons, plus a usage or rate limit and an interrupted connection (transient: retried later the same day). */
export const BRIEF_FALLBACK_REASONS = ["Claude 尚未登入", "Codex 尚未登入", "產生逾時", "回應格式不正確", "額度已達上限", "暫時無法連線"] as const;
export type BriefFallbackReason = (typeof BRIEF_FALLBACK_REASONS)[number];

export interface TodayBrief {
  /** ready: AI text. generating: a job is running (text is the rule brief meanwhile). fallback: AI failed. off: AI disabled. */
  state: BriefState;
  /** Always present: the AI text when ready, otherwise the rule brief. */
  text: string;
  source: "ai" | "rule";
  generatedAt?: string;
  reason?: BriefFallbackReason;
  /** Local "HH:MM" of the next automatic brief, for the end mark; absent when AI is off. */
  next?: string;
}

export type HandledKind = "reply" | "done" | "snooze" | "calendar";

/** One item closed today, for the queue footer's 「顯示」 list. */
export interface HandledItem {
  itemId: string;
  kind: QueueKind;
  title: string;
  action: ActionId;
  at: string;
  actionId: string;
  /** Whether DELETE /api/actions/:actionId can still revert it. */
  undoable: boolean;
}

export interface LaterEvent {
  /** "10/13" */
  date: string;
  /** 「明天」 or 「週六」 */
  label: string;
  title: string;
  meta: string;
  /** ISO start, for ordering. */
  start?: string;
}

export interface LaterProject {
  name: string;
  pct?: number;
  /** 「下一步：…」 text without the prefix, or the PR meta line. */
  next: string;
  /** A ProjectColor token name (task, event, accent…). */
  color?: string;
  pr?: boolean;
  /** Deep link: `#/work/projects/<id>` or the PR URL. */
  href?: string;
}

export interface SidebarProject {
  id: string;
  name: string;
  pct: number;
  color: string;
}

export interface TodayCounts {
  /** Items currently in the queue (all groups, display caps ignored). */
  open: number;
  /** Distinct items closed today by any action (snooze and 略過 included) that are not open again. */
  handled: number;
  /** open + handled. */
  total: number;
  handledBy: Record<HandledKind, number>;
  inboxUnread: number;
  /** Habits still expected today. Never part of `total`. */
  habitsLeft: number;
  /** Sidebar badges owned by modules: 待辦 open todos, 作業與專案 (due ≤ 7 d + review requests), 活動 new suggestions. */
  nav?: { tasks: number; work: number; events: number };
}

export interface TodayGap {
  start: string;
  end?: string;
  /** Whole or half hours. */
  hours: number;
  forItemId: string;
  /** 「適合寫 HW3」 */
  label: string;
  /** The item's estimate when shorter than the gap: 排進 blocks this long. */
  estimateMinutes?: number;
}

export interface TodayPayload {
  /** Today's local DayKey. */
  date: DayKey;
  now: string;
  greeting: "早安" | "午安" | "辛苦了";
  weather?: { city: string; tempC: number; text: string; rain?: { from: string; pct: number } };
  brief: TodayBrief;
  counts: TodayCounts;
  /** Only when handled >= 3 and open > 0. */
  paceMinutes?: number;
  nextUp?: { start: string; title: string };
  /** Always the three groups in order. `items` is complete; the UI shows the first items.length − hidden until 顯示全部. */
  queue: { group: QueueGroup; items: QueueItem[]; hidden: number; cap?: number }[];
  digest?: { total: number; categories: DigestCategory[] };
  agenda: { items: TodayAgendaItem[]; gap?: TodayGap };
  habits: TodayHabit[];
  /** Latest 2. */
  ideas: { id: string; text: string; at: string }[];
  later: { events: LaterEvent[]; projects: LaterProject[] };
  sources: TodaySource[];
  /** Items closed today, newest first. */
  handled?: HandledItem[];
  sidebar?: { projects: SidebarProject[]; streakDays?: number };
  /**
   * Open todos with no due day that were created before today's local day (so something captured a minute ago never
   * nags). Absent at 0. It never changes `counts`, the queue or the nav badges: Today shows one quiet line under the
   * queue (「還有 3 件待辦沒排日期」) that opens #/tasks on the undated group.
   */
  backlog?: { undatedTodos: number };
}

/* ---------------------------------------------------------------------------
 * Module side: what `today()` returns (server/modules.ts ModuleParts.today).
 * ------------------------------------------------------------------------- */

/**
 * Grouping inputs a module attaches to each queue candidate (SPEC §4.3). The
 * core decides the group from these and the kind; a module never picks one.
 */
export interface QueueHints {
  /** ISO deadline: assignment due, bill due (end of that day), todo due time (end of day when there is no time). */
  dueAt?: string;
  /** A deadline that cannot move (assignments, bills, high-priority todos): within 24 h it is 最重要. */
  hardDeadline?: boolean;
  /** When it arrived (mail received, review requested): order and the review 24 h rule. */
  receivedAt?: string;
  /** mail.reply only: triage priority high, or (rule fallback) IMPORTANT and not automated. */
  important?: boolean;
  /** AI rank inside its group (1 first); the AI never moves an item across groups. */
  rank?: number;
  /** event.decide: when the event starts (the nearest two are kept). */
  startsAt?: string;
  /**
   * Changes whenever the source item meaningfully changes (due date, submission
   * state, a new review request). An item closed "until change" (標為已交,
   * 標為已審查, handled) comes back when its fingerprint differs.
   */
  fingerprint?: string;
}

/** A queue row before grouping: a QueueItem without `group`, plus hints. */
export interface QueueCandidate extends Omit<QueueItem, "group"> {
  hints: QueueHints;
}

/** Work that may fill today's free slot (SPEC §4.8). The core pairs the slot with the first one that is open in the queue. */
export interface GapCandidate {
  itemId: string;
  /** 「適合寫 HW3」 */
  label: string;
  dueAt: string;
  estimateMinutes?: number;
}

/** A today() agenda row: the core sets `past`. */
export type AgendaContribution = Omit<TodayAgendaItem, "past">;

/** 明天與之後 rows: the core keeps those not in the queue, from tomorrow on, nearest first, at most 3. */
export interface LaterEventContribution {
  /** ISO start (all-day: local midnight). */
  start: string;
  title: string;
  /** 「地點 · 來源」 */
  meta: string;
  /** Hidden when this queue item is open. */
  itemId?: string;
}

/** One digest strip category (SPEC-ux §4.4). */
export interface DigestCategory {
  key: string;
  label: string;
  count: number;
  action: ActionId;
  /** Where 逐類看 (`open`) goes: the connected account's Gmail inbox. Optional: older fixtures have none. */
  url?: string;
}

/**
 * What a module's today() returns. Every field is optional; the core merges
 * contributions in registry order (first wins for weather and brief; lists
 * are concatenated; numbers are summed).
 */
export interface TodayContribution {
  queue?: QueueCandidate[];
  agenda?: AgendaContribution[];
  gapCandidates?: GapCandidate[];
  /** Digest categories (mail module); merged by key. */
  digest?: DigestCategory[];
  inboxUnread?: number;
  habits?: TodayHabit[];
  ideas?: { id: string; text: string; at: string }[];
  later?: { events?: LaterEventContribution[]; projects?: LaterProject[] };
  weather?: NonNullable<TodayPayload["weather"]>;
  /** The brief module's state; the core fills `text` with the rule brief unless state is ready. */
  brief?: Omit<TodayBrief, "text" | "source" | "next"> & { text?: string };
  /** Upcoming events today or tomorrow (the agenda's events are candidates too). */
  nextUp?: { start: string; title: string }[];
  /** Sidebar PROJECTS (up to 5 shown) and the streak card. */
  sidebar?: { projects?: SidebarProject[]; streakDays?: number };
  /** Module-owned nav badges; summed per key. */
  nav?: Partial<NonNullable<TodayCounts["nav"]>>;
  /** Undated open todos created before today (todos module); summed. The core sets `TodayPayload.backlog` when the sum is above 0. */
  backlog?: { undatedTodos?: number };
}

/** The second argument of today(). */
export interface TodayInput {
  /** Today's local DayKey in BELLPERSONAL_TZ. */
  day: DayKey;
  now: Date;
  timeZone: string;
  settings: AppSettings;
  /** Aborted when the per-module deadline passes; stop work and return. */
  signal: AbortSignal;
}

/* ---------------------------------------------------------------------------
 * Actions: POST /api/actions, DELETE /api/actions/:actionId.
 * ------------------------------------------------------------------------- */

export interface ActionRequestBody {
  itemId: string;
  action: ActionId;
  /** snooze: { until: ISO }. Others are defined by the owning module. */
  params?: Record<string, unknown>;
}

/** What an action created or reused (轉成作業, 加入作業): the toast names what was saved, not what the page guessed. */
export interface ActionCreated {
  title: string;
  /** ISO deadline; null without one. */
  dueAt?: string | null;
  /** The deadline is a day (23:59), not a time the mail named. */
  dueDateOnly?: boolean;
}

/** 202 from POST /api/actions. Show the undo toast until `undoUntil`. */
export interface ActionAccepted {
  actionId: string;
  /** ISO; the remote write (if any) commits at this instant. Equal to the request time when nothing can be undone. */
  undoUntil: string;
  label: string;
  /** The record the action created or reused, when it makes one. */
  created?: ActionCreated;
}

export const ACTION_STATES = ["applied", "pending", "committed", "undone", "failed", "logged"] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/** GET /api/actions/:actionId — poll once after undoUntil to learn whether the remote write failed. */
export interface ActionStatus {
  actionId: string;
  itemId: string;
  action: ActionId;
  state: ActionState;
  at: string;
  undoUntil: string;
  /** zh-TW, set when state is failed. */
  error?: string;
}
