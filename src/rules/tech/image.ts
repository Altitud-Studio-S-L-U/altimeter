import { startsLikeSvg } from '../helpers.ts';

/** Image formats recognised from their leading bytes, independent of the Content-Type the server sends. */
export type ImageFormat = 'png' | 'gif' | 'jpeg' | 'ico' | 'bmp' | 'webp' | 'svg' | 'avif' | 'tiff' | 'ppm';

export interface ImageInfo {
  readonly format: ImageFormat | undefined;
  /** Largest size found; undefined for vector images or when the header cannot be read. */
  readonly width?: number;
  readonly height?: number;
}

function size(width: number, height: number): { width: number; height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return size(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    offset += 2 + length;
  }
  return undefined;
}

function icoSize(bytes: Buffer): { width: number; height: number } | undefined {
  const count = bytes.readUInt16LE(4);
  let best: { width: number; height: number } | undefined;
  for (let index = 0; index < count && 6 + index * 16 + 16 <= bytes.length; index += 1) {
    const entry = 6 + index * 16;
    let width = bytes[entry]! === 0 ? 256 : bytes[entry]!;
    let height = bytes[entry + 1]! === 0 ? 256 : bytes[entry + 1]!;
    // An entry may embed a PNG whose own header holds the exact size, which can exceed 256.
    const dataOffset = bytes.readUInt32LE(entry + 12);
    if (dataOffset + 24 <= bytes.length && bytes.readUInt32BE(dataOffset) === 0x89504e47) {
      width = bytes.readUInt32BE(dataOffset + 16);
      height = bytes.readUInt32BE(dataOffset + 20);
    }
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && bytes.length >= 30) return size(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const b0 = bytes[21]!;
    const b1 = bytes[22]!;
    const b2 = bytes[23]!;
    const b3 = bytes[24]!;
    return size(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
  }
  if (chunk === 'VP8X' && bytes.length >= 30) return size(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
  return undefined;
}

function looksLikeSvg(bytes: Buffer): boolean {
  return startsLikeSvg(bytes.subarray(0, 1024).toString('utf8'));
}

/** Reads the format and pixel size of an image from its first bytes. */
export function imageInfo(bytes: Buffer): ImageInfo {
  try {
    if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { format: 'png', ...size(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) };
    const signature = bytes.toString('latin1', 0, 6);
    if ((signature === 'GIF87a' || signature === 'GIF89a') && bytes.length >= 10) return { format: 'gif', ...size(bytes.readUInt16LE(6), bytes.readUInt16LE(8)) };
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: 'jpeg', ...jpegSize(bytes) };
    if (bytes.length >= 6 && bytes.readUInt32BE(0) === 0x00000100) return { format: 'ico', ...icoSize(bytes) };
    if (bytes.length >= 26 && signature.startsWith('BM')) return { format: 'bmp', ...size(Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22))) };
    if (bytes.length >= 16 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return { format: 'webp', ...webpSize(bytes) };
    if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]/u.test(bytes.toString('latin1', 8, 12))) return { format: 'avif' };
    if (bytes.length >= 4 && (bytes.toString('latin1', 0, 4) === 'II*\0' || bytes.toString('latin1', 0, 4) === 'MM\0*')) return { format: 'tiff' };
    if (/^P[1-6]\s/u.test(bytes.toString('latin1', 0, 3))) return { format: 'ppm' };
    if (looksLikeSvg(bytes)) return { format: 'svg' };
  } catch {
    // A truncated header leaves the format unknown rather than failing the rule.
  }
  return { format: undefined };
}

export function describeImage(info: ImageInfo): string {
  if (info.format === undefined) return 'unrecognised format';
  return info.width !== undefined && info.height !== undefined ? `${info.format} ${info.width}x${info.height}` : info.format;
}
