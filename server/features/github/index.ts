import { Router } from "express";
import { z } from "zod";
import { GITHUB_LIMITS, type ContributionDay, type GitHubItem, type GitHubItemView, type GitHubOverview } from "../../../shared/github.js";
import { addDays } from "../../../shared/time.js";
import { AppError } from "../../errors.js";
import type { ActionHandler, ActionPlan, FeatureModule, ModuleContext } from "../../modules.js";
import { defaultLabel } from "../../today/actions.js";
import { GitHubSync, runGh } from "./sync.js";
import { cachedGitHubItems, githubToday, needsChanges, prChangesFingerprint, queueIdOf, reviewFingerprint, reviewedLocally } from "./today.js";

const ROW_ACTIONS = new Set(["open", "snooze", "reviewed", "dismiss"]);
const threadsSchema = z.object({
  threads: z.array(z.string().regex(/^\d{1,20}$/, "通知代碼格式不正確")).min(1).max(GITHUB_LIMITS.threadsPerAction),
}).loose();

/** The cached item a `github:<node id>` row stands for. */
function findItem(ctx: Pick<ModuleContext, "sourceItems">, nodeId: string): GitHubItem | undefined {
  for (const kind of ["review-request", "pr", "issue"] as const) {
    const item = ctx.sourceItems.get<GitHubItem>("github", `${kind}:${nodeId}`)?.value;
    if (item) return item;
  }
  return undefined;
}

/** 標為已讀 on notification threads: the cache flips at once, PATCH notifications/threads/:id after the undo window. */
function readPlan(ctx: ModuleContext, source: GitHubSync, threads: string[]): ActionPlan {
  const flip = (unread: boolean) => {
    const rows = threads
      .map((thread) => ctx.sourceItems.get<GitHubItem>("github", `notification:${thread}`))
      .filter((row): row is NonNullable<typeof row> => !!row);
    ctx.sourceItems.upsert("github", rows.map((row) => ({ kind: "github-item" as const, externalId: row.externalId, value: { ...row.value, unread }, updatedAt: row.updatedAt })));
  };
  return {
    label: threads.length === 1 ? "已標為已讀" : `已將 ${threads.length} 則通知標為已讀`,
    apply: () => { source.rememberRead(threads); flip(false); },
    remote: async (signal) => {
      for (const thread of threads) await runGh(ctx, ["api", "--method", "PATCH", `notifications/threads/${thread}`], { signal });
    },
    undo: () => { source.forgetRead(threads); flip(true); },
  };
}

/**
 * actions.github: 開始審查, 延後 and 標為已審查 are generic (the core writes the
 * state); this refuses what a GitHub row does not offer, describes rows
 * Today did not serve (a snoozed review marked in #/work) so the core keeps
 * the fingerprint, and handles 標為已讀 on notification threads
 * (`github:digest-…` targets with params.threads).
 */
export function githubActionHandler(ctx: ModuleContext, source: GitHubSync): ActionHandler {
  return (request) => {
    if (request.action === "read") {
      if (!request.sourceId.startsWith("digest")) throw new AppError(400, "只能把 GitHub 通知標為已讀。");
      return readPlan(ctx, source, threadsSchema.parse(request.params).threads);
    }
    if (!ROW_ACTIONS.has(request.action)) throw new AppError(400, "這個 GitHub 項目不能這樣處理。");
    const label = defaultLabel(request.action);
    if (request.item) return { label };
    const item = findItem(ctx, request.sourceId);
    if (!item) throw new AppError(404, "找不到這個 GitHub 項目，可能已經關閉。");
    if (item.kind === "review-request") return { label, target: { kind: "review", title: `審查 #${item.number ?? ""} ${item.title}`.trim(), fingerprint: reviewFingerprint(item) } };
    if (needsChanges(item)) return { label, target: { kind: "pr.changes", title: `修改 #${item.number ?? ""} ${item.title}`.trim(), fingerprint: prChangesFingerprint(item) } };
    throw new AppError(400, "這個 GitHub 項目不在佇列裡。");
  };
}

function sumSince(days: ContributionDay[], since: string): number {
  return days.filter((day) => day.date >= since).reduce((sum, day) => sum + day.count, 0);
}

/** GET /api/github */
export async function githubOverview(ctx: ModuleContext, source: GitHubSync): Promise<GitHubOverview> {
  const items = cachedGitHubItems(ctx);
  const view = (item: GitHubItem): GitHubItemView => {
    if (item.kind === "notification" || item.kind === "issue") return item;
    const itemId = queueIdOf(item);
    return { ...item, itemId, ...(item.kind === "review-request" && reviewedLocally(ctx.itemState.get(itemId), item) ? { localReviewed: true } : {}) };
  };
  const byTime = (field: "requestedAt" | "updatedAt", direction: 1 | -1) => (a: GitHubItem, b: GitHubItem) =>
    direction * (Date.parse(a[field] ?? a.updatedAt) - Date.parse(b[field] ?? b.updatedAt));
  const days = ctx.sourceItems.list<ContributionDay>({ source: "github", kind: "contribution-day" }).map((item) => item.value);
  const today = ctx.today();
  const login = source.login();
  return {
    status: await source.status(),
    ...(login ? { login } : {}),
    reviewRequests: items.filter((item) => item.kind === "review-request").sort(byTime("requestedAt", 1)).map(view),
    pullRequests: items.filter((item) => item.kind === "pr").sort(byTime("updatedAt", -1)).map(view),
    issues: items.filter((item) => item.kind === "issue").sort(byTime("updatedAt", -1)).map(view),
    notifications: items.filter((item) => item.kind === "notification" && item.unread !== false).sort(byTime("updatedAt", -1)).map(view),
    contributions: { week: sumSince(days, addDays(today, -6)), month: sumSince(days, addDays(today, -29)) },
  };
}

/**
 * GitHub (work team): the `gh` CLI's login, read-only except marking
 * notification threads read. Source `github` → source_items `github-item`
 * (pr, review-request, issue, notification) and `contribution-day` (feeds the
 * automatic habit when habits.githubAuto is on).
 * Routes (/api/github): GET / → GitHubOverview. today(): see today.ts.
 */
export const githubModule: FeatureModule = {
  name: "github",
  label: "GitHub",
  setup(ctx) {
    const source = new GitHubSync(ctx);
    const router = Router();
    router.get("/", async (_req, res) => {
      res.json(await githubOverview(ctx, source));
    });
    return {
      router,
      sources: [source],
      today: (context, input) => githubToday(context, input),
      actions: { github: githubActionHandler(ctx, source) },
      status: () => {
        const login = source.login();
        return login ? { login } : {};
      },
    };
  },
};

