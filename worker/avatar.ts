import { fail } from "./security";

// Native V8 codecs avoid allocating/JSON-serializing 524,288 JS numbers.
// SQLite unhex() stores the parameter as a true BLOB, not text.
export const toHex = (bytes: Uint8Array) =>
  (bytes as Uint8Array & { toHex(): string }).toHex();
export const fromHex = (hex: string) =>
  (
    Uint8Array as typeof Uint8Array & {
      fromHex(hex: string): Uint8Array<ArrayBuffer>;
    }
  ).fromHex(hex);

// Inspect bounded container headers without decompressing untrusted images on Workers Free.
export function validateAvatar(bytes: Uint8Array, type: string) {
  if (!bytes.length || bytes.length > 524288)
    fail(413, "Choose an avatar up to 512 KB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    new TextDecoder().decode(bytes.subarray(offset, offset + length));
  let width = 0,
    height = 0;
  if (type === "image/png") {
    if (
      bytes.length < 45 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    )
      fail(415, "Invalid PNG.");
    let offset = 8,
      data = false,
      end = false,
      chunks = 0;
    while (offset + 12 <= bytes.length) {
      if (++chunks > 256)
        fail(415, "Please re-export this image with fewer metadata chunks.");
      const length = view.getUint32(offset),
        chunk = ascii(offset + 4, 4);
      if (offset + 12 + length > bytes.length) fail(415, "Truncated PNG.");
      if (offset === 8) {
        if (chunk !== "IHDR" || length !== 13) fail(415, "Invalid PNG header.");
        width = view.getUint32(16);
        height = view.getUint32(20);
      }
      if (chunk === "acTL") fail(415, "Use a still image.");
      if (chunk === "IDAT" && length > 0) data = true;
      offset += 12 + length;
      if (chunk === "IEND") {
        end = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!data || !end) fail(415, "Invalid PNG image.");
  } else if (type === "image/jpeg") {
    if (
      bytes.length < 20 ||
      bytes[0] !== 255 ||
      bytes[1] !== 216 ||
      bytes.at(-2) !== 255 ||
      bytes.at(-1) !== 217
    )
      fail(415, "Invalid JPEG.");
    let offset = 2,
      scan = false,
      segments = 0;
    while (offset + 4 < bytes.length) {
      if (++segments > 256)
        fail(415, "Please re-export this image with fewer metadata segments.");
      if (bytes[offset++] !== 255) fail(415, "Invalid JPEG segment.");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218) {
        scan = true;
        break;
      }
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length)
        fail(415, "Invalid JPEG length.");
      if ([192, 193, 194].includes(marker)) {
        if (length < 8) fail(415, "Invalid JPEG frame.");
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
      }
      offset += length;
    }
    if (!scan) fail(415, "Invalid JPEG image.");
  } else if (type === "image/webp") {
    if (
      bytes.length < 30 ||
      ascii(0, 4) !== "RIFF" ||
      ascii(8, 4) !== "WEBP" ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      fail(415, "Invalid WebP.");
    let offset = 12,
      data = false,
      chunks = 0;
    while (offset + 8 <= bytes.length) {
      if (++chunks > 256)
        fail(415, "Please re-export this image with fewer metadata chunks.");
      const chunk = ascii(offset, 4),
        length = view.getUint32(offset + 4, true),
        start = offset + 8;
      if (start + length > bytes.length) fail(415, "Truncated WebP.");
      if (chunk === "ANIM" || chunk === "ANMF") fail(415, "Use a still image.");
      if (
        chunk === "VP8 " &&
        length >= 10 &&
        bytes[start + 3] === 157 &&
        bytes[start + 4] === 1 &&
        bytes[start + 5] === 42
      ) {
        width = view.getUint16(start + 6, true) & 16383;
        height = view.getUint16(start + 8, true) & 16383;
        data = true;
      }
      if (chunk === "VP8L" && length >= 5 && bytes[start] === 47) {
        const bits = view.getUint32(start + 1, true);
        width = (bits & 16383) + 1;
        height = ((bits >>> 14) & 16383) + 1;
        data = true;
      }
      offset = start + length + (length % 2);
    }
    if (!data || offset !== bytes.length) fail(415, "Invalid WebP image.");
  } else fail(415, "Choose a JPEG, PNG, or WebP image.");
  if (width < 1 || height < 1 || width > 2048 || height > 2048)
    fail(400, "Avatar dimensions must be 1–2048 pixels.");
  return { width, height };
}
