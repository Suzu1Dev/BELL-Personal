/**
 * Hash router (bell-cves pattern, no dependency) for every route in
 * SPEC-ux §3.1. `parseHash` is pure; `useRoute` also rewrites legacy or
 * shorthand hashes (`#/`, `#/projects/:id`) to their canonical form with
 * history.replaceState, so the back button never bounces.
 */
import { useEffect, useState } from "react";
import { MAIL_SEARCH_LIMITS, MAIL_VIEWS, type MailView } from "../../shared/mail";

export const SETTINGS_TABS = ["sources", "roles", "ai", "brief", "appearance", "privacy"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const WORK_TABS = ["assignments", "projects", "github"] as const;
export type WorkTab = (typeof WORK_TABS)[number];

export const CALENDAR_VIEWS = ["day", "week", "month"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export type Route =
  | { name: "today" }
  | { name: "bot" }
  /** `view` (default 收件匣) and `q` (a mail search) are SPEC-mail-assignments §1.1; both survive opening a conversation. */
  | { name: "inbox"; threadId?: string; view?: MailView; q?: string }
  | { name: "calendar"; view: CalendarView }
  /** `id` deep-links one object (`#/tasks/<id>`); the page keeps its key, so opening one never resets scroll or focus. */
  | { name: "tasks"; id?: string }
  | { name: "work"; tab: WorkTab }
  | { name: "project"; id: string }
  | { name: "events"; id?: string }
  | { name: "ideas"; id?: string }
  | { name: "habits" }
  | { name: "settings"; tab: SettingsTab }
  | { name: "google-guide" }
  | { name: "setup" }
  | { name: "guide" }
  | { name: "not-found"; path: string };

export type RouteName = Route["name"];
/** The narrowed route a page receives: `RouteOf<"inbox">` → `{ name: "inbox"; threadId?: string }`. */
export type RouteOf<N extends RouteName> = Extract<Route, { name: N }>;

/** The sidebar section a route belongs to (drives aria-current and the breadcrumb). */
export type NavSection = "today" | "bot" | "inbox" | "calendar" | "tasks" | "work" | "events" | "ideas" | "habits" | "settings" | "guide" | "setup" | "not-found";

const SIMPLE = new Set(["today", "bot", "tasks", "events", "ideas", "habits", "setup", "guide"]);
/** Pages that also open one object by id: `#/tasks/<id>`, `#/events/<id>`, `#/ideas/<id>`. */
const OBJECT_PAGES = new Set(["tasks", "events", "ideas"]);

function decode(segment: string): string | undefined {
  try {
    const value = decodeURIComponent(segment);
    return value ? value : undefined;
  } catch {
    return undefined; // malformed escape
  }
}

function oneOf<T extends string>(list: readonly T[], value: string | null | undefined, fallback: T): T {
  return value && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Splits `#/calendar/?view=week#keys` into path segments and query (an inner `#anchor` is ignored). */
function split(hash: string): { segments: string[]; query: URLSearchParams; path: string } {
  const raw = hash.replace(/^#/, "");
  const withoutAnchor = raw.replace(/#.*$/, "");
  const [pathPart = "", queryPart = ""] = withoutAnchor.split("?", 2);
  const path = pathPart.replace(/^\/+/, "").replace(/\/+$/, "");
  return { segments: path ? path.split("/") : [], query: new URLSearchParams(queryPart), path: pathPart || "/" };
}

export function parseHash(hash: string): Route {
  const { segments, query, path } = split(hash);
  const [head = "", ...rest] = segments;
  if (!head) return { name: "today" };
  if (SIMPLE.has(head) && !rest.length) return { name: head } as Route;
  if (OBJECT_PAGES.has(head)) {
    // Exactly one URI-decoded segment; `#/tasks/a/b`, a malformed escape or a dot segment is a 404.
    // `.` and `..` survive encodeURIComponent, so `/api/ideas/..` would reach `/api/` once fetch normalises it.
    const id = rest.length === 1 ? decode(rest[0]) : undefined;
    return id && id !== "." && id !== ".." ? ({ name: head, id } as Route) : { name: "not-found", path };
  }

  switch (head) {
    case "inbox": {
      const view = oneOf(MAIL_VIEWS, query.get("view"), "inbox");
      const q = (query.get("q") ?? "").trim().slice(0, MAIL_SEARCH_LIMITS.query);
      const extra = { ...(view !== "inbox" ? { view } : {}), ...(q ? { q } : {}) };
      if (!rest.length) return { name: "inbox", ...extra };
      const threadId = rest.length === 1 ? decode(rest[0]) : undefined;
      return threadId ? { name: "inbox", threadId, ...extra } : { name: "not-found", path };
    }
    case "calendar":
      if (rest.length) break;
      return { name: "calendar", view: oneOf(CALENDAR_VIEWS, query.get("view"), "day") };
    case "work": {
      if (!rest.length) return { name: "work", tab: oneOf(WORK_TABS, query.get("tab"), "assignments") };
      if (rest[0] === "projects") {
        if (rest.length === 1) return { name: "work", tab: "projects" };
        const id = rest.length === 2 ? decode(rest[1]) : undefined;
        if (id) return { name: "project", id };
      }
      break;
    }
    case "projects": {
      // Legacy brief route: #/projects/:id → #/work/projects/:id (canonicalHash rewrites it).
      if (!rest.length) return { name: "work", tab: "projects" };
      const id = rest.length === 1 ? decode(rest[0]) : undefined;
      if (id) return { name: "project", id };
      break;
    }
    case "settings": {
      if (!rest.length) return { name: "settings", tab: "sources" };
      if (rest.length === 2 && rest[0] === "sources" && rest[1] === "google") return { name: "google-guide" };
      if (rest.length === 1 && (SETTINGS_TABS as readonly string[]).includes(rest[0])) return { name: "settings", tab: rest[0] as SettingsTab };
      break;
    }
  }
  return { name: "not-found", path };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case "inbox": {
      const query = new URLSearchParams();
      if (route.view && route.view !== "inbox") query.set("view", route.view);
      if (route.q) query.set("q", route.q);
      const search = query.size ? `?${query.toString()}` : "";
      return `${route.threadId ? `#/inbox/${encodeURIComponent(route.threadId)}` : "#/inbox"}${search}`;
    }
    case "calendar":
      return route.view === "day" ? "#/calendar" : `#/calendar?view=${route.view}`;
    case "work":
      return route.tab === "assignments" ? "#/work" : `#/work?tab=${route.tab}`;
    case "project":
      return `#/work/projects/${encodeURIComponent(route.id)}`;
    case "settings":
      return `#/settings/${route.tab}`;
    case "google-guide":
      return "#/settings/sources/google";
    case "not-found":
      return `#${route.path.startsWith("/") ? route.path : `/${route.path}`}`;
    case "tasks":
    case "events":
    case "ideas":
      return route.id ? `#/${route.name}/${encodeURIComponent(route.id)}` : `#/${route.name}`;
    default:
      return `#/${route.name}`;
  }
}

/**
 * The canonical hash for a shorthand or legacy hash, or undefined when the
 * hash needs no rewrite (a 404 keeps its URL so the user can see the typo).
 * `""`, `#`, `#/` → `#/today`; `#/projects[/:id]` → `#/work…`; `#/work/projects` → `#/work?tab=projects`.
 */
export function canonicalHash(hash: string): string | undefined {
  const { segments } = split(hash);
  const [head, second] = segments;
  if (!head) return "#/today";
  const legacy = head === "projects" || (head === "work" && second === "projects" && segments.length === 2);
  if (!legacy) return undefined;
  const route = parseHash(hash);
  return route.name === "not-found" ? undefined : routeHref(route);
}

/** Which sidebar item is current for a route. */
export function navSection(route: Route): NavSection {
  switch (route.name) {
    case "project":
      return "work";
    case "google-guide":
      return "settings";
    default:
      return route.name;
  }
}

/**
 * The page a route shows. Changes inside a page (日/週, a settings or work
 * tab, an inbox conversation, a deep-linked task, event or idea) keep it: the shell moves scroll and focus only
 * when this changes, so the control the user just used keeps focus.
 */
export function pageKey(route: Route): string {
  switch (route.name) {
    case "project":
      return `project:${route.id}`;
    case "not-found":
      return `not-found:${route.path}`;
    default:
      return route.name;
  }
}

function currentRoute(): Route {
  const canonical = canonicalHash(window.location.hash);
  if (canonical) window.history.replaceState(window.history.state, "", canonical);
  return parseHash(window.location.hash);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Go to a hash (`navigate("#/inbox")` or `navigate(routeHref(route))`); the same hash scrolls to the top. */
export function navigate(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
  else window.scrollTo({ top: 0, behavior: "smooth" });
}
