import { GitPullRequest } from "lucide-react";
import { Button } from "../components/Button";
import { suiteCopy } from "../copy/suite";
import { cx } from "../lib/cx";
import { prDraftUrl } from "./handoff";
import { useSuiteLinks } from "./useSuite";
import "./ExplainThis.css";

export interface SendToPrProps {
  text: string;
  title?: string;
  back: string;
  compact?: boolean;
  className?: string;
}

export function sendToPrHref(origin: string | undefined, { text, title, back }: Pick<SendToPrProps, "text" | "title" | "back">): string | undefined {
  if (!origin || !text.trim()) return undefined;
  const heading = title?.trim();
  return prDraftUrl({ origin, draft: text, ...(heading ? { title: heading } : {}), back });
}

export function SendToPrView({ href, compact, className }: Pick<SendToPrProps, "compact" | "className"> & { href?: string }) {
  const SEND_TO_PR = suiteCopy().sendToPr;
  if (!href) return null;
  return (
    <Button
      href={href}
      variant={compact ? "ghost" : "secondary"}
      size="sm"
      icon={GitPullRequest}
      className={cx("explain-this", compact && "is-compact", className)}
      title={SEND_TO_PR.description}
      aria-description={SEND_TO_PR.description}
    >
      {SEND_TO_PR.label}
    </Button>
  );
}

export function SendToPr({ text, title, back, compact, className }: SendToPrProps) {
  const links = useSuiteLinks();
  const href = sendToPrHref(links.pr, { text, title, back });
  return <SendToPrView href={href} compact={compact} className={className} />;
}
