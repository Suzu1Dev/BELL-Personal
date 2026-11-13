/**
 * lucide-react icons, always decorative (`aria-hidden`), sized by the global
 * `.ico` / `.ico-sm` / `.ico-xs` classes (base.css). Import glyphs from here
 * or straight from lucide-react; render them through <Icon> so the classes
 * and aria-hidden are never forgotten.
 */
import type { LucideIcon, LucideProps } from "lucide-react";
import { cx } from "../lib/cx";

export type IconType = LucideIcon;

export interface IconProps extends Omit<LucideProps, "ref" | "size"> {
  icon: LucideIcon;
  /** md 16px (default), sm 14px, xs 13px; anything else via className. */
  size?: "md" | "sm" | "xs";
}

export function Icon({ icon: Glyph, size = "md", className, ...rest }: IconProps) {
  return <Glyph className={cx("ico", size === "sm" && "ico-sm", size === "xs" && "ico-xs", className)} aria-hidden="true" focusable="false" {...rest} />;
}

export {
  AlarmClock, Archive, ArchiveRestore, ArrowLeft, ArrowRight, ArrowUpRight, AudioLines, CalendarClock, CalendarDays, CalendarPlus, Check, CheckCheck,
  ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Clipboard, Clock, CloudRain, CloudSun, CodeXml, Compass, Construction, Copy,
  CornerDownLeft, Eye, Flag, Flame, FolderKanban, Github, GitPullRequest, GraduationCap, Inbox, Info, KeyRound, Layers, Lightbulb, ListPlus,
  ListTodo, LoaderCircle, LockKeyhole, Mail, MailOpen, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, Receipt, RefreshCw,
  ExternalLink, Reply, RotateCcw, RotateCw, Search, Settings, Sparkles, Sun, Sunrise, Target, Ticket, Trash2, TriangleAlert, Undo2, Unplug, UserRound, WandSparkles, X,
} from "lucide-react";
