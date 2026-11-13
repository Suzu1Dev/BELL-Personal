/**
 * The conversation list (SPEC-ux §3.3, SPEC-mail-assignments §2–§4):
 * `.card.queue` with the tools row (search field and the 收件匣 · 封存 · 全部
 * switch), the category chips in the plain 收件匣 view, then `.q-group`
 * sections — categories (with 全部標為已讀), or one flat group for 封存,
 * 全部 and search results — of `.q-row` rows in the Today grammar (initial
 * or tile, subject, 寄件者 · 一行摘要, received time). Without opening a
 * conversation: hover (or focus) shows its primary, 封存 and 刪除 (two icon
 * buttons beside the reading pane), and on touch a left swipe reveals the
 * 封存 · 刪除 tray while a right swipe runs the E action. The cursor row is
 * the one shown in the reading pane.
 */
import type { ReactNode } from "react";
import type { InboxCategory, InboxThread, MailView } from "../../../shared/mail";
import type { QueueAction } from "../../../shared/today";
import { Button } from "../../components/Button";
import { Icon, CheckCheck, Inbox } from "../../components/Icon";
import { Keys } from "../../components/Kbd";
import { Tile } from "../../components/Tile";
import { ACTION_LABELS } from "../../copy/common";
import { INBOX, MAIL_SEARCH, ROW_ACTIONS } from "../../copy/inbox";
import { cx } from "../../lib/cx";
import { useSingleKeyShortcuts } from "../../lib/preferences";
import { inboxLegendItems } from "../../lib/shortcuts";
import { useRowSwipe } from "../today/swipe";
import { SwipeTray } from "../today/SwipeTray";
import { GMAIL_WRITES, highlightRanges, mailHoverActions } from "./inbox-model";
import { ACTION_ICONS, keyLabel, ThreadMark, When } from "./parts";

export interface ListSection {
  key: string;
  title: string;
  hint?: string;
  /** Mono count after the title (category groups). */
  count?: number;
  /** A category group: its header offers 全部標為已讀 while it has unread mail. */
  category?: InboxCategory;
  unread?: number;
  threads: InboxThread[];
}

export interface InboxListProps {
  /** Conversations in the view (the card head's count). */
  count?: number;
  /** Rows on screen (the footer and legend show while there are any). */
  rows: number;
  /** The search field and the view switch (`.inbox-tools`). */
  tools: ReactNode;
  /** The category chips: only in the 收件匣 view without a query. */
  chips?: ReactNode;
  sections: ListSection[];
  /** Under the sections: 載入更多, 正在搜尋 Gmail…, notices for the Gmail part. */
  after?: ReactNode;
  view: MailView;
  /** Literal search terms to highlight. */
  terms: readonly string[];
  cursor: string | undefined;
  /** The reading pane is beside the list (≥1180). */
  split: boolean;
  onSelect: (thread: InboxThread) => void;
  onRun: (thread: InboxThread, action: QueueAction) => void;
  /**
   * Gmail is not connected: 封存 · 標為已讀 · 刪除 · 移回收件匣 stay on screen
   * dimmed (aria-disabled, so focus stays) and described by the notice's
   * `#inbox-offline` line; running one only says why (onRun refuses it).
   */
  offline?: boolean;
  onMarkCategory: (category: InboxCategory, threads: InboxThread[]) => void;
  titleRef: (threadId: string, element: HTMLButtonElement | null) => void;
  /** Notices and the stale note, under the head. */
  notices?: ReactNode;
  /** Shown instead of the sections when there is nothing to list. */
  empty?: ReactNode;
  /** Conversations hidden until their snooze ends (the footer line). */
  snoozed: number;
  /** The conversation whose swipe tray is open (one at a time). */
  trayFor: string | undefined;
  onTray: (threadId: string | undefined) => void;
  /** The polite live region: search results and pages loaded. */
  announce?: string;
}

/**
 * The compact 封存 / 移回收件匣 button's tooltip names its key only when E is
 * that action: on unread notices E is 標為已讀 and 封存 has no key.
 */
export function compactTitle(close: QueueAction): string {
  if (close.id === "unarchive") return close.key === "E" ? ROW_ACTIONS.restoreTitle : ROW_ACTIONS.restoreShortTitle;
  return close.key === "E" ? ROW_ACTIONS.archiveTitle : ROW_ACTIONS.archiveShortTitle;
}

export function stateText(thread: InboxThread): string | undefined {
  if (thread.state?.kind === "replying") return INBOX.replying;
  if (thread.state?.kind === "handled" && thread.state.action === "todo") return INBOX.handledTodo;
  if ((thread.state?.kind === "handled" && thread.state.action === "assignment") || thread.converted) return INBOX.converted;
  if (thread.replied) return INBOX.replied;
  return undefined;
}

/** The aria props of a button whose action cannot run without Gmail; none while it can. */
export function offlineProps(action: QueueAction | undefined, offline: boolean | undefined) {
  return offline && action && GMAIL_WRITES.has(action.id) ? { "aria-disabled": true as const, "aria-describedby": "inbox-offline" } : {};
}

/** `text` with the search terms wrapped in `<mark class="hit">`. */
export function Hit({ text, terms }: { text: string; terms: readonly string[] }) {
  const ranges = highlightRanges(text, terms);
  if (!ranges.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark className="hit" key={start}>{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export interface PagesFooterProps {
  /** The listing answered (not loading, not failed). */
  ready: boolean;
  nextPageToken?: string;
  loadingMore: boolean;
  origin?: "gmail" | "cache";
  /** Rows of this listing on screen. */
  rows: number;
  onLoadMore: () => void;
}

/**
 * Under a Gmail listing (SPEC-mail-assignments §3.2): 載入更多 whenever Gmail
 * has another page, even when every row on screen was acted on or already
 * shown above (a search's local results); 「沒有更多信了。」 only at the end.
 * While loading the button stays a focusable `aria-disabled` button (a
 * disabled one drops keyboard focus to <body>, §9).
 */
export function PagesFooter({ ready, nextPageToken, loadingMore, origin, rows, onLoadMore }: PagesFooterProps) {
  if (!ready) return null;
  if (nextPageToken) {
    return (
      <div className="q-more">
        <Button
          variant="ghost"
          size="sm"
          data-load-more=""
          aria-disabled={loadingMore || undefined}
          aria-busy={loadingMore || undefined}
          onClick={() => { if (!loadingMore) onLoadMore(); }}
        >
          {loadingMore ? MAIL_SEARCH.loadingMore : MAIL_SEARCH.loadMore}
        </Button>
      </div>
    );
  }
  return rows && origin === "gmail" ? <p className="inbox-none">{MAIL_SEARCH.noMore}</p> : null;
}

export function InboxList(props: InboxListProps) {
  const { count, rows, tools, chips, sections, after, cursor, notices, empty, snoozed, announce, view } = props;
  // In 封存, E is 移回收件匣.
  const legend = inboxLegendItems().map((item) => (view === "archive" && item.keys[0] === "E" ? { ...item, label: ACTION_LABELS.unarchive } : item));
  // The legend lists single keys (J K E #…): hidden when 單鍵快捷鍵 is off, like Today's.
  const singleKeys = useSingleKeyShortcuts();
  return (
    <section className="card queue inbox-list" aria-labelledby="inbox-list-title">
      <header className="q-head">
        <div className="card-head">
          <Tile icon={Inbox} tone="mail" />
          <h2 id="inbox-list-title">{INBOX.listTitle}</h2>
          {count !== undefined ? <span className="count" aria-label={INBOX.listCountLabel(count)}>{count}</span> : null}
        </div>
        <div className="inbox-tools">{tools}</div>
        {chips}
      </header>
      <p className="sr-only" role="status" aria-live="polite">{announce ?? ""}</p>
      {notices}
      {empty ?? sections.map((section) => (
        <section key={section.key} className="q-group" aria-labelledby={`inbox-group-${section.key}`}>
          <div className="q-ghead">
            <h3 id={`inbox-group-${section.key}`}>{section.title}</h3>
            {section.count !== undefined ? <span className="count">{section.count}</span> : null}
            {section.hint ? <span className="hint">{section.hint}</span> : null}
            {section.category && section.unread ? (
              <Button
                variant="ghost"
                size="sm"
                icon={CheckCheck}
                className="g-act"
                aria-label={INBOX.markAllReadLabel(section.title)}
                {...(props.offline ? { "aria-disabled": true as const, "aria-describedby": "inbox-offline" } : {})}
                onClick={() => props.onMarkCategory(section.category!, section.threads)}
              >
                {INBOX.markAllRead}
              </Button>
            ) : null}
          </div>
          <ul className="q-list">
            {section.threads.map((thread) => (
              <Row key={thread.threadId} thread={thread} focus={thread.threadId === cursor} {...props} />
            ))}
          </ul>
        </section>
      ))}
      {empty ? null : after}
      {snoozed || rows ? (
        <footer className="q-foot">
          {snoozed ? <span className="done">{INBOX.snoozedNote(snoozed)}</span> : null}
          {singleKeys ? (
            <span className="legend" aria-hidden="true">
              {legend.map((item) => <span key={item.label}><Keys keys={item.keys} />{item.label}</span>)}
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

interface RowProps extends InboxListProps {
  thread: InboxThread;
  focus: boolean;
}

function Row({ thread, focus, split, view, terms, onSelect, onRun, offline, titleRef, trayFor, onTray }: RowProps) {
  const note = stateText(thread);
  const primary = thread.actions[0];
  const hover = mailHoverActions(thread.actions);
  const close = thread.actions.find((action) => action.id === "archive" || action.id === "unarchive");
  const trash = thread.actions.find((action) => action.id === "trash");
  const done = thread.actions.find((action) => action.key === "E");
  const restore = close?.id === "unarchive";
  const archivedInAll = view === "all" && thread.location === "archive";
  const trayOpen = trayFor === thread.threadId;
  const tray = !!close && !!trash;
  const swipe = useRowSwipe({
    enabled: true,
    tray,
    open: tray && trayOpen,
    canDone: !!done,
    canLeft: tray,
    onDecision: (decision) => {
      if (decision === "tray-open") onTray(thread.threadId);
      else if (decision === "tray-close") onTray(undefined);
      else if (decision === "done" && done) onRun(thread, done);
    },
  });
  const runFromTray = (action: QueueAction) => {
    onTray(undefined);
    onRun(thread, action);
  };
  return (
    <li
      className={cx(
        "q-row can-swipe", focus && "is-focus", thread.unread && "is-unread",
        swipe.direction && `is-swipe-${swipe.direction}`, swipe.traying && "is-traying", swipe.dragging && "is-dragging",
      )}
      aria-current={focus ? "true" : undefined}
      data-row-id={thread.threadId}
      style={swipe.style}
      {...swipe.handlers}
      onClick={(event) => {
        // Clicking empty row space selects it too; buttons and links handle themselves.
        if ((event.target as HTMLElement).closest("button, a")) return;
        onSelect(thread);
      }}
    >
      {swipe.direction === "done" && done ? <span className="q-swipe" aria-hidden="true">{done.touchLabel}</span> : null}
      {tray && close && trash && (swipe.traying || trayOpen) ? (
        <SwipeTray open={trayOpen} subject={thread.subject} restore={restore} onArchive={() => runFromTray(close)} onTrash={() => runFromTray(trash)} />
      ) : null}
      <ThreadMark thread={thread} />
      <div className="q-main">
        <button
          type="button"
          className="q-title"
          tabIndex={focus ? 0 : -1}
          ref={(element) => titleRef(thread.threadId, element)}
          aria-controls={split ? "mail-reader" : undefined}
          onClick={() => onSelect(thread)}
        >
          {thread.unread ? <span className="sr-only">{INBOX.unreadPrefix}</span> : null}
          <Hit text={thread.title} terms={terms} />
        </button>
        <p className="q-meta">
          {archivedInAll ? <span className="q-note">{INBOX.archived} · </span> : null}
          {note ? <span className={cx("q-note", thread.state?.kind === "replying" && "is-replying")}>{note} · </span> : null}
          <Hit text={thread.meta.join(" · ")} terms={terms} />
        </p>
      </div>
      <div className="q-end">
        {split ? (
          <div className="q-acts is-compact">
            {close ? (
              <Button
                variant="icon"
                size="sm"
                icon={ACTION_ICONS[close.id]}
                aria-label={restore ? ROW_ACTIONS.restore(thread.subject) : ROW_ACTIONS.archive(thread.subject)}
                title={compactTitle(close)}
                {...offlineProps(close, offline)}
                onClick={() => onRun(thread, close)}
              />
            ) : null}
            {trash ? (
              <Button variant="icon" size="sm" icon={ACTION_ICONS.trash} aria-label={ROW_ACTIONS.trash(thread.subject)} title={ROW_ACTIONS.trashTitle} {...offlineProps(trash, offline)} onClick={() => onRun(thread, trash)} />
            ) : null}
          </div>
        ) : (
          <div className="q-acts">
            {hover.map((action, slot) => (
              // Keyed by slot: an action that keeps the row (標為已讀, 封存 in 全部) changes the set, and a remounted button would drop focus.
              <Button key={slot} variant="ghost" size="sm" icon={ACTION_ICONS[action.id]} kbd={keyLabel(action.key)} {...offlineProps(action, offline)} onClick={() => onRun(thread, action)}>
                {action.label}
              </Button>
            ))}
          </div>
        )}
        {thread.unread ? <span className="unread-dot" aria-hidden="true" /> : null}
        <When when={thread.when} />
        {primary ? (
          <button type="button" className="btn btn-secondary btn-sm q-primary" {...offlineProps(primary, offline)} onClick={() => onRun(thread, primary)}>
            {ACTION_ICONS[primary.id] ? <Icon icon={ACTION_ICONS[primary.id]!} size="sm" /> : null}
            {primary.touchLabel}
          </button>
        ) : null}
      </div>
    </li>
  );
}
