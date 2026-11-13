/**
 * Sidebar (SPEC-ux §3.2, §9): product switcher, search, ＋ 快速記下 N,
 * Chinese navigation groups, and at the bottom 連線與設定, 使用指南 ? and
 * the profile row. Counts, projects and the streak come from TodayProvider;
 * nothing here computes them.
 */
import type { CSSProperties, Ref } from "react";
import { commonCopy } from "../copy/common";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Flame, Icon, Plus, Search, Sun, X } from "../components/Icon";
import { modKeyLabel } from "../lib/keys";
import { useSingleKeyShortcuts } from "../lib/preferences";
import { navSection, type Route } from "../lib/router";
import { useStatus } from "../lib/status";
import { useAppSettings } from "../lib/app-settings";
import { isFeatureVisible } from "../../shared/profile";
import { useToday } from "../lib/today";
import { MEDIA, useMediaQuery } from "../lib/useMediaQuery";
import { AppSwitcher } from "../suite/AppSwitcher";
import { bottomNavItems, navCountLabel, visibleNavItems, type NavItem } from "./nav";
import "./Sidebar.css";

export interface SidebarProps {
  route: Route;
  /** Hidden off-screen (closed drawer): keep it out of the Tab order. */
  inert: boolean;
  drawerOpen: boolean;
  onCapture: () => void;
  onOpenPalette: () => void;
  onCloseDrawer: () => void;
  closeRef?: Ref<HTMLButtonElement>;
}

function NavLink({ item, current, count, onNavigate }: { item: NavItem; current: boolean; count?: number; onNavigate: () => void }) {
  const { SHELL } = commonCopy();
  return (
    <a href={item.href} title={item.label} aria-current={current ? "page" : undefined} onClick={() => { if (current) onNavigate(); }}>
      <Icon icon={item.icon} />
      <span>{item.label}</span>
      {count ? (
        <>
          <span className="n" aria-hidden="true">{count}</span>
          {item.count ? <span className="sr-only">{SHELL.srParens(navCountLabel(item.count, count))}</span> : null}
        </>
      ) : null}
    </a>
  );
}

export function Sidebar({ route, inert, drawerOpen, onCapture, onOpenPalette, onCloseDrawer, closeRef }: SidebarProps) {
  const { SHELL, META } = commonCopy();
  const today = useToday();
  const status = useStatus();
  const app = useAppSettings();
  const section = navSection(route);
  const login = status.data?.github.login;
  const name = login || SHELL.profileFallback;
  const online = status.chip.kind !== "offline";
  const mobile = useMediaQuery(MEDIA.mobile);
  // N and ? are single keys: no hint when 單鍵快捷鍵 is off.
  const singleKeys = useSingleKeyShortcuts();

  return (
    <aside className="sidebar" id="primary-sidebar" aria-label={SHELL.sidebarLabel} inert={inert}>
      <div className="side-inner">
        {mobile ? (
          <a className="brand" href="#/today" aria-label={META.brandLabel}>
            <span className="brand-tile"><Icon icon={Sun} /></span>
            <span className="wordmark"><b>BELL</b> Personal</span>
          </a>
        ) : <AppSwitcher brand />}
        {drawerOpen ? (
          <Button ref={closeRef} variant="icon" icon={X} className="side-close" aria-label={SHELL.drawerClose} onClick={onCloseDrawer} />
        ) : null}

        <button className="sidebar-search" type="button" onClick={onOpenPalette}>
          <Icon icon={Search} size="sm" />
          <span>{SHELL.quickGo}</span>
          <kbd>{modKeyLabel()} K</kbd>
        </button>

        <button className="cta" type="button" title={SHELL.captureTitle} onClick={onCapture}>
          <Icon icon={Plus} />
          <span>{SHELL.capture}</span>
          {singleKeys ? <kbd>N</kbd> : null}
        </button>

        <div className="side-label">{SHELL.todayLabel}</div>
        <nav className="nav" aria-label={SHELL.navLabel}>
          {visibleNavItems(app.settings?.["profile.roles"] ?? null, app.overrides).map((item) => (
            <NavLink key={item.section} item={item} current={item.section === section} count={item.count ? today.nav[item.count] : undefined} onNavigate={onCloseDrawer} />
          ))}
        </nav>

        {today.projects.length && isFeatureVisible("projects", app.settings?.["profile.roles"] ?? null, app.overrides) ? (
          <div className="side-proj">
            <div className="side-label">{SHELL.projectsLabel}</div>
            <ul className="proj">
              {today.projects.map((project) => (
                <li key={project.name}>
                  <a href={project.href} title={project.name}>
                    <span className="dot" style={{ "--c": project.colorVar } as CSSProperties} aria-hidden="true" />
                    <span className="proj-name">{project.name}</span>
                    {project.pct !== undefined ? <span className="pct">{project.pct}%</span> : null}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="side-bottom">
          {today.streak !== undefined ? (
            <div className="streak-card">
              <b>
                <Icon icon={Flame} size="sm" />
                {today.streak > 0 ? SHELL.streakTitle(today.streak) : SHELL.streakZero}
              </b>
              {today.streak > 0 ? <p className="kp">{SHELL.streakBody}</p> : null}
              <a href="#/habits">{SHELL.streakLink}</a>
            </div>
          ) : null}
          {bottomNavItems().map((item) => (
            <a key={item.section} href={item.href} title={item.label} aria-current={item.section === section ? "page" : undefined}>
              <Icon icon={item.icon} />
              <span>{item.label}</span>
              {item.section === "guide" && singleKeys ? <kbd>?</kbd> : null}
            </a>
          ))}
          <div className="profile" title={name}>
            <Avatar name={name} variant="self" />
            <div>
              <b>{name}</b>
              <small><span className={online ? "okdot" : "warndot"} aria-hidden="true" />{SHELL.localWorkspace}</small>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
