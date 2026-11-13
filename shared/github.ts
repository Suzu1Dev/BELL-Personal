import type { SourceStatus } from "./sources.js";
import type { DayKey } from "./time.js";

/** pr: my open PR. review-request: a PR waiting for my review. issue: assigned to me. notification: unread thread. */
export const GITHUB_ITEM_KINDS = ["pr", "review-request", "issue", "notification"] as const;
export type GitHubItemKind = (typeof GITHUB_ITEM_KINDS)[number];

export const GITHUB_REVIEW_DECISIONS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"] as const;
export type GitHubReviewDecision = (typeof GITHUB_REVIEW_DECISIONS)[number];

export const GITHUB_CHECK_STATES = ["SUCCESS", "FAILURE", "PENDING", "ERROR", "EXPECTED"] as const;
export type GitHubCheckState = (typeof GITHUB_CHECK_STATES)[number];

export interface GitHubItem {
  /** "<kind>:<node id or notification id>". */
  id: string;
  kind: GitHubItemKind;
  /** "owner/name". */
  repo: string;
  title: string;
  url: string;
  number?: number;
  updatedAt: string;
  isDraft?: boolean;
  reviewDecision?: GitHubReviewDecision | null;
  checks?: GitHubCheckState | null;
  /** Notifications only: GitHub's reason, e.g. "review_requested". */
  reason?: string;
  unread?: boolean;
  /** PR author login (review requests: who asked). */
  author?: string;
  additions?: number;
  deletions?: number;
  /** review-request: when the review was requested (the 24 h rule). */
  requestedAt?: string;
  createdAt?: string;
  /** pr: who asked for changes (reviewDecision CHANGES_REQUESTED). */
  changesRequestedBy?: string;
  /** pr: when that review was submitted. */
  changesRequestedAt?: string;
  /** notification: GitHub's subject type (PullRequest, Issue, Release, CheckSuite…). */
  subjectType?: string;
}

/** One day of the contribution calendar; can drive an automatic habit. */
export interface ContributionDay {
  date: DayKey;
  count: number;
}

/** GitHub item as #/work lists it. */
export interface GitHubItemView extends GitHubItem {
  /** The Today queue id (`github:<node id>`) for review requests and PRs. */
  itemId?: string;
  /** review-request: 標為已審查 locally until GitHub shows a new request. */
  localReviewed?: boolean;
}

/** GET /api/github: the cached overview for #/work?tab=github. */
export interface GitHubOverview {
  status: SourceStatus;
  /** The gh login the cache belongs to, when known. */
  login?: string;
  reviewRequests: GitHubItemView[];
  pullRequests: GitHubItemView[];
  issues: GitHubItemView[];
  /** Unread notification threads, newest first. */
  notifications: GitHubItemView[];
  /** Contributions in the last 7 and 30 days (from the contribution calendar). */
  contributions: { week: number; month: number };
}

/** POST /api/actions params for `read` on a `github:digest-…` target (mark notification threads read). */
export interface GitHubReadParams {
  /** Notification thread ids (1–50). */
  threads: string[];
}

export const GITHUB_LIMITS = { threadsPerAction: 50 } as const;
