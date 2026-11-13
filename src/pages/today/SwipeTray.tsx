/**
 * The swipe tray of a mail row (SPEC-mail-assignments §2.4): swiping left
 * reveals two 72 px buttons pinned to the right edge, 封存 (移回 in the 封存
 * view) and 刪除. Native buttons named after the conversation; `inert` and
 * hidden from assistive technology while closed. Shared by Today's mail rows
 * and the inbox list.
 */
import { ROW_ACTIONS } from "../../copy/inbox";
import { Archive, ArchiveRestore, Icon, Trash2 } from "../../components/Icon";
import { cx } from "../../lib/cx";
import "./SwipeTray.css";

export interface SwipeTrayProps {
  open: boolean;
  subject: string;
  /** 移回收件匣 instead of 封存 (archived conversations). */
  restore?: boolean;
  onArchive: () => void;
  onTrash: () => void;
}

export function SwipeTray({ open, subject, restore, onArchive, onTrash }: SwipeTrayProps) {
  return (
    <div className="q-tray" inert={!open} aria-hidden={open ? undefined : true} role="group" aria-label={ROW_ACTIONS.trayLabel(subject)}>
      <button
        type="button"
        className={cx("q-tray-btn", restore ? "is-restore" : "is-archive")}
        aria-label={restore ? ROW_ACTIONS.restore(subject) : ROW_ACTIONS.archive(subject)}
        onClick={onArchive}
      >
        <Icon icon={restore ? ArchiveRestore : Archive} />
        <span>{restore ? ROW_ACTIONS.restoreShort : ROW_ACTIONS.archiveShort}</span>
      </button>
      <button type="button" className="q-tray-btn is-trash" aria-label={ROW_ACTIONS.trash(subject)} onClick={onTrash}>
        <Icon icon={Trash2} />
        <span>{ROW_ACTIONS.trashShort}</span>
      </button>
    </div>
  );
}
