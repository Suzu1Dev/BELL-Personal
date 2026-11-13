import { UNSORTED_COURSE, isNativeOrigin, type Assignment } from "../../../shared/assignments.js";
import { addDays, dayBounds, dayKey } from "../../../shared/time.js";
import type { AgendaContribution, GapCandidate, LaterEventContribution, QueueAction, QueueCandidate, TodayContribution, TodayInput } from "../../../shared/today.js";
import { deadlineWhen, metaDeadline, queueAction } from "../../../shared/today-format.js";
import type { ModuleContext } from "../../modules.js";
import { assignmentFingerprint, assignmentSite, cachedAssignments, itemIdOf, locallySubmitted, queueSourceOf, shortTitle } from "./lms.js";
import { allAssignments } from "./native.js";

export { cachedAssignments };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Overdue rows stay in 最重要 this long after their deadline. */
export const OVERDUE_DAYS = 7;
/** 明天與之後 looks this far ahead (the core keeps the nearest 3). */
const LATER_DAYS = 14;

/** The course as a row shows it: 「未分類」 is left out of titles and meta. */
const courseOf = (assignment: Assignment) => (assignment.courseName === UNSORTED_COURSE ? undefined : assignment.courseName);

/**
 * The primary action and its link. LMS rows open the course site (new tab);
 * a mail assignment opens its conversation in the app (開啟信件 →
 * `#/inbox/<threadId>`), a manual one opens #/work (SPEC-mail-assignments §5.7).
 */
function primaryOf(assignment: Assignment): { action: QueueAction; url?: string } {
  if (assignment.origin === "mail" && assignment.mailRef)
    return { action: queueAction("open", { label: "開啟信件", touchLabel: "開啟" }), url: `#/inbox/${encodeURIComponent(assignment.mailRef.threadId)}` };
  if (isNativeOrigin(assignment.origin)) return { action: queueAction("open", { label: "開啟", touchLabel: "開啟" }), url: "#/work" };
  const site = assignmentSite(assignment);
  return { action: queueAction("open", { label: `開啟 ${site.short}`, touchLabel: "開啟" }), ...(assignment.url ? { url: assignment.url } : {}) };
}

/**
 * The lms module's part of GET /api/today (docs/ARCHITECTURE.md §10.2), for
 * LMS assignments and native ones (from mail or added by hand, ids
 * `assignment:<uuid>`; a mail assignment an LMS also lists shows once):
 *  - queue: one `assignment` row per not-submitted assignment with a deadline
 *    (the core groups it: overdue or < 24 h → 最重要, < 48 h → 今天內, ≤ 7 d →
 *    可以等, later → left out); fingerprint = due date + submission state;
 *  - gapCandidates: 「適合寫 HW3」 for deadlines within 48 h;
 *  - agenda: 「HW3 截止」 rows for deadlines today;
 *  - later.events: deadlines within 14 days (the core drops those still in the queue);
 *  - nav.work: deadlines within 7 days that were not marked 已交 here.
 * Reads the item cache, local_assignments and item state only.
 */
export function lmsToday(ctx: Pick<ModuleContext, "sourceItems" | "itemState" | "db" | "trash" | "now">, input: Pick<TodayInput, "now" | "timeZone" | "day">): TodayContribution {
  const { now, timeZone, day } = input;
  const queue: QueueCandidate[] = [];
  const gapCandidates: GapCandidate[] = [];
  const agenda: AgendaContribution[] = [];
  const later: LaterEventContribution[] = [];
  let work = 0;
  const tomorrow = Date.parse(dayBounds(timeZone, addDays(day, 1)).start);
  const merged = allAssignments(ctx);

  for (const assignment of [...merged.lms, ...merged.native]) {
    if (!assignment.dueAt || assignment.submission !== "not-submitted") continue;
    const due = Date.parse(assignment.dueAt);
    if (Number.isNaN(due) || due < now.getTime() - OVERDUE_DAYS * DAY) continue;
    const dueAt = new Date(due).toISOString();
    const itemId = itemIdOf(assignment);
    const site = assignmentSite(assignment);
    const course = courseOf(assignment);
    const short = shortTitle(assignment.title);
    const snoozeLimit = due - 2 * HOUR;
    const overdue = due < now.getTime();
    const primary = primaryOf(assignment);

    queue.push({
      id: itemId,
      kind: "assignment",
      source: queueSourceOf(assignment),
      title: (course ? `${course} ${assignment.title}` : assignment.title).slice(0, 280),
      meta: [site.label, ...(course ? [course] : []), metaDeadline(dueAt, now, timeZone), "尚未繳交"],
      when: deadlineWhen(dueAt, now, timeZone),
      actions: [
        primary.action,
        queueAction("submitted"),
        ...(snoozeLimit > now.getTime() + 60_000 ? [queueAction("snooze")] : []),
      ],
      ...(primary.url ? { url: primary.url } : {}),
      ...(snoozeLimit > now.getTime() ? { snoozeLimit: new Date(snoozeLimit).toISOString() } : {}),
      hints: { dueAt, hardDeadline: true, fingerprint: assignmentFingerprint(assignment) },
    });
    if (!overdue && due - now.getTime() <= 48 * HOUR) gapCandidates.push({ itemId, label: `適合寫 ${short}`, dueAt });

    if (locallySubmitted(ctx.itemState.get(itemId), assignment)) continue;
    if (due - now.getTime() <= 7 * DAY) work++;
    const meta = [course, site.label].filter(Boolean).join(" · ");
    if (dayKey(timeZone, dueAt) === day) agenda.push({ start: dueAt, title: `${short} 截止`, meta, kind: "due", itemId });
    else if (due >= tomorrow && due < now.getTime() + LATER_DAYS * DAY) later.push({ start: dueAt, title: `${short} 截止`, meta, itemId });
  }

  return {
    queue,
    ...(gapCandidates.length ? { gapCandidates } : {}),
    ...(agenda.length ? { agenda } : {}),
    ...(later.length ? { later: { events: later } } : {}),
    nav: { work },
  };
}
