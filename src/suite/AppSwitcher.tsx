import { useEffect, useId, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Command } from "cmdk";
import { AudioLines, CalendarRange, Check, ChevronDown, GitPullRequest, Highlighter, RotateCw, Search, Sun, type LucideIcon } from "lucide-react";
import type { SuiteAppId, SuiteLinks } from "../../shared/suite";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/Skeleton";
import { onboardingCopy } from "../copy/onboarding";
import { cx } from "../lib/cx";
import { useSuiteManifest, type ManifestState } from "./useSuite";
import "./AppSwitcher.css";

export interface SwitcherRow {
  id: SuiteAppId;
  name: string;
  summary: string;
  kind: "current" | "linked" | "unlinked";
  href?: string;
}

const ICONS: Record<SuiteAppId, LucideIcon> = { personal: Sun, explain: AudioLines, pr: GitPullRequest, reader: Highlighter, campaign: CalendarRange };
const ORDER: readonly SuiteAppId[] = ["personal", "explain", "pr", "reader", "campaign"];
const SHORTCUTS: Record<SuiteAppId, number> = { personal: 1, explain: 2, pr: 3, reader: 4, campaign: 5 };

export function switcherRows(links: SuiteLinks): SwitcherRow[] {
  const { apps } = onboardingCopy().switcher;
  return ORDER.map((id): SwitcherRow => {
    const { name, summary } = apps[id];
    if (id === "personal") return { id, name, summary, kind: "current" };
    const origin = links[id];
    return origin ? { id, name, summary, kind: "linked", href: `${origin}/` } : { id, name, summary, kind: "unlinked" };
  });
}

function RowBody({ row }: { row: SwitcherRow }) {
  const SWITCHER = onboardingCopy().switcher;
  return (
    <>
      <span className={cx("suite-app-tile", `is-${row.id}`)} aria-hidden="true"><Icon icon={ICONS[row.id]} /></span>
      <span className="suite-app-text">
        <span className="suite-app-name">{row.name}</span>
        <span className="suite-app-summary">{row.summary}</span>
      </span>
      <span className="suite-app-state">
        {row.kind === "current" ? <em>{SWITCHER.current} <Icon icon={Check} size="xs" /></em> : null}
        {row.kind === "unlinked" ? <em>{SWITCHER.unlinked}</em> : null}
        <kbd>⌃{SHORTCUTS[row.id]}</kbd>
      </span>
    </>
  );
}

function Row({ row, onActivate }: { row: SwitcherRow; onActivate: () => void }) {
  return (
    <Command.Item
      asChild
      value={`${row.name} ${row.summary}`}
      disabled={row.kind !== "linked"}
      onSelect={() => {
        if (row.href) window.location.href = row.href;
        onActivate();
      }}
    >
      {row.kind === "linked" && row.href ? (
        <a role="menuitem" tabIndex={-1} className="suite-app-row" href={row.href} onClick={onActivate}><RowBody row={row} /></a>
      ) : (
        <div
          role="menuitem"
          tabIndex={-1}
          aria-disabled="true"
          aria-current={row.kind === "current" ? "true" : undefined}
          className={cx("suite-app-row", row.kind === "current" ? "is-current" : "is-unlinked")}
        >
          <RowBody row={row} />
        </div>
      )}
    </Command.Item>
  );
}

export interface AppSwitcherMenuProps {
  id?: string;
  manifest: ManifestState["status"];
  rows: SwitcherRow[];
  onRetry?: () => void;
  onClose?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  menuRef?: Ref<HTMLDivElement>;
  inputRef?: Ref<HTMLInputElement>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function AppSwitcherMenu({ id, manifest, rows, onRetry, onClose, onKeyDown, menuRef, inputRef, open, onOpenChange }: AppSwitcherMenuProps) {
  const SWITCHER = onboardingCopy().switcher;
  const shown = manifest === "ready" ? rows : rows.filter((row) => row.kind === "current");
  const content = (
    <>
      <div className="suite-switcher-search">
        <Icon icon={Search} size="sm" />
        <Command.Input ref={inputRef} aria-label={SWITCHER.label} placeholder={SWITCHER.searchPlaceholder} autoFocus />
        <kbd>esc</kbd>
      </div>
      <div id={id} role="menu" aria-label={SWITCHER.menuLabel} className="suite-switcher-menu" ref={menuRef}>
        <Command.List aria-label={SWITCHER.menuLabel} className="suite-switcher-options">
          {shown.map((row) => <Row key={row.id} row={row} onActivate={() => onClose?.()} />)}
          {manifest === "loading" ? (
            <Command.Item asChild disabled value={SWITCHER.loading}>
              <div role="menuitem" tabIndex={-1} aria-disabled="true" className="suite-app-row is-status">
                <Spinner /><span className="suite-app-summary">{SWITCHER.loading}</span>
              </div>
            </Command.Item>
          ) : null}
          {manifest === "error" ? (
            <Command.Item asChild value={`${SWITCHER.failed} ${SWITCHER.retry}`} onSelect={onRetry}>
              <button role="menuitem" tabIndex={-1} type="button" className="suite-app-row is-status is-error" onClick={onRetry}>
                <Icon icon={RotateCw} size="sm" /><span className="suite-app-summary">{SWITCHER.failed}</span><span className="suite-app-retry">{SWITCHER.retry}</span>
              </button>
            </Command.Item>
          ) : null}
          <Command.Empty>{SWITCHER.empty}</Command.Empty>
        </Command.List>
      </div>
    </>
  );
  if (open !== undefined) {
    return (
      <Command.Dialog
        open={open}
        onOpenChange={onOpenChange}
        label={SWITCHER.menuLabel}
        className="suite-switcher-command"
        overlayClassName="suite-switcher-overlay"
        contentClassName="suite-switcher-content"
      >
        {content}
      </Command.Dialog>
    );
  }
  return <Command className="suite-switcher-command" label={SWITCHER.menuLabel} onKeyDown={onKeyDown}>{content}</Command>;
}

function SwitcherButton({ open, onToggle, onKeyDown, buttonRef, menuId, brand = false }: {
  open: boolean;
  onToggle?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  menuId?: string;
  brand?: boolean;
}) {
  const SWITCHER = onboardingCopy().switcher;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={brand ? "suite-brand-trigger" : "btn btn-icon suite-switcher-btn"}
      aria-label={SWITCHER.label}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      {brand ? (
        <>
          <span className="brand-tile" aria-hidden="true"><Icon icon={Sun} /></span>
          <span className="wordmark"><b>BELL</b> Personal</span>
          <Icon icon={ChevronDown} size="sm" />
        </>
      ) : (
        <>
          <span className="brand-tile" aria-hidden="true"><Icon icon={Sun} /></span>
          <Icon icon={ChevronDown} size="xs" />
        </>
      )}
    </button>
  );
}

export interface AppSwitcherViewProps {
  open: boolean;
  manifest: ManifestState["status"];
  rows: SwitcherRow[];
  onToggle?: () => void;
  onButtonKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  wrapRef?: Ref<HTMLDivElement>;
  menuId?: string;
  panel?: ReactNode;
}

export function AppSwitcherView({ open, manifest, rows, onToggle, onButtonKeyDown, buttonRef, wrapRef, menuId, panel }: AppSwitcherViewProps) {
  return (
    <div className="suite-switcher" ref={wrapRef}>
      <SwitcherButton open={open} onToggle={onToggle} onKeyDown={onButtonKeyDown} buttonRef={buttonRef} menuId={menuId} />
      {open ? panel ?? <div className="suite-switcher-pop"><AppSwitcherMenu id={menuId} manifest={manifest} rows={rows} /></div> : null}
    </div>
  );
}

export function AppSwitcher({ brand = false }: { brand?: boolean }) {
  const manifest = useSuiteManifest();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const links = manifest.status === "ready" ? manifest.links : undefined;
  const rows = switcherRows(links ?? {});

  useEffect(() => {
    const onGlobalKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key;
      if (!["1", "2", "3", "4", "5"].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (key === "1") { setOpen(true); return; }
      const href = key === "2" ? links?.explain : key === "3" ? links?.pr : key === "4" ? links?.reader : links?.campaign;
      if (href) window.location.href = `${href}/`;
      else setOpen(true);
    };
    window.addEventListener("keydown", onGlobalKey, true);
    return () => window.removeEventListener("keydown", onGlobalKey, true);
  }, [links]);

  return (
    <div className="suite-switcher">
      <SwitcherButton brand={brand} open={open} onToggle={() => setOpen(current => !current)} menuId={menuId} />
      <AppSwitcherMenu id={menuId} manifest={manifest.status} rows={rows} onRetry={manifest.retry} open={open} onOpenChange={setOpen} onClose={() => setOpen(false)} />
    </div>
  );
}
