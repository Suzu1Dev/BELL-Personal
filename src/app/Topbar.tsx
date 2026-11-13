/**
 * Topbar (SPEC-ux §3.2, §7, §9): navigation and breadcrumbs on the left;
 * sync chip, theme toggle and avatar on the right. At ≤720 it also holds
 * the product switcher, drawer button, brand tile and search icon.
 */
import { useEffect, type Ref } from "react";
import { commonCopy } from "../copy/common";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { Icon, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, TriangleAlert, Unplug } from "../components/Icon";
import { Spinner } from "../components/Skeleton";
import { useToast } from "../components/toast/ToastProvider";
import { applyTheme, chooseTheme, nextThemeMode, useThemeMode } from "../lib/preferences";
import { navigate } from "../lib/router";
import { useStatus } from "../lib/status";
import { clockTime } from "../lib/today-model";
import { MEDIA, useMediaQuery } from "../lib/useMediaQuery";
import { AppSwitcher } from "../suite/AppSwitcher";
import "./Topbar.css";

export interface TopbarProps {
  page: string;
  rail: boolean;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  onToggleRail: () => void;
  onOpenPalette: () => void;
  menuRef?: Ref<HTMLButtonElement>;
}

function SyncChip() {
  const { SYNC } = commonCopy();
  const status = useStatus();
  const chip = status.chip;
  const timeZone = status.data?.timeZone;
  const open = () => navigate("#/settings/sources");

  switch (chip.kind) {
    case "ok": {
      const time = clockTime(chip.at, timeZone);
      return (
        <button className="sync-chip" type="button" aria-label={SYNC.okAria(time)} onClick={open}>
          <span className="okdot" aria-hidden="true" /><span className="lbl">{SYNC.ok}</span><span className="mono">{time}</span>
        </button>
      );
    }
    case "syncing":
      return (
        <button className="sync-chip" type="button" aria-label={SYNC.syncingAria} onClick={open}>
          <Spinner /><span className="lbl">{SYNC.syncing}</span>
        </button>
      );
    case "warn":
      return (
        <button className="sync-chip is-warn" type="button" aria-label={SYNC.warnAria(chip.count)} onClick={open}>
          <Icon icon={TriangleAlert} size="sm" /><span className="lbl">{SYNC.warn(chip.count)}</span><span className="mono m-only">{chip.count}</span>
        </button>
      );
    case "offline":
      return (
        <button className="sync-chip is-warn" type="button" aria-label={SYNC.offlineAria} onClick={open}>
          <Icon icon={TriangleAlert} size="sm" /><span className="lbl">{SYNC.offline}</span>
        </button>
      );
    default:
      return (
        <button className="sync-chip" type="button" aria-label={SYNC.noneAria} onClick={open}>
          <Icon icon={Unplug} size="sm" /><span className="lbl">{SYNC.none}</span>
        </button>
      );
  }
}

function ThemeToggle() {
  const { THEME, APPEARANCE, ERRORS } = commonCopy();
  const mode = useThemeMode();
  const toast = useToast();
  const prefersDark = useMediaQuery(MEDIA.dark);
  useEffect(() => applyTheme(mode), [mode]);
  const next = nextThemeMode(mode, prefersDark);
  const label = next === "dark" ? THEME.toDark : THEME.toLight;
  return (
    <Button variant="icon" data-theme-toggle aria-label={label} title={THEME.current[mode]} onClick={() => {
      chooseTheme(next).catch((cause: unknown) => toast.error(ERRORS.actionFailed(APPEARANCE.save, cause instanceof Error ? cause.message : ERRORS.offline)));
    }}>
      <Icon icon={Moon} className="tg-moon" />
      <Icon icon={Sun} className="tg-sun" />
    </Button>
  );
}

export function Topbar({ page, rail, drawerOpen, onOpenDrawer, onToggleRail, onOpenPalette, menuRef }: TopbarProps) {
  const { SHELL } = commonCopy();
  const status = useStatus();
  const name = status.data?.github.login || SHELL.profileFallback;
  const mobile = useMediaQuery(MEDIA.mobile);

  return (
    <header className="topbar">
      <Button ref={menuRef} variant="icon" icon={Menu} className="m-only" aria-label={SHELL.drawerOpen} aria-controls="primary-sidebar" aria-expanded={drawerOpen} onClick={onOpenDrawer} />
      {mobile ? <AppSwitcher /> : null}
      <Button variant="icon" icon={rail ? PanelLeftOpen : PanelLeftClose} className="d-only" aria-label={rail ? SHELL.railExpand : SHELL.railCollapse} aria-controls="primary-sidebar" aria-expanded={!rail} onClick={onToggleRail} />
      <nav className="crumbs" aria-label={SHELL.breadcrumbLabel}>
        <b aria-current="page">{page}</b>
      </nav>
      <div className="top-actions">
        <Button variant="icon" icon={Search} className="m-only" aria-label={SHELL.quickGo} onClick={onOpenPalette} />
        <SyncChip />
        <ThemeToggle />
        <span className="d-only top-avatar" title={name}><Avatar name={name} variant="self" /></span>
      </div>
    </header>
  );
}
