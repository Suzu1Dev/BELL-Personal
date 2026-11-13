/**
 * FocusQueue (SPEC-ux §4.3, §5, §6.1–§6.2, §9, §11): `.card.queue` with the
 * source chips, the three rule-made groups with their caps, exactly one
 * cursor row opened in place, J/K/↵/E/S/T/C/Space/Esc on the cursor, the
 * 「顯示」 list of today's handled items. Also the
 * loading, empty (state 01), cleared (state 02), source-failure (state 03),
 * stale and error states. Data comes in as a TodayPayload; actions go out
 * through `onAct` (the page calls useToday().act()).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActionId, HandledItem, QueueAction, QueueActionKey, QueueGroup, QueueItem, TodayHabit, TodayPayload, TodaySource } from "../../../shared/today";
import { queueAction } from "../../../shared/today-format";
import { ACTION_EFFECTS } from "../../../shared/today-logic";
import { localTime } from "../../../shared/time";
import { ACTION_TOASTS, BUTTONS } from "../../copy/common";
import { ACTION_HANDLED_LABELS, QUEUE, SOURCE_NOTICES, WIDGET_UNAVAILABLE } from "../../copy/today";
import { Button } from "../../components/Button";
import { CardHead } from "../../components/Card";
import { ChipGroup } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { ChevronDown, CircleCheck, Icon, Plus, RotateCw, Sunrise, Target, Undo2, Unplug } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { SkeletonRow } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { Tile } from "../../components/Tile";
import { cx } from "../../lib/cx";
import { navigate } from "../../lib/router";
import { useShortcuts } from "../../lib/shortcuts";
import { MEDIA, useMediaQuery } from "../../lib/useMediaQuery";
import type { PollState } from "../../lib/usePoll";
import { Celebration } from "./Celebration";
import { QueueRow, type SwipeDirection } from "./QueueRow";
import { useTrayDismiss } from "./swipe";
import { SnoozePopover } from "./SnoozePopover";
import { KIND_TILES } from "./today-icons";
import {
  QUEUE_SOURCE_IDS, TODAY_TZ, actionForKey, allItems, arrivals, cursorAfterRemoval, isBroken, isInAppUrl, isMailRow, isSuggestion, mailAssignmentToast, moveCursor, oldestSync,
  queueChips, queueView, rowOrder, sincePhrase, type GroupView, type QueueFilter,
} from "./today-view";
import "./FocusQueue.css";

export interface FocusQueueProps {
  payload: TodayPayload | undefined;
  pollState: PollState;
  /** When the payload was fetched (ms), for 「顯示 08:12 的內容。」. */
  updatedAt?: number;
  onAct: (item: QueueItem, action: ActionId, params?: Record<string, unknown>, message?: string) => void;
  onRetry: () => void;
  onSyncSources: (ids: string[]) => void;
  onCapture: () => void;
  onUndoHandled: (entry: HandledItem) => void;
  onToggleHabit: (habit: TodayHabit) => void;
}

/** Row exit: .22 s slide and fade, then .18 s height (SPEC-ux §8). */
const EXIT_MS = 400;
const BACK_FLASH_MS = 1_000;

/** Focus that is gone: on <body>, on a removed element, or on a toast button that is about to leave. */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || !!active.closest(".toast-host");
}

export function FocusQueue(props: FocusQueueProps) {
  const { payload } = props;
  const view = !payload ? "loading" : allItems(payload).length ? "list" : payload.counts.handled > 0 ? "cleared" : "empty";
  // The view committed last: the cleared state takes focus only right after the last row closed, and the
  // list only when it comes back from the cleared state (復原), never on page load.
  const committed = useRef(view);
  useEffect(() => { committed.current = view; });
  if (!payload) return props.pollState === "error" ? <QueueUnavailable /> : <QueueLoading />;
  if (view === "cleared") return <Celebration payload={payload} onToggleHabit={props.onToggleHabit} focusOnMount={committed.current === "list"} />;
  if (view === "empty") return <QueueEmpty {...props} payload={payload} />;
  return <QueueList {...props} payload={payload} focusOnMount={committed.current === "cleared"} />;
}

function QueueHead({ count, children }: { count?: number; children?: ReactNode }) {
  return (
    <header className="q-head">
      <CardHead title={QUEUE.title} titleId="q-title" icon={Target} tone="accent" count={count} countLabel={count === undefined ? undefined : QUEUE.countLabel(count)} />
      {children}
    </header>
  );
}

function QueueLoading() {
  return (
    <section className="card queue" aria-labelledby="q-title" aria-busy="true">
      <QueueHead />
      <div className="q-group">
        <p className="sr-only" role="status">{QUEUE.loading}</p>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </section>
  );
}

/** The first load failed: the card without a skeleton or 「正在載入」 (the page notice says why and has 重試). */
function QueueUnavailable() {
  return (
    <section className="card queue" aria-labelledby="q-title">
      <QueueHead />
      <p className="widget-off kp">{WIDGET_UNAVAILABLE}</p>
    </section>
  );
}

function QueueEmpty({ payload, pollState, updatedAt, onRetry, onSyncSources, onCapture }: FocusQueueProps & { payload: TodayPayload }) {
  return (
    <section className="card queue" aria-labelledby="q-title">
      <QueueHead count={0} />
      <QueueNotices payload={payload} pollState={pollState} updatedAt={updatedAt} onRetry={onRetry} onSyncSources={onSyncSources} />
      <div className="q-empty">
        <EmptyState
          icon={Sunrise}
          title={QUEUE.emptyTitle}
          hint={QUEUE.emptyHint}
          action={<Button variant="secondary" icon={Plus} kbd="N" onClick={onCapture}>{BUTTONS.captureOne}</Button>}
        />
      </div>
    </section>
  );
}

/** Source failures are announced once per session (SPEC-ux §11 "Live regions"). */
const announced = new Set<string>();

function SourceNotice({ source, payload, onSyncSources }: { source: TodaySource; payload: TodayPayload; onSyncSources: (ids: string[]) => void }) {
  const reconnect = source.state === "reconnect";
  const role = announced.has(source.id) ? undefined : "alert";
  useEffect(() => {
    announced.add(source.id);
  }, [source.id]);
  const reason = reconnect ? (SOURCE_NOTICES.reason[source.id] ?? SOURCE_NOTICES.reconnectTitle(source.label)) : SOURCE_NOTICES.failed;
  const what = SOURCE_NOTICES.missing[source.id] ?? SOURCE_NOTICES.missing.feeds;
  const time = source.lastSyncedAt ? sincePhrase(source.lastSyncedAt, payload.now) : undefined;
  return (
    <Notice
      tone="warn"
      icon={Unplug}
      role={role}
      title={reconnect ? SOURCE_NOTICES.reconnectTitle(source.label) : SOURCE_NOTICES.errorTitle(source.label)}
      actions={reconnect
        ? <Button variant="secondary" size="sm" href="#/settings/sources">{SOURCE_NOTICES.reconnect}</Button>
        : <Button variant="secondary" size="sm" icon={RotateCw} onClick={() => onSyncSources([source.id])}>{SOURCE_NOTICES.retry}</Button>}
    >
      {SOURCE_NOTICES.body(reason, what, payload.counts.open, time)}
    </Notice>
  );
}

function QueueNotices({ payload, pollState, updatedAt, onRetry, onSyncSources }: Pick<FocusQueueProps, "pollState" | "updatedAt" | "onRetry" | "onSyncSources"> & { payload: TodayPayload }) {
  const broken = payload.sources.filter((source) => QUEUE_SOURCE_IDS.includes(source.id) && isBroken(source));
  const failed = pollState === "stale";
  if (!broken.length && !failed) return null;
  return (
    <div className="q-notices">
      {failed ? (
        <Notice
          tone="error"
          role="alert"
          title={QUEUE.errorTitle}
          actions={<Button variant="secondary" size="sm" icon={RotateCw} onClick={onRetry}>{BUTTONS.retry}</Button>}
        >
          {QUEUE.errorBody(updatedAt ? localTime(TODAY_TZ, updatedAt) : localTime(TODAY_TZ, payload.now))}
        </Notice>
      ) : null}
      {broken.length > 2 ? (
        <Notice
          tone="warn"
          icon={Unplug}
          title={SOURCE_NOTICES.many(broken.length)}
          actions={<Button variant="secondary" size="sm" href="#/settings/sources">{SOURCE_NOTICES.view}</Button>}
        >
          {SOURCE_NOTICES.manyBody}
        </Notice>
      ) : (
        broken.map((source) => <SourceNotice key={source.id} source={source} payload={payload} onSyncSources={onSyncSources} />)
      )}
    </div>
  );
}

interface Ghost {
  item: QueueItem;
  group: QueueGroup;
  index: number;
}

/** Whether a key event's target is somewhere the queue keys may act (the page itself, or inside the queue). */
function inQueueScope(target: unknown): boolean {
  if (!(target instanceof Element)) return true;
  return target === document.body || target.id === "main" || !!target.closest(".queue");
}

/** ↵ and Space act on the cursor only from the page or a row title; on any other control they keep their native meaning. */
function onTitleOrPage(target: unknown): boolean {
  if (!(target instanceof Element)) return true;
  return target === document.body || target.id === "main" || target.classList.contains("q-title");
}

/** The toast line for suggestions quotes the event or todo and its time; 轉成作業 on mail quotes what the rules read. */
function toastFor(item: QueueItem, action: ActionId, now: string): string | undefined {
  if (action === "assignment" && isMailRow(item)) return mailAssignmentToast(item);
  if (!isSuggestion(item)) return undefined;
  if (action === "calendar") return ACTION_TOASTS.calendar(item.meta[0] ?? item.title, item.meta[1]);
  if (action === "todo") return ACTION_TOASTS.todo(item.meta[0] ?? item.title, item.meta[1]);
  // 加入作業 quotes the assignment and its deadline phrase (meta: title · course? · deadline · 來自 …).
  if (action === "assignment") return ACTION_TOASTS.assignment(item.subject ?? item.meta[0] ?? item.title, item.meta.find((part) => part.endsWith("截止")));
  return undefined;
}

function QueueList({ payload, pollState, updatedAt, onAct, onRetry, onSyncSources, onUndoHandled, focusOnMount }: FocusQueueProps & { payload: TodayPayload; focusOnMount?: boolean }) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<QueueGroup>>(new Set());
  const [cursorId, setCursorId] = useState<string>();
  const [detailOpen, setDetailOpen] = useState(true);
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const [ghosts, setGhosts] = useState<ReadonlyMap<string, Ghost>>(new Map());
  const [back, setBack] = useState<ReadonlySet<string>>(new Set());
  const [snooze, setSnooze] = useState<{ item: QueueItem; anchor: HTMLElement | null }>();
  const [showHandled, setShowHandled] = useState(false);
  const mobile = useMediaQuery(MEDIA.mobile);

  const known = useRef<Set<string> | null>(null);
  const left = useRef(new Set<string>());
  const titles = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef<string | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const groups = useMemo(() => queueView(payload, filter, held, expandedGroups), [payload, filter, held, expandedGroups]);
  const order = useMemo(() => rowOrder(groups), [groups]);
  const cursor = cursorId && order.includes(cursorId) ? cursorId : order[0];
  const cursorItem = cursor ? groups.flatMap((group) => group.shown).find((item) => item.id === cursor) : undefined;
  const heldNow = allItems(payload).filter((item) => held.has(item.id)).length;

  // New rows never jump the list (SPEC-ux §6.1); rows coming back after 復原 flash once (§8).
  useEffect(() => {
    const ids = allItems(payload).map((item) => item.id);
    if (!known.current) {
      known.current = new Set(ids);
      return;
    }
    const seen = known.current;
    const { silent, held: arrived } = arrivals(ids, seen, cursor);
    silent.forEach((id) => seen.add(id));
    if (arrived.length) setHeld((current) => new Set([...current, ...arrived]));
    const returned = ids.filter((id) => left.current.has(id));
    if (returned.length) {
      returned.forEach((id) => left.current.delete(id));
      setGhosts((current) => {
        if (!returned.some((id) => current.has(id))) return current;
        const next = new Map(current);
        returned.forEach((id) => next.delete(id));
        return next;
      });
      setBack((current) => new Set([...current, ...returned]));
      later(() => setBack((current) => new Set([...current].filter((id) => !returned.includes(id)))), BACK_FLASH_MS);
    }
    // `cursor` is read at the moment the new data lands; re-running on cursor moves would misfile rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);

  // DOM focus follows the cursor after an action or a J/K move.
  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    titles.current.get(id)?.focus();
  });

  // Back from the cleared state (復原 on the last row): the restored row takes focus again.
  useEffect(() => {
    if (focusOnMount && cursor && focusLost()) titles.current.get(cursor)?.focus();
    // Only on mount: later renders move focus through focusNext.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (item: QueueItem) => {
    if (item.id === cursor && detailOpen && !isSuggestion(item)) setDetailOpen(false);
    else {
      setCursorId(item.id);
      setDetailOpen(true);
    }
  };

  const focusCursor = (id: string | undefined) => {
    if (!id) return;
    setCursorId(id);
    setDetailOpen(true);
    focusNext.current = id;
  };

  const openSnooze = (item: QueueItem) => {
    const anchor = titles.current.get(item.id)?.closest("li") ?? null;
    setSnooze({ item, anchor });
  };

  const run = (item: QueueItem, action: QueueAction, params?: Record<string, unknown>) => {
    if (action.id === "snooze" && !params) {
      openSnooze(item);
      return;
    }
    if (action.id === "open" || action.id === "reply") {
      if (isInAppUrl(item.url)) navigate(item.url);
      else if (item.url) window.open(item.url, "_blank", "noopener,noreferrer");
      else if (item.kind === "todo") navigate("#/tasks");
    }
    if (ACTION_EFFECTS[action.id].closes) {
      const group = groups.find((entry) => entry.shown.some((row) => row.id === item.id));
      const index = group ? group.shown.findIndex((row) => row.id === item.id) : 0;
      setGhosts((current) => new Map(current).set(item.id, { item, group: item.group, index }));
      later(() => setGhosts((current) => {
        if (!current.has(item.id)) return current;
        const next = new Map(current);
        next.delete(item.id);
        return next;
      }), EXIT_MS);
      left.current.add(item.id);
      // Focus never falls to the page: the next row takes the cursor, or the cursor row keeps it.
      if (item.id === cursor) focusCursor(cursorAfterRemoval(order, item.id));
      else if (cursor) focusNext.current = cursor;
    }
    onAct(item, action.id, params, toastFor(item, action.id, payload.now));
  };

  const swipe = (item: QueueItem, direction: SwipeDirection) => {
    const action = actionForKey(item, direction === "done" ? "E" : "S");
    if (action) run(item, action);
  };

  const pressKey = (key: QueueActionKey) => {
    if (!cursorItem) return false;
    const action = actionForKey(cursorItem, key) ?? (key === "A" && isMailRow(cursorItem) ? queueAction("assignment") : undefined);
    if (!action) return false;
    run(cursorItem, action);
    return true;
  };

  // One swipe tray at a time; scrolling, Esc or touching anywhere else closes it (SPEC-mail-assignments §2.4).
  const [trayFor, setTrayFor] = useState<string>();
  useTrayDismiss(trayFor, () => setTrayFor(undefined));
  const tray = (item: QueueItem, open: boolean) => setTrayFor(open ? item.id : undefined);

  const move = (delta: number) => {
    const active = document.activeElement;
    // The first J or ↓ only steps into the queue (SPEC-ux §6.1).
    if (!(active instanceof HTMLElement && active.classList.contains("q-title"))) focusCursor(cursor);
    else focusCursor(moveCursor(order, cursor, delta));
  };

  useShortcuts({
    j: () => move(1),
    k: () => move(-1),
    arrowdown: (event) => (inQueueScope(event.target) ? move(1) : false),
    arrowup: (event) => (inQueueScope(event.target) ? move(-1) : false),
    enter: (event) => (onTitleOrPage(event.target) ? pressKey("Enter") : false),
    e: () => pressKey("E"),
    s: () => pressKey("S"),
    t: () => pressKey("T"),
    c: () => pressKey("C"),
    // SPEC-mail-assignments §2.3: # / Delete 刪除 a mail row, A 轉成作業 or 加入作業.
    "#": () => pressKey("#"),
    delete: () => pressKey("#"),
    a: () => pressKey("A"),
    space: (event) => {
      if (!onTitleOrPage(event.target) || !cursorItem || isSuggestion(cursorItem)) return false;
      setDetailOpen((open) => !open);
      return true;
    },
    escape: () => {
      if (!cursorItem || !detailOpen || isSuggestion(cursorItem)) return false;
      setDetailOpen(false);
      return true;
    },
  }, !snooze);

  const chips = queueChips(payload, held);
  const staleAt = oldestSync(payload.sources, QUEUE_SOURCE_IDS);
  const handledItems = payload.handled ?? [];

  return (
    <section className="card queue" aria-labelledby="q-title">
      <QueueHead count={payload.counts.open}>
        {chips.length > 1 ? (
          <ChipGroup<QueueFilter>
            label={QUEUE.filterLabel}
            value={filter}
            allValue="all"
            onChange={setFilter}
            options={chips.map((chip) => ({
              value: chip.value,
              label: QUEUE.chips[chip.value],
              count: chip.count,
              error: !!chip.broken,
              errorTitle: chip.broken ? (chip.broken.state === "reconnect" ? QUEUE.chipError(chip.broken.label) : QUEUE.chipFailed(chip.broken.label)) : undefined,
            }))}
          />
        ) : null}
      </QueueHead>
      {staleAt ? (
        <div className="q-stale">
          <StaleNote
            time={sincePhrase(staleAt, payload.now)}
            onRefresh={() => onSyncSources(payload.sources.filter((source) => QUEUE_SOURCE_IDS.includes(source.id) && source.state === "stale").map((source) => source.id))}
          />
        </div>
      ) : null}
      <QueueNotices payload={payload} pollState={pollState} updatedAt={updatedAt} onRetry={onRetry} onSyncSources={onSyncSources} />
      {heldNow ? (
        <div className="q-new">
          <button
            type="button"
            className="chip q-new-pill"
            onClick={() => {
              // The pill leaves with this click: focus moves to the first row it shows (else back to the cursor).
              const first = rowOrder(queueView(payload, filter, new Set(), expandedGroups)).find((id) => held.has(id));
              held.forEach((id) => known.current?.add(id));
              setHeld(new Set());
              if (first) focusCursor(first);
              else if (cursor) focusNext.current = cursor;
            }}
          >
            {QUEUE.newItems(heldNow)}
          </button>
        </div>
      ) : null}

      {groups.map((group) => (
        <QueueGroupView
          key={group.group}
          group={group}
          ghosts={[...ghosts.values()].filter((ghost) => ghost.group === group.group && !group.items.some((item) => item.id === ghost.item.id))}
          expanded={expandedGroups.has(group.group)}
          onExpand={(open) => setExpandedGroups((current) => {
            const next = new Set(current);
            if (open) next.add(group.group);
            else next.delete(group.group);
            return next;
          })}
          cursor={cursor}
          detailOpen={detailOpen}
          back={back}
          titles={titles.current}
          onSelect={select}
          onAction={run}
          onSwipe={swipe}
          trayFor={trayFor}
          onTray={tray}
        />
      ))}

      <footer className="q-foot">
        <span className="done"><Icon icon={CircleCheck} size="sm" />{QUEUE.handled(payload.counts.handled)}</span>
        {handledItems.length ? (
          <button className="link" type="button" aria-expanded={showHandled} aria-controls="q-handled" onClick={() => setShowHandled((open) => !open)}>
            {showHandled ? QUEUE.hide : QUEUE.show}
            <Icon icon={ChevronDown} size="xs" className={cx(showHandled && "is-open")} />
          </button>
        ) : null}
      </footer>
      {showHandled && handledItems.length ? (
        <ul className="q-handled" id="q-handled" aria-label={QUEUE.handled(payload.counts.handled)}>
          {handledItems.map((entry) => {
            const tile = KIND_TILES[entry.kind] ?? KIND_TILES.todo;
            return (
              <li className="q-row is-done" key={entry.actionId}>
                <Tile icon={tile.icon} tone={tile.tone} />
                <div className="q-main">
                  <p className="q-title">{entry.title}</p>
                  <p className="q-meta">{ACTION_HANDLED_LABELS[entry.action]} · {QUEUE.handledAt(localTime(TODAY_TZ, entry.at))}</p>
                </div>
                <div className="q-end">
                  {entry.undoable ? (
                    <Button variant="ghost" size="sm" icon={Undo2} onClick={() => onUndoHandled(entry)}>{QUEUE.handledUndo}</Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {snooze ? (
        <SnoozePopover
          snoozeLimit={snooze.item.snoozeLimit}
          now={payload.now}
          anchor={snooze.anchor}
          sheet={mobile}
          onClose={() => {
            focusNext.current = snooze.item.id;
            setSnooze(undefined);
          }}
          onPick={(until, label) => {
            const item = snooze.item;
            setSnooze(undefined);
            const action = item.actions.find((entry) => entry.id === "snooze");
            if (action) run(item, action, { until, label });
          }}
        />
      ) : null}
    </section>
  );
}

interface QueueGroupViewProps {
  group: GroupView;
  ghosts: Ghost[];
  expanded: boolean;
  onExpand: (open: boolean) => void;
  cursor: string | undefined;
  detailOpen: boolean;
  back: ReadonlySet<string>;
  titles: Map<string, HTMLButtonElement>;
  onSelect: (item: QueueItem) => void;
  onAction: (item: QueueItem, action: QueueAction) => void;
  onSwipe: (item: QueueItem, direction: SwipeDirection) => void;
  /** The mail row whose swipe tray is open. */
  trayFor: string | undefined;
  onTray: (item: QueueItem, open: boolean) => void;
}

function QueueGroupView({ group, ghosts, expanded, onExpand, cursor, detailOpen, back, titles, onSelect, onAction, onSwipe, trayFor, onTray }: QueueGroupViewProps) {
  const copy: { title: string; hint?: string } = QUEUE.groups[group.group];
  const headId = `qg-${group.group}`;
  const rows: { item: QueueItem; ghost: boolean }[] = group.shown.map((item) => ({ item, ghost: false }));
  for (const ghost of [...ghosts].sort((a, b) => a.index - b.index)) rows.splice(Math.min(ghost.index, rows.length), 0, { item: ghost.item, ghost: true });
  const capped = group.hidden > 0;
  return (
    <section className="q-group" aria-labelledby={headId}>
      <div className="q-ghead">
        <h3 id={headId}>{copy.title}</h3>
        <span className="count" aria-label={QUEUE.groupCount(group.items.length)}>{group.items.length}</span>
        {copy.hint ? <span className="hint">{copy.hint}</span> : null}
      </div>
      <ul className="q-list">
        {rows.map(({ item, ghost }) => (
          <QueueRow
            key={item.id}
            item={item}
            cursor={!ghost && item.id === cursor}
            expanded={detailOpen}
            leaving={ghost}
            back={back.has(item.id)}
            titleRef={ghost ? undefined : (element) => {
              if (element) titles.set(item.id, element);
              else titles.delete(item.id);
            }}
            onSelect={onSelect}
            onAction={onAction}
            onSwipe={onSwipe}
            trayOpen={!ghost && trayFor === item.id}
            onTray={onTray}
          />
        ))}
      </ul>
      {capped ? (
        <div className="q-more">
          <Button variant="ghost" size="sm" onClick={() => onExpand(true)}>{QUEUE.more(group.hidden)}</Button>
        </div>
      ) : expanded && group.overflow > 0 ? (
        <div className="q-more">
          <Button variant="ghost" size="sm" onClick={() => onExpand(false)}>{QUEUE.fewer}</Button>
        </div>
      ) : null}
    </section>
  );
}
