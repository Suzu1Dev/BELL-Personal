/**
 * 「解釋這個」: opens the text in BELL Explain (suite-contract v1 handoff,
 * `#/explain?text=&title=&from=personal&back=`), in the same tab. Renders
 * nothing while Explain is not linked, or when there is no text. It only
 * opens a page: Explain shows the text and generates nothing by itself, and
 * nothing here calls a server or an AI.
 */
import { BookOpen } from "lucide-react";
import { Button } from "../components/Button";
import { suiteCopy } from "../copy/suite";
import { cx } from "../lib/cx";
import { explainThisUrl } from "./handoff";
import { useSuiteLinks } from "./useSuite";
import "./ExplainThis.css";

export interface ExplainThisProps {
  /** The context to explain (task title + notes, an idea, an event, a mail excerpt); clipped to 2000 characters. */
  text: string;
  /** Optional heading Explain shows (≤ 120). */
  title?: string;
  /** Where Explain's 回到 BELL Personal returns to: a Personal hash route such as `#/tasks/<id>`. */
  back: string;
  /** Compact icon-and-label button for dense rows. */
  compact?: boolean;
  className?: string;
}

/** The link's address, or undefined when it must not render (pure; tested). */
export function explainThisHref(origin: string | undefined, { text, title, back }: Pick<ExplainThisProps, "text" | "title" | "back">): string | undefined {
  if (!origin || !text.trim()) return undefined;
  const heading = title?.trim();
  return explainThisUrl({ origin, text, ...(heading ? { title: heading } : {}), back });
}

export function ExplainThisView({ href, compact, className }: Pick<ExplainThisProps, "compact" | "className"> & { href?: string }) {
  const EXPLAIN_THIS = suiteCopy().explainThis;
  if (!href) return null;
  return (
    <Button
      href={href}
      variant={compact ? "ghost" : "secondary"}
      size="sm"
      icon={BookOpen}
      className={cx("explain-this", compact && "is-compact", className)}
      title={EXPLAIN_THIS.description}
      aria-description={EXPLAIN_THIS.description}
    >
      {EXPLAIN_THIS.label}
    </Button>
  );
}

export function ExplainThis({ text, title, back, compact, className }: ExplainThisProps) {
  const links = useSuiteLinks();
  const href = explainThisHref(links.explain, { text, title, back });
  return <ExplainThisView href={href} compact={compact} className={className} />;
}
