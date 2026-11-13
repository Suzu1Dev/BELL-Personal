/**
 * Keyboard hints. `<kbd>` styling lives in base.css (11px mono, --ink-2);
 * inside `.btn-primary` it switches to --accent-strong (Button.css).
 */
import type { ReactNode } from "react";
import { displayKeys } from "../lib/shortcuts";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

/** A key sequence: <Keys keys={["G", "T"]} /> or <Keys keys={["Mod", "K"]} /> (⌘ / Ctrl). */
export function Keys({ keys }: { keys: string[] }) {
  return (
    <>
      {displayKeys(keys).map((key, index) => <kbd key={`${key}-${index}`}>{key}</kbd>)}
    </>
  );
}
