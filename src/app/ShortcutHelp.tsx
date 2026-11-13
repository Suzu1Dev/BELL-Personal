/** The `?` dialog: the #/guide keyboard section in a native <dialog> (SPEC-ux §6.2). */
import { HELP } from "../copy/common";
import { Dialog } from "../components/Dialog";
import { ShortcutList } from "../components/ShortcutList";
import "./ShortcutHelp.css";

export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={HELP.title} className="help-dialog">
      <p className="kp help-intro">{HELP.intro}</p>
      <ShortcutList />
    </Dialog>
  );
}
