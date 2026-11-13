/**
 * The delete choice of a weekly row: 只刪這一次 (one occurrence is skipped) or
 * 刪除整個每週行程 (the whole series goes to the trash). Both are undone from the
 * toast that follows, so this is a menu, not a confirm dialog. Opens under the
 * row's trash button (above it when there is no room), Esc and an outside press
 * close it, arrows move, and keys pressed inside never reach the page shortcuts.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CALENDAR } from "../../copy/calendar";
import { isComposing } from "../../lib/keys";

export type RemoveScope = "occurrence" | "series";

export interface RemoveMenuProps {
  title: string;
  /** The trash button the menu belongs to. */
  anchor: HTMLElement;
  onPick: (scope: RemoveScope) => void;
  onClose: () => void;
}

export function RemoveMenu({ title, anchor, onPick, onClose }: RemoveMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Transparent (not hidden) until placed, so the first option can take focus at once.
  const [position, setPosition] = useState<CSSProperties>({ opacity: 0 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const menu = ref.current;
      if (!menu) return;
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - menu.offsetWidth - 12, rect.right - menu.offsetWidth));
      const below = rect.bottom + 6;
      const top = below + menu.offsetHeight > window.innerHeight - 12 ? Math.max(12, rect.top - menu.offsetHeight - 6) : below;
      setPosition({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onCloseRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      anchor.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Tab") {
      // Arrows and Tab cycle between the two options: focus never wanders off to the end of the page behind the menu.
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  };

  return createPortal(
    <div ref={ref} className="rm-pop" role="menu" aria-label={CALENDAR.removeMenu(title)} style={position} onKeyDown={onKeyDown}>
      <button type="button" role="menuitem" className="rm-opt" onClick={() => onPick("occurrence")}>{CALENDAR.removeOne}</button>
      <button type="button" role="menuitem" className="rm-opt" onClick={() => onPick("series")}>{CALENDAR.removeSeries}</button>
    </div>,
    document.body,
  );
}
