import type { GitHubItem } from "../../../shared/github.js";
import { dayKey, daysBetween } from "../../../shared/time.js";
import type { LaterProject, QueueCandidate, TodayContribution, TodayInput } from "../../../shared/today.js";
import { queueAction, receivedWhen } from "../../../shared/today-format.js";
import type { ModuleContext } from "../../modules.js";
import type { ItemStateRow } from "../../today/item-state.js";

/** My PRs waiting this long for review appear in 專案 (SPEC-ux §4.5). */
export const PR_WAITING_DAYS = 2;

export function cachedGitHubItems(ctx: Pick<ModuleContext, "sourceItems">): GitHubItem[] {
  return ctx.sourceItems.list<GitHubItem>({ source: "github", kind: "github-item" }).map((item) => item.value);
}

/** `review-request:PR_x` → `PR_x` (the Today id is `github:PR_x`). */
export function nodeIdOf(item: Pick<GitHubItem, "id">): string {
  return item.id.slice(item.id.indexOf(":") + 1);
}

export function queueIdOf(item: Pick<GitHubItem, "id">): string {
  return `github:${nodeIdOf(item)}`;
}

/** A review request comes back when it is requested again. */
export function reviewFingerprint(item: GitHubItem): string {
  return item.requestedAt ?? item.updatedAt;
}

export function needsChanges(item: GitHubItem): boolean {
  return item.kind === "pr" && !item.isDraft && (item.reviewDecision === "CHANGES_REQUESTED" || item.checks === "FAILURE" || item.checks === "ERROR");
}

export function prChangesFingerprint(item: GitHubItem): string {
  return `${item.reviewDecision ?? "none"}|${item.checks ?? "none"}|${item.changesRequestedAt ?? item.updatedAt}`;
}

/** Whether 標為已審查 (or 略過) currently hides this request. */
export function reviewedLocally(state: ItemStateRow | undefined, item: GitHubItem): boolean {
  return !!state && state.state === "dismissed" && (state.fingerprint === null || state.fingerprint === reviewFingerprint(item));
}

function waitingDays(item: GitHubItem, now: Date, timeZone: string): number {
  return daysBetween(dayKey(timeZone, item.createdAt ?? item.updatedAt), dayKey(timeZone, now));
}

/** My open PRs nobody has reviewed yet, oldest first. */
export function waitingPullRequests(items: GitHubItem[], now: Date, timeZone: string): GitHubItem[] {
  return items
    .filter((item) => item.kind === "pr" && !item.isDraft && !needsChanges(item) && item.reviewDecision !== "APPROVED")
    .filter((item) => waitingDays(item, now, timeZone) > PR_WAITING_DAYS)
    .sort((a, b) => Date.parse(a.createdAt ?? a.updatedAt) - Date.parse(b.createdAt ?? b.updatedAt));
}

/**
 * The github module's part of GET /api/today (docs/ARCHITECTURE.md §10.2):
 *  - `review` rows for review requests (> 24 h old → 最重要, else 今天內; the
 *    core decides from hints.receivedAt), fingerprint = request time;
 *  - `pr.changes` rows for my PRs with changes requested or failing checks;
 *  - later.projects: my PRs waiting more than 2 days (`pr: true`);
 *  - nav.work: review requests not marked 已審查.
 */
export function githubToday(ctx: Pick<ModuleContext, "sourceItems" | "itemState">, input: Pick<TodayInput, "now" | "timeZone">): TodayContribution {
  const { now, timeZone } = input;
  const items = cachedGitHubItems(ctx);
  const queue: QueueCandidate[] = [];
  let work = 0;

  for (const item of items) {
    if (item.kind === "review-request") {
      const receivedAt = item.requestedAt ?? item.updatedAt;
      const id = queueIdOf(item);
      queue.push({
        id,
        kind: "review",
        source: "github",
        title: `審查 ${item.number !== undefined ? `#${item.number} ` : ""}${item.title}`.slice(0, 280),
        meta: [item.repo, item.author ? `${item.author} 請你審查` : "請你審查"],
        ...(typeof item.additions === "number" && typeof item.deletions === "number" ? { diff: { add: item.additions, del: item.deletions } } : {}),
        when: receivedWhen(receivedAt, now, timeZone),
        actions: [queueAction("open", { label: "開始審查", touchLabel: "審查" }), queueAction("reviewed"), queueAction("snooze")],
        url: item.url,
        hints: { receivedAt, fingerprint: reviewFingerprint(item) },
      });
      if (!reviewedLocally(ctx.itemState.get(id), item)) work++;
    } else if (needsChanges(item)) {
      const receivedAt = item.changesRequestedAt ?? item.updatedAt;
      queue.push({
        id: queueIdOf(item),
        kind: "pr.changes",
        source: "github",
        title: `修改 ${item.number !== undefined ? `#${item.number} ` : ""}${item.title}`.slice(0, 280),
        meta: [item.repo, item.reviewDecision === "CHANGES_REQUESTED" ? `${item.changesRequestedBy ?? "審查者"} 要求修改` : "檢查沒有通過"],
        when: receivedWhen(receivedAt, now, timeZone),
        actions: [queueAction("open"), queueAction("snooze")],
        url: item.url,
        hints: { receivedAt, fingerprint: prChangesFingerprint(item) },
      });
    }
  }

  const projects: LaterProject[] = waitingPullRequests(items, now, timeZone).map((item) => ({
    name: `${item.repo}${item.number !== undefined ? ` #${item.number}` : ""}`,
    next: `${item.title} · 等待審查 ${waitingDays(item, now, timeZone)} 天`,
    pr: true,
    href: item.url,
  }));

  return {
    queue,
    ...(projects.length ? { later: { projects } } : {}),
    nav: { work },
  };
}
