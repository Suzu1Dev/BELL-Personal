/**
 * DigestStrip (SPEC-ux §4.4, §9): mail that needs no action, never in the
 * queue. One tap 全部標為已讀 (deferred, undoable), or 逐類看 with one
 * contextual action per category. Hidden until loaded, when empty, and
 * when Gmail is broken (the queue's notice covers it).
 */
import { useState } from "react";
import type { ActionId, TodayPayload } from "../../../shared/today";
import { DIGEST } from "../../copy/today";
import { Button } from "../../components/Button";
import { Archive, ArrowUpRight, CheckCheck, ChevronDown, Inbox, MailOpen, type IconType } from "../../components/Icon";
import { Tile } from "../../components/Tile";
import { cx } from "../../lib/cx";
import { isBroken, sincePhrase } from "./today-view";
import "./DigestStrip.css";

export interface DigestStripProps {
  payload: TodayPayload | undefined;
  /** itemId is `gmail:digest` (every category) or `gmail:digest:<key>`. */
  onAct: (itemId: string, action: ActionId, message?: string) => void;
}

const CATEGORY_ICONS: Partial<Record<ActionId, IconType>> = { read: MailOpen, open: ArrowUpRight, archive: Archive };

export function DigestStrip({ payload, onAct }: DigestStripProps) {
  const [expanded, setExpanded] = useState(false);
  const digest = payload?.digest;
  const gmail = payload?.sources.find((source) => source.id === "gmail");
  if (!payload || !digest || digest.total <= 0 || (gmail && isBroken(gmail))) return null;
  const stale = gmail?.state === "stale" && gmail.lastSyncedAt ? DIGEST.staleSuffix(sincePhrase(gmail.lastSyncedAt, payload.now)) : undefined;

  const runCategory = (key: string, label: string, count: number, action: ActionId, url?: string) => {
    if (action === "open") {
      window.open(url ?? DIGEST.gmailInbox, "_blank", "noopener,noreferrer");
      onAct(`gmail:digest:${key}`, "open");
      return;
    }
    onAct(`gmail:digest:${key}`, action, action === "archive" ? DIGEST.categoryArchive(label, count) : DIGEST.categoryRead(label, count));
  };

  return (
    <section className={cx("card digest", expanded && "is-open")} aria-labelledby="dg-title">
      <Tile icon={Inbox} tone="mail" />
      <div className="txt">
        <b id="dg-title">{DIGEST.title(digest.total)}</b>
        <span>
          {digest.categories.map((category, index) => (
            <span key={category.key} className="cat">
              {index > 0 ? " · " : null}
              {category.label} <span className="mono">{category.count}</span>
            </span>
          ))}
          {` · ${DIGEST.stillInGmail}`}
          {stale ? ` · ${stale}` : null}
        </span>
      </div>
      <div className="acts">
        <Button variant="secondary" size="sm" icon={CheckCheck} onClick={() => onAct("gmail:digest", "read", DIGEST.readAllToast(digest.total))}>
          {DIGEST.readAll}
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls="digest-cats" onClick={() => setExpanded((open) => !open)}>
          {DIGEST.byCategory}
          <ChevronDown className={cx("ico ico-xs", expanded && "is-open")} aria-hidden="true" />
        </Button>
      </div>
      {expanded ? (
        <ul className="digest-cats" id="digest-cats" aria-label={DIGEST.categoriesLabel}>
          {digest.categories.map((category) => (
            <li key={category.key}>
              <span className="t">{category.label}</span>
              <span className="mono">{category.count}</span>
              <Button
                variant="ghost"
                size="sm"
                icon={CATEGORY_ICONS[category.action]}
                onClick={() => runCategory(category.key, category.label, category.count, category.action, category.url)}
              >
                {DIGEST.actions[category.action] ?? DIGEST.actions.open}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
