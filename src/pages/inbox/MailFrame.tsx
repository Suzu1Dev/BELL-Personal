/**
 * The mail's own layout (SPEC-mail-html §5): a sandboxed `<iframe srcdoc>`
 * on a white paper card, sized to its content.
 *
 * Sandbox: `allow-same-origin allow-popups allow-popups-to-escape-sandbox`
 * and nothing else — no allow-scripts (nothing in the mail can run: not a
 * script, a handler or a javascript: URL), no allow-forms, no
 * allow-top-navigation. allow-same-origin is safe only because scripts are
 * off; it lets this page measure the document (auto height, zoom-to-fit)
 * and makes the frame's image requests same-origin, so the server's
 * same-site guard keeps refusing everyone else. The document carries its own
 * CSP (default-src 'none'; images same-origin and data: only) and inherits
 * the app's. Links open in a new tab without opener or referrer.
 *
 * Height follows the content, down as well as up (ResizeObserver on the
 * frame's body; the root's box, not its scroll height; a guard freezes it on
 * a loop); a mail wider than the column is zoomed to fit down
 * to half size, then scrolls sideways inside the frame, never the page. Keys
 * pressed inside the frame are handed to the app's shortcuts, so J, K, E or
 * I keep working after a click on the mail (forwardsKey: never Enter on a
 * link, which opens the link).
 */
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";
import { contentHeight, fitZoom, forwardsKey, HeightGuard } from "./mail-frame";

export const FRAME_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

export interface MailFrameProps {
  document: string;
  title: string;
}

export function MailFrame({ document: page, title }: MailFrameProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>();
  const [measuring, setMeasuring] = useState(true);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let cleanup: (() => void) | undefined;
    setMeasuring(true);

    const attach = () => {
      cleanup?.();
      const doc = element.contentDocument;
      const view = element.contentWindow;
      if (!doc?.documentElement || !doc.body || !view) return;
      const root = doc.documentElement;
      const guard = new HeightGuard();
      let frozen = false;
      let pending = 0;

      const fit = () => {
        root.style.zoom = "";
        const zoom = fitZoom(root.scrollWidth, element.clientWidth);
        if (zoom < 1) root.style.zoom = String(zoom);
      };
      const measure = () => {
        pending = 0;
        if (frozen) return;
        // The content's own height (contentHeight: never root.scrollHeight, which cannot drop below the frame's).
        // A horizontal scrollbar takes height inside the frame: added, so nothing is cut.
        const next = guard.next(contentHeight({
          rootHeight: root.getBoundingClientRect().height,
          bodyTop: doc.body.getBoundingClientRect().top,
          bodyScrollHeight: doc.body.scrollHeight,
          zoom: Number(root.style.zoom) || 1,
          scrollbar: root.scrollWidth > root.clientWidth + 1 ? Math.max(0, view.innerHeight - root.clientHeight) : 0,
        }));
        if (next.capped) {
          frozen = true;
          root.style.setProperty("overflow-y", "auto", "important");
        }
        if (next.changed || next.capped) setHeight(next.height);
        setMeasuring(false);
      };
      const schedule = () => { if (!pending) pending = window.requestAnimationFrame(measure); };
      const refit = () => { fit(); schedule(); };

      fit();
      measure();
      const content = new ResizeObserver(schedule);
      content.observe(doc.body);
      const outer = new ResizeObserver(refit);
      outer.observe(element);
      // Late images (the proxy, cid: parts) change the width a table needs: fit again when one arrives.
      const onImage = (event: Event) => { if ((event.target as Element | null)?.tagName === "IMG") refit(); };
      doc.addEventListener("load", onImage, true);
      doc.addEventListener("error", onImage, true);
      const forward = (event: KeyboardEvent) => {
        // Tab moves through the mail's links, Enter opens one; an IME composition keeps every key (the copy could not carry keyCode 229).
        if (!forwardsKey(event)) return;
        const copy = new KeyboardEvent("keydown", {
          key: event.key, code: event.code, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey,
          metaKey: event.metaKey, repeat: event.repeat, isComposing: event.isComposing, bubbles: true, cancelable: true,
        });
        window.dispatchEvent(copy);
        if (copy.defaultPrevented) event.preventDefault();
      };
      doc.addEventListener("keydown", forward);
      cleanup = () => {
        content.disconnect();
        outer.disconnect();
        if (pending) window.cancelAnimationFrame(pending);
        doc.removeEventListener("load", onImage, true);
        doc.removeEventListener("error", onImage, true);
        doc.removeEventListener("keydown", forward);
      };
    };

    element.addEventListener("load", attach);
    // srcdoc may already have loaded before this effect ran.
    if (element.contentDocument?.readyState === "complete" && element.contentDocument.body?.firstChild) attach();
    return () => {
      element.removeEventListener("load", attach);
      cleanup?.();
    };
  }, [page]);

  return (
    <div className={cx("mr-paper", measuring && "is-measuring")}>
      <iframe
        ref={frame}
        className="mr-frame"
        title={title}
        sandbox={FRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={page}
        style={height === undefined ? undefined : { height }}
      />
    </div>
  );
}
