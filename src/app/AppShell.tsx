/**
 * AppShell (SPEC-ux §3.2, §7, §9): skip link, `.app-shell` › sidebar +
 * scrim + `.workspace` › topbar + `main#main.page`, the quickbar and the
 * toast host.
 *
 * Sidebar width: the user's choice in `bell-personal.sidebar.collapsed`
 * ("true" rail, "false" full); without one it is a 64px rail at ≤980 and
 * full above. At ≤720 it is a drawer: the rest of the page is inert while
 * it is open, Esc or the scrim closes it, and focus returns to ≡ (to <main>
 * when a link in it changed the page).
 *
 * A new page (pageKey) scrolls to the top and puts focus on <main>; a change
 * inside a page (日/週, a tab, an inbox conversation) leaves scroll and focus
 * to the page, so the control just used keeps focus.
 *
 * BELL Suite: a to-do draft sent from a sibling (`#/tasks?draft=…&from=…`)
 * is taken out of the address on load and on every hashchange — before the
 * router reads the hash — and shown above #/tasks (src/suite/TaskDraftPanel).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { commonCopy } from "../copy/common";
import { ToastHost } from "../components/toast/ToastProvider";
import { cx } from "../lib/cx";
import { pageKey, type Route } from "../lib/router";
import { useShortcuts } from "../lib/shortcuts";
import { useAppSettings } from "../lib/app-settings";
import { STORAGE_KEYS, storedValue, useStoredValue } from "../lib/storage";
import { MEDIA, useMediaQuery } from "../lib/useMediaQuery";
import { TaskDraftPanel } from "../suite/TaskDraftPanel";
import { captureTaskHandoff, leaveTaskRoute } from "../suite/useTaskHandoff";
import { pageLabel } from "./nav";
import { BotFloatingDock } from "./BotFloatingDock";
import { QuickBar } from "./QuickBar";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import "./AppShell.css";

type SidebarPreference = "auto" | "rail" | "full";

export const sidebarStore = storedValue<SidebarPreference>(
  STORAGE_KEYS.sidebarCollapsed,
  (raw) => (raw === "true" ? "rail" : raw === "false" ? "full" : "auto"),
  (value) => (value === "auto" ? null : value === "rail" ? "true" : "false"),
);

export interface AppShellProps {
  route: Route;
  onCapture: () => void;
  onOpenPalette: () => void;
  children: ReactNode;
}

export function AppShell({ route, onCapture, onOpenPalette, children }: AppShellProps) {
  const { SHELL } = commonCopy();
  const mobile = useMediaQuery(MEDIA.mobile);
  const app = useAppSettings();
  const narrow = useMediaQuery(MEDIA.rail);
  const preference = useStoredValue(sidebarStore);
  const rail = !mobile && (preference === "rail" || (preference === "auto" && narrow));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = drawerOpen && mobile;
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  /** Where focus goes once the drawer has closed: ≡, or <main> after a link in it changed the route. */
  const focusAfterClose = useRef<"menu" | "main">("menu");

  const closeDrawer = useCallback(() => {
    focusAfterClose.current = "menu";
    setDrawerOpen(false);
  }, []);

  useShortcuts({ escape: () => closeDrawer() }, drawer);

  // A handoff in the address (`#/tasks?draft=…`) is read and replaced with `#/tasks` at once. This
  // listener is added before the router's (child effects run first), so it also runs first.
  useLayoutEffect(() => {
    captureTaskHandoff();
    window.addEventListener("hashchange", captureTaskHandoff);
    return () => window.removeEventListener("hashchange", captureTaskHandoff);
  }, []);
  const onTasks = route.name === "tasks";
  useEffect(() => {
    if (!onTasks) leaveTaskRoute();
  }, [onTasks]);

  // Opening the drawer moves focus into it; closing it gives focus back after the render that
  // lifts `inert` from the workspace (focus() on an inert element does nothing, so it fell to <body>).
  const wasDrawer = useRef(false);
  useEffect(() => {
    if (drawer) closeRef.current?.focus();
    else if (wasDrawer.current) {
      const active = document.activeElement;
      const lost = !active || active === document.body || !!active.closest("#primary-sidebar");
      if (lost) {
        if (focusAfterClose.current === "main") mainRef.current?.focus({ preventScroll: true });
        else menuRef.current?.focus();
      }
    }
    focusAfterClose.current = "menu";
    wasDrawer.current = drawer;
  }, [drawer]);

  // A route change closes the drawer. A new page also scrolls to the top and puts focus on <main> (not
  // on first load, so the skip link stays the first Tab stop); a change inside the page leaves both alone.
  const routeKey = JSON.stringify(route);
  const page = pageKey(route);
  const shown = useRef({ routeKey, page });
  useEffect(() => {
    const previous = shown.current;
    if (previous.routeKey === routeKey) return;
    shown.current = { routeKey, page };
    const newPage = previous.page !== page;
    if (newPage) window.scrollTo(0, 0);
    if (drawerRef.current) {
      focusAfterClose.current = "main";
      setDrawerOpen(false);
      return;
    }
    setDrawerOpen(false);
    if (newPage) mainRef.current?.focus({ preventScroll: true });
  }, [routeKey, page]);

  const toggleRail = () => sidebarStore.set(rail ? "full" : "rail");
  const capture = () => {
    setDrawerOpen(false);
    onCapture();
  };

  return (
    <>
      <a
        className="skip"
        href="#main"
        inert={drawer}
        onClick={(event) => {
          // A plain #main would change the hash route.
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        {SHELL.skip}
      </a>
      <div className={cx("app-shell", drawer && "is-drawer-open")} data-sidebar={rail ? "rail" : "full"}>
        <Sidebar
          route={route}
          inert={mobile && !drawer}
          drawerOpen={drawer}
          onCapture={capture}
          onOpenPalette={onOpenPalette}
          onCloseDrawer={closeDrawer}
          closeRef={closeRef}
        />
        {drawer ? <div className="scrim" aria-hidden="true" onClick={closeDrawer} /> : null}
        <div className="workspace" inert={drawer}>
          <Topbar
            page={pageLabel(route, app.settings?.["profile.roles"] ?? null, app.overrides)}
            rail={rail}
            drawerOpen={drawer}
            onOpenDrawer={() => setDrawerOpen(true)}
            onToggleRail={toggleRail}
            onOpenPalette={onOpenPalette}
            menuRef={menuRef}
          />
          <main id="main" className="page" ref={mainRef} tabIndex={-1}>
            {onTasks ? <TaskDraftPanel /> : null}
            {children}
          </main>
        </div>
        <QuickBar route={route} inert={drawer} onCapture={onCapture} />
        {route.name !== "bot" ? <BotFloatingDock inert={drawer} /> : null}
        <ToastHost />
      </div>
    </>
  );
}
