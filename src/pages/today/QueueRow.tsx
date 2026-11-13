/**
 * One focus-queue row (SPEC-ux §4.3, §9 FocusQueue): `li.q-row` › tile or
 * serif initial, `.q-main` (title button, one-line meta), `.q-end` (hover
 * actions to the left of the always-visible `.when`, the touch primary),
 * and, for the cursor, `.q-detail` with the summary and every action.
 * Suggestion rows never expand: their two buttons are always visible.
 * Touch rows can be swiped: right runs the row's E action; left snoozes, or,
 * on mail rows, reveals the 封存 · 刪除 tray (SPEC-mail-assignments §2.4),
 * except on the expanded cursor row, whose detail already shows both.
 */
import type { MouseEvent } from "react";
import type { QueueAction, QueueItem } from "../../../shared/today";
import { EXTERNAL_LINKS, QUEUE } from "../../copy/today";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { Icon, Sparkles } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Tile } from "../../components/Tile";
import { cx } from "../../lib/cx";
import { useRowSwipe } from "./swipe";
import { SwipeTray } from "./SwipeTray";
import { actionIcon, KIND_TILES } from "./today-icons";
import { KEY_LABELS, actionForKey, detailVariant, hoverActions, isMailRow, isSuggestion, opensExternally, touchPrimary } from "./today-view";

export type SwipeDirection = "done" | "snooze";

export interface QueueRowProps {
  item: QueueItem;
  /** The keyboard cursor (`.is-focus`, aria-current). */
  cursor: boolean;
  /** The cursor row is open in place. */
  expanded: boolean;
  /** Exiting after an action (a ghost of the removed row). */
  leaving?: boolean;
  /** Back after 復原 (a 1 s accent flash). */
  back?: boolean;
  titleRef?: (element: HTMLButtonElement | null) => void;
  onSelect: (item: QueueItem) => void;
  onAction: (item: QueueItem, action: QueueAction) => void;
  onSwipe?: (item: QueueItem, direction: SwipeDirection) => void;
  /** Mail rows: the swipe tray is open on this row (one at a time; the list owns it). */
  trayOpen?: boolean;
  onTray?: (item: QueueItem, open: boolean) => void;
}

function metaParts(item: QueueItem): string[] {
  if (!item.replying) return item.meta;
  const replaced = item.meta.map((part) => (part === "待回覆" ? QUEUE.replying : part));
  return replaced.includes(QUEUE.replying) ? replaced : [...replaced, QUEUE.replying];
}

function Meta({ item }: { item: QueueItem }) {
  const parts = metaParts(item);
  return (
    <p className="q-meta">
      {parts.map((part, index) => (
        <span key={`${index}-${part}`}>
          {index > 0 ? " · " : null}
          {part.startsWith("逾期") || part === QUEUE.replying ? <span className={part === QUEUE.replying ? "replying" : "hot"}>{part}</span> : part}
        </span>
      ))}
      {item.diff ? (
        <>
          {parts.length ? " · " : null}
          <span className="add mono">+{item.diff.add}</span> <span className="del mono">−{item.diff.del}</span>
        </>
      ) : null}
    </p>
  );
}

function When({ item }: { item: QueueItem }) {
  if (!item.when) return null;
  return <span className={cx("when", !item.when.mono && "zh", item.when.tone === "hot" && "hot", item.when.tone === "warm" && "warm")}>{item.when.label}</span>;
}

export function QueueRow({ item, cursor, expanded, leaving, back, titleRef, onSelect, onAction, onSwipe, trayOpen = false, onTray }: QueueRowProps) {
  const ai = isSuggestion(item);
  const open = cursor && expanded && !ai;
  const tile = KIND_TILES[item.kind];
  const primary = touchPrimary(item);
  const archive = item.actions.find((action) => action.id === "archive");
  const trash = item.actions.find((action) => action.id === "trash");
  // The expanded cursor row already shows 封存 and 刪除 in its detail: no tray over them (a left swipe snoozes, as on other rows).
  const tray = !!onTray && isMailRow(item) && !!archive && !!trash && !open;
  const swipe = useRowSwipe({
    enabled: !!onSwipe && !leaving,
    tray,
    open: tray && trayOpen,
    canDone: !!actionForKey(item, "E"),
    canLeft: tray || !!actionForKey(item, "S"),
    onDecision: (decision) => {
      if (decision === "tray-open") onTray?.(item, true);
      else if (decision === "tray-close") onTray?.(item, false);
      else onSwipe?.(item, decision);
    },
  });
  const runFromTray = (action: QueueAction) => {
    onTray?.(item, false);
    onAction(item, action);
  };

  const onRowClick = (event: MouseEvent<HTMLLIElement>) => {
    // Buttons and links (the title included) handle their own clicks; empty row space selects the row.
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    onSelect(item);
  };

  const ext = item.url && !opensExternally(item) ? EXTERNAL_LINKS[item.source] : undefined;

  return (
    <li
      className={cx(
        "q-row", cursor && "is-focus", ai && "is-ai", leaving && "is-leaving", back && "is-back", onSwipe && "can-swipe",
        swipe.direction && `is-swipe-${swipe.direction}`, swipe.traying && "is-traying", swipe.dragging && "is-dragging",
      )}
      aria-current={cursor ? "true" : undefined}
      aria-hidden={leaving ? true : undefined}
      inert={leaving}
      data-row-id={item.id}
      onClick={onRowClick}
      style={swipe.style}
      {...swipe.handlers}
    >
      {swipe.direction ? (
        <span className="q-swipe" aria-hidden="true">
          {swipe.direction === "done" ? actionForKey(item, "E")?.touchLabel : actionForKey(item, "S")?.touchLabel}
        </span>
      ) : null}
      {tray && archive && trash && (swipe.traying || trayOpen) ? (
        <SwipeTray open={trayOpen} subject={item.subject ?? item.title} onArchive={() => runFromTray(archive)} onTrash={() => runFromTray(trash)} />
      ) : null}
      {item.avatar ? <Avatar name={item.title} initial={item.avatar.initial} /> : <Tile icon={tile.icon} tone={tile.tone} />}
      <div className="q-main">
        <button
          ref={titleRef}
          className="q-title"
          type="button"
          tabIndex={cursor ? 0 : -1}
          aria-expanded={ai ? undefined : open}
          onClick={() => onSelect(item)}
        >
          {item.title}
        </button>
        <Meta item={item} />
      </div>
      <div className="q-end">
        {ai ? (
          item.actions.map((action, index) => (
            <Button
              key={action.id}
              variant={index === 0 ? "secondary" : "ghost"}
              size="sm"
              icon={index === 0 ? actionIcon(item, action) : undefined}
              kbd={index === 0 && action.key ? KEY_LABELS[action.key] : undefined}
              aria-label={action.id === "dismiss" ? QUEUE.dismissSuggestion : undefined}
              onClick={() => onAction(item, action)}
            >
              {action.label}
            </Button>
          ))
        ) : (
          <>
            {open ? null : (
              <div className="q-acts">
                {hoverActions(item).map((action) => (
                  <Button key={action.id} variant="ghost" size="sm" icon={actionIcon(item, action)} kbd={action.key ? KEY_LABELS[action.key] : undefined} tabIndex={-1} onClick={() => onAction(item, action)}>
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
            <When item={item} />
            {open || !primary ? null : (
              <Button className="q-primary" variant="secondary" size="sm" icon={actionIcon(item, primary)} onClick={() => onAction(item, primary)}>
                {primary.touchLabel}
              </Button>
            )}
          </>
        )}
      </div>
      {open ? (
        <div className="q-detail">
          {item.summary ? (
            <p className="q-sum">
              {item.summarySource === "rule" ? null : <Icon icon={Sparkles} size="sm" />}
              <span className="kp">{item.summary}</span>
            </p>
          ) : null}
          <div className="q-actions" role="group" aria-label={QUEUE.rowActions(item.title)}>
            {item.actions.map((action, index) => (
              <Button
                key={action.id}
                variant={detailVariant(action, index)}
                size="sm"
                icon={actionIcon(item, action)}
                kbd={action.key ? KEY_LABELS[action.key] : undefined}
                onClick={() => onAction(item, action)}
              >
                {action.label}
              </Button>
            ))}
            {ext && item.url ? <TextLink href={item.url} external>{ext}</TextLink> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
