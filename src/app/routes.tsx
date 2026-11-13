/**
 * Route → page. Page files live at src/pages/<dir>/<Name>Page.tsx with a
 * default export taking `{ route }`; feature teams replace those files and
 * never need to edit this one.
 *
 * Code splitting: Today (the landing page) and the 404 stay in the main
 * bundle; every other page is its own chunk, loaded on first visit and
 * fetched in the background once the browser is idle, so moving between
 * pages normally never waits. While a chunk loads, <main> shows the page's
 * head and the same row skeletons the pages use (rows only after a short
 * delay, so a fast load never flashes). A chunk that fails to load (offline,
 * or a new build replaced the old file) shows 「無法載入這個頁面」 with
 * 重新載入 inside <main>; the sidebar, top bar and the other pages keep working.
 */
import { Component, Suspense, lazy, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { RefreshCw } from "../components/Icon";
import { Notice } from "../components/Notice";
import { PageHead } from "../components/PageHead";
import { SkeletonRow } from "../components/Skeleton";
import { ROUTE_LOAD, commonCopy } from "../copy/common";
import { PROJECTS } from "../copy/work";
import { pageKey, type Route } from "../lib/router";
import { isFeatureVisible, isSectionVisible, type FeatureId } from "../../shared/profile";
import { useAppSettings } from "../lib/app-settings";
import { HiddenFeature } from "../components/HiddenFeature";
import NotFoundPage from "../pages/not-found/NotFoundPage";
import TodayPage from "../pages/today/TodayPage";

type PageModule = { default: ComponentType<{ route: never }> };

/** One loader per lazy page; `preloadPages` calls them all once the browser is idle. */
export const PAGE_LOADERS = {
  bot: () => import("../pages/bot/BotPage"),
  inbox: () => import("../pages/inbox/InboxPage"),
  calendar: () => import("../pages/calendar/CalendarPage"),
  tasks: () => import("../pages/tasks/TasksPage"),
  work: () => import("../pages/work/WorkPage"),
  events: () => import("../pages/events/EventsPage"),
  ideas: () => import("../pages/ideas/IdeasPage"),
  habits: () => import("../pages/habits/HabitsPage"),
  settings: () => import("../pages/settings/SettingsPage"),
  setup: () => import("../pages/setup/SetupPage"),
  guide: () => import("../pages/guide/GuidePage"),
} satisfies Record<string, () => Promise<PageModule>>;

export type LazyPage = keyof typeof PAGE_LOADERS;

const BotPage = lazy(PAGE_LOADERS.bot);
const InboxPage = lazy(PAGE_LOADERS.inbox);
const CalendarPage = lazy(PAGE_LOADERS.calendar);
const TasksPage = lazy(PAGE_LOADERS.tasks);
const WorkPage = lazy(PAGE_LOADERS.work);
const EventsPage = lazy(PAGE_LOADERS.events);
const IdeasPage = lazy(PAGE_LOADERS.ideas);
const HabitsPage = lazy(PAGE_LOADERS.habits);
const SettingsPage = lazy(PAGE_LOADERS.settings);
const SetupPage = lazy(PAGE_LOADERS.setup);
const GuidePage = lazy(PAGE_LOADERS.guide);

/** The chunk a route needs, or undefined for the pages in the main bundle (Today, 404). */
export function lazyPageOf(route: Route): LazyPage | undefined {
  switch (route.name) {
    case "today":
    case "not-found":
      return undefined;
    case "project":
      return "work";
    case "google-guide":
      return "settings";
    default:
      return route.name;
  }
}

let preloaded = false;
/** Fetches every page chunk (once); failures are ignored here and surface on the visit instead. */
export function preloadPages(): void {
  if (preloaded) return;
  preloaded = true;
  for (const load of Object.values(PAGE_LOADERS)) void load().catch(() => {});
}

/** Rows appear only when the chunk takes longer than this, so a fast load shows no skeleton at all. */
export const FALLBACK_ROWS_DELAY_MS = 180;
const PRELOAD_AFTER_MS = 1500;

/** The page head a route's own page renders first, so the fallback and the page line up. */
export function fallbackHead(route: Route): { eyebrow: string; title: ReactNode; sub?: string } | undefined {
  const { PAGE_HEADS } = commonCopy();
  switch (route.name) {
    case "bot":
      return PAGE_HEADS.bot;
    case "inbox":
      return PAGE_HEADS.inbox;
    case "calendar":
      return PAGE_HEADS.calendar;
    case "tasks":
      return PAGE_HEADS.tasks;
    case "work":
      return PAGE_HEADS.work;
    case "project":
      // ProjectDetail's own loading head: the eyebrow, and the title for screen readers only.
      return { eyebrow: PAGE_HEADS.work.eyebrow, title: <span className="sr-only">{PROJECTS.title}</span> };
    case "events":
      return PAGE_HEADS.events;
    case "ideas":
      return PAGE_HEADS.ideas;
    case "habits":
      return PAGE_HEADS.habits;
    case "settings":
      return PAGE_HEADS.settings;
    case "google-guide":
      return PAGE_HEADS.googleGuide;
    case "setup":
      return PAGE_HEADS.setup;
    case "guide":
      return PAGE_HEADS.guide;
    default:
      return undefined;
  }
}

/** Shown in <main> while a page's chunk loads. `rowsShown` is for tests (no timers under renderToStaticMarkup). */
export function RouteFallback({ route, rowsShown = false }: { route: Route; rowsShown?: boolean }) {
  const head = fallbackHead(route);
  const [rows, setRows] = useState(rowsShown);
  useEffect(() => {
    if (rows) return;
    const timer = window.setTimeout(() => setRows(true), FALLBACK_ROWS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [rows]);
  return (
    <div className="route-fallback" aria-busy="true">
      {head ? <PageHead eyebrow={head.eyebrow} title={head.title} sub={head.sub} /> : null}
      <Card className="route-fallback-rows" aria-hidden="true" style={rows ? undefined : { visibility: "hidden" }}>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </Card>
      <span className="sr-only" role="status">{rows ? ROUTE_LOAD.loading : ""}</span>
    </div>
  );
}

/** 「無法載入這個頁面」 with 重新載入 (a full reload fetches the current build). */
export function RouteLoadFailed({ onReload = () => window.location.reload() }: { onReload?: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Focus stays where it is (normally <main>); only focus that fell to <body> with the failed page moves here.
    const active = document.activeElement;
    if (!active || active === document.body) button.current?.focus({ preventScroll: true });
  }, []);
  return (
    <Notice
      tone="error"
      role="alert"
      className="route-failed"
      title={ROUTE_LOAD.failedTitle}
      actions={<Button ref={button} size="sm" icon={RefreshCw} onClick={onReload}>{ROUTE_LOAD.reload}</Button>}
    >
      {ROUTE_LOAD.failedHint}
    </Notice>
  );
}

interface BoundaryProps {
  /** pageKey(route): opening another page clears the failure without remounting a page that works. */
  resetKey: string;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  resetKey: string;
}

/** Keeps a failed chunk (or a page that throws while rendering) inside <main>; the shell stays usable. */
export class RouteErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render() {
    return this.state.failed ? <RouteLoadFailed /> : this.props.children;
  }
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "today":
      return <TodayPage route={route} />;
    case "bot":
      return <BotPage route={route} />;
    case "inbox":
      return <InboxPage route={route} />;
    case "calendar":
      return <CalendarPage route={route} />;
    case "tasks":
      return <TasksPage route={route} />;
    case "work":
    case "project":
      return <SectionGate section="work" fallback="projects"><WorkPage route={route} /></SectionGate>;
    case "events":
      return <SectionGate section="events" fallback="events"><EventsPage route={route} /></SectionGate>;
    case "ideas":
      return <IdeasPage route={route} />;
    case "habits":
      return <HabitsPage route={route} />;
    case "settings":
    case "google-guide":
      return <SettingsPage route={route} />;
    case "setup":
      return <SetupPage route={route} />;
    case "guide":
      return <GuidePage route={route} />;
    case "not-found":
      return <NotFoundPage route={route} />;
  }
}

function SectionGate({ section, fallback, children }: { section: "work" | "events"; fallback: FeatureId; children: ReactNode }) {
  const app = useAppSettings();
  const roles = app.settings?.["profile.roles"] ?? null;
  return isSectionVisible(section, roles, app.overrides) ? children : <HiddenFeature feature={fallback} />;
}

export function RoutePage({ route }: { route: Route }) {
  useEffect(() => {
    const idle = window.requestIdleCallback as ((run: () => void, options?: { timeout: number }) => number) | undefined;
    if (idle) {
      const handle = idle(preloadPages, { timeout: PRELOAD_AFTER_MS * 2 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(preloadPages, PRELOAD_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  // Both live inside <main>, which the shell focuses on a page change, so a fallback or a failure never drops
  // focus; the page's own effects (deep-link landing, editors) run once its chunk has arrived and it mounts.
  return (
    <RouteErrorBoundary resetKey={pageKey(route)}>
      <Suspense fallback={<RouteFallback route={route} />}>
        <Page route={route} />
      </Suspense>
    </RouteErrorBoundary>
  );
}
