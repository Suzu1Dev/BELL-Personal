/**
 * One message's body in the reader (SPEC-mail-html §5): 純文字 (the cached
 * plain-text excerpt, as before) or 原始版面 (the sanitized HTML in a
 * sandboxed frame). In 原始版面:
 *  - loading: skeleton lines; a failure, a body too large or unsafe to show,
 *    or Gmail not connected: the plain text with a one-line note (重試 on a
 *    failure); a mail without HTML simply shows its plain text;
 *  - remote images blocked: a calm notice 「已封鎖外部圖片，保護你的隱私。」
 *    [顯示圖片 I] [一律顯示「寄件者」的圖片], with the tracking-pixel count;
 *    once shown (asked or a trusted sender) a quiet note says they came
 *    through the owner's server, and focus moves to it when the owner acted
 *    on the notice (its button is gone); a failed image load says so with
 *    重試, and 顯示圖片 or I ask again;
 *  - image attachments as a strip of thumbnails under the message.
 */
import { useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import type { InboxMessage, MailAddress, MailBodyResponse, MailBodyView, MailImageAttachment } from "../../../shared/mail";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { Skeleton } from "../../components/Skeleton";
import { ERRORS } from "../../copy/common";
import { MAIL_BODY } from "../../copy/inbox";
import { routeHref } from "../../lib/router";
import { formatBytes, senderLabel } from "./mail-frame";
import { MailFrame } from "./MailFrame";
import { useMailBody, type MailBodyState } from "./useMailBody";

export interface MailBodyProps {
  message: InboxMessage;
  view: MailBodyView;
  /** How many times the owner asked to see this message's images (this session; 0: not asked). Asking again after a failure retries. */
  imagesAsked: number;
  onShowImages: (messageId: string) => void;
  onTrust: (sender: MailAddress, messageId: string) => void;
  /** Show the I key on 顯示圖片 (the newest message, pointer: fine). */
  keyHint: boolean;
  /** What the server answered for this message (the reader's note depends on whether any message has a layout). */
  onKind?: (messageId: string, kind: MailBodyResponse["kind"]) => void;
}

function PlainText({ message }: { message: InboxMessage }) {
  const text = message.excerpt ?? message.snippet;
  return text ? <div className="mr-text">{text}</div> : null;
}

/** The parts of 原始版面 that depend only on the server's answer (rendered statically in tests). */
export function OriginalBody({ message, body, onShowImages, onTrust, keyHint }: {
  message: InboxMessage;
  body: MailBodyState;
  onShowImages: () => void;
  onTrust: (sender: MailAddress) => void;
  keyHint: boolean;
}) {
  const data = body.data;
  // 顯示圖片 or 一律顯示 takes the notice (and its focused button) away: focus goes to the note that replaces it, never <body>.
  const acted = useRef(false);
  const shownNote = useRef<HTMLParagraphElement | null>(null);
  const shown = !!data && data.kind === "html" && data.images.remote > 0 && data.images.shown;
  useEffect(() => {
    if (!shown || !acted.current) return;
    acted.current = false;
    shownNote.current?.focus();
  }, [shown]);
  const fromNotice = (action: () => void) => () => {
    acted.current = true;
    action();
  };
  if (!data) {
    if (body.state === "error") {
      return (
        <>
          <p className="mr-note mr-fallback">{MAIL_BODY.fallback.failed} <Button variant="ghost" size="sm" onClick={body.retry}>{MAIL_BODY.retry}</Button></p>
          <PlainText message={message} />
        </>
      );
    }
    return (
      <div className="mr-loading" aria-busy="true">
        <p className="sr-only" role="status">{MAIL_BODY.loading}</p>
        <Skeleton width="96%" /><Skeleton width="90%" /><Skeleton width="64%" />
      </div>
    );
  }
  if (data.kind === "text" || !data.document) {
    const note = data.reason && data.reason !== "no-html" ? MAIL_BODY.fallback[data.reason] : undefined;
    return (
      <>
        {note ? <p className="mr-note mr-fallback">{note}</p> : null}
        <PlainText message={message} />
        <Attachments body={data} />
      </>
    );
  }
  const { images } = data;
  const sender = senderLabel(data.sender);
  // 一律顯示 names the address it will trust, never only a display name (「Google 帳號小組」 can be anyone).
  const address = data.sender.email;
  const blocked = images.remote > 0 && !images.shown;
  const trackers = images.trackers ? MAIL_BODY.trackers(images.trackers) : "";
  // The images=1 answer failed: the blocked document stays, and says so with 重試.
  const failed = blocked && body.state === "error";
  return (
    <>
      {blocked ? (
        <Notice
          className="mr-images"
          icon={ImageOff}
          title={MAIL_BODY.blockedTitle}
          actions={(
            <>
              <Button variant="secondary" size="sm" kbd={keyHint ? "I" : undefined} onClick={fromNotice(onShowImages)} aria-busy={body.state === "loading" ? true : undefined}>
                {MAIL_BODY.showImages}
              </Button>
              {address ? (
                <Button variant="ghost" size="sm" onClick={fromNotice(() => onTrust(data.sender))} aria-label={MAIL_BODY.trustSenderLabel(address)} title={MAIL_BODY.trustSenderLabel(address)}>
                  {MAIL_BODY.trustSender(address)}
                </Button>
              ) : null}
            </>
          )}
        >
          {trackers || undefined}
        </Notice>
      ) : null}
      {failed ? (
        <p className="mr-note mr-fallback" role="status">
          {MAIL_BODY.imagesFailed(body.error ?? ERRORS.offline)} <Button variant="ghost" size="sm" onClick={body.retry}>{MAIL_BODY.retry}</Button>
        </p>
      ) : null}
      <MailFrame document={data.document} title={MAIL_BODY.frameTitle} />
      {images.remote > 0 && images.shown ? (
        <p className="mr-note mr-shown" ref={shownNote} tabIndex={-1}>
          {images.trusted ? MAIL_BODY.trusted(sender) : MAIL_BODY.proxied}{trackers ? ` ${trackers}` : ""}
          {images.trusted ? <> <TextLink href={routeHref({ name: "settings", tab: "privacy" })} bare>{MAIL_BODY.manage}</TextLink></> : null}
        </p>
      ) : !blocked && trackers ? <p className="mr-note">{trackers}</p> : null}
      <Attachments body={data} />
    </>
  );
}

/** One image attachment; one the server will not show (not an image, too many pixels to decode) becomes a quiet tile, not a link. */
function AttachmentTile({ item }: { item: MailImageAttachment }) {
  const [refused, setRefused] = useState(false);
  const meta = (
    <>
      <span className="mr-att-name">{item.filename}</span>
      <span className="mr-att-size mono">{formatBytes(item.size)}</span>
    </>
  );
  if (refused) {
    return (
      <span className="mr-att is-refused" title={MAIL_BODY.attachmentRefused}>
        <span className="mr-att-thumb"><Icon icon={ImageOff} /><span className="sr-only">{MAIL_BODY.attachmentRefused}</span></span>
        {meta}
      </span>
    );
  }
  return (
    <a className="mr-att" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={MAIL_BODY.openAttachment(item.filename)}>
      <img src={item.url} alt="" loading="lazy" decoding="async" onError={() => setRefused(true)} />
      {meta}
    </a>
  );
}

function Attachments({ body }: { body: MailBodyResponse }) {
  if (!body.attachments.length) return null;
  return (
    <ul className="mr-attachments" aria-label={MAIL_BODY.attachments}>
      {body.attachments.map((item) => <li key={item.partId}><AttachmentTile item={item} /></li>)}
    </ul>
  );
}

export function MailBody({ message, view, imagesAsked, onShowImages, onTrust, keyHint, onKind }: MailBodyProps) {
  const original = view === "original";
  const body = useMailBody(message.id, imagesAsked > 0, original, imagesAsked);
  const kind = body.data?.kind;
  useEffect(() => {
    if (kind) onKind?.(message.id, kind);
  }, [kind, message.id, onKind]);
  if (!original) return <PlainText message={message} />;
  return (
    <OriginalBody
      message={message}
      body={body}
      // While a request runs, asking again would only restart it.
      onShowImages={() => { if (body.state !== "loading") onShowImages(message.id); }}
      onTrust={(sender) => onTrust(sender, message.id)}
      keyHint={keyHint}
    />
  );
}
