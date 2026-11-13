import test from "node:test";
import assert from "node:assert/strict";
import { pngImage } from "./fixtures/html-mail.js";
import { acceptableRaster, contentDisposition, isPixel, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, sniffImage, TRANSPARENT_GIF } from "./images.js";

/** Raster images only, by magic bytes (SPEC-mail-html §4.1); file names that cannot break a header or a path. */

function jpeg(width: number, height: number): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

/** A GIF with a logical screen and one frame of its own size and position (no pixels: only the header matters here). */
function gif(screen: [number, number], frame: [number, number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(screen[0], 6);
  header.writeUInt16LE(screen[1], 8);
  header[10] = 0x80; // a global colour table of 2 entries
  const table = Buffer.alloc(6);
  const extension = Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0]);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  frame.forEach((value, index) => descriptor.writeUInt16LE(value, 1 + index * 2));
  return Buffer.concat([header, table, extension, descriptor, Buffer.from([2, 2, 0x4c, 0x01, 0, 0x3b])]);
}

const box = (type: string, payload: Buffer) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + payload.length);
  return Buffer.concat([size, Buffer.from(type, "latin1"), payload]);
};

/** An AVIF whose meta/iprp/ipco holds `ispe` boxes (image spatial extents). */
function avifWith(...sizes: Array<[number, number]>): Buffer {
  const ispe = sizes.map(([width, height]) => {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(width, 4);
    payload.writeUInt32BE(height, 8);
    return box("ispe", payload);
  });
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), box("hdlr", Buffer.alloc(24)), box("iprp", box("ipco", Buffer.concat(ispe)))]));
  return Buffer.concat([box("ftyp", Buffer.from("avif\0\0\0\0mif1avif", "latin1")), meta]);
}

function webp(chunk: "VP8L" | "VP8X", width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(32, 4);
  bytes.write("WEBP", 8, "latin1");
  bytes.write(chunk, 12, "latin1");
  if (chunk === "VP8L") {
    bytes[20] = 0x2f;
    bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

test("raster images are recognised by their magic bytes with their pixel size; SVG, HTML, PDF and empty bodies are not images", () => {
  assert.deepEqual(sniffImage(pngImage(7, 3, () => [1, 2, 3])), { type: "png", mime: "image/png", width: 7, height: 3 });
  assert.deepEqual(sniffImage(TRANSPARENT_GIF), { type: "gif", mime: "image/gif", width: 1, height: 1 });
  assert.deepEqual(sniffImage(jpeg(64, 32)), { type: "jpeg", mime: "image/jpeg", width: 64, height: 32 });
  assert.deepEqual(sniffImage(webp("VP8L", 10, 5)), { type: "webp", mime: "image/webp", width: 10, height: 5 });
  assert.deepEqual(sniffImage(webp("VP8X", 300, 200)), { type: "webp", mime: "image/webp", width: 300, height: 200 });
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif\0\0\0\0mif1avifmiaf", "latin1")]);
  assert.deepEqual(sniffImage(avif), { type: "avif", mime: "image/avif" }, "no ispe: no size");
  for (const notImage of [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"/>", "<?xml version=\"1.0\"?><svg/>", "<!doctype html><script>alert(1)</script>",
    "%PDF-1.4", "GIF8", "", "\x89PNG\r\n\x1a\n", "RIFF\0\0\0\0WAVEfmt ",
  ]) assert.equal(sniffImage(Buffer.from(notImage, "latin1")), undefined, JSON.stringify(notImage.slice(0, 20)));
  assert.equal(isPixel({ width: 1, height: 1 }), true);
  assert.equal(isPixel({ width: 0, height: 0 }), true);
  assert.equal(isPixel({ width: 1, height: 2 }), false);
  assert.equal(isPixel({}), false, "an unknown size is not a pixel");
});

test("Content-Disposition: inline, the sniffed type's extension, nothing that breaks the header or names a path", () => {
  assert.equal(contentDisposition("白板照片.png", "png"), "inline; filename=\"____.png\"; filename*=UTF-8''%E7%99%BD%E6%9D%BF%E7%85%A7%E7%89%87.png");
  assert.equal(contentDisposition("report.html", "jpeg"), "inline; filename=\"report.jpg\"; filename*=UTF-8''report.jpg", "a misleading extension is replaced");
  assert.equal(contentDisposition("../../etc/passwd", "gif"), "inline; filename=\"image.gif\"; filename*=UTF-8''image.gif", "no separators, no dot names");
  assert.equal(contentDisposition("..\\..\\boot.ini.png", "png"), "inline; filename=\"....boot.ini.png\"; filename*=UTF-8''....boot.ini.png".replace(/\.\.\.\./g, ""));
  assert.equal(contentDisposition("a\"b\r\nSet-Cookie: x=1.png", "png"), "inline; filename=\"abSet-Cookie x=1.png\"; filename*=UTF-8''abSet-Cookie%20x%3D1.png");
  assert.equal(contentDisposition(undefined, "webp"), "inline; filename=\"image.webp\"; filename*=UTF-8''image.webp");
  assert.equal(contentDisposition("...", "png"), "inline; filename=\"image.png\"; filename*=UTF-8''image.png");
});

test("an image whose header declares too many pixels is not acceptable, whatever its byte size (decompression bombs)", () => {
  const png = (width: number, height: number) => {
    const bytes = Buffer.from(pngImage(2, 2, () => [0, 0, 0]));
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const bombs: Array<[string, Buffer]> = [
    ["png 23000²", png(23_000, 23_000)],
    ["png one long side", png(MAX_IMAGE_SIDE + 1, 10)],
    ["png 8000×8000 (64 Mpx)", png(8000, 8000)],
    ["gif screen", gif([23_000, 23_000], [0, 0, 1, 1])],
    ["gif frame bigger than its 1×1 screen", gif([1, 1], [0, 0, 16_000, 16_000])],
    ["gif frame placed far out", gif([10, 10], [23_000, 0, 10, 10])],
    ["jpeg", jpeg(23_000, 23_000)],
    ["jpeg without a height (DNL)", jpeg(4000, 0)],
    ["webp VP8L", webp("VP8L", 16_384, 16_384)],
    ["webp VP8X", webp("VP8X", 23_000, 23_000)],
    ["avif", avifWith([23_000, 23_000])],
    ["avif grid with small tiles", avifWith([512, 512], [20_000, 20_000])],
    ["avif without ispe", Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif\0\0\0\0mif1avifmiaf", "latin1")])],
  ];
  for (const [label, bytes] of bombs) {
    const image = sniffImage(bytes);
    assert.ok(image, label);
    assert.equal(acceptableRaster(image), false, `${label}: ${JSON.stringify(image)}`);
  }
  assert.ok(png(23_000, 23_000).length < 100, "a few bytes declare half a billion pixels");
  assert.deepEqual(sniffImage(gif([1, 1], [0, 0, 16_000, 16_000])), { type: "gif", mime: "image/gif", width: 16_000, height: 16_000 }, "the largest frame, not the 1×1 screen");
  assert.equal(isPixel(sniffImage(gif([1, 1], [0, 0, 16_000, 16_000]))!), false, "so it is not mistaken for a pixel");
  assert.deepEqual(sniffImage(avifWith([1200, 800])), { type: "avif", mime: "image/avif", width: 1200, height: 800 });
  for (const ok of [pngImage(600, 240, () => [1, 2, 3]), jpeg(4000, 3000), webp("VP8X", 1200, 800), gif([600, 400], [0, 0, 600, 400]), avifWith([1200, 800])]) {
    assert.equal(acceptableRaster(sniffImage(ok)!), true, JSON.stringify(sniffImage(ok)));
  }
  assert.equal(acceptableRaster({ width: 6324, height: 6324 }), true, "about 40 Mpx is the limit");
  assert.equal(acceptableRaster({ width: 6325, height: 6325 }), false);
  assert.ok(6324 * 6324 <= MAX_IMAGE_PIXELS && 6325 * 6325 > MAX_IMAGE_PIXELS);
  assert.equal(acceptableRaster({}), false, "a size the header does not name is refused");
  // Truncated and looping GIF block streams end the walk (linear, no throw).
  assert.ok(sniffImage(gif([10, 10], [0, 0, 10, 10]).subarray(0, 30)));
  assert.ok(sniffImage(Buffer.concat([gif([10, 10], [0, 0, 10, 10]).subarray(0, 21), Buffer.alloc(100_000, 0x21)])));
});
