import { MAIL_LIMITS, type MailAddress, type MailMessage } from "../../../shared/mail.js";
import { stripHiddenElements } from "../../html.js";

/**
 * Gmail API message resources → MailMessage. Only metadata, the snippet and a
 * plain-text excerpt (≤ MAIL_LIMITS.excerptBytes) are kept: the excerpt comes
 * from the first text/plain part, else from text/html with every tag removed.
 * HTML, attachments and remote images are never stored (decisions.md item 9).
 */

export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
/** users.messages.get (format=full or minimal). */
export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/**
 * Gmail web for the connected account: /mail/u/<address>/ picks that account
 * among the browser's signed-in ones (u/0 is merely the first). Without a
 * known address it falls back to u/0.
 */
export function gmailWebBase(account?: string): string {
  return `https://mail.google.com/mail/u/${account ? encodeURIComponent(account) : "0"}/`;
}

/** The Gmail web link for a conversation (SPEC-ux §6.3 「在 Gmail 開啟」); #all also finds archived threads. */
export function gmailThreadUrl(threadId: string, account?: string): string {
  return `${gmailWebBase(account)}#all/${encodeURIComponent(threadId)}`;
}

/** The connected account's inbox (the digest's 逐類看). */
export function gmailInboxUrl(account?: string): string {
  return `${gmailWebBase(account)}#inbox`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·",
  bull: "•", copy: "©", reg: "®", trade: "™", times: "×", yen: "¥", euro: "€", zwnj: "", zwj: "", shy: "",
};

/** Decodes HTML character references (named, decimal and hex). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Decoded bodies are cut to this many characters before any parsing: the
 * excerpt keeps 8 KB, and a hostile multi-megabyte body must not hold the
 * event loop (every step below is linear, the cut bounds the constant).
 */
export const MAX_PLAIN_CHARS = 64 * 1024;
export const MAX_HTML_CHARS = 512 * 1024;

const HIDDEN_ELEMENTS = ["head", "style", "script", "title", "template", "svg", "noscript"] as const;

/**
 * HTML → readable plain text: drops head, style, script and comments, turns
 * block ends into line breaks, removes every tag, decodes entities and
 * collapses whitespace. No markup survives. Linear in the input: tag patterns
 * stop at the next `<`, so a run of unbalanced brackets cannot backtrack.
 */
export function htmlToText(html: string): string {
  const text = stripHiddenElements(html, HIDDEN_ELEMENTS)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|table|blockquote)\s*>/gi, "\n\n")
    .replace(/<\/(div|tr|section|article|header|footer|ul|ol)\s*>/gi, "\n")
    .replace(/<li\b[^<>]*>/gi, "\n• ")
    .replace(/<(td|th)\b[^<>]*>/gi, " ")
    .replace(/<[^<>]*>/g, "")
    .replace(/[<>]/g, "");
  return normalizeText(decodeEntities(text));
}

/** Trims every line, collapses runs of spaces and of blank lines. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ​]+/g, " ")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drops quoted reply history (`> …` lines and the 「… wrote:」 line before them) from a plain-text body. */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  // nextQuoted[i]: whether the next non-blank line after line i is quoted (one backward pass).
  const nextQuoted = new Array<boolean>(lines.length).fill(false);
  let quoted = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    nextQuoted[index] = quoted;
    if (lines[index].trim() !== "") quoted = lines[index].startsWith(">");
  }
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith(">")) continue;
    if (nextQuoted[index] && /(wrote|寫道)[:：]?\s*$/i.test(line)) continue;
    kept.push(line);
  }
  return normalizeText(kept.join("\n"));
}

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a character. */
export function clipUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "").trimEnd();
}

/** A decoder for a declared charset, or undefined for an unknown label or one WHATWG maps to "replacement" (ISO-2022-KR, HZ). */
function declaredDecoder(charset: string | undefined): TextDecoder | undefined {
  if (!charset) return undefined;
  try {
    const decoder = new TextDecoder(charset.trim().toLowerCase());
    return decoder.encoding === "replacement" ? undefined : decoder;
  } catch {
    return undefined;
  }
}

/**
 * A part's bytes as text. Gmail may hand back either the original charset or
 * UTF-8: valid UTF-8 wins, otherwise the declared charset (Big5 mail from
 * Taiwanese senders), otherwise lenient UTF-8. 7-bit stateful charsets
 * (ISO-2022-JP) are always valid UTF-8 byte for byte, so their declared label
 * goes first when the bytes carry escape sequences.
 */
export function decodeBody(data: string, charset: string | undefined): string {
  return decodeBytes(Buffer.from(data, "base64url"), charset);
}

/** decodeBody for bytes already decoded from base64url (a part fetched with attachments.get). */
export function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  const declared = declaredDecoder(charset);
  if (declared && declared.encoding !== "utf-8" && (declared.encoding.startsWith("iso-2022") || bytes.includes(0x1b))) {
    try { return declared.decode(bytes); } catch { /* fall back to UTF-8 */ }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { /* not UTF-8 */ }
  if (declared) return declared.decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((item) => item.name.toLowerCase() === lower)?.value;
}

/** RFC 2047 encoded words (=?UTF-8?B?…?=), in case a header arrives undecoded. */
export function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(\s+(?==\?))?/gi, (match, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_hex, code: string) => String.fromCharCode(Number.parseInt(code, 16))), "latin1");
      const decoder = declaredDecoder(charset.replace(/\*.*$/, ""));
      return decoder ? decoder.decode(bytes) : match;
    } catch {
      return match;
    }
  });
}

/** `"林志明 教授" <cmlin@cs.nycu.edu.tw>` → { name, email }. */
export function parseAddress(value: string | undefined): MailAddress {
  const raw = decodeMimeWords((value ?? "").trim());
  const angle = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(raw);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, "\"").trim();
    return { ...(name && name !== angle[2] ? { name: name.slice(0, 120) } : {}), email: angle[2].toLowerCase().slice(0, 254) };
  }
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(raw);
  return { email: (bare?.[1] ?? raw).toLowerCase().slice(0, 254) || "unknown" };
}

export const charsetOf = (part: GmailPart) => /charset="?([^";\s]+)"?/i.exec(header(part, "content-type") ?? "")?.[1];
export const isAttachment = (part: GmailPart) => !!part.filename || /^\s*attachment/i.test(header(part, "content-disposition") ?? "");

/** Depth-first: the first inline part of a MIME type that carries data. */
function findPart(part: GmailPart | undefined, mimeType: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType?.toLowerCase() === mimeType && part.body?.data && !isAttachment(part)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** The plain-text excerpt of a full message: text/plain first, else stripped text/html; quoted history removed. */
export function extractExcerpt(payload: GmailPart | undefined, maxBytes: number = MAIL_LIMITS.excerptBytes): string | undefined {
  const plain = findPart(payload, "text/plain");
  let text: string | undefined;
  if (plain?.body?.data) text = normalizeText(decodeBody(plain.body.data, charsetOf(plain)).slice(0, MAX_PLAIN_CHARS));
  else {
    const html = findPart(payload, "text/html");
    if (html?.body?.data) text = htmlToText(decodeBody(html.body.data, charsetOf(html)).slice(0, MAX_HTML_CHARS));
  }
  if (!text) return undefined;
  const cleaned = stripQuoted(text) || text;
  return clipUtf8(cleaned, maxBytes) || undefined;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** A full (or minimal) message resource → MailMessage, without triage; links point at `account` when known. */
export function normalizeMessage(resource: GmailMessageResource, account?: string): MailMessage {
  const labels = [...new Set(resource.labelIds ?? [])];
  const internal = Number(resource.internalDate);
  const dateHeader = Date.parse(header(resource.payload, "date") ?? "");
  const receivedAt = new Date(Number.isFinite(internal) && internal > 0 ? internal : Number.isFinite(dateHeader) ? dateHeader : 0).toISOString();
  const subject = clip(normalizeText(decodeMimeWords(header(resource.payload, "subject") ?? "")).replace(/\n+/g, " "), 300);
  const snippet = clip(normalizeText(decodeEntities(resource.snippet ?? "")).replace(/\n+/g, " "), 300);
  const excerpt = extractExcerpt(resource.payload);
  return {
    id: resource.id,
    threadId: resource.threadId,
    from: parseAddress(header(resource.payload, "from")),
    subject: subject || "（沒有主旨）",
    snippet,
    ...(excerpt ? { excerpt } : {}),
    receivedAt,
    unread: labels.includes("UNREAD"),
    labels,
    webUrl: gmailThreadUrl(resource.threadId, account),
    ...(header(resource.payload, "list-unsubscribe") ? { listUnsubscribe: true } : {}),
  };
}

/** normalizeMessage, or the headers alone when the body cannot be parsed (live reads: one odd message never fails a page). */
export function normalizeOrHeaders(resource: GmailMessageResource, account?: string): MailMessage {
  try {
    return normalizeMessage(resource, account);
  } catch {
    return normalizeMessage({ ...resource, payload: { headers: resource.payload?.headers ?? [] } }, account);
  }
}

/** Same message with new labels (history labelAdded/labelRemoved). */
export function withLabels(message: MailMessage, labels: string[]): MailMessage {
  const unique = [...new Set(labels)];
  return { ...message, labels: unique, unread: unique.includes("UNREAD") };
}
