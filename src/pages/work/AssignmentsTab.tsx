/**
 * #/work 作業 (SPEC-ux §3.3, SPEC-mail-assignments §5.8): assignments by
 * course from every origin (E3, Canvas, a teacher's mail, added by hand) with
 * status pills 未繳交 / 已交（本機） / 已繳交 / 逾期, source chips
 * E3 · Canvas · 信件 · 手動, 標為已交 (local until the LMS agrees, §6.4; final
 * for native rows, D7), the 「從信件找到」 suggestions (加入作業 / 略過), and
 * every widget state (§5): loading, error, stale, empty, 尚未連線 and a
 * source needing reconnection. Native rows render even when every LMS is broken.
 */
import { useMemo, useState } from "react";
import type { AssignmentStatus, AssignmentSuggestionRow, AssignmentView, AssignmentsResponse, LmsAccountView } from "../../../shared/assignments";
import { ASSIGNMENTS, WORK_PAGE } from "../../copy/work";
import { ACTION_TOASTS, ERRORS } from "../../copy/common";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { ChipGroup } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { ArrowRight, ArrowUpRight, Check, GraduationCap, Plus, RefreshCw, Sparkles, X } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { StatusPill } from "../../components/Pill";
import { SkeletonRow, SkeletonStatus } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { Tile } from "../../components/Tile";
import { clockTime } from "../../lib/today-model";
import type { Poll } from "../../lib/usePoll";
import { Pencil } from "./icons";
import { WorkRow } from "./WorkRow";
import { useOptimistic, useWorkAction } from "./useWork";
import { assignmentMeta, assignmentPill, assignmentWhen, groupByCourse, isNative, pendingCount, sourceOptions, syncTime, type SourceFilter } from "./work-model";

const SETTINGS_HREF = "#/settings/sources";
const META_LABELS = { noDue: ASSIGNMENTS.noDue, grade: ASSIGNMENTS.grade, missing: ASSIGNMENTS.missing, notYetShown: ASSIGNMENTS.notYetShown, markedByYou: ASSIGNMENTS.markedByYou };

export interface AssignmentsTabProps {
  poll: Poll<AssignmentsResponse>;
  timeZone: string;
  onSync: () => void;
  syncing: boolean;
  /** 新增作業 (the empty state's button; the page head has the other). */
  onCreate: () => void;
  /** 編輯 a native row. */
  onEdit: (row: AssignmentView) => void;
  /** Rows deleted a moment ago (their undo toast is up): hidden until the next fetch says otherwise. */
  hidden?: ReadonlySet<string>;
}

export function AssignmentsTab({ poll, timeZone, onSync, syncing, onCreate, onEdit, hidden }: AssignmentsTabProps) {
  const [filter, setFilter] = useState<SourceFilter>("all");
  const local = useOptimistic<AssignmentStatus>(poll.updatedAt);
  const decided = useOptimistic<true>(poll.updatedAt);
  const act = useWorkAction(poll.refresh);
  const now = new Date();
  const accounts = poll.data?.accounts ?? [];
  const localStatus = local.get;
  const assignments = useMemo(
    () => (poll.data?.assignments ?? []).filter((row) => !hidden?.has(row.id)).map((row) => {
      const status = localStatus(row.itemId);
      return status ? { ...row, status } : row;
    }),
    [poll.data, localStatus, hidden],
  );
  const suggestions = (poll.data?.suggestions ?? []).filter((row) => !decided.get(row.itemId));
  const options = sourceOptions(accounts, assignments);
  const activeFilter = options.some((option) => option.value === filter) ? filter : "all";
  const groups = groupByCourse(assignments, activeFilter);
  const connected = accounts.some((account) => account.connected);
  const firstSync = accounts.some((account) => account.connected && account.status.state === "syncing" && !account.status.lastSyncedAt);

  const markSubmitted = (row: AssignmentView) => act(row.itemId, "submitted", {
    message: ASSIGNMENTS.submittedToast(row.title),
    local: {
      apply: () => local.put(row.itemId, isNative(row) ? "submitted" : "local"),
      undo: () => local.put(row.itemId, row.status),
      settle: () => local.settle(row.itemId),
      drop: () => local.drop(row.itemId),
    },
  });

  const decide = (row: AssignmentSuggestionRow, action: "assignment" | "dismiss") => {
    const title = row.meta[0] ?? row.title;
    const deadline = row.meta.find((part) => part.endsWith("截止"));
    return act(row.itemId, action, {
      message: action === "assignment" ? ACTION_TOASTS.assignment(title, deadline) : ACTION_TOASTS.dismiss(title),
      ...(action === "assignment" ? { icon: GraduationCap } : { icon: X }),
      local: {
        apply: () => decided.put(row.itemId, true),
        undo: () => decided.drop(row.itemId),
        settle: () => decided.settle(row.itemId),
        drop: () => decided.drop(row.itemId),
      },
    });
  };

  const problems = accounts.filter((account) => account.connected && (account.status.state === "needs_reconnect" || account.status.state === "error")).slice(0, 2);
  const staleSince = poll.state === "stale" && poll.updatedAt ? clockTime(new Date(poll.updatedAt).toISOString(), timeZone) : undefined;
  const createButton = <Button variant="secondary" icon={Plus} onClick={onCreate}>{ASSIGNMENTS.create}</Button>;

  let body;
  if (poll.state === "loading") {
    body = <div className="skel-list" aria-busy="true">{[0, 1, 2].map((index) => <SkeletonRow key={index} />)}</div>;
  } else if (poll.state === "error") {
    body = (
      <Notice tone="error" title={WORK_PAGE.loadError} role="alert" actions={<Button size="sm" icon={RefreshCw} onClick={() => void poll.refresh()}>{ERRORS.retry}</Button>}>
        {poll.error}
      </Notice>
    );
  } else if (!assignments.length) {
    if (firstSync) body = <div className="work-status"><SkeletonStatus>{ASSIGNMENTS.firstSync}</SkeletonStatus></div>;
    else body = (
      <EmptyState
        icon={GraduationCap}
        tone="task"
        title={ASSIGNMENTS.emptyTitle}
        hint={connected ? ASSIGNMENTS.emptyConnected : ASSIGNMENTS.emptyHint}
        action={createButton}
      />
    );
  } else if (!groups.length) {
    body = <p className="q-empty">{ASSIGNMENTS.filteredEmpty}</p>;
  } else {
    body = groups.map((group) => {
      const headingId = `course-${group.key.replace(/[^a-z0-9-]/gi, "-")}-${group.rows[0].itemId.replace(/[^a-z0-9-]/gi, "-")}`;
      return (
        <section key={group.key} className="q-group" aria-labelledby={headingId}>
          <div className="q-ghead">
            <h3 id={headingId} className="kp">{group.course}</h3>
            {group.pending ? <span className="count" aria-label={ASSIGNMENTS.countLabel(group.pending)}>{group.pending}</span> : null}
            {group.sites.length ? <span className="hint">{group.sites.join(" · ")}</span> : null}
          </div>
          <ul className="q-list">
            {group.rows.map((row) => (
              <AssignmentRow key={row.itemId} row={row} now={now} timeZone={timeZone} onSubmit={() => void markSubmitted(row)} onEdit={() => onEdit(row)} />
            ))}
          </ul>
        </section>
      );
    });
  }

  return (
    <div className="work-grid">
      <div className="work-main">
        {suggestions.length ? <SuggestionsCard rows={suggestions} onDecide={(row, action) => void decide(row, action)} /> : null}
        <Card className="work-list" aria-labelledby="work-assignments-title">
          <div className="q-head">
            <CardHead title={ASSIGNMENTS.title} titleId="work-assignments-title" icon={GraduationCap} tone="task" count={pendingCount(assignments)} countLabel={ASSIGNMENTS.countLabel(pendingCount(assignments))} />
            {options.length ? (
              <ChipGroup
                label={ASSIGNMENTS.filterLabel}
                allValue="all"
                value={activeFilter}
                onChange={setFilter}
                options={[{ value: "all", label: ASSIGNMENTS.all, count: pendingCount(assignments) }, ...options]}
              />
            ) : null}
          </div>
          {problems.map((account) => <SourceProblem key={account.source} account={account} now={now} timeZone={timeZone} onRetry={onSync} syncing={syncing} />)}
          {staleSince ? <StaleNote time={staleSince} onRefresh={() => void poll.refresh()} /> : null}
          {body}
        </Card>
      </div>
      <aside className="work-side" aria-label={ASSIGNMENTS.sitesTitle}>
        <SitesCard accounts={accounts} loading={poll.state === "loading"} now={now} timeZone={timeZone} />
      </aside>
    </div>
  );
}

/**
 * 「從信件找到」 (SPEC-mail-assignments §5.5, §5.8): pending assignment
 * suggestions as the Today `.q-row.is-ai` rows, buttons always visible.
 */
function SuggestionsCard({ rows, onDecide }: { rows: AssignmentSuggestionRow[]; onDecide: (row: AssignmentSuggestionRow, action: "assignment" | "dismiss") => void }) {
  return (
    <Card className="work-list work-suggestions" aria-labelledby="work-suggestions-title">
      <div className="q-head">
        <CardHead title={ASSIGNMENTS.suggestionsTitle} titleId="work-suggestions-title" icon={Sparkles} tone="accent" count={rows.length} countLabel={ASSIGNMENTS.suggestionsCount(rows.length)} />
      </div>
      <ul className="q-list">
        {rows.map((row) => (
          <li key={row.itemId} className="q-row is-ai">
            <Tile icon={Sparkles} tone="accent" />
            <div className="q-main">
              <p className="q-title">{row.title}</p>
              <p className="q-meta">{row.meta.join(" · ")}</p>
            </div>
            <div className="q-end">
              {row.actions.map((action, index) => (
                <Button
                  key={action.id}
                  variant={index === 0 ? "secondary" : "ghost"}
                  size="sm"
                  icon={index === 0 ? GraduationCap : undefined}
                  aria-label={action.id === "dismiss" ? ASSIGNMENTS.skipAria : undefined}
                  onClick={() => onDecide(row, action.id === "assignment" ? "assignment" : "dismiss")}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AssignmentRow({ row, now, timeZone, onSubmit, onEdit }: { row: AssignmentView; now: Date; timeZone: string; onSubmit: () => void; onEdit: () => void }) {
  const pending = row.status === "open" || row.status === "overdue";
  const native = isNative(row);
  const short = row.site?.short ?? (row.origin === "moodle" ? "Moodle" : "Canvas");
  const pill = assignmentPill(row);
  const mailHref = row.mailRef ? `#/inbox/${encodeURIComponent(row.mailRef.threadId)}` : undefined;
  const openSite = !native && row.url ? <Button variant="ghost" size="sm" icon={ArrowUpRight} href={row.url} external>{ASSIGNMENTS.open(short)}</Button> : null;
  const openMail = mailHref ? <Button variant="ghost" size="sm" icon={ArrowRight} href={mailHref}>{ASSIGNMENTS.openMail}</Button> : null;
  const edit = native ? <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit} aria-label={ASSIGNMENTS.editAria(row.title)}>{ASSIGNMENTS.edit}</Button> : null;
  const submit = pending ? <Button variant="ghost" size="sm" icon={Check} onClick={onSubmit}>{ASSIGNMENTS.markSubmitted}</Button> : null;
  return (
    <WorkRow
      rowId={row.id}
      icon={GraduationCap}
      tone={row.origin === "mail" ? "mail" : "task"}
      title={row.title}
      href={native ? undefined : row.url}
      {...(native ? { onTitle: onEdit, titleLabel: ASSIGNMENTS.editAria(row.title) } : {})}
      meta={assignmentMeta(row, now, timeZone, META_LABELS)}
      pill={{ ...pill, quietOnPhone: pending }}
      when={assignmentWhen(row, now, timeZone)}
      done={!pending}
      actions={<>{submit}{openSite}{openMail}{edit}</>}
      primary={pending ? (
        <Button variant="secondary" size="sm" icon={Check} className="q-primary" onClick={onSubmit} aria-label={`${ASSIGNMENTS.markSubmitted}「${row.title}」`}>
          {ASSIGNMENTS.markSubmittedTouch}
        </Button>
      ) : null}
    />
  );
}

/** A connected source that needs attention (SPEC-ux §5 "Disconnected"): one notice each. */
function SourceProblem({ account, now, timeZone, onRetry, syncing }: { account: LmsAccountView; now: Date; timeZone: string; onRetry: () => void; syncing: boolean }) {
  const time = syncTime(account.status.lastSyncedAt, now, timeZone);
  if (account.status.state === "needs_reconnect") {
    return (
      <Notice tone="warn" title={ASSIGNMENTS.reconnectTitle(account.short)} actions={<Button size="sm" href={SETTINGS_HREF}>{ASSIGNMENTS.reconnect}</Button>}>
        {ASSIGNMENTS.reconnectHint(time)}
      </Notice>
    );
  }
  return (
    <Notice tone="warn" title={ASSIGNMENTS.errorTitle(account.short)} actions={<Button size="sm" icon={RefreshCw} onClick={onRetry} disabled={syncing}>{ERRORS.retry}</Button>}>
      {ASSIGNMENTS.errorHint(account.status.lastError, time)}
    </Notice>
  );
}

/** Side card: each LMS with its state, account and last sync, or a way to connect it. */
function SitesCard({ accounts, loading, now, timeZone }: { accounts: LmsAccountView[]; loading: boolean; now: Date; timeZone: string }) {
  const connected = accounts.filter((account) => account.connected).length;
  return (
    <Card className="work-card" aria-labelledby="work-sites-title">
      <CardHead title={ASSIGNMENTS.sitesTitle} titleId="work-sites-title" link={{ href: SETTINGS_HREF, label: WORK_PAGE.settings }}>
        {!loading ? <span className="count">{ASSIGNMENTS.sitesCount(connected)}</span> : null}
      </CardHead>
      {loading ? <div className="skel-list" aria-busy="true"><SkeletonRow /><SkeletonRow /></div> : accounts.map((account) => (
        <div key={account.source} className="work-source">
          <Tile icon={GraduationCap} tone={account.source === "moodle" ? "task" : "info"} />
          <div>
            <b>{account.connected ? account.siteLabel : ASSIGNMENTS.siteName[account.source]}</b>
            <span>{account.connected
              ? ASSIGNMENTS.account(account.account?.name ?? account.account?.username, syncTime(account.status.lastSyncedAt, now, timeZone))
              : ASSIGNMENTS.purpose[account.source]}</span>
          </div>
          {account.connected ? <StatusPill state={account.status.state} /> : <Button size="sm" href={SETTINGS_HREF}>{ASSIGNMENTS.connectOne}</Button>}
        </div>
      ))}
    </Card>
  );
}
