/** Image format and pixel size read from the first bytes of a file, for the formats Google Images supports. */
export interface ImageInfo {
  readonly format: 'png' | 'gif' | 'jpeg' | 'webp' | 'bmp' | 'svg' | 'avif' | 'ico';
  /** Absent when the size cannot be read from the header (SVG, AVIF, some WebP and ICO files). */
  readonly width?: number;
  readonly height?: number;
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    // Start-of-frame markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && bytes.length >= 30) return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && bytes.length >= 30) return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return undefined;
}

export function imageInfo(bytes: Buffer): ImageInfo | undefined {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') return { format: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return { format: 'jpeg', ...jpegSize(bytes) };
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { format: 'webp', ...webpSize(bytes) };
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') return { format: 'bmp', width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/u.test(bytes.toString('ascii', 8, 32))) return { format: 'avif' };
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00000100) return { format: 'ico' };
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 1024)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { format: 'svg' };
  return undefined;
}
