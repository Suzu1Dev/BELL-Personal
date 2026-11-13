/**
 * Tracking pixels (SPEC-mail-html D13). The main defence is that remote
 * images are never loaded until the owner asks, and then only through the
 * proxy (the sender sees the server's request, not the owner's device or
 * browser); these rules keep the known open-tracking out even then:
 *
 *  - an image whose attributes or style make it invisible (at most 1×1, a
 *    zero dimension, display:none, visibility:hidden, opacity 0) is removed
 *    by the sanitizer and never fetched;
 *  - an image on a known open-tracking host or endpoint is removed and never
 *    fetched (a short, best-effort list of the common mail services), and
 *    the proxy does not follow a redirect into one;
 *  - an image the proxy fetched that decodes to at most 1×1 pixels is
 *    replaced with a transparent pixel of our own (images.ts isPixel): its
 *    bytes never reach the browser, but its request did reach the sender.
 *
 * Removed pixels are counted for the reader's 「已擋下 N 個追蹤像素」.
 */

/** Hosts (and their subdomains) that only serve open-tracking pixels in mail. */
export const TRACKER_HOSTS = [
  "list-manage.com", // Mailchimp opens (…/track/open.php)
  "mandrillapp.com", // Mandrill opens
  "ct.sendgrid.net", // SendGrid opens and clicks (…/wf/open)
  "mailtrack.io",
  "mltrk.io",
  "bananatag.com",
  "t.yesware.com",
  "getnotify.com",
  "mailfoogae.appspot.com", // Streak
  "r.superhuman.com",
  "exct.net", // Salesforce Marketing Cloud opens (…/open.aspx)
  "t.eloqua.com",
  "google-analytics.com",
  "doubleclick.net",
  "bat.bing.com",
  "pixel.wp.com",
  "stats.wp.com",
] as const;

/** Open-tracking endpoints that mail services also serve from the sender's own domain. */
const TRACKER_PATHS = /\/(?:wf\/open|track\/open(?:\.php)?|open\.aspx|e\/FooterImages\/FooterImage)(?:[/?]|$)/i;

export function isTrackerHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return TRACKER_HOSTS.some((tracker) => host === tracker || host.endsWith(`.${tracker}`));
}

export function isTrackerUrl(url: URL): boolean {
  return isTrackerHost(url.hostname) || TRACKER_PATHS.test(url.pathname);
}

/** A width or height attribute as pixels, when it is a plain number (「1」, 「1px」, 「0」). Trimmed first: one anchored, linear match. */
export function attributePixels(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(?:\s*px)?$/i.exec((value ?? "").trim());
  return match ? Number(match[1]) : undefined;
}

/** Both dimensions at most one pixel, or either one zero: nothing a reader could see. */
export function invisibleSize(width: number | undefined, height: number | undefined): boolean {
  if (width === 0 || height === 0) return true;
  return width !== undefined && height !== undefined && width <= 1 && height <= 1;
}
