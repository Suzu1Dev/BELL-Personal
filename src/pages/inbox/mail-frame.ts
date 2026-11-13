/**
 * Pure rules of the reader's mail frame (SPEC-mail-html §5): how much a
 * fixed-width mail is zoomed to fit the reader column, how the frame's height
 * follows its content without a feedback loop, and small labels.
 */
import type { MailAddress } from "../../../shared/mail";

/** Never smaller than this: a wider mail scrolls sideways inside its frame (never the page). */
export const MIN_ZOOM = 0.5;
/** The frame never grows past this; beyond it the mail scrolls inside the frame. */
export const MAX_FRAME_HEIGHT = 30_000;
/** A mail whose height keeps changing this often is treated as a loop and frozen. */
export const MAX_RESIZES = 200;

/** The zoom that fits `contentWidth` CSS pixels into `frameWidth` (1 when it fits). */
export function fitZoom(contentWidth: number, frameWidth: number): number {
  if (!(frameWidth > 0) || !(contentWidth > 0) || contentWidth <= frameWidth + 1) return 1;
  return Math.max(MIN_ZOOM, Math.floor((frameWidth / contentWidth) * 1000) / 1000);
}

/** What the frame reads from its document to size itself (CSS pixels; rects are already zoomed, scroll sizes are not). */
export interface FrameMetrics {
  /** documentElement.getBoundingClientRect().height: the content's own box (html is height:auto). */
  rootHeight: number;
  /** body.getBoundingClientRect().top and body.scrollHeight: what sticks out below the body (a relatively positioned block). */
  bodyTop: number;
  bodyScrollHeight: number;
  zoom: number;
  /** The horizontal scrollbar's height when the mail scrolls sideways, else 0. */
  scrollbar: number;
}

/**
 * The height the frame needs: the content's, never documentElement.scrollHeight,
 * which is at least the frame's current height, so the frame could grow but
 * never shrink (a one-line reply kept a 160 px card, a widened window left
 * blank space under the mail).
 */
export function contentHeight(metrics: FrameMetrics): number {
  return Math.max(metrics.rootHeight, metrics.bodyTop + metrics.bodyScrollHeight * metrics.zoom) + metrics.scrollbar;
}

export interface FrameHeight {
  height: number;
  /** Worth a re-render (it moved by 2 px or more). */
  changed: boolean;
  /** Frozen: too tall or changing without end; the mail scrolls inside the frame from now on. */
  capped: boolean;
}

/**
 * The frame's height from its content's. The sanitizer removes what makes a
 * page depend on its frame's height (viewport units, 100% html/body), and
 * this guard stops whatever is left: past MAX_FRAME_HEIGHT or MAX_RESIZES
 * the height freezes and the mail scrolls inside.
 */
export class HeightGuard {
  private resizes = 0;
  private last: number | undefined;
  private frozen = false;

  next(measured: number): FrameHeight {
    if (this.frozen && this.last !== undefined) return { height: this.last, changed: false, capped: true };
    const height = Math.min(Math.max(Math.ceil(measured), 1), MAX_FRAME_HEIGHT);
    if (this.last !== undefined && Math.abs(height - this.last) < 2) return { height: this.last, changed: false, capped: false };
    this.resizes++;
    if (measured > MAX_FRAME_HEIGHT || this.resizes > MAX_RESIZES) this.frozen = true;
    this.last = height;
    return { height, changed: true, capped: this.frozen };
  }
}

/**
 * Whether a key pressed inside the mail's frame goes to the app's shortcuts
 * (J, K, E, I… keep working after a click on the mail). Not Tab (it moves
 * through the mail's links), not during an IME composition, and not Enter or
 * Space on a link: those open the link, never the conversation's 封存.
 */
export function forwardsKey(event: Pick<KeyboardEvent, "key" | "isComposing" | "keyCode" | "target">): boolean {
  if (event.key === "Tab" || event.isComposing || event.keyCode === 229) return false;
  if (event.key === "Enter" || event.key === " ") {
    // The frame's elements belong to another window: no instanceof, only closest().
    const target = event.target as { closest?: (selector: string) => unknown } | null;
    if (target?.closest?.("a[href]")) return false;
  }
  return true;
}

/** 「iThome 電子報」, or the address; long names are cut with 「…」. */
export function senderLabel(sender: MailAddress, max = 24): string {
  const name = (sender.name ?? sender.email).trim() || sender.email;
  return [...name].length > max ? `${[...name].slice(0, max - 1).join("")}…` : name;
}

/** 「12 KB」 · 「1.4 MB」 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
