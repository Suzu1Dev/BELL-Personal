/**
 * Which lucide glyph and tile tone each Today row and action uses (SPEC-ux
 * §4.3 table: module identity comes from one tinted tile).
 */
import type { ActionId, QueueAction, QueueItem, QueueKind } from "../../../shared/today";
import {
  AlarmClock, Archive, ArchiveRestore, ArrowRight, ArrowUpRight, CalendarPlus, Check, Eye, Flag, GitPullRequest, GraduationCap, ListPlus, ListTodo,
  Mail, MailOpen, Receipt, Reply, Sparkles, Trash2, X, type IconType,
} from "../../components/Icon";
import { isInAppUrl } from "./today-view";
import type { TileTone } from "../../components/Tile";

export const KIND_TILES: Record<QueueKind, { icon: IconType; tone: TileTone }> = {
  "mail.reply": { icon: Mail, tone: "mail" },
  "mail.bill": { icon: Receipt, tone: "warn" },
  "mail.action": { icon: Mail, tone: "mail" },
  assignment: { icon: GraduationCap, tone: "task" },
  review: { icon: GitPullRequest, tone: "info" },
  "pr.changes": { icon: GitPullRequest, tone: "info" },
  todo: { icon: ListTodo, tone: "task" },
  "suggestion.event": { icon: Sparkles, tone: "accent" },
  "suggestion.todo": { icon: Sparkles, tone: "accent" },
  "suggestion.assignment": { icon: Sparkles, tone: "accent" },
  "event.decide": { icon: Flag, tone: "event" },
};

const ACTION_ICONS: Record<ActionId, IconType> = {
  reply: Reply,
  open: ArrowUpRight,
  archive: Archive,
  read: MailOpen,
  todo: ListPlus,
  snooze: AlarmClock,
  done: Check,
  submitted: Check,
  reviewed: Check,
  calendar: CalendarPlus,
  going: CalendarPlus,
  dismiss: X,
  schedule: CalendarPlus,
  trash: Trash2,
  unarchive: ArchiveRestore,
  assignment: GraduationCap,
};

/** 開始審查 shows an eye; 開啟 without an external page points inside the app. */
export function actionIcon(item: QueueItem, action: QueueAction): IconType {
  if (action.id === "open" && (item.kind === "review" || item.kind === "pr.changes")) return Eye;
  if (action.id === "open" && (!item.url || isInAppUrl(item.url))) return ArrowRight;
  return ACTION_ICONS[action.id];
}
