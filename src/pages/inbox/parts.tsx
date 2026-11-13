/**
 * Small pieces shared by the inbox list and the reading pane: the row's
 * leading tile or initial, the `.when` phrase and a conversation's action
 * buttons (labels, icons and keys exactly as the Today row's).
 */
import { Bell, Newspaper } from "lucide-react";
import type { InboxCategory, InboxThread } from "../../../shared/mail";
import type { ActionId, QueueAction } from "../../../shared/today";
import { Avatar } from "../../components/Avatar";
import { Button, type ButtonVariant } from "../../components/Button";
import {
  AlarmClock, Archive, ArchiveRestore, CalendarPlus, Check, GraduationCap, ListPlus, Mail, MailOpen, Receipt, Reply, Ticket, Trash2, X, type IconType,
} from "../../components/Icon";
import { Tile, type TileTone } from "../../components/Tile";
import { cx } from "../../lib/cx";
import { QUIET_ACTIONS } from "../today/today-view";

const CATEGORY_TILES: Record<InboxCategory, { icon: IconType; tone: TileTone }> = {
  "needs-reply": { icon: Reply, tone: "mail" },
  bill: { icon: Receipt, tone: "warn" },
  school: { icon: GraduationCap, tone: "task" },
  invitation: { icon: Ticket, tone: "event" },
  newsletter: { icon: Newspaper, tone: "mail" },
  notification: { icon: Bell, tone: "info" },
  other: { icon: Mail, tone: "mail" },
};

/** A person's serif initial, else the category tile (SPEC-ux §3.3 「person avatar or tile」). */
export function ThreadMark({ thread }: { thread: InboxThread }) {
  if (thread.avatar) return <Avatar name={thread.from.name ?? thread.from.email} initial={thread.avatar.initial} />;
  const tile = CATEGORY_TILES[thread.category];
  return <Tile icon={tile.icon} tone={tile.tone} />;
}

export function When({ when }: { when: InboxThread["when"] }) {
  return <span className={cx("when", !when.mono && "zh", when.tone === "hot" && "hot", when.tone === "warm" && "warm")}>{when.label}</span>;
}

export const ACTION_ICONS: Partial<Record<ActionId, IconType>> = {
  reply: Reply, todo: ListPlus, snooze: AlarmClock, archive: Archive, read: MailOpen, calendar: CalendarPlus, dismiss: X, done: Check,
  trash: Trash2, unarchive: ArchiveRestore, assignment: GraduationCap,
};

/** ↵ is shown as the return glyph, letters as themselves. */
export const keyLabel = (key: QueueAction["key"]) => (key === "Enter" ? "↵" : key);

/** primary → btn-primary, 封存 and 略過 → ghost, the rest secondary (SPEC-ux §4.3 cursor row). */
export function variantFor(action: QueueAction, index: number, primary: boolean): ButtonVariant {
  if (index === 0) return primary ? "primary" : "secondary";
  return QUIET_ACTIONS.has(action.id) ? "ghost" : "secondary";
}

export interface ActionButtonProps {
  action: QueueAction;
  index: number;
  /** The first action is the filled primary button. */
  primary?: boolean;
  touch?: boolean;
  onRun: (action: QueueAction) => void;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  expanded?: boolean;
  /** Gmail is not connected: dimmed but focusable, described by the element with this id (onRun only says why). */
  blockedBy?: string;
}

export function ActionButton({ action, index, primary = true, touch, onRun, buttonRef, expanded, blockedBy }: ActionButtonProps) {
  return (
    <Button
      ref={buttonRef}
      variant={variantFor(action, index, primary)}
      size="sm"
      icon={ACTION_ICONS[action.id]}
      kbd={touch ? undefined : keyLabel(action.key)}
      onClick={() => onRun(action)}
      {...(blockedBy ? { "aria-disabled": true as const, "aria-describedby": blockedBy } : {})}
      {...(action.id === "snooze" ? { "aria-haspopup": "menu" as const, "aria-expanded": !!expanded } : {})}
    >
      {touch ? action.touchLabel : action.label}
    </Button>
  );
}
