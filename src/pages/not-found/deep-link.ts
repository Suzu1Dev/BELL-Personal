/**
 * Deep links to one object (`#/tasks/<id>`, `#/events/<id>`, `#/ideas/<id>`):
 * the page keeps its key (router.ts pageKey), so the shell leaves scroll and
 * focus alone and the page itself lands on the object once its data is in —
 * scroll it into view, flash it and move focus to it — or shows
 * <MissingObject> when it is not there.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api";

/** How long a landed row keeps its highlight (matches the `*-flash` keyframes). */
export const FLASH_MS = 1600;

/** A GET for one object that failed because it is not there (deleted, or an id the server rejects). */
export function isMissing(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 400);
}

/** The text 解釋這個 sends for an object: its title, a blank line and the body, without empty parts. */
export function explainText(title: string, ...body: Array<string | undefined | null>): string {
  const head = title.trim();
  const rest = body.map((part) => part?.trim()).filter(Boolean).join("\n");
  return [head, rest].filter(Boolean).join("\n\n");
}

/**
 * Calls `land(id)` once per deep-linked id, as soon as `ready` (the object is
 * rendered). Clearing the id (back to the list) re-arms it, so opening the
 * same link again lands again.
 */
export function useLandOnce(id: string | undefined, ready: boolean, land: (id: string) => void): void {
  const landed = useRef<string | undefined>(undefined);
  const latest = useRef(land);
  latest.current = land;
  useEffect(() => {
    if (!id) { landed.current = undefined; return; }
    if (!ready || landed.current === id) return;
    landed.current = id;
    latest.current(id);
  }, [id, ready]);
}

/** The id that is flashing, and a setter that clears it after FLASH_MS. */
export function useFlash(): [string | undefined, (id: string) => void] {
  const [flash, setFlash] = useState<string | undefined>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useCallback((id: string) => {
    clearTimeout(timer.current);
    setFlash(id);
    timer.current = setTimeout(() => setFlash(undefined), FLASH_MS);
  }, []);
  return [flash, start];
}

/** After the next paint: scroll `[data-<attr>="<id>"]` under `root` to the middle and focus `focus` inside it (or the row). */
export function landOn(root: ParentNode | null | undefined, attr: string, id: string, focus?: string): void {
  requestAnimationFrame(() => {
    const row = root?.querySelector<HTMLElement>(`[data-${attr}="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    const target = focus ? row.querySelector<HTMLElement>(focus) : row;
    target?.focus({ preventScroll: true });
  });
}
