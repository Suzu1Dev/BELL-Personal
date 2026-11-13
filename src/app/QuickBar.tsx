/**
 * QuickBar (SPEC-ux §3.2, §7): fixed at the bottom at ≤720 (any pointer),
 * with safe-area padding: 今天 · 收件匣 (badge = unread) · 待辦 · ＋捕捉.
 */
import { commonCopy } from "../copy/common";
import { Icon, Inbox, ListTodo, Plus, Sun } from "../components/Icon";
import { navSection, type Route } from "../lib/router";
import { useToday } from "../lib/today";
import "./QuickBar.css";

export function QuickBar({ route, inert, onCapture }: { route: Route; inert: boolean; onCapture: () => void }) {
  const { NAV, NAV_COUNT_LABELS, SHELL } = commonCopy();
  const { nav } = useToday();
  const section = navSection(route);
  const current = (name: string) => (section === name ? "page" : undefined);
  return (
    <nav className="quickbar" aria-label={SHELL.quickbarLabel} inert={inert}>
      <a href="#/today" aria-current={current("today")}><Icon icon={Sun} />{NAV.today}</a>
      <a href="#/inbox" aria-current={current("inbox")}>
        <Icon icon={Inbox} />{NAV.inbox}
        {nav.inbox ? (
          <>
            <span className="badge" aria-hidden="true">{nav.inbox}</span>
            <span className="sr-only">{SHELL.srParens(NAV_COUNT_LABELS.inbox(nav.inbox))}</span>
          </>
        ) : null}
      </a>
      <a href="#/tasks" aria-current={current("tasks")}><Icon icon={ListTodo} />{NAV.tasks}</a>
      <button type="button" className="cap" onClick={onCapture}>
        <span className="plus"><Icon icon={Plus} /></span>{SHELL.quickbarCapture}
      </button>
    </nav>
  );
}
