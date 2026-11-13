/**
 * The not-found state for a deep link to one object that is not there
 * (「找不到這個待辦」 · 「可能已刪除。」 · 回到全部待辦). It takes focus when it
 * appears, so a keyboard or screen-reader user hears why the page is empty.
 */
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../../components/Button";
import { EmptyState, type EmptyStateProps } from "../../components/EmptyState";
import "./NotFoundPage.css";

export interface MissingObjectProps {
  icon: EmptyStateProps["icon"];
  tone?: EmptyStateProps["tone"];
  title: string;
  hint: string;
  /** The list the object lived in, e.g. `#/tasks`. */
  backHref: string;
  backLabel: string;
}

export function MissingObject({ icon, tone, title, hint, backHref, backLabel }: MissingObjectProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div ref={ref} className="missing-object" tabIndex={-1} role="status" aria-live="polite">
      <EmptyState icon={icon} tone={tone} title={title} hint={hint} action={<Button variant="secondary" icon={ArrowLeft} href={backHref}>{backLabel}</Button>} />
    </div>
  );
}
