import { z } from "zod";
import {
  ACTION_IDS, BRIEF_FALLBACK_REASONS, QUEUE_ACTION_KEYS, QUEUE_GROUPS, QUEUE_KINDS, QUEUE_SOURCES,
  type TodayContribution, type TodayPayload,
} from "../../shared/today.js";

/**
 * Runtime shapes of the Today contract. Module contributions are checked
 * before merging, so a module returning a malformed value is treated like a
 * module that threw (its sources turn to error; the page still renders), and
 * the dev fixtures (BELLPERSONAL_TODAY_FIXTURE, server/fixtures/today-*.json)
 * are checked against the payload shape.
 */

const iso = z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "ISO 時間格式不正確" });
const text = (max: number) => z.string().max(max);

const queueAction = z.object({
  id: z.enum(ACTION_IDS),
  label: text(40),
  touchLabel: text(20),
  key: z.enum(QUEUE_ACTION_KEYS).optional(),
});

const queueItemBase = {
  id: z.string().min(3).max(600).regex(/^[a-z]+:.+$/),
  kind: z.enum(QUEUE_KINDS),
  source: z.enum(QUEUE_SOURCES),
  title: text(300),
  subject: text(300).optional(),
  meta: z.array(text(300)).max(8),
  avatar: z.object({ initial: text(4) }).optional(),
  when: z.object({ label: text(40), tone: z.enum(["hot", "warm", "muted"]).optional(), mono: z.boolean() }).optional(),
  summary: text(600).optional(),
  summarySource: z.enum(["ai", "rule"]).optional(),
  actions: z.array(queueAction).min(1).max(8),
  url: text(2000).optional(),
  snoozeLimit: iso.optional(),
  replying: z.boolean().optional(),
  diff: z.object({ add: z.number().int().min(0), del: z.number().int().min(0) }).optional(),
};

const queueCandidate = z.object({
  ...queueItemBase,
  hints: z.object({
    dueAt: iso.optional(),
    hardDeadline: z.boolean().optional(),
    receivedAt: iso.optional(),
    important: z.boolean().optional(),
    rank: z.number().optional(),
    startsAt: iso.optional(),
    fingerprint: text(500).optional(),
  }),
}).refine((item) => item.id.startsWith(`${item.source}:`), { message: "id 必須以 source: 開頭" });

const agendaBase = {
  start: iso,
  end: iso.optional(),
  title: text(300),
  meta: text(300),
  kind: z.enum(["event", "due"]),
  habitLink: text(40).optional(),
  habitId: text(100).optional(),
  allDay: z.boolean().optional(),
  itemId: text(600).optional(),
  transparent: z.boolean().optional(),
};

const habit = z.object({
  id: text(100),
  name: text(80),
  short: text(8),
  cadence: text(60),
  doneToday: z.boolean(),
  week: z.array(z.enum(["y", "n", "rest"])).length(7),
  streak: z.number().int().min(0),
  streakUnit: z.enum(["天", "週"]),
  due: z.boolean().optional(),
});

const idea = z.object({ id: text(100), text: text(8000), at: iso });
const digestCategory = z.object({ key: text(40), label: text(40), count: z.number().int().min(0), action: z.enum(ACTION_IDS), url: text(2000).optional() });
const laterProject = z.object({ name: text(160), pct: z.number().min(0).max(100).optional(), next: text(300), color: text(20).optional(), pr: z.boolean().optional(), href: text(2000).optional() });
const sidebarProject = z.object({ id: text(100), name: text(160), pct: z.number().min(0).max(100), color: text(20) });
const weather = z.object({ city: text(80), tempC: z.number(), text: text(40), rain: z.object({ from: iso, pct: z.number().min(0).max(100) }).optional() });

/** Array caps of a module contribution. TodayService cuts a longer array (and logs it) instead of dropping the module. */
export const CONTRIBUTION_CAPS = {
  queue: 500, agenda: 200, gapCandidates: 100, digest: 20, habits: 50, ideas: 50, nextUp: 100,
  laterEvents: 100, laterProjects: 50, sidebarProjects: 20,
} as const;

/**
 * A contribution with every over-long array cut to its cap, and the names of
 * the arrays that were cut. Lists are cut from the end, so a module should
 * still order and cap its own rows (nearest first); this keeps one busy
 * source from blanking the whole module.
 */
export function capContribution(value: unknown): { value: unknown; capped: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, capped: [] };
  const capped: string[] = [];
  const cut = (list: unknown, max: number, name: string) => {
    if (!Array.isArray(list) || list.length <= max) return list;
    capped.push(name);
    return list.slice(0, max);
  };
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ["queue", "agenda", "gapCandidates", "digest", "habits", "ideas", "nextUp"] as const)
    if (key in out) out[key] = cut(out[key], CONTRIBUTION_CAPS[key], key);
  const later = out.later as Record<string, unknown> | undefined;
  if (later && typeof later === "object") {
    out.later = {
      ...later,
      ...("events" in later ? { events: cut(later.events, CONTRIBUTION_CAPS.laterEvents, "later.events") } : {}),
      ...("projects" in later ? { projects: cut(later.projects, CONTRIBUTION_CAPS.laterProjects, "later.projects") } : {}),
    };
  }
  const sidebar = out.sidebar as Record<string, unknown> | undefined;
  if (sidebar && typeof sidebar === "object" && "projects" in sidebar)
    out.sidebar = { ...sidebar, projects: cut(sidebar.projects, CONTRIBUTION_CAPS.sidebarProjects, "sidebar.projects") };
  return { value: out, capped };
}

export const todayContributionSchema = z.object({
  queue: z.array(queueCandidate).max(CONTRIBUTION_CAPS.queue).optional(),
  agenda: z.array(z.object(agendaBase)).max(CONTRIBUTION_CAPS.agenda).optional(),
  gapCandidates: z.array(z.object({ itemId: text(600), label: text(60), dueAt: iso, estimateMinutes: z.number().int().positive().optional() })).max(CONTRIBUTION_CAPS.gapCandidates).optional(),
  digest: z.array(digestCategory).max(CONTRIBUTION_CAPS.digest).optional(),
  inboxUnread: z.number().int().min(0).optional(),
  habits: z.array(habit).max(CONTRIBUTION_CAPS.habits).optional(),
  ideas: z.array(idea).max(CONTRIBUTION_CAPS.ideas).optional(),
  later: z.object({
    events: z.array(z.object({ start: iso, title: text(300), meta: text(300), itemId: text(600).optional() })).max(CONTRIBUTION_CAPS.laterEvents).optional(),
    projects: z.array(laterProject).max(CONTRIBUTION_CAPS.laterProjects).optional(),
  }).optional(),
  weather: weather.optional(),
  brief: z.object({
    state: z.enum(["ready", "generating", "fallback", "off"]),
    text: text(400).optional(),
    generatedAt: iso.optional(),
    reason: z.enum(BRIEF_FALLBACK_REASONS).optional(),
  }).optional(),
  nextUp: z.array(z.object({ start: iso, title: text(300) })).max(CONTRIBUTION_CAPS.nextUp).optional(),
  sidebar: z.object({ projects: z.array(sidebarProject).max(CONTRIBUTION_CAPS.sidebarProjects).optional(), streakDays: z.number().int().min(0).optional() }).optional(),
  nav: z.object({ tasks: z.number().int().min(0).optional(), work: z.number().int().min(0).optional(), events: z.number().int().min(0).optional() }).optional(),
  backlog: z.object({ undatedTodos: z.number().int().min(0).optional() }).optional(),
}) satisfies z.ZodType<TodayContribution, unknown>;

const count = z.number().int().min(0);

export const todayPayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  now: iso,
  greeting: z.enum(["早安", "午安", "辛苦了"]),
  weather: weather.optional(),
  brief: z.object({
    state: z.enum(["ready", "generating", "fallback", "off"]),
    text: text(400),
    source: z.enum(["ai", "rule"]),
    generatedAt: iso.optional(),
    reason: z.enum(BRIEF_FALLBACK_REASONS).optional(),
    next: z.string().optional(),
  }),
  counts: z.object({
    open: count, handled: count, total: count,
    handledBy: z.object({ reply: count, done: count, snooze: count, calendar: count }),
    inboxUnread: count, habitsLeft: count,
    nav: z.object({ tasks: count, work: count, events: count }).optional(),
  }),
  paceMinutes: z.number().int().min(5).max(120).optional(),
  nextUp: z.object({ start: iso, title: text(300) }).optional(),
  queue: z.array(z.object({
    group: z.enum(QUEUE_GROUPS),
    items: z.array(z.object({ ...queueItemBase, group: z.enum(QUEUE_GROUPS) })),
    hidden: count,
    cap: count.optional(),
  })).length(3),
  digest: z.object({ total: count, categories: z.array(digestCategory) }).optional(),
  agenda: z.object({
    items: z.array(z.object({ ...agendaBase, past: z.boolean() })),
    gap: z.object({ start: iso, end: iso.optional(), hours: z.number().positive(), forItemId: text(600), label: text(60), estimateMinutes: z.number().optional() }).optional(),
  }),
  habits: z.array(habit),
  ideas: z.array(idea).max(2),
  later: z.object({
    events: z.array(z.object({ date: text(10), label: text(10), title: text(300), meta: text(300), start: iso.optional() })).max(3),
    projects: z.array(laterProject).max(3),
  }),
  sources: z.array(z.object({
    id: text(60), label: text(60), state: z.enum(["ok", "syncing", "stale", "error", "reconnect", "off"]), lastSyncedAt: iso.optional(), message: text(300).optional(),
  })),
  handled: z.array(z.object({
    itemId: text(600), kind: z.enum(QUEUE_KINDS), title: text(300), action: z.enum(ACTION_IDS), at: iso, actionId: text(100), undoable: z.boolean(),
  })).optional(),
  sidebar: z.object({ projects: z.array(sidebarProject).max(5), streakDays: count.optional() }).optional(),
  backlog: z.object({ undatedTodos: count }).optional(),
}).strict()
  .refine((payload) => payload.queue.map((group) => group.group).join() === QUEUE_GROUPS.join(), { message: "queue 必須依序包含 now、today、later" })
  .refine((payload) => payload.counts.total === payload.counts.open + payload.counts.handled, { message: "counts.total 必須等於 open + handled" })
  .refine((payload) => payload.counts.open === payload.queue.reduce((sum, group) => sum + group.items.length, 0), { message: "counts.open 必須等於佇列項目數" }) satisfies z.ZodType<TodayPayload, unknown>;
