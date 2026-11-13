import type { Response } from "express";

/**
 * The only images BELL serves from mail (inline cid: parts, image
 * attachments, remote images through the proxy): raster formats recognised
 * by their magic bytes, never by the sender's Content-Type or file name. SVG
 * (a document that can carry script and links), HTML and anything else is
 * refused. The served Content-Type comes from the sniff; every response
 * carries nosniff, a sandboxing CSP, `Content-Disposition: inline` with a
 * clean file name whose extension matches the sniffed type, a short private
 * cache and same-origin CORP, so it can only ever be an image of this app.
 *
 * Bytes are not the cost: a 64 KB PNG can declare 23000×23000 pixels and
 * make the reader's tab decode gigabytes. So an image is only served when its
 * header names its size and that size is sane (acceptableRaster: each side
 * ≤ 16384, at most 40 million pixels; GIF frames and AVIF's `ispe` boxes
 * count too); anything else is refused like a non-image.
 */

export const RASTER_TYPES = ["png", "jpeg", "gif", "webp", "avif"] as const;
export type RasterType = (typeof RASTER_TYPES)[number];

export const RASTER_MIME: Record<RasterType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

const EXTENSIONS: Record<RasterType, string> = { png: "png", jpeg: "jpg", gif: "gif", webp: "webp", avif: "avif" };

export interface SniffedImage {
  type: RasterType;
  mime: string;
  /** Decoded pixel size when the header says (GIF: the largest of the screen and every frame; AVIF: the largest `ispe`). */
  width?: number;
  height?: number;
}

/** The largest side and area an image may decode to (about 160 MB of RGBA). */
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = 40_000_000;

const ascii = (bytes: Buffer, start: number, length: number) => bytes.subarray(start, start + length).toString("latin1");

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  // Segments until a start-of-frame marker; each step moves forward, so the scan is linear.
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (startOfFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

/**
 * A GIF's canvas: browsers grow the logical screen to fit a frame that does
 * not fit it, so every frame's extent counts. One linear walk over the
 * blocks; a truncated file keeps what was read.
 */
function gifSize(bytes: Buffer): { width: number; height: number } {
  let width = bytes.readUInt16LE(6);
  let height = bytes.readUInt16LE(8);
  const tableSize = (flags: number) => ((flags & 0x80) ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  let offset = 13 + tableSize(bytes[10]);
  const skipSubBlocks = () => {
    while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1;
    offset++;
  };
  while (offset < bytes.length) {
    const block = bytes[offset];
    if (block === 0x2c && offset + 10 <= bytes.length) {
      width = Math.max(width, bytes.readUInt16LE(offset + 1) + bytes.readUInt16LE(offset + 5));
      height = Math.max(height, bytes.readUInt16LE(offset + 3) + bytes.readUInt16LE(offset + 7));
      offset += 10 + tableSize(bytes[offset + 9]) + 1;
      skipSubBlocks();
    } else if (block === 0x21) {
      offset += 2;
      skipSubBlocks();
    } else {
      break;
    }
  }
  return { width, height };
}

/**
 * The largest `ispe` (image spatial extents) property of an AVIF, found by
 * walking its boxes down meta → iprp → ipco; undefined without one.
 */
function avifSize(bytes: Buffer): { width: number; height: number } | undefined {
  let found: { width: number; height: number } | undefined;
  const walk = (start: number, end: number, depth: number) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = bytes.readUInt32BE(offset);
      const type = ascii(bytes, offset + 4, 4);
      let header = 8;
      if (size === 1 && offset + 16 <= end) {
        const high = bytes.readUInt32BE(offset + 8);
        size = high ? Number.MAX_SAFE_INTEGER : bytes.readUInt32BE(offset + 12);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header) return;
      const boxEnd = Math.min(end, offset + size);
      if (type === "ispe" && offset + header + 12 <= boxEnd) {
        const width = bytes.readUInt32BE(offset + header + 4);
        const height = bytes.readUInt32BE(offset + header + 8);
        found = { width: Math.max(found?.width ?? 0, width), height: Math.max(found?.height ?? 0, height) };
      } else if (depth < 4 && (type === "meta" || type === "iprp" || type === "ipco")) {
        // meta is a full box: four bytes of version and flags before its children.
        walk(offset + header + (type === "meta" ? 4 : 0), boxEnd, depth + 1);
      }
      offset = boxEnd;
    }
  };
  walk(0, bytes.length, 0);
  return found;
}

function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 " && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && bytes.length >= 30) return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return undefined;
}

/** The raster type of `bytes` by its magic bytes, with its pixel size when the header has one; undefined for anything else (SVG, HTML, PDF…). */
export function sniffImage(bytes: Buffer): SniffedImage | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && ascii(bytes, 12, 4) === "IHDR") {
    return { type: "png", mime: RASTER_MIME.png, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 13 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    return { type: "gif", mime: RASTER_MIME.gif, ...gifSize(bytes) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "jpeg", mime: RASTER_MIME.jpeg, ...jpegSize(bytes) };
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { type: "webp", mime: RASTER_MIME.webp, ...webpSize(bytes) };
  }
  if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp") {
    const boxSize = Math.min(bytes.readUInt32BE(0), bytes.length, 64);
    const brands = [ascii(bytes, 8, 4)];
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) brands.push(ascii(bytes, offset, 4));
    if (brands.includes("avif") || brands.includes("avis")) return { type: "avif", mime: RASTER_MIME.avif, ...avifSize(bytes) };
  }
  return undefined;
}

/**
 * Whether an image may be served or shown at all: its header names both
 * sides, each at least 1 and at most MAX_IMAGE_SIDE, and the area is at most
 * MAX_IMAGE_PIXELS (a decompression bomb is refused, not decoded).
 */
export function acceptableRaster(image: Pick<SniffedImage, "width" | "height">): boolean {
  const { width, height } = image;
  if (width === undefined || height === undefined) return false;
  if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return false;
  return width * height <= MAX_IMAGE_PIXELS;
}

/** A 1×1 (or 0×0) image is a tracking pixel: never shown, whoever sent it. */
export function isPixel(image: Pick<SniffedImage, "width" | "height">): boolean {
  return image.width !== undefined && image.height !== undefined && image.width <= 1 && image.height <= 1;
}

/** A transparent 1×1 GIF of our own, served in place of a tracking pixel (its bytes never reach the browser). */
export const TRANSPARENT_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** `inline; filename="…"; filename*=UTF-8''…` with the sniffed type's extension and nothing that could break the header or a path. */
export function contentDisposition(name: string | undefined, type: RasterType): string {
  const extension = EXTENSIONS[type];
  const cleaned = (name ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f"\\/:;*?<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  const stem = cleaned.replace(/\.[^.]*$/, "").replace(/^\.+/, "") || "image";
  const full = `${stem}.${extension}`;
  const fallback = full.replace(/[^\x20-\x7e]/g, "_");
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}

export interface ServedImage {
  bytes: Buffer;
  image: SniffedImage;
  filename?: string;
}

/** Writes an image response with the headers above (they replace the guard's CSP and no-store for this response only). */
export function sendImage(res: Response, served: ServedImage): void {
  res.status(200);
  res.setHeader("Content-Type", served.image.mime);
  res.setHeader("Content-Length", String(served.bytes.length));
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", contentDisposition(served.filename, served.image.type));
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(served.bytes);
}
