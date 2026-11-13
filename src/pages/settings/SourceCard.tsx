/**
 * SourceCard (SPEC-ux §3.3 帳號與來源, §5 "Source card", §9; states.css
 * `.source-card`): 36px tile, name, one-line purpose, the StatusPill,
 * `帳號 · 上次同步 08:12`, the actions, and an optional body (a connect
 * form, the feed list, a city search).
 */
import type { ReactNode } from "react";
import type { SourceState } from "../../../shared/sources";
import type { IconType } from "../../components/Icon";
import { StatusPill } from "../../components/Pill";
import { Tile, type TileTone } from "../../components/Tile";
import { cx } from "../../lib/cx";
import "./SourceCard.css";

export interface SourceCardProps {
  id: string;
  icon: IconType;
  tone: TileTone;
  name: string;
  purpose: ReactNode;
  /** 「suzu1dev@gmail.com · 上次同步 08:12」 */
  meta?: ReactNode;
  /** The last error, in one zh sentence. */
  error?: string;
  pill?: { state: SourceState; label?: string };
  actions?: ReactNode;
  children?: ReactNode;
  /** Rendered after the card (a confirm dialog), outside its layout. */
  after?: ReactNode;
  className?: string;
}

export function SourceCard({ id, icon, tone, name, purpose, meta, error, pill, actions, children, after, className }: SourceCardProps) {
  const titleId = `source-${id}`;
  return (
    <>
      <section className={cx("card source-card", className)} aria-labelledby={titleId}>
        <Tile icon={icon} tone={tone} />
        <div className="sc-text">
          <h3 id={titleId}>{name}</h3>
          <p className="kp">{purpose}</p>
          {error ? <p className="sc-error kp">{error}</p> : null}
          {meta ? <p className="meta">{meta}</p> : null}
        </div>
        {pill ? <StatusPill state={pill.state} label={pill.label} /> : <span aria-hidden="true" />}
        {actions ? <div className="acts">{actions}</div> : null}
        {children ? <div className="sc-body">{children}</div> : null}
      </section>
      {after}
    </>
  );
}
