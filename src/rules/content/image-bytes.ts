export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | 'bmp' | 'svg' | 'heic' | 'jxl' | 'tiff' | 'ico' | 'unknown';

/** Formats Google Images indexes. */
export const indexableFormats: ReadonlySet<ImageFormat> = new Set(['jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg']);

/** Identifies an image by its first bytes, which is what decoders trust, not the file extension. */
export function sniffImage(body: Buffer): ImageFormat {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpeg';
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (body.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = body.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  if ((body[0] === 0xff && body[1] === 0x0a) || body.subarray(4, 8).toString('latin1') === 'JXL ') return 'jxl';
  if (body.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || body.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return 'tiff';
  if (body.subarray(0, 2).toString('latin1') === 'BM') return 'bmp';
  if (body.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return 'ico';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/iu.test(body.subarray(0, 4096).toString('utf8'))) return 'svg';
  return 'unknown';
}

/** Pixel width and height from the image header, for raster formats whose header states them. */
export function imageSize(body: Buffer): { readonly width: number; readonly height: number } | undefined {
  const format = sniffImage(body);
  if (format === 'png' && body.length >= 24) return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
  if (format === 'gif' && body.length >= 10) return { width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
  if (format === 'bmp' && body.length >= 26) return { width: body.readInt32LE(18), height: Math.abs(body.readInt32LE(22)) };
  if (format === 'webp' && body.length >= 30) {
    const chunk = body.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') return { width: body.readUInt16LE(26) & 0x3fff, height: body.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = body.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: body.readUIntLE(24, 3) + 1, height: body.readUIntLE(27, 3) + 1 };
  }
  if (format === 'jpeg') {
    let offset = 2;
    while (offset + 9 < body.length) {
      if (body[offset] !== 0xff) return undefined;
      const marker = body[offset + 1]!;
      const length = body.readUInt16BE(offset + 2);
      // Start-of-frame markers carry the dimensions; C4, C8 and CC are tables, not frames.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: body.readUInt16BE(offset + 7), height: body.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
  }
  return undefined;
}

export function formatFromContentType(value: string | undefined): ImageFormat | undefined {
  const type = (value ?? '').split(';')[0]!.trim().toLowerCase();
  const map: Record<string, ImageFormat> = {
    'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/pjpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
    'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/heic': 'heic', 'image/heif': 'heic', 'image/jxl': 'jxl', 'image/tiff': 'tiff',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  };
  return map[type];
}

export function formatFromExtension(url: string): ImageFormat | undefined {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  const extension = /\.([a-z0-9]+)$/u.exec(path)?.[1];
  const map: Record<string, ImageFormat> = {
    jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', avif: 'avif', bmp: 'bmp', svg: 'svg', heic: 'heic', heif: 'heic',
    jxl: 'jxl', tif: 'tiff', tiff: 'tiff', ico: 'ico',
  };
  return extension === undefined ? undefined : map[extension];
}
