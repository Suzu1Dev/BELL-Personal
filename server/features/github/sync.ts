import { GITHUB_CHECK_STATES, GITHUB_REVIEW_DECISIONS, type ContributionDay, type GitHubCheckState, type GitHubItem, type GitHubReviewDecision } from "../../../shared/github.js";
import type { SourceStatus } from "../../../shared/sources.js";
import { isDayKey } from "../../../shared/time.js";
import { ghEnvironment, type CommandResult } from "../../ai/process.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { redact } from "../../secrets/redact.js";
import type { SourceItemInput } from "../../stores/source-items.js";
import { ReconnectRequiredError, SourceSync, type SyncContext, type SyncOutcome } from "../../sync.js";

/**
 * GitHub through the `gh` CLI the server is already logged in with
 * (decisions.md item 3, brief D1): one GraphQL call every 5 minutes (my open
 * PRs with review and check state, review requests, assigned issues, the
 * contribution calendar) plus the REST notifications list with
 * If-Modified-Since (a 304 is free) and GitHub's X-Poll-Interval honoured.
 * Read-only, except PATCH notifications/threads/:id from the 標為已讀 action.
 * CLI output is parsed, never shown: failures become zh-TW messages.
 */

export const GITHUB_INTERVAL_MS = 5 * 60_000;
/** How long a `gh auth status` answer is trusted by configured(). */
export const GH_AUTH_CACHE_MS = 10 * 60_000;
/** A probe that got no answer (a timeout) is asked again this soon, and counts as configured meanwhile. */
export const GH_AUTH_RETRY_MS = 60_000;
const GH_TIMEOUT_MS = 30_000;

/** Validated on this host (cost 1): see the work team's notes in docs/ARCHITECTURE.md §10. */
export const GITHUB_QUERY = `query {
  viewer {
    login
    contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } }
  }
  mine: search(type: ISSUE, query: "is:open is:pr author:@me archived:false", first: 30) {
    nodes {
      ... on PullRequest {
        id number title url isDraft createdAt updatedAt additions deletions reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        latestReviews(first: 10) { nodes { state submittedAt author { login } } }
      }
    }
  }
  reviews: search(type: ISSUE, query: "is:open is:pr review-requested:@me archived:false", first: 30) {
    nodes {
      ... on PullRequest {
        id number title url isDraft createdAt updatedAt additions deletions
        author { login }
        repository { nameWithOwner }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) {
          nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } ... on Team { slug } } } }
        }
      }
    }
  }
  assigned: search(type: ISSUE, query: "is:open assignee:@me archived:false", first: 30) {
    nodes {
      ... on Issue { id number title url createdAt updatedAt author { login } repository { nameWithOwner } }
      ... on PullRequest { id number title url createdAt updatedAt author { login } repository { nameWithOwner } }
    }
  }
}`;

interface Login { login?: string | null }
interface RepoNode { nameWithOwner?: string }

interface PullNode {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  createdAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  author?: Login | null;
  repository?: RepoNode;
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } } | null> };
  latestReviews?: { nodes?: Array<{ state?: string; submittedAt?: string | null; author?: Login | null } | null> };
  timelineItems?: { nodes?: Array<{ createdAt?: string; requestedReviewer?: { login?: string; slug?: string } | null } | null> };
}

export interface GraphQLAnswer {
  data?: {
    viewer?: { login?: string; contributionsCollection?: { contributionCalendar?: { weeks?: Array<{ contributionDays?: Array<{ date?: string; contributionCount?: number }> }> } } };
    mine?: { nodes?: Array<PullNode | null> };
    reviews?: { nodes?: Array<PullNode | null> };
    assigned?: { nodes?: Array<PullNode | null> };
  };
  errors?: unknown[];
}

export interface GraphQLParsed {
  login?: string;
  items: GitHubItem[];
  contributions: ContributionDay[];
}

const nodeOk = (node: PullNode | null | undefined): node is PullNode & { id: string; title: string; url: string } =>
  !!node && typeof node.id === "string" && typeof node.title === "string" && typeof node.url === "string" && /^https:\/\/github\.com\//.test(node.url);

const iso = (value: string | null | undefined) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined);
/** Titles are user content from GitHub: squeezed, capped and redacted before they are cached. */
const text = (value: string, max = 300) => redact(value.replace(/\s+/g, " ").trim()).slice(0, max);

function checkState(node: PullNode): GitHubCheckState | null {
  const state = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return state && (GITHUB_CHECK_STATES as readonly string[]).includes(state) ? (state as GitHubCheckState) : null;
}

function decision(node: PullNode): GitHubReviewDecision | null {
  const value = node.reviewDecision;
  return value && (GITHUB_REVIEW_DECISIONS as readonly string[]).includes(value) ? (value as GitHubReviewDecision) : null;
}

function base(node: PullNode & { id: string; title: string; url: string }, kind: GitHubItem["kind"], fallbackTime: string): GitHubItem {
  return {
    id: `${kind}:${node.id}`,
    kind,
    repo: node.repository?.nameWithOwner ?? node.url.split("/").slice(3, 5).join("/"),
    title: text(node.title),
    url: node.url,
    ...(typeof node.number === "number" ? { number: node.number } : {}),
    updatedAt: iso(node.updatedAt) ?? fallbackTime,
    ...(iso(node.createdAt) ? { createdAt: iso(node.createdAt) } : {}),
  };
}

/** The GraphQL answer → GitHubItems (pr, review-request, issue) and contribution days. */
export function parseGraphQL(answer: GraphQLAnswer, now: Date): GraphQLParsed {
  const data = answer.data;
  if (!data) throw new AppError(502, "GitHub 回傳的資料格式不正確，稍後會自動重試。");
  const fallback = now.toISOString();
  const login = data.viewer?.login;
  const items: GitHubItem[] = [];

  for (const node of data.mine?.nodes ?? []) {
    if (!nodeOk(node)) continue;
    const changes = (node.latestReviews?.nodes ?? [])
      .filter((review) => review?.state === "CHANGES_REQUESTED")
      .sort((a, b) => Date.parse(b?.submittedAt ?? "") - Date.parse(a?.submittedAt ?? ""))[0];
    items.push({
      ...base(node, "pr", fallback),
      isDraft: !!node.isDraft,
      reviewDecision: decision(node),
      checks: checkState(node),
      ...(login ? { author: login } : {}),
      ...(typeof node.additions === "number" ? { additions: node.additions } : {}),
      ...(typeof node.deletions === "number" ? { deletions: node.deletions } : {}),
      ...(changes?.author?.login ? { changesRequestedBy: changes.author.login } : {}),
      ...(iso(changes?.submittedAt) ? { changesRequestedAt: iso(changes?.submittedAt) } : {}),
    });
  }

  for (const node of data.reviews?.nodes ?? []) {
    if (!nodeOk(node)) continue;
    const requests = (node.timelineItems?.nodes ?? []).filter((event): event is NonNullable<typeof event> => !!event?.createdAt);
    const mine = requests.filter((event) => !event.requestedReviewer?.login || event.requestedReviewer.login === login);
    const requestedAt = iso((mine.at(-1) ?? requests.at(-1))?.createdAt);
    items.push({
      ...base(node, "review-request", fallback),
      isDraft: !!node.isDraft,
      ...(node.author?.login ? { author: node.author.login } : {}),
      ...(typeof node.additions === "number" ? { additions: node.additions } : {}),
      ...(typeof node.deletions === "number" ? { deletions: node.deletions } : {}),
      ...(requestedAt ? { requestedAt } : {}),
    });
  }

  for (const node of data.assigned?.nodes ?? []) {
    if (!nodeOk(node)) continue;
    items.push({ ...base(node, "issue", fallback), ...(node.author?.login ? { author: node.author.login } : {}) });
  }

  const contributions: ContributionDay[] = [];
  for (const week of data.viewer?.contributionsCollection?.contributionCalendar?.weeks ?? [])
    for (const day of week.contributionDays ?? [])
      if (isDayKey(day.date) && typeof day.contributionCount === "number") contributions.push({ date: day.date, count: day.contributionCount });

  return { ...(login ? { login } : {}), items, contributions };
}

/* ------------------------------------------------------------- Notifications */

export interface RestNotification {
  id?: string;
  unread?: boolean;
  reason?: string;
  updated_at?: string;
  subject?: { title?: string; url?: string | null; type?: string };
  repository?: { full_name?: string; html_url?: string };
}

/** An API subject URL → the page a person opens (…/pulls/7 → …/pull/7). */
export function notificationUrl(notification: RestNotification): { url: string; number?: number } {
  const repoHtml = notification.repository?.html_url && /^https:\/\/github\.com\//.test(notification.repository.html_url)
    ? notification.repository.html_url
    : `https://github.com/${notification.repository?.full_name ?? ""}`;
  const subject = notification.subject?.url ?? "";
  const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/(pulls|issues|commits|discussions|releases)\/([^/?#]+)/.exec(subject);
  if (match) {
    const [, owner, repo, type, id] = match;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const number = /^\d+$/.test(id) ? Number(id) : undefined;
    switch (type) {
      case "pulls": return { url: `${repoUrl}/pull/${id}`, ...(number ? { number } : {}) };
      case "issues": return { url: `${repoUrl}/issues/${id}`, ...(number ? { number } : {}) };
      case "discussions": return { url: `${repoUrl}/discussions/${id}`, ...(number ? { number } : {}) };
      case "commits": return { url: `${repoUrl}/commit/${id}` };
      default: return { url: `${repoUrl}/releases` };
    }
  }
  if (notification.subject?.type === "CheckSuite" || notification.subject?.type === "WorkflowRun") return { url: `${repoHtml}/actions` };
  return { url: repoHtml };
}

export function parseNotifications(list: RestNotification[], now: Date): GitHubItem[] {
  const items: GitHubItem[] = [];
  for (const entry of list) {
    if (!entry.id || !/^\d{1,20}$/.test(entry.id) || !entry.subject?.title || !entry.repository?.full_name) continue;
    const { url, number } = notificationUrl(entry);
    items.push({
      id: `notification:${entry.id}`,
      kind: "notification",
      repo: entry.repository.full_name,
      title: text(entry.subject.title),
      url,
      ...(number ? { number } : {}),
      updatedAt: iso(entry.updated_at) ?? now.toISOString(),
      ...(entry.reason ? { reason: entry.reason } : {}),
      unread: entry.unread !== false,
      ...(entry.subject.type ? { subjectType: entry.subject.type } : {}),
    });
  }
  return items;
}

/** `gh api --include …` output → status, headers and body. */
export function parseIncluded(stdout: string): { status: number; headers: Map<string, string>; body: string } | undefined {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(stdout);
  if (!match) return undefined;
  const split = /\r?\n\r?\n/.exec(stdout);
  const head = split ? stdout.slice(0, split.index) : stdout;
  const body = split ? stdout.slice(split.index + split[0].length) : "";
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), headers, body };
}

/** What the source keeps between runs (sync_state.cursor). */
export interface GitHubCursor {
  login?: string;
  notifications?: { lastModified?: string; pollIntervalSec?: number; fetchedAt?: string };
}

export function readCursor(cursor: string | null | undefined): GitHubCursor {
  if (!cursor) return {};
  try {
    const value = JSON.parse(cursor) as GitHubCursor;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

/* ------------------------------------------------------------------ The CLI */

/**
 * What a dead gh login says everywhere (/api/github, /api/status, 連線與設定):
 * only a new `gh auth login` on the host fixes it, so the shared 「請到連線與設定重新授權」
 * would send the user somewhere that cannot help. No CLI output, no paths.
 */
export const GH_RECONNECT_MESSAGE = "GitHub 連線已失效：請在執行 BELL Personal 的主機上重新登入 GitHub CLI，再按重試。";

/** A gh failure (its message or stderr) as a zh-TW AppError; the raw output is never shown. */
export function ghFailure(message: string, status?: number): AppError {
  if (/auth login|not logged in|HTTP 401|Bad credentials|requires authentication/i.test(message))
    return new ReconnectRequiredError(GH_RECONNECT_MESSAGE);
  if (status === 503) return new AppError(503, "伺服器找不到 GitHub CLI，請安裝並登入後再試。");
  if (status === 504) return new AppError(504, "GitHub 回應逾時，稍後會自動重試。");
  if (/rate limit|HTTP 403|HTTP 429/i.test(message)) return new AppError(429, "GitHub 暫時限制請求頻率，稍後會自動重試。");
  return new AppError(502, "無法從 GitHub 取得資料，稍後會自動重試。");
}

/** Runs gh with its environment allow-list; failures become zh-TW AppErrors (never raw CLI output). */
export async function runGh(ctx: Pick<ModuleContext, "command" | "config">, args: string[], options: { signal?: AbortSignal; allowedCodes?: number[] } = {}): Promise<CommandResult> {
  try {
    return await ctx.command(ctx.config.ghPath, args, {
      env: ghEnvironment(), timeoutMs: GH_TIMEOUT_MS, maxBytes: 4_000_000,
      ...(options.signal ? { signal: options.signal } : {}), ...(options.allowedCodes ? { allowedCodes: options.allowedCodes } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw ghFailure(error instanceof Error ? error.message : "", error instanceof AppError ? error.status : undefined);
  }
}

/* --------------------------------------------------------------- The source */

export interface GitHubRun {
  items: GitHubItem[];
  contributions: ContributionDay[];
  cursor: GitHubCursor;
}

/**
 * SourceSync `github`. configured() = `gh auth status` says logged in (cached
 * 10 min, so status pages never spawn a process per request). Only a definite
 * answer (not logged in, gh missing) counts as 尚未設定; a probe that times
 * out counts as configured and is retried after a minute, so run() reports
 * the real problem as an error. Once an answer exists, status() and Today
 * never wait for gh: a stale answer is served while the probe refreshes it.
 */
export class GitHubSync extends SourceSync {
  private auth?: { ok: boolean; at: number; ttl: number };
  private probe?: Promise<boolean>;
  /** Threads marked read here whose PATCH may not have reached GitHub yet: kept read across syncs. */
  private readonly readThreads = new Map<string, number>();

  constructor(private readonly ctx: ModuleContext, options: { intervalMs?: number } = {}) {
    super({ id: "github", state: ctx.syncState, intervalMs: options.intervalMs ?? GITHUB_INTERVAL_MS, fetch: ctx.fetch, now: ctx.now });
  }

  /** The shared reconnect line points at 連線與設定; a gh login is fixed on the host instead (GH_RECONNECT_MESSAGE). */
  override async status(): Promise<SourceStatus> {
    const status = await super.status();
    return status.state === "needs_reconnect" ? { ...status, lastError: GH_RECONNECT_MESSAGE } : status;
  }

  configured(): Promise<boolean> {
    const cached = this.auth;
    if (cached && this.now().getTime() - cached.at < cached.ttl) return Promise.resolve(cached.ok);
    this.probe ??= this.ctx.command(this.ctx.config.ghPath, ["auth", "status", "--hostname", "github.com"], { env: ghEnvironment(), timeoutMs: 10_000, maxBytes: 50_000, allowedCodes: [0, 1] })
      .then(
        // Exit 1: gh answered that no usable login exists; only `gh auth login` on the server helps.
        (result) => ({ ok: result.code === 0, ttl: GH_AUTH_CACHE_MS }),
        // gh missing (503) is a definite no; a timeout or another failure is not an answer.
        (error) => (error instanceof AppError && error.status === 503 ? { ok: false, ttl: GH_AUTH_CACHE_MS } : { ok: true, ttl: GH_AUTH_RETRY_MS }),
      )
      .then(({ ok, ttl }) => { this.auth = { ok, at: this.now().getTime(), ttl }; return ok; })
      .finally(() => { this.probe = undefined; });
    return cached ? Promise.resolve(cached.ok) : this.probe;
  }

  /** The login the cache belongs to (from the last GraphQL answer). */
  login(): string | undefined {
    return readCursor(this.state.get("github")?.cursor).login;
  }

  /** 標為已讀 applied locally (until `ttlMs` passes or forgetRead()). */
  rememberRead(threads: string[], ttlMs = 15 * 60_000): void {
    const until = this.now().getTime() + ttlMs;
    for (const thread of threads) this.readThreads.set(thread, until);
  }

  forgetRead(threads: string[]): void {
    for (const thread of threads) this.readThreads.delete(thread);
  }

  isRead(thread: string): boolean {
    const until = this.readThreads.get(thread);
    if (until === undefined) return false;
    if (until < this.now().getTime()) { this.readThreads.delete(thread); return false; }
    return true;
  }

  protected async run({ signal, cursor, now }: SyncContext): Promise<SyncOutcome> {
    const result = await this.fetchAll(readCursor(cursor), now, signal);
    signal.throwIfAborted();
    const items = result.items.map((item) => (item.kind === "notification" && this.isRead(item.id.slice("notification:".length)) ? { ...item, unread: false } : item));
    this.ctx.sourceItems.replace("github", "github-item", items.map((value): SourceItemInput<GitHubItem> => ({ kind: "github-item", externalId: value.id, value, updatedAt: value.updatedAt })));
    if (result.contributions.length)
      this.ctx.sourceItems.replace("github", "contribution-day", result.contributions.map((value): SourceItemInput<ContributionDay> => ({ kind: "contribution-day", externalId: value.date, value })));
    return { items: items.length, cursor: JSON.stringify(result.cursor) };
  }

  /** GraphQL plus notifications; exposed for tests. */
  async fetchAll(previous: GitHubCursor, now: Date, signal: AbortSignal): Promise<GitHubRun> {
    // gh exits 1 when the answer carries `errors`, even with usable `data` (a node in an org whose
    // SAML or app policy blocks the token comes back null): use the data, fail only without it.
    const graph = await runGh(this.ctx, ["api", "graphql", "-f", `query=${GITHUB_QUERY}`], { signal, allowedCodes: [0, 1] });
    let answer: GraphQLAnswer | undefined;
    try { answer = JSON.parse(graph.stdout) as GraphQLAnswer; } catch { answer = undefined; }
    if (!answer?.data || typeof answer.data !== "object") {
      if (graph.code !== 0) throw ghFailure(`${graph.stderr}\n${graph.stdout}`);
      throw new AppError(502, "GitHub 回傳的資料格式不正確，稍後會自動重試。");
    }
    if (Array.isArray(answer.errors) && answer.errors.length) {
      const types = [...new Set(answer.errors.map((error) => String((error as { type?: unknown })?.type ?? "unknown").slice(0, 40)))].slice(0, 5);
      logEvent("github.graphql_partial", { errors: answer.errors.length, types });
    }
    const parsed = parseGraphQL(answer, now);
    const cursor: GitHubCursor = { ...previous, ...(parsed.login ? { login: parsed.login } : {}) };

    let notifications: GitHubItem[] | undefined;
    const last = previous.notifications;
    const waitMs = (last?.pollIntervalSec ?? 60) * 1000;
    const fresh = last?.fetchedAt && now.getTime() - Date.parse(last.fetchedAt) < waitMs;
    if (!fresh) {
      const args = ["api", "--include", "notifications?per_page=50"];
      if (last?.lastModified) args.push("-H", `If-Modified-Since: ${last.lastModified}`);
      // gh exits 1 on a 304 (and on HTTP errors); the status line in the output says which.
      const response = await runGh(this.ctx, args, { signal, allowedCodes: [0, 1] });
      const included = parseIncluded(response.stdout);
      if (!included) throw new AppError(502, "無法從 GitHub 取得通知，稍後會自動重試。");
      if (included.status === 401) throw new ReconnectRequiredError(GH_RECONNECT_MESSAGE);
      if (included.status === 200) {
        let list: unknown;
        try { list = JSON.parse(included.body); } catch { throw new AppError(502, "GitHub 回傳的通知格式不正確，稍後會自動重試。"); }
        if (!Array.isArray(list)) throw new AppError(502, "GitHub 回傳的通知格式不正確，稍後會自動重試。");
        notifications = parseNotifications(list as RestNotification[], now);
      } else if (included.status !== 304) {
        throw new AppError(included.status === 403 || included.status === 429 ? 429 : 502, "無法從 GitHub 取得通知，稍後會自動重試。");
      }
      const interval = Number(included.headers.get("x-poll-interval"));
      cursor.notifications = {
        lastModified: included.headers.get("last-modified") ?? last?.lastModified,
        pollIntervalSec: Number.isFinite(interval) && interval > 0 ? Math.min(interval, 3600) : last?.pollIntervalSec ?? 60,
        fetchedAt: now.toISOString(),
      };
    }
    // 304 or not yet due: keep the notifications already cached.
    notifications ??= this.ctx.sourceItems.list<GitHubItem>({ source: "github", kind: "github-item" })
      .map((item) => item.value).filter((item) => item.kind === "notification");
    return { items: [...parsed.items, ...notifications], contributions: parsed.contributions, cursor };
  }
}
