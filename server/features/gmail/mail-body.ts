import { MAIL_BODY_LIMITS, type MailAddress } from "../../../shared/mail.js";
import { logEvent } from "../../log.js";
import type { ModuleContext } from "../../modules.js";
import { ResponseTooLargeError } from "../../sync.js";
import { GmailApi } from "./api.js";
import type { LiveMail } from "./live.js";
import { charsetOf, decodeBytes, header, isAttachment, parseAddress, type GmailMessageResource, type GmailPart } from "./parse.js";

/**
 * A message's HTML and image parts for the reader's original layout
 * (SPEC-mail-html §2): read live with messages.get(format=full) when the
 * reader opens the message (the sync never keeps HTML), decoded with the
 * same charset rules as the plain-text path, and held only in server memory
 * (LiveMail, 5 minutes, bounded by bytes). A message over the 5 MB answer
 * cap, or whose HTML is longer than MAIL_BODY_LIMITS.htmlChars, keeps its
 * plain text (`htmlTooLarge`).
 */

export interface MailImagePart {
  /** MIME part id ("1.2"): stable for the message, unlike Gmail's attachment ids. */
  partId: string;
  mimeType: string;
  filename?: string;
  /** Content-ID without its angle brackets (cid: target). */
  contentId?: string;
  size: number;
  /** An attachment (not only an inline image of the HTML). */
  attachment: boolean;
  /** base64url bytes when Gmail put them in the message answer. */
  data?: string;
  /** Otherwise the id for messages.attachments.get, valid for this read of the message. */
  attachmentId?: string;
}

export interface MailBodyParts {
  messageId: string;
  threadId: string;
  from: MailAddress;
  /** Decoded HTML, when the message has some that fits. */
  html?: string;
  /** The message or its HTML is too big to render: show the plain text. */
  htmlTooLarge?: boolean;
  images: MailImagePart[];
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif)$/i;
/** Parts looked at per message at most (a hostile MIME tree cannot make the walk long). */
const MAX_PARTS = 500;

function contentIdOf(part: GmailPart): string | undefined {
  const raw = header(part, "content-id") ?? header(part, "x-attachment-id");
  const id = raw?.trim().replace(/^<|>$/g, "").trim();
  return id && id.length <= 300 ? id : undefined;
}

/** The first inline text/html part and every image part, depth first. */
export function mailParts(payload: GmailPart | undefined): { html?: GmailPart; images: MailImagePart[] } {
  const images: MailImagePart[] = [];
  let html: GmailPart | undefined;
  let seen = 0;
  const walk = (part: GmailPart | undefined, path: string) => {
    if (!part || seen++ >= MAX_PARTS) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    const partId = /^[0-9.]{1,40}$/.test(part.partId ?? "") ? part.partId! : path;
    if (mime === "text/html" && !html && !isAttachment(part) && (part.body?.data || part.body?.attachmentId)) html = part;
    const imageLike = mime.startsWith("image/") || (mime === "application/octet-stream" && IMAGE_EXTENSION.test(part.filename ?? ""));
    if (imageLike && (part.body?.data || part.body?.attachmentId) && mime !== "image/svg+xml") {
      const contentId = contentIdOf(part);
      const disposition = (header(part, "content-disposition") ?? "").trim().toLowerCase();
      images.push({
        partId,
        mimeType: mime,
        ...(part.filename ? { filename: part.filename.slice(0, 200) } : {}),
        ...(contentId ? { contentId } : {}),
        size: Number(part.body?.size ?? 0) || 0,
        attachment: disposition.startsWith("attachment") || (!contentId && !!part.filename),
        ...(part.body?.data ? { data: part.body.data } : {}),
        ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
      });
    }
    (part.parts ?? []).forEach((child, index) => walk(child, path ? `${path}.${index}` : String(index)));
  };
  walk(payload, "");
  return { ...(html ? { html } : {}), images };
}

/** Rough bytes a body holds in memory (UTF-16 HTML plus inline data). */
const heldBytes = (parts: MailBodyParts) => (parts.html?.length ?? 0) * 2 + parts.images.reduce((sum, image) => sum + (image.data?.length ?? 0), 0) + 1024;

/**
 * The message's parts from memory, else one messages.get(format=full) (and,
 * for an HTML part Gmail left out of it, one attachments.get). Undefined
 * when Gmail no longer has the message.
 */
export async function readMailBody(ctx: ModuleContext, live: LiveMail, messageId: string, signal: AbortSignal): Promise<MailBodyParts | undefined> {
  const held = live.body(messageId);
  if (held) return held;
  const api = GmailApi.withSignal(ctx, signal);
  let resource: GmailMessageResource | undefined;
  let tooLarge = false;
  try {
    resource = await api.message(messageId, "full");
  } catch (error) {
    if (!(error instanceof ResponseTooLargeError)) throw error;
    // Over the 5 MB answer cap: the headers say who sent it; the reader keeps the plain text.
    logEvent("gmail.message_too_large", { format: "full" });
    tooLarge = true;
    resource = await api.message(messageId, "metadata");
  }
  if (!resource) return undefined;
  const { html: htmlPart, images } = tooLarge ? { html: undefined, images: [] } : mailParts(resource.payload);
  let html: string | undefined;
  if (htmlPart) {
    let bytes: Buffer | undefined;
    try {
      bytes = htmlPart.body?.data
        ? Buffer.from(htmlPart.body.data, "base64url")
        : await api.attachment(messageId, htmlPart.body!.attachmentId!, MAIL_BODY_LIMITS.htmlChars * 4);
    } catch (error) {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      tooLarge = true;
    }
    if (bytes) {
      const text = decodeBytes(bytes, charsetOf(htmlPart));
      if (text.length > MAIL_BODY_LIMITS.htmlChars) tooLarge = true;
      else html = text;
    }
  }
  const parts: MailBodyParts = {
    messageId: resource.id,
    threadId: resource.threadId,
    from: parseAddress(header(resource.payload, "from")),
    ...(html !== undefined ? { html } : {}),
    ...(tooLarge ? { htmlTooLarge: true } : {}),
    images,
  };
  live.putBody(parts, heldBytes(parts));
  return parts;
}

/**
 * One image part's bytes: from the message answer, else attachments.get. A
 * held body's attachment id can be stale once Gmail has moved on; then the
 * message is read again and its fresh id used, once. Undefined when the part
 * is gone or over MAIL_BODY_LIMITS.imageBytes.
 */
export async function readImagePart(ctx: ModuleContext, live: LiveMail, parts: MailBodyParts, part: MailImagePart, signal: AbortSignal): Promise<Buffer | undefined> {
  const api = GmailApi.withSignal(ctx, signal);
  const fetchPart = async (image: MailImagePart): Promise<Buffer | undefined> => {
    if (image.data) {
      const bytes = Buffer.from(image.data, "base64url");
      return bytes.length <= MAIL_BODY_LIMITS.imageBytes ? bytes : undefined;
    }
    if (!image.attachmentId) return undefined;
    try {
      return await api.attachment(parts.messageId, image.attachmentId, MAIL_BODY_LIMITS.imageBytes);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) return undefined;
      throw error;
    }
  };
  const bytes = await fetchPart(part);
  if (bytes || part.data || !part.attachmentId) return bytes;
  live.forgetBody(parts.messageId);
  const fresh = await readMailBody(ctx, live, parts.messageId, signal);
  const again = fresh?.images.find((image) => image.partId === part.partId);
  return again && again.attachmentId !== part.attachmentId ? fetchPart(again) : undefined;
}
