/**
 * Touch swipes on queue and inbox rows (SPEC-ux §7, SPEC-mail-assignments
 * §2.4). Every swipeable row: a right swipe past 35 % of the row (or a
 * flick) runs its E action. Other rows: a left swipe opens the snooze sheet.
 * Mail rows: a left swipe reveals the tray (封存 or 移回 · 刪除, 144 px),
 * snapping open past 56 px or on a flick, with 0.3× resistance beyond the
 * tray. The pure rules are exported for tests; the hook wires pointer
 * events (touch only; the mouse and pen never swipe).
 */
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";

export const SWIPE = {
  /** A horizontal drag starts after this many pixels, when it is more horizontal than vertical. */
  start: 12,
  /** Right swipe (and the other rows' left swipe): this share of the row width. */
  ratio: 0.35,
  /** A flick: at least this fast (px/ms). */
  flick: 0.6,
  /** The tray: two 72 px buttons. */
  tray: 144,
  /** The tray snaps open once dragged this far. */
  open: 56,
  /** Drag beyond the tray moves at this fraction. */
  resistance: 0.3,
  /** An open tray closes when dragged back right this far. */
  close: 24,
} as const;

export interface SwipeOptions {
  /** The row has a tray (mail rows): left reveals it instead of running the S action. */
  tray: boolean;
  /** The tray is open on this row. */
  open: boolean;
  /** The row has an E action (right swipe). */
  canDone: boolean;
  /** Left does something: the tray, or an S action. */
  canLeft: boolean;
}

export type SwipeDecision = "done" | "snooze" | "tray-open" | "tray-close" | "none";

/** Where the row's content sits while the finger is `dx` px from where it went down. */
export function swipeOffset(dx: number, options: SwipeOptions): number {
  const raw = (options.open ? -SWIPE.tray : 0) + dx;
  if (raw > 0) return options.canDone && !options.open ? raw : 0;
  if (raw < 0 && !options.canLeft) return 0;
  if (options.tray && raw < -SWIPE.tray) return -SWIPE.tray + (raw + SWIPE.tray) * SWIPE.resistance;
  return raw;
}

/** What a released swipe does: run E, open the snooze sheet, open or close the tray, or nothing (spring back). */
export function swipeDecision(dx: number, speed: number, width: number, options: SwipeOptions): SwipeDecision {
  const flick = speed >= SWIPE.flick;
  if (options.tray && options.open) return dx >= SWIPE.close || (flick && dx > 0) ? "tray-close" : "tray-open";
  if (dx > 0) return options.canDone && (dx >= width * SWIPE.ratio || flick) ? "done" : "none";
  if (dx < 0 && options.canLeft) {
    if (options.tray) return -dx >= SWIPE.open || flick ? "tray-open" : "none";
    return -dx >= width * SWIPE.ratio || flick ? "snooze" : "none";
  }
  return "none";
}

interface Drag {
  x: number;
  y: number;
  at: number;
  active: boolean;
  open: boolean;
}

export interface RowSwipeInput extends Omit<SwipeOptions, "open"> {
  enabled: boolean;
  open: boolean;
  /** A swipe was released past its threshold. */
  onDecision: (decision: Exclude<SwipeDecision, "none">) => void;
}

/** Scrolling closes an open tray once the page moved this far (a settling momentum scroll does not). */
const TRAY_SCROLL_CLOSE_PX = 8;

/**
 * Closes the open tray (SPEC-mail-assignments §2.4): when the page scrolls,
 * when Esc is pressed, or when a touch lands anywhere but on that row (its
 * `data-row-id`). One list owns one tray at a time.
 */
export function useTrayDismiss(openRow: string | undefined, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!openRow) return;
    const startY = window.scrollY;
    const shut = () => latest.current();
    const scroll = () => { if (Math.abs(window.scrollY - startY) > TRAY_SCROLL_CLOSE_PX) shut(); };
    const outside = (event: Event) => {
      const row = (event.target as Element | null)?.closest?.("[data-row-id]");
      if (row?.getAttribute("data-row-id") !== openRow) shut();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") shut(); };
    window.addEventListener("scroll", scroll, { passive: true });
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("scroll", scroll);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [openRow]);
}

const reducedMotion = () => {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

/**
 * Pointer handlers, the row's class names and its `--dx` / `--reveal` style.
 * A click that ends a drag, or the tap that closes an open tray, never
 * reaches the row (it would open the conversation).
 */
export function useRowSwipe(input: RowSwipeInput) {
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(input);
  latest.current = input;

  // A tray that closes from outside (another row, a scroll, Esc) leaves no drag behind.
  useEffect(() => {
    if (!input.open) setDx(0);
  }, [input.open]);

  const options = (open: boolean): SwipeOptions => ({ tray: latest.current.tray, open, canDone: latest.current.canDone, canLeft: latest.current.canLeft });

  const end = () => {
    drag.current = null;
    setDragging(false);
    setDx(0);
  };

  const handlers = input.enabled ? {
    onPointerDown: (event: PointerEvent<HTMLLIElement>) => {
      if (event.pointerType !== "touch") return;
      swallowClick.current = false;
      drag.current = { x: event.clientX, y: event.clientY, at: event.timeStamp, active: false, open: latest.current.open };
    },
    onPointerMove: (event: PointerEvent<HTMLLIElement>) => {
      const state = drag.current;
      if (!state) return;
      const moveX = event.clientX - state.x;
      const moveY = event.clientY - state.y;
      if (!state.active) {
        if (Math.abs(moveY) > 10 && Math.abs(moveY) > Math.abs(moveX)) {
          drag.current = null;
          return;
        }
        if (Math.abs(moveX) < SWIPE.start) return;
        state.active = true;
        swallowClick.current = true;
        setDragging(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
      }
      // Reduced motion: nothing slides; the tray appears at the threshold instead.
      if (reducedMotion() && latest.current.tray && !state.open && moveX <= -SWIPE.open && latest.current.canLeft) {
        state.open = true;
        drag.current = null;
        setDragging(false);
        setDx(0);
        latest.current.onDecision("tray-open");
        return;
      }
      setDx(reducedMotion() ? 0 : moveX);
    },
    onPointerUp: (event: PointerEvent<HTMLLIElement>) => {
      const state = drag.current;
      if (!state?.active) {
        // A tap on an open row's content closes the tray (its buttons handle their own taps).
        if (state?.open && !(event.target as HTMLElement).closest(".q-tray")) {
          swallowClick.current = true;
          latest.current.onDecision("tray-close");
        }
        drag.current = null;
        return;
      }
      const moveX = event.clientX - state.x;
      const speed = Math.abs(moveX) / Math.max(1, event.timeStamp - state.at);
      const width = event.currentTarget.offsetWidth || 1;
      const decision = swipeDecision(moveX, speed, width, options(state.open));
      end();
      if (decision === "none") return;
      if (decision === "tray-open" && state.open) return;
      if (decision !== "tray-close") {
        try { navigator.vibrate?.(8); } catch { /* vibration is a nicety */ }
      }
      latest.current.onDecision(decision);
    },
    onPointerCancel: end,
    onClickCapture: (event: MouseEvent<HTMLLIElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  } : {};

  const offset = dragging ? swipeOffset(dx, options(drag.current?.open ?? input.open)) : input.open ? -SWIPE.tray : 0;
  const traying = input.tray && offset < 0;
  const style = offset ? ({ "--dx": `${offset}px`, ...(traying ? { "--reveal": `${-offset}px` } : {}) } as CSSProperties) : undefined;
  const direction: "done" | "snooze" | undefined = offset > 0 ? "done" : offset < 0 && !input.tray ? "snooze" : undefined;
  return { handlers, style, direction, traying, dragging };
}
