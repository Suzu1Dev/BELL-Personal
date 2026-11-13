/**
 * #/work?tab=github (SPEC-ux §3.3): 請你審查 · 我的 PR (checks, review state) ·
 * 指派給我 · 通知 (bulk 標為已讀), with the gh connection state. Read-only
 * except 標為已審查 (local until GitHub changes) and 標為已讀 (deferred
 * PATCH, undoable for 6 s).
 */
import { useMemo } from "react";
import type { GitHubItemView, GitHubOverview } from "../../../shared/github";
import { ERRORS } from "../../copy/common";
import { GITHUB, WORK_PAGE } from "../../copy/work";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { Notice } from "../../components/Notice";
import { StatusPill } from "../../components/Pill";
import { SkeletonRow } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { Tile } from "../../components/Tile";
import { clockTime } from "../../lib/today-model";
import type { Poll } from "../../lib/usePoll";
import { ArrowUpRight, Bell, Check, CheckCheck, CircleDot, GitPullRequest, GitPullRequestDraft, RefreshCw } from "./icons";
import { Diff, WorkRow } from "./WorkRow";
import { useOptimistic, useWorkAction } from "./useWork";
import { notificationReason, numbered, pullMeta, receivedWhen, reviewPill, syncTime } from "./work-model";

const SETTINGS_HREF = "#/settings/sources";

export function GitHubTab({ poll, timeZone, onSync, syncing }: { poll: Poll<GitHubOverview>; timeZone: string; onSync: () => void; syncing: boolean }) {
  const reviewed = useOptimistic<boolean>(poll.updatedAt);
  const read = useOptimistic<boolean>(poll.updatedAt);
  const act = useWorkAction(poll.refresh);
  const now = new Date();
  const data = poll.data;
  const reviewedLocally = reviewed.get;
  const reviews = useMemo(() => (data?.reviewRequests ?? []).map((item) => {
    const local = item.itemId ? reviewedLocally(item.itemId) : undefined;
    return local === undefined ? item : { ...item, localReviewed: local };
  }), [data, reviewedLocally]);
  const notifications = (data?.notifications ?? []).filter((item) => !read.get(item.id));
  const status = data?.status;
  const hasItems = !!data && (data.reviewRequests.length + data.pullRequests.length + data.issues.length + data.notifications.length) > 0;
  const staleSince = poll.state === "stale" && poll.updatedAt ? clockTime(new Date(poll.updatedAt).toISOString(), timeZone) : undefined;
  const lastSync = syncTime(status?.lastSyncedAt, now, timeZone);

  const markReviewed = (item: GitHubItemView) => item.itemId && act(item.itemId, "reviewed", {
    message: GITHUB.reviewedToast(numbered(item)),
    local: {
      apply: () => reviewed.put(item.itemId!, true),
      undo: () => reviewed.put(item.itemId!, false),
      settle: () => reviewed.settle(item.itemId!),
      drop: () => reviewed.drop(item.itemId!),
    },
  });

  const markRead = (items: GitHubItemView[]) => {
    if (!items.length) return;
    const threads = items.map((item) => item.id.slice(item.id.indexOf(":") + 1));
    const ids = items.map((item) => item.id);
    const each = (fn: (id: string) => void) => () => ids.forEach(fn);
    void act(`github:digest-notifications-${Date.now()}`, "read", {
      message: GITHUB.readToast(items.length),
      params: { threads },
      local: { apply: each((id) => read.put(id, true)), undo: each((id) => read.put(id, false)), settle: each(read.settle), drop: each(read.drop) },
    });
  };

  if (poll.state === "loading") {
    return (
      <div className="work-grid">
        <div className="work-main">{[0, 1].map((index) => <Card key={index} className="work-card"><div className="skel-list" aria-busy="true"><SkeletonRow /><SkeletonRow /></div></Card>)}</div>
        <aside className="work-side"><Card className="work-card"><SkeletonRow /></Card></aside>
      </div>
    );
  }
  if (poll.state === "error") {
    return (
      <Notice tone="error" title={WORK_PAGE.loadError} role="alert" actions={<Button size="sm" icon={RefreshCw} onClick={() => void poll.refresh()}>{ERRORS.retry}</Button>}>
        {poll.error}
      </Notice>
    );
  }
  if (!hasItems && status && !status.configured) {
    return (
      <EmptyState icon={GitPullRequest} tone="info" title={GITHUB.notConnectedTitle} hint={GITHUB.notConnectedHint}
        action={<Button variant="secondary" href={SETTINGS_HREF}>{WORK_PAGE.settings}</Button>} />
    );
  }

  const problem = status?.state === "needs_reconnect"
    ? <Notice tone="warn" title={GITHUB.reconnectTitle} actions={<Button size="sm" icon={RefreshCw} onClick={onSync} disabled={syncing}>{ERRORS.retry}</Button>}>{GITHUB.reconnectHint(lastSync)}</Notice>
    : status?.state === "error"
      ? <Notice tone="warn" title={GITHUB.errorTitle} actions={<Button size="sm" icon={RefreshCw} onClick={onSync} disabled={syncing}>{ERRORS.retry}</Button>}>{status.lastError}</Notice>
      : null;

  const pendingReviews = reviews.filter((item) => !item.localReviewed);
  return (
    <>
      {problem ? <div className="work-notices">{problem}</div> : null}
      {staleSince ? <StaleNote time={staleSince} onRefresh={() => void poll.refresh()} /> : null}
      <div className="work-grid">
        <div className="work-main">
          <Card className="work-list" aria-labelledby="gh-reviews-title">
            <div className="q-head">
              <CardHead title={GITHUB.reviewsTitle} titleId="gh-reviews-title" icon={GitPullRequest} tone="info" count={pendingReviews.length} countLabel={GITHUB.reviewsCount(pendingReviews.length)} />
            </div>
            {reviews.length ? (
              <ul className="q-group">
                {[...pendingReviews, ...reviews.filter((item) => item.localReviewed)].map((item) => (
                  <WorkRow
                    key={item.id}
                    icon={GitPullRequest}
                    tone="info"
                    title={numbered(item)}
                    href={item.url}
                    meta={[item.repo, item.author ? GITHUB.requestedBy(item.author) : undefined, <Diff key="diff" add={item.additions} del={item.deletions} />]}
                    pill={item.localReviewed ? { label: GITHUB.reviewedPill, tone: "ok" } : undefined}
                    when={receivedWhen(item.requestedAt ?? item.updatedAt, now, timeZone)}
                    done={item.localReviewed}
                    actions={(
                      <>
                        {!item.localReviewed ? <Button variant="ghost" size="sm" icon={Check} onClick={() => void markReviewed(item)}>{GITHUB.reviewed}</Button> : null}
                        <Button variant="ghost" size="sm" icon={ArrowUpRight} href={item.url} external>{GITHUB.startReview}</Button>
                      </>
                    )}
                    primary={!item.localReviewed ? (
                      <Button variant="secondary" size="sm" icon={Check} className="q-primary" onClick={() => void markReviewed(item)} aria-label={`${GITHUB.reviewed}「${numbered(item)}」`}>
                        {GITHUB.reviewedTouch}
                      </Button>
                    ) : null}
                  />
                ))}
              </ul>
            ) : <p className="q-empty">{GITHUB.reviewsEmpty}</p>}
          </Card>

          <Card className="work-list" aria-labelledby="gh-prs-title">
            <div className="q-head">
              <CardHead title={GITHUB.prsTitle} titleId="gh-prs-title" icon={GitPullRequest} tone="info" count={data?.pullRequests.length ?? 0} countLabel={GITHUB.prsCount(data?.pullRequests.length ?? 0)} />
            </div>
            {data?.pullRequests.length ? (
              <ul className="q-group">
                {data.pullRequests.map((item) => (
                  <WorkRow
                    key={item.id}
                    icon={item.isDraft ? GitPullRequestDraft : GitPullRequest}
                    tone={item.reviewDecision === "CHANGES_REQUESTED" || item.checks === "FAILURE" || item.checks === "ERROR" ? "danger" : "info"}
                    title={numbered(item)}
                    href={item.url}
                    meta={pullMeta(item, now, timeZone)}
                    pill={reviewPill(item)}
                    when={receivedWhen(item.updatedAt, now, timeZone)}
                    actions={<Button variant="ghost" size="sm" icon={ArrowUpRight} href={item.url} external>{GITHUB.open}</Button>}
                  />
                ))}
              </ul>
            ) : <p className="q-empty">{GITHUB.prsEmpty}</p>}
          </Card>

          <Card className="work-list" aria-labelledby="gh-issues-title">
            <div className="q-head">
              <CardHead title={GITHUB.issuesTitle} titleId="gh-issues-title" icon={CircleDot} tone="warn" count={data?.issues.length ?? 0} countLabel={GITHUB.issuesCount(data?.issues.length ?? 0)} />
            </div>
            {data?.issues.length ? (
              <ul className="q-group">
                {data.issues.map((item) => (
                  <WorkRow
                    key={item.id}
                    icon={CircleDot}
                    tone="warn"
                    title={numbered(item)}
                    href={item.url}
                    meta={[item.repo, item.author ? item.author : undefined]}
                    when={receivedWhen(item.updatedAt, now, timeZone)}
                    actions={<Button variant="ghost" size="sm" icon={ArrowUpRight} href={item.url} external>{GITHUB.open}</Button>}
                  />
                ))}
              </ul>
            ) : <p className="q-empty">{GITHUB.issuesEmpty}</p>}
          </Card>
        </div>

        <aside className="work-side" aria-label={GITHUB.notificationsTitle}>
          <Card className="work-card" aria-labelledby="gh-account-title">
            <CardHead title={GITHUB.accountTitle} titleId="gh-account-title" link={{ href: SETTINGS_HREF, label: WORK_PAGE.settings }} />
            <div className="work-source">
              <Tile icon={GitPullRequest} tone="info" />
              <div>
                <b>{data?.login ?? "GitHub"}</b>
                <span>{GITHUB.accountLine(undefined, lastSync)}</span>
                {data ? <span>{GITHUB.contributions(data.contributions.week, data.contributions.month)}</span> : null}
              </div>
              {status ? <StatusPill state={status.state} /> : null}
            </div>
          </Card>

          <Card className="work-card" aria-labelledby="gh-notifications-title">
            <CardHead title={GITHUB.notificationsTitle} titleId="gh-notifications-title" icon={Bell} tone="mail" count={notifications.length} countLabel={GITHUB.notificationsCount(notifications.length)}>
              {notifications.length ? <Button variant="ghost" size="sm" icon={CheckCheck} onClick={() => markRead(notifications)}>{GITHUB.markAllRead}</Button> : null}
            </CardHead>
            {notifications.length ? (
              <ul className="note-list">
                {notifications.map((item) => (
                  <li key={item.id} className="note-row">
                    <a href={item.url} target="_blank" rel="noopener noreferrer" className="note-main">
                      <span className="t">{item.title}</span>
                      <span className="m">{[item.repo, notificationReason(item.reason), receivedWhen(item.updatedAt, now, timeZone).label].join(" · ")}</span>
                    </a>
                    <Button variant="icon" icon={Check} aria-label={GITHUB.markReadOne(item.title)} title={GITHUB.markRead} onClick={() => markRead([item])} />
                  </li>
                ))}
              </ul>
            ) : <p className="work-hint">{GITHUB.notificationsEmpty}</p>}
          </Card>
        </aside>
      </div>
    </>
  );
}
