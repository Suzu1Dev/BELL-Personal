/**
 * The body of a page that is not built yet: the route's `.page-head` and a
 * dashed 「建置中」 empty state. Feature teams replace their page file and
 * stop importing this.
 */
import type { ReactNode } from "react";
import { BUILDING, BUTTONS } from "../copy/common";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { Construction } from "../components/Icon";
import { PageHead } from "../components/PageHead";

export interface PageHeadCopy {
  eyebrow: string;
  title: string;
  sub?: string;
}

export function PagePlaceholder({ head, actions, children }: { head: PageHeadCopy; actions?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <PageHead eyebrow={head.eyebrow} title={head.title} sub={head.sub} actions={actions} />
      {children}
      <EmptyState
        icon={Construction}
        title={BUILDING.title}
        hint={BUILDING.hint}
        action={<Button variant="secondary" href="#/today">{BUTTONS.backToToday}</Button>}
      />
    </>
  );
}
