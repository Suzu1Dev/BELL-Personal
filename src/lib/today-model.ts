/**
 * Pure helpers over the Today contract (shared/today.ts): undo for the
 * optimistic queue update, the numbers the shell shows, and the async steps
 * after an action or a sync. Counts always come from `TodayPayload.counts`
 * (SPEC-ux §4.3 "one store"); these helpers only adjust them optimistically
 * or pick them out, never recompute them from items. The optimistic step
 * itself is `applyActionToPayload` in shared/today-logic.ts, which the
 * server's dev fixture override replays too, so both follow ACTION_EFFECTS.
 */
import type { SourceStatus } from "../../shared/sources";
import { weekdayOf } from "../../shared/time";
import type { ActionCreated, ActionId, ActionStatus, QueueItem, TodayPayload, TodaySource } from "../../shared/today";
import { metaDeadline } from "../../shared/today-format";
import { ACTION_EFFECTS, hiddenRows } from "../../shared/today-logic";
import { ACTION_TOASTS, WEEKDAYS_EN } from "../copy/common";

export function findQueueItem(payload: TodayPayload | undefined, itemId: string): QueueItem | undefined {
  for (const group of payload?.queue ?? []) {
    const item = group.items.find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  return undefined;
}

/**
 * The title an action's toast quotes: suggestions quote their first meta (the event or todo name),
 * a row whose title is a question (「Balsn CTF 2026，要參加嗎？」) its subject, a free slot its row.
 */
export function itemTitle(item: QueueItem | undefined, payload: TodayPayload | undefined, itemId: string): string {
  if (item) return item.subject ?? (item.kind.startsWith("suggestion.") && item.meta[0] ? item.meta[0] : item.title);
  const gap = payload?.agenda.gap;
  if (gap && gap.forItemId === itemId) return findQueueItem(payload, itemId)?.title ?? gap.label;
  return "";
}

/** Where a row sat before an action, so 復原 can put it back in place. */
export interface QueueSnapshot {
  item: QueueItem;
  group: QueueItem["group"];
  index: number;
  action: ActionId;
}

export function snapshotQueueItem(payload: TodayPayload | undefined, itemId: string, action: ActionId): QueueSnapshot | undefined {
  for (const group of payload?.queue ?? []) {
    const index = group.items.findIndex((candidate) => candidate.id === itemId);
    if (index >= 0) return { item: group.items[index], group: group.group, index, action };
  }
  return undefined;
}

/**
 * The inverse of applyActionToPayload for 復原 on a closing action:
 * re-inserts the row at its old position and moves the count back from
 * handled to open. A no-op when the row is already back (the server restored
 * it first) or the action never took it out.
 */
export function restoreQueueItem(payload: TodayPayload, snapshot: QueueSnapshot): TodayPayload {
  const effect = ACTION_EFFECTS[snapshot.action];
  if (!effect.closes || findQueueItem(payload, snapshot.item.id)) return payload;
  const target = payload.queue.find((group) => group.group === snapshot.group);
  const queue = target
    ? payload.queue.map((group) => {
      if (group !== target) return group;
      const items = [...group.items];
      items.splice(Math.min(snapshot.index, items.length), 0, snapshot.item);
      return { ...group, items, hidden: hiddenRows(group, items.length) };
    })
    : [...payload.queue, { group: snapshot.group, items: [snapshot.item], hidden: 0 }];
  const bucket = effect.handledKind ?? "done";
  const counts = payload.counts;
  const readsMail = snapshot.item.kind.startsWith("mail.") && (snapshot.action === "archive" || snapshot.action === "read");
  return {
    ...payload,
    queue,
    counts: {
      ...counts,
      open: counts.open + 1,
      handled: Math.max(0, counts.handled - 1),
      handledBy: { ...counts.handledBy, [bucket]: Math.max(0, counts.handledBy[bucket] - 1) },
      inboxUnread: readsMail ? counts.inboxUnread + 1 : counts.inboxUnread,
    },
  };
}

/**
 * Nav counts for the sidebar and quickbar, picked from `counts` (never
 * recomputed): 今天 = open, 收件匣 = inboxUnread, 習慣 = habitsLeft, and the
 * module-owned 待辦 / 作業與專案 / 活動 badges from `counts.nav` when the
 * server sends it (absent or 0 = no badge).
 */
export interface NavCounts {
  today?: number;
  inbox?: number;
  tasks?: number;
  work?: number;
  events?: number;
  habits?: number;
}

const asCount = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);

export function navCounts(payload: TodayPayload | undefined): NavCounts {
  if (!payload) return {};
  const { counts } = payload;
  return {
    today: asCount(counts.open),
    inbox: asCount(counts.inboxUnread),
    tasks: asCount(counts.nav?.tasks),
    work: asCount(counts.nav?.work),
    events: asCount(counts.nav?.events),
    habits: asCount(counts.habitsLeft),
  };
}

/** Module colour names a project may use (shared/projects.ts PROJECT_COLORS) → the CSS variable. */
const PROJECT_COLOR_VARS: Readonly<Record<string, string>> = {
  accent: "var(--accent)",
  mail: "var(--m-mail)",
  cal: "var(--m-cal)",
  task: "var(--m-task)",
  event: "var(--m-event)",
  idea: "var(--m-idea)",
  habit: "var(--m-habit)",
};

export function projectColorVar(color: string | undefined): string {
  return (color && PROJECT_COLOR_VARS[color]) || PROJECT_COLOR_VARS.task;
}

export interface SidebarProject {
  name: string;
  pct?: number;
  colorVar: string;
  href: string;
}

const clampPct = (pct: number | undefined) => (typeof pct === "number" ? Math.max(0, Math.min(100, Math.round(pct))) : undefined);
const projectHref = (id: string | undefined) => (id ? `#/work/projects/${encodeURIComponent(id)}` : "#/work?tab=projects");

/**
 * Up to 5 projects for the sidebar PROJECTS list: the server's
 * `sidebar.projects` when it sends a sidebar (the projects module decides
 * which), otherwise the native rows of the later card (PR rows skipped).
 */
export function sidebarProjects(payload: TodayPayload | undefined): SidebarProject[] {
  if (!payload) return [];
  if (payload.sidebar) {
    return payload.sidebar.projects.slice(0, 5).map((project) => ({
      name: project.name,
      pct: clampPct(project.pct),
      colorVar: projectColorVar(project.color),
      href: projectHref(project.id),
    }));
  }
  return payload.later.projects
    .filter((project) => !project.pr)
    .slice(0, 5)
    .map((project) => ({
      name: project.name,
      pct: clampPct(project.pct),
      colorVar: projectColorVar(project.color),
      href: project.href?.startsWith("#/") ? project.href : projectHref(undefined),
    }));
}

/**
 * The sidebar streak: `sidebar.streakDays` when the server sends it,
 * otherwise the days every daily habit has been kept (the shortest daily
 * streak). Undefined when there are no daily habits to speak of.
 */
export function streakDays(payload: TodayPayload | undefined): number | undefined {
  if (!payload) return undefined;
  const explicit = asCount(payload.sidebar?.streakDays);
  if (explicit !== undefined) return explicit;
  const daily = payload.habits.filter((habit) => habit.streakUnit === "天");
  if (!daily.length) return undefined;
  return Math.min(...daily.map((habit) => Math.max(0, habit.streak)));
}

/** Waits used by the async helpers below; tests pass a fake. */
export type Wait = (ms: number) => Promise<void>;

/**
 * Whether the user sees an undo toast for an action: only when it visibly
 * took something away (a closing action, 排進 taking the free slot, or
 * 移回收件匣 taking a conversation out of 封存, SPEC-mail-assignments §2.5).
 * 回覆 and 開啟 keep the row and have nothing to undo (SPEC-ux §6.4).
 */
/**
 * The 轉成作業 / 加入作業 toast from what the server saved (ActionAccepted.created):
 * the toast is the only confirmation, so once the answer is in it names the
 * record's title and deadline, not the page's guess (SPEC-mail-assignments §5.6).
 */
export function createdToast(created: ActionCreated, now: Date, timeZone: string): string {
  const when = created.dueAt ? metaDeadline(created.dueAt, now, timeZone, { dateOnly: !!created.dueDateOnly }) : undefined;
  return ACTION_TOASTS.assignment(created.title, when);
}

/**
 * A deferred remote write that failed (`remoteFailure` answered a reason):
 * the caller's own optimistic edits go first (`onFailed`: #/inbox's page
 * edits, which Today's refresh does not touch), then the error toast with
 * 重試 and a refresh. Nothing when the write went through (undefined).
 */
export function reportRemoteFailure(failure: string | undefined, handlers: { onFailed?: () => void; error: (reason: string) => void; refresh: () => void }): boolean {
  if (failure === undefined) return false;
  handlers.onFailed?.();
  handlers.error(failure);
  handlers.refresh();
  return true;
}

export function offersUndo(action: ActionId): boolean {
  return ACTION_EFFECTS[action].closes || action === "schedule" || action === "unarchive";
}

/**
 * The deferred remote write's outcome (SPEC-ux §6.5, ARCHITECTURE §10.3):
 * after `undoUntil` plus a grace period, read GET /api/actions/:id; while it
 * is still `pending` (the remote call is running) read again a few times.
 * Returns the zh-TW error when the write failed (the server has already put
 * the row back), otherwise undefined — also when the status cannot be read.
 */
export async function remoteFailure(
  read: () => Promise<ActionStatus | undefined>,
  wait: Wait,
  { delayMs, retryMs = 2_000, tries = 4 }: { delayMs: number; retryMs?: number; tries?: number },
): Promise<string | undefined> {
  await wait(Math.max(0, delayMs));
  for (let attempt = 0; attempt < tries; attempt++) {
    const status = await read();
    if (!status) return undefined;
    if (status.state === "failed") return status.error ?? "";
    if (status.state !== "pending") return undefined;
    await wait(retryMs);
  }
  return undefined;
}

/**
 * After POST /api/sync started some sources: refresh Today every
 * `intervalMs` (new rows appear) until none of them is still syncing in
 * `sources()`, at most `tries` times. The caller then refreshes the status.
 */
export async function followSync(
  started: readonly string[],
  deps: { refresh: () => Promise<void>; sources: () => TodaySource[] | undefined; wait: Wait },
  { intervalMs = 3_000, tries = 10 }: { intervalMs?: number; tries?: number } = {},
): Promise<void> {
  if (!started.length) return;
  for (let attempt = 0; attempt < tries; attempt++) {
    await deps.wait(intervalMs);
    await deps.refresh();
    const syncing = (deps.sources() ?? []).some((source) => started.includes(source.id) && source.state === "syncing");
    if (!syncing) return;
  }
}

export type SyncChipState =
  | { kind: "ok"; at: string }
  | { kind: "syncing" }
  | { kind: "warn"; count: number }
  | { kind: "none" }
  | { kind: "offline" };

/**
 * The topbar sync chip from `GET /api/status` sources (SPEC-ux §3.2, §5):
 * warn when any configured source needs a reconnect or failed, 同步中 while
 * one is syncing, else 已同步 with the latest successful sync time.
 */
export function syncChipState(sources: SourceStatus[] | undefined, failed: boolean): SyncChipState {
  if (!sources) return failed ? { kind: "offline" } : { kind: "syncing" };
  const active = sources.filter((source) => source.configured && source.state !== "not_configured" && source.state !== "disabled");
  const broken = active.filter((source) => source.state === "needs_reconnect" || source.state === "error").length;
  if (broken) return { kind: "warn", count: broken };
  if (active.some((source) => source.state === "syncing")) return { kind: "syncing" };
  const latest = active.map((source) => source.lastSyncedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  if (!latest) return active.length ? { kind: "syncing" } : { kind: "none" };
  return { kind: "ok", at: latest };
}

/** The Today eyebrow date: "2026-10-12" → "MON · 10/12" (SPEC-ux §4.2). */
export function dayEyebrow(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return "";
  const weekday = WEEKDAYS_EN[weekdayOf(day)];
  return `${weekday} · ${Number(match[2])}/${Number(match[3])}`;
}

/** `HH:MM` in Asia/Taipei (SPEC-ux §10: all dates through Intl.DateTimeFormat). */
export function clockTime(iso: string, timeZone = "Asia/Taipei"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-TW", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}
