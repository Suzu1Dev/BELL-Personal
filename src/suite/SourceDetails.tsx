/**
 * 來源詳情 (bell-suite SPEC §4.5): what Today reads from each sibling, its
 * state, when it last answered and what is shared. A native modal <dialog>
 * (focus moves in and stays in, Esc closes) shown as a right-hand drawer on
 * desktop and full width at ≤720px; closing gives focus back to the button
 * that opened it.
 */
import { useId } from "react";
import { BookOpen, RefreshCw } from "lucide-react";
import type { SuiteLinks, SuiteSiblingId, SuiteSourceStatus, SuiteSourcesResponse } from "../../shared/suite";
import { Button } from "../components/Button";
import { useNativeDialog } from "../components/Dialog";
import { X } from "../components/Icon";
import { Pill, type PillTone } from "../components/Pill";
import { suiteCopy, type SuiteLocale } from "../copy/suite";
import type { PollState } from "../lib/usePoll";
import { effectiveStatus, findSource, suiteTime } from "./explain-view";
import "./SourceDetails.css";

const TONES: Record<SuiteSourceStatus, PillTone> = {
  ready: "ok",
  stale: "warn",
  unavailable: "danger",
  unconfigured: "neutral",
  unsupported: "neutral",
};

export interface SourceRowView {
  id: SuiteSiblingId;
  name: string;
  status: SuiteSourceStatus | "loading";
  lastSuccess?: string;
  /** What this source shares, or why it shares nothing. */
  note: string;
  /** 開啟 BELL Explain: only when linked. */
  openHref?: string;
  openLabel?: string;
  refreshable: boolean;
}

export interface SourceDetailsInput {
  pollState: PollState;
  data: SuiteSourcesResponse | undefined;
  updatedAt?: number;
  links: SuiteLinks;
  timeZone?: string;
  now?: Date;
  locale?: SuiteLocale;
}

/** One row per sibling, Explain first (pure). */
export function sourceRows({ pollState, data, updatedAt, links, timeZone, now = new Date(), locale }: SourceDetailsInput): SourceRowView[] {
  const copy = suiteCopy(locale);
  const explain = findSource(data, "explain");
  const explainStatus = effectiveStatus(explain, pollState, updatedAt, now);
  const pr = findSource(data, "pr");
  const prStatus = effectiveStatus(pr, pollState, updatedAt, now);
  return [
    {
      id: "explain",
      name: copy.apps.explain.name,
      status: explainStatus,
      lastSuccess: suiteTime(explain?.lastSuccessAt, timeZone, now),
      note: explainStatus === "unconfigured" ? copy.sourceDetails.explainUnconfigured : copy.sourceDetails.explainShared,
      ...(links.explain ? { openHref: `${links.explain}/`, openLabel: copy.sourceDetails.openExplain } : {}),
      refreshable: explainStatus !== "unconfigured" && explainStatus !== "unsupported",
    },
    {
      id: "pr",
      name: copy.apps.pr.name,
      status: prStatus,
      lastSuccess: suiteTime(pr?.lastSuccessAt, timeZone, now),
      note: prStatus === "unconfigured"
        ? copy.sourceDetails.prUnconfigured
        : prStatus === "unsupported"
          ? copy.sourceDetails.prUnsupported
          : copy.sourceDetails.prShared,
      ...(links.pr && prStatus !== "unconfigured" && prStatus !== "unsupported"
        ? { openHref: `${links.pr}/`, openLabel: copy.sourceDetails.openPr }
        : {}),
      refreshable: prStatus !== "unconfigured" && prStatus !== "unsupported",
    },
  ];
}

export interface SourceDetailsBodyProps {
  rows: SourceRowView[];
  onRefresh: () => void;
  refreshing: boolean;
}

/** The dialog's content (pure). */
export function SourceDetailsBody({ rows, onRefresh, refreshing }: SourceDetailsBodyProps) {
  const { sourceDetails: SOURCE_DETAILS, sourceStatus: SOURCE_STATUS } = suiteCopy();
  return (
    <>
      <p className="suite-details-intro kp">{SOURCE_DETAILS.intro}</p>
      <ul className="suite-details-list">
        {rows.map((row) => (
          <li key={row.id} className="suite-details-row">
            <div className="suite-details-head">
              <h3>{row.name}</h3>
              {row.status === "loading"
                ? <Pill>{SOURCE_DETAILS.loading}</Pill>
                : <Pill tone={TONES[row.status]} dot>{SOURCE_STATUS[row.status]}</Pill>}
            </div>
            <dl className="suite-details-facts">
              <div>
                <dt>{SOURCE_DETAILS.status}</dt>
                <dd>{row.status === "loading" ? SOURCE_DETAILS.loading : SOURCE_STATUS[row.status]}</dd>
              </div>
              {row.refreshable || row.lastSuccess ? (
                <div>
                  <dt>{SOURCE_DETAILS.lastSuccess}</dt>
                  <dd className="mono">{row.lastSuccess ?? SOURCE_DETAILS.never}</dd>
                </div>
              ) : null}
              <div>
                <dt>{SOURCE_DETAILS.shared}</dt>
                <dd>{row.note}</dd>
              </div>
            </dl>
            {row.refreshable || row.openHref ? (
              <div className="suite-details-actions">
                {row.refreshable ? (
                  <Button size="sm" icon={RefreshCw} disabled={refreshing} aria-busy={refreshing || undefined} onClick={onRefresh}>
                    {refreshing ? SOURCE_DETAILS.refreshing : SOURCE_DETAILS.refresh}
                  </Button>
                ) : null}
                {row.openHref ? (
                  <Button size="sm" variant="ghost" icon={BookOpen} href={row.openHref}>{row.openLabel}</Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

export interface SourceDetailsProps extends SourceDetailsBodyProps {
  open: boolean;
  onClose: () => void;
}

export function SourceDetails({ open, onClose, rows, onRefresh, refreshing }: SourceDetailsProps) {
  const SOURCE_DETAILS = suiteCopy().sourceDetails;
  const ref = useNativeDialog(open, onClose);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      className="dialog suite-drawer"
      aria-labelledby={titleId}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <h2 id={titleId}>{SOURCE_DETAILS.title}</h2>
          <Button variant="icon" icon={X} aria-label={SOURCE_DETAILS.close} onClick={onClose} />
        </header>
        <div className="dialog-body">
          {open ? <SourceDetailsBody rows={rows} onRefresh={onRefresh} refreshing={refreshing} /> : null}
        </div>
      </div>
    </dialog>
  );
}
