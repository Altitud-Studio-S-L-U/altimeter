import zlib from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

const cache = new Map<string, Buffer>();

/** A decodable single-colour PNG of the given size, so images render and their headers carry real dimensions. */
export function png(width: number, height: number, rgb: readonly [number, number, number] = [32, 96, 160]): Buffer {
  const key = `${width}x${height}:${rgb.join(',')}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  cache.set(key, image);
  return image;
}

/** A small SVG wordmark, the kind of logo Organization markup often points to. */
export function logoSvg(name: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 64" width="240" height="64" role="img" aria-label="${name}">`
    + `<rect width="64" height="64" rx="12" fill="#205fa0"/><text x="78" y="41" font-family="sans-serif" font-size="22" fill="#14213d">${name}</text></svg>`;
}
