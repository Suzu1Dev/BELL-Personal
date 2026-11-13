/**
 * One list row in the queue grammar (SPEC-ux §9 FocusQueue parts): tile,
 * `.q-title` + `.q-meta`, and `.q-end` with the hover actions (`.q-acts`,
 * desktop), the status pill, `.when` and the touch primary (`.q-primary`).
 */
import { Fragment, type ReactNode } from "react";
import type { QueueItem } from "../../../shared/today";
import { Pill, type PillTone } from "../../components/Pill";
import { Tile, type TileTone } from "../../components/Tile";
import type { IconType } from "../../components/Icon";
import { cx } from "../../lib/cx";

export interface WorkRowProps {
  icon: IconType;
  tone: TileTone;
  title: string;
  /** External page the title opens (new tab). */
  href?: string;
  /** The title is a button instead (a native assignment opens 編輯); `titleLabel` is its accessible name. */
  onTitle?: () => void;
  titleLabel?: string;
  meta: ReactNode[];
  pill?: { label: string; tone: PillTone; quietOnPhone?: boolean };
  when?: QueueItem["when"];
  /** Desktop hover / focus actions (ghost buttons). */
  actions?: ReactNode;
  /** Touch: the one visible primary action. */
  primary?: ReactNode;
  done?: boolean;
  /** The row's id (`data-row-id`), so focus can move to its neighbour when it is deleted. */
  rowId?: string;
}

export function WorkRow({ icon, tone, title, href, onTitle, titleLabel, meta, pill, when, actions, primary, done, rowId }: WorkRowProps) {
  return (
    <li className={cx("q-row", done && "is-done", actions ? "has-acts" : undefined)} data-row-id={rowId}>
      <Tile icon={icon} tone={tone} />
      <div className="q-main">
        {onTitle
          ? <button type="button" className="q-title" onClick={onTitle} aria-label={titleLabel}>{title}</button>
          : href
            ? <a className="q-title" href={href} target="_blank" rel="noopener noreferrer">{title}</a>
            : <span className="q-title">{title}</span>}
        <p className="q-meta">
          {meta.filter((part) => part !== undefined && part !== null && part !== "").map((part, index) => (
            <Fragment key={index}>{index ? " · " : ""}{part}</Fragment>
          ))}
        </p>
      </div>
      <div className="q-end">
        {actions ? <div className="q-acts">{actions}</div> : null}
        {pill ? <Pill tone={pill.tone} className={pill.quietOnPhone ? "m-quiet" : undefined}>{pill.label}</Pill> : null}
        {when ? <span className={cx("when", !when.mono && "zh", when.tone)}>{when.label}</span> : null}
        {primary}
      </div>
    </li>
  );
}

/** `+142 −38` for a diff, coloured like the mockup's `.add` / `.del`. */
export function Diff({ add, del }: { add?: number; del?: number }) {
  if (add === undefined || del === undefined) return null;
  return (
    <>
      <span className="add mono">+{add}</span> <span className="del mono">−{del}</span>
    </>
  );
}
