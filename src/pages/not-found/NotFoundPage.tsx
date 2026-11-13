/** #/<anything unknown> (SPEC-ux §3.1): 「找不到這一頁。」 with one CTA, 回到今天. Complete. */
import { BUTTONS, PAGE_HEADS } from "../../copy/common";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { Compass, Sun } from "../../components/Icon";
import { PageHead } from "../../components/PageHead";
import type { RouteOf } from "../../lib/router";
import "./NotFoundPage.css";

export default function NotFoundPage({ route }: { route: RouteOf<"not-found"> }) {
  return (
    <>
      <PageHead eyebrow={PAGE_HEADS.notFound.eyebrow} title={PAGE_HEADS.notFound.title} />
      <EmptyState
        icon={Compass}
        title={PAGE_HEADS.notFound.sub}
        hint={<span className="not-found-path mono">#{route.path}</span>}
        action={<Button variant="primary" icon={Sun} href="#/today">{BUTTONS.backToToday}</Button>}
      />
    </>
  );
}
