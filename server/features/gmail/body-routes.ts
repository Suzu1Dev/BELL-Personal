import { Router, type Response } from "express";
import { z } from "zod";
import { MAIL_BODY_LIMITS, trustedSender, type MailBodyFallback, type MailBodyResponse, type MailImageAttachment, type MailMessage } from "../../../shared/mail.js";
import { AppError } from "../../errors.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { GMAIL_ERRORS, liveFailure } from "./api.js";
import type { ImageProxy, ImageSigner } from "./image-proxy.js";
import { acceptableRaster, sendImage, sniffImage, TRANSPARENT_GIF } from "./images.js";
import type { LiveMail } from "./live.js";
import { readImagePart, readMailBody, type MailBodyParts, type MailImagePart } from "./mail-body.js";
import { mailDocument, sanitizeMailHtml } from "./sanitize.js";

/**
 * The reader's original layout (SPEC-mail-html), GET only, behind the
 * identity gate and the same-origin guard like every /api route:
 *
 *   GET /api/gmail/messages/:messageId/body[?images=1]          MailBodyResponse
 *   GET /api/gmail/messages/:messageId/inline/:contentId        a cid: part (raster image)
 *   GET /api/gmail/messages/:messageId/attachments/:partId      an image attachment (raster image)
 *   GET /api/mail-images/proxy?m=&u=&s=                         a remote image, signed per message
 *
 * A body built with images shown starts the server's fetch of every remote
 * image in it (ImageProxy.prefetch); the proxy route only answers from that
 * fetch, so what the browser renders never decides what reaches the sender.
 *
 * Nothing here writes to disk or logs a URL, subject, sender or query:
 * the log lines carry counts and outcomes only.
 */

export interface BodyDeps {
  live: LiveMail;
  signer: ImageSigner;
  proxy: ImageProxy;
  /** Gmail is connected with gmail.modify and not waiting for a reconnect. */
  ready: () => Promise<boolean>;
}

const messageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const partIdSchema = z.string().regex(/^[0-9.]{1,40}$/);
const READ_TIMEOUT_MS = 20_000;

const IMAGE_ERRORS = {
  missing: "找不到這張圖片。",
  notImage: "這不是可以顯示的圖片。",
  badLink: "圖片連結無效，請重新打開這封信。",
  rateLimited: "這封信的圖片載入太多次了，請稍後再試。",
  blocked: "這張圖片的位址不允許載入。",
  tooLarge: "圖片太大，沒有載入。",
  timeout: "圖片載入逾時。",
  failed: "無法載入這張圖片。",
} as const;

function emptyImages(trusted: boolean): MailBodyResponse["images"] {
  return { remote: 0, shown: false, trusted, trackers: 0 };
}

function attachmentsOf(parts: MailBodyParts, shownInline: ReadonlySet<string>): MailImageAttachment[] {
  return parts.images
    .filter((image) => !(image.contentId && shownInline.has(image.contentId)))
    .slice(0, MAIL_BODY_LIMITS.attachments)
    .map((image) => ({
      partId: image.partId,
      filename: image.filename || `image-${image.partId}`,
      size: image.size,
      url: `/api/gmail/messages/${encodeURIComponent(parts.messageId)}/attachments/${encodeURIComponent(image.partId)}`,
    }));
}

/** Gmail's read failed: the same zh-TW sentences as the live reader (429 stays 429). */
function readFailure(error: unknown): AppError {
  if (error instanceof AppError && error.status === 404) return error;
  return new AppError(error instanceof AppError && error.status === 429 ? 429 : 502, liveFailure(error));
}

export function addBodyRoutes(router: Router, ctx: ModuleContext, deps: BodyDeps): void {
  const { live } = deps;

  const partsOf = async (messageId: string): Promise<MailBodyParts> => {
    if (!(await deps.ready())) {
      live.clear();
      throw new AppError(503, GMAIL_ERRORS.notConnected);
    }
    const parts = await readMailBody(ctx, live, messageId, AbortSignal.timeout(READ_TIMEOUT_MS)).catch((error: unknown) => { throw readFailure(error); });
    if (!parts) throw new AppError(404, GMAIL_ERRORS.gone);
    return parts;
  };

  router.get("/messages/:messageId/body", async (req, res) => {
    const started = Date.now();
    const parsed = messageIdSchema.safeParse(req.params.messageId);
    if (!parsed.success) throw new AppError(404, GMAIL_ERRORS.gone);
    const messageId = parsed.data;
    const asked = req.query.images === "1";
    const text = (reason: MailBodyFallback, extra: Partial<MailBodyResponse> & Pick<MailBodyResponse, "sender">): MailBodyResponse => {
      logEvent("gmail.body", { outcome: "text", reason, ms: Date.now() - started });
      return { messageId, kind: "text", reason, images: emptyImages(false), attachments: [], ...extra };
    };

    if (!(await deps.ready())) {
      live.clear();
      // The cached plain text still shows; the reader says why the layout does not.
      const cached = ctx.sourceItems.get<MailMessage>("gmail", messageId)?.value;
      res.json(text("not-connected", { sender: cached?.from ?? { email: "" } }));
      return;
    }
    const parts = await readMailBody(ctx, live, messageId, AbortSignal.timeout(READ_TIMEOUT_MS)).catch((error: unknown) => { throw readFailure(error); });
    if (!parts) throw new AppError(404, GMAIL_ERRORS.gone);
    const trusted = trustedSender(ctx.settings.value("mail.trustedImageSenders"), parts.from.email);
    if (parts.htmlTooLarge) {
      res.json(text("too-large", { sender: parts.from, attachments: attachmentsOf(parts, new Set()) }));
      return;
    }
    if (parts.html === undefined) {
      res.json(text("no-html", { sender: parts.from, attachments: attachmentsOf(parts, new Set()) }));
      return;
    }
    const show = asked || trusted;
    const inline = new Set(parts.images.flatMap((image) => (image.contentId ? [image.contentId] : [])));
    const sanitized = sanitizeMailHtml(parts.html, {
      messageId, remote: show ? "proxy" : "block", proxy: (url) => deps.signer.path(messageId, url), inline,
    });
    if (sanitized.slow) {
      // Past the sanitizer's time budget: too much markup to show safely in time.
      logEvent("gmail.body_slow", { chars: parts.html.length, ms: Date.now() - started });
      res.json(text("too-large", { sender: parts.from, attachments: attachmentsOf(parts, new Set()) }));
      return;
    }
    if (!sanitized.stable) {
      // The two sanitizer passes disagreed: something in this HTML parses two ways. Never shown.
      logEvent("gmail.body_unstable", { chars: parts.html.length });
      res.json(text("unsafe", { sender: parts.from, attachments: attachmentsOf(parts, new Set()) }));
      return;
    }
    const body: MailBodyResponse = {
      messageId,
      kind: "html",
      document: mailDocument(sanitized),
      images: { remote: sanitized.remote, shown: show, trusted, trackers: sanitized.trackers },
      sender: parts.from,
      attachments: attachmentsOf(parts, sanitized.inline),
    };
    logEvent("gmail.body", {
      outcome: "html", ms: Date.now() - started, chars: parts.html.length, remote: sanitized.remote, trackers: sanitized.trackers,
      inline: sanitized.inline.size, attachments: body.attachments.length, shown: show, trusted,
    });
    if (show && sanitized.remoteUrls.length) {
      // Every remote image of the body, now, whatever the browser later renders (the proxy route only answers from this).
      const fetchStarted = Date.now();
      void deps.proxy.prefetch(messageId, sanitized.remoteUrls).then((outcomes) => {
        const count = (kind: string) => outcomes.filter((outcome) => outcome.kind === kind).length;
        logEvent("mail.prefetch", { urls: outcomes.length, images: count("image"), pixels: count("pixel"), refused: count("refused"), ms: Date.now() - fetchStarted });
      }).catch(() => undefined);
    }
    res.json(body);
  });

  const servePart = async (res: Response, parts: MailBodyParts, part: MailImagePart | undefined, source: "inline" | "attachment") => {
    const started = Date.now();
    if (!part) {
      logEvent("mail.image", { source, outcome: "missing", ms: Date.now() - started });
      throw new AppError(404, IMAGE_ERRORS.missing);
    }
    const key = `part:${parts.messageId}:${part.partId}`;
    const held = live.image(key);
    const bytes = held?.bytes ?? await readImagePart(ctx, live, parts, part, AbortSignal.timeout(READ_TIMEOUT_MS)).catch((error: unknown) => { throw readFailure(error); });
    if (!bytes) {
      logEvent("mail.image", { source, outcome: "missing", ms: Date.now() - started });
      throw new AppError(404, IMAGE_ERRORS.missing);
    }
    const image = sniffImage(bytes);
    // A raster by its magic bytes, and a pixel size the reader can decode (no decompression bombs, whatever the file size).
    if (!image || !acceptableRaster(image)) {
      logEvent("mail.image", { source, outcome: image ? "too-large" : "not-image", ms: Date.now() - started });
      throw new AppError(415, IMAGE_ERRORS.notImage);
    }
    if (!held) live.putImage(key, { bytes, ...(part.filename ? { filename: part.filename } : {}) }, parts.threadId);
    logEvent("mail.image", { source, outcome: held ? "cached" : "served", ms: Date.now() - started, bytes: bytes.length });
    sendImage(res, { bytes, image, ...(part.filename ? { filename: part.filename } : {}) });
  };

  router.get("/messages/:messageId/inline/:contentId", async (req, res) => {
    const messageId = messageIdSchema.safeParse(req.params.messageId);
    const contentId = String(req.params.contentId ?? "");
    if (!messageId.success || !contentId || contentId.length > 300) throw new AppError(404, IMAGE_ERRORS.missing);
    const parts = await partsOf(messageId.data);
    const part = parts.images.find((image) => image.contentId === contentId)
      ?? parts.images.find((image) => image.contentId?.toLowerCase() === contentId.toLowerCase());
    await servePart(res, parts, part, "inline");
  });

  router.get("/messages/:messageId/attachments/:partId", async (req, res) => {
    const messageId = messageIdSchema.safeParse(req.params.messageId);
    const partId = partIdSchema.safeParse(req.params.partId);
    if (!messageId.success || !partId.success) throw new AppError(404, IMAGE_ERRORS.missing);
    const parts = await partsOf(messageId.data);
    await servePart(res, parts, parts.images.find((image) => image.partId === partId.data), "attachment");
  });
}

const proxyQuery = z.object({
  m: messageIdSchema,
  u: z.string().min(1).max(4000),
  s: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const REFUSED_STATUS: Record<string, [number, string]> = {
  "rate-limited": [429, IMAGE_ERRORS.rateLimited],
  "blocked-address": [403, IMAGE_ERRORS.blocked],
  "invalid-url": [400, IMAGE_ERRORS.badLink],
  "not-image": [415, IMAGE_ERRORS.notImage],
  "too-large": [413, IMAGE_ERRORS.tooLarge],
  timeout: [504, IMAGE_ERRORS.timeout],
  // Nothing was prefetched for it (or it is no longer held): the reader asks for the body again after five minutes.
  expired: [410, IMAGE_ERRORS.badLink],
};

/** /api/mail-images: the signed remote-image proxy. */
export function imageProxyRouter(deps: Pick<BodyDeps, "signer" | "proxy">): Router {
  const router = Router();
  router.get("/proxy", async (req, res) => {
    const started = Date.now();
    const parsed = proxyQuery.safeParse(req.query);
    if (!parsed.success || !deps.signer.verify(parsed.data.m, parsed.data.u, parsed.data.s)) {
      logEvent("mail.image", { source: "remote", outcome: "bad-signature", ms: Date.now() - started });
      throw new AppError(403, IMAGE_ERRORS.badLink);
    }
    const outcome = await deps.proxy.serve(parsed.data.u);
    if (outcome.kind === "refused") {
      logEvent("mail.image", { source: "remote", outcome: outcome.reason, ms: Date.now() - started });
      const [status, message] = REFUSED_STATUS[outcome.reason] ?? [502, IMAGE_ERRORS.failed];
      throw new AppError(status, message);
    }
    if (outcome.kind === "pixel") {
      // A 1×1 image (or a redirect into a tracker): the sender's pixel never reaches the browser; a transparent one of ours does.
      logEvent("mail.image", { source: "remote", outcome: outcome.tracker ? "tracker" : "pixel", ms: Date.now() - started });
      sendImage(res, { bytes: TRANSPARENT_GIF, image: { type: "gif", mime: "image/gif", width: 1, height: 1 } });
      return;
    }
    logEvent("mail.image", { source: "remote", outcome: outcome.cached ? "cached" : "served", ms: Date.now() - started, bytes: outcome.bytes.length });
    sendImage(res, { bytes: outcome.bytes, image: outcome.image });
  });
  return router;
}
