/**
 * The module list shared by the sidebar, the quickbar, the breadcrumb and
 * the palette's 前往 section (SPEC-ux §3.1 order and icons).
 */
import { NAV, commonCopy } from "../copy/common";
import {
  CalendarDays, CircleHelp, Flame, FolderKanban, Inbox, Lightbulb, ListTodo, Settings, Sparkles, Sun, Ticket, type IconType,
} from "../components/Icon";
import { navSection, type NavSection, type Route } from "../lib/router";
import type { NavCounts } from "../lib/today-model";
import { isFeatureVisible, isSectionVisible, type FeatureOverrides, type ProfileRole } from "../../shared/profile";

export interface NavItem {
  section: NavSection;
  href: string;
  label: string;
  icon: IconType;
  /** Which nav count shows next to it. */
  count?: keyof NavCounts;
  /** The `G` chord key (display). */
  chord?: string;
  /** Extra palette search words (zh and en). */
  keywords: string[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { section: "today", href: "#/today", label: NAV.today, icon: Sun, count: "today", chord: "T", keywords: ["today", "首頁", "佇列", "queue"] },
  { section: "bot", href: "#/bot", label: NAV.bot, icon: Sparkles, chord: "B", keywords: ["bot", "ai", "assistant", "助理", "對話", "紀錄", "bellbot", "chat"] },
  { section: "inbox", href: "#/inbox", label: NAV.inbox, icon: Inbox, count: "inbox", chord: "I", keywords: ["inbox", "mail", "gmail", "信", "郵件", "email"] },
  { section: "calendar", href: "#/calendar", label: NAV.calendar, icon: CalendarDays, chord: "C", keywords: ["calendar", "schedule", "行程", "日曆", "agenda"] },
  { section: "tasks", href: "#/tasks", label: NAV.tasks, icon: ListTodo, count: "tasks", chord: "D", keywords: ["tasks", "todo", "待辦事項", "to-do"] },
  { section: "work", href: "#/work", label: NAV.work, icon: FolderKanban, count: "work", chord: "W", keywords: ["work", "作業", "專案", "github", "pr", "assignments", "projects", "e3", "moodle", "canvas"] },
  { section: "events", href: "#/events", label: NAV.events, icon: Ticket, count: "events", chord: "E", keywords: ["events", "ctf", "ctftime", "活動", "kktix", "upcoming"] },
  { section: "ideas", href: "#/ideas", label: NAV.ideas, icon: Lightbulb, chord: "L", keywords: ["ideas", "idea", "點子", "筆記", "notes"] },
  { section: "habits", href: "#/habits", label: NAV.habits, icon: Flame, count: "habits", chord: "H", keywords: ["habits", "habit", "打卡", "streak"] },
];

export const BOTTOM_ITEMS: readonly NavItem[] = [
  { section: "settings", href: "#/settings/sources", label: NAV.settings, icon: Settings, keywords: ["settings", "設定", "連線", "google", "sources", "來源", "外觀", "theme"] },
  { section: "guide", href: "#/guide", label: NAV.guide, icon: CircleHelp, keywords: ["guide", "help", "說明", "快捷鍵", "shortcuts", "?"] },
];

function localizedNavItems(): NavItem[] {
  const { NAV } = commonCopy();
  return NAV_ITEMS.map((item) => ({ ...item, label: item.section in NAV ? NAV[item.section as keyof typeof NAV] : item.label }));
}

export function bottomNavItems(): NavItem[] {
  const { NAV } = commonCopy();
  return BOTTOM_ITEMS.map((item) => ({ ...item, label: NAV[item.section as "settings" | "guide"] }));
}

export function workNavLabel(roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): string {
  const { NAV } = commonCopy();
  return isFeatureVisible("assignments", roles, overrides) ? NAV.work : NAV.workDev;
}

export function visibleNavItems(roles: readonly ProfileRole[] | null, overrides: FeatureOverrides = {}): NavItem[] {
  return localizedNavItems().filter((item) => isSectionVisible(item.section, roles, overrides))
    .map((item) => item.section === "work" ? { ...item, label: workNavLabel(roles, overrides) } : item);
}

/** 「8 件待處理」-style unit text for a nav count. */
export function navCountLabel(key: keyof NavCounts, value: number): string {
  return commonCopy().NAV_COUNT_LABELS[key](value);
}

/** The breadcrumb / document title name of a route. */
export function pageLabel(route: Route, roles: readonly ProfileRole[] | null = null, overrides: FeatureOverrides = {}): string {
  const { NAV, PAGE_HEADS } = commonCopy();
  const section = navSection(route);
  switch (section) {
    case "setup":
      return NAV.setup;
    case "not-found":
      return NAV.notFound;
    case "settings":
      return route.name === "google-guide" ? PAGE_HEADS.googleGuide.title : NAV.settings;
    case "work":
      return workNavLabel(roles, overrides);
    default:
      return [...localizedNavItems(), ...bottomNavItems()].find((item) => item.section === section)?.label ?? NAV.today;
  }
}
