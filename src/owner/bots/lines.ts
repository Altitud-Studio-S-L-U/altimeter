import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** Longest line kept; longer lines are skipped whole, so one corrupt line cannot exhaust memory. */
export const maxLineBytes = 1024 * 1024;

export type LineEvent = { readonly line: string } | { readonly tooLong: true } | { readonly error: string };

async function isGzip(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(2);
    const { bytesRead } = await handle.read(head, 0, 2, 0);
    return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

/**
 * Splits a byte stream into lines without holding more than one line in memory. A line longer than `limit` bytes is
 * reported once as too long and dropped; a stream error (for example a gzip file still being written) ends the lines
 * with an error event instead of throwing.
 */
export async function* splitLines(stream: Readable, limit = maxLineBytes): AsyncGenerator<LineEvent> {
  let parts: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const flush = (): LineEvent | undefined => {
    if (overflow) {
      overflow = false;
      parts = [];
      size = 0;
      return { tooLong: true };
    }
    const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    parts = [];
    size = 0;
    const text = bytes.toString('utf8');
    return { line: text.endsWith('\r') ? text.slice(0, -1) : text };
  };
  try {
    for await (const chunk of stream) {
      let buffer = chunk as Buffer;
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        const piece = newline === -1 ? buffer : buffer.subarray(0, newline);
        if (!overflow) {
          if (size + piece.length > limit) {
            overflow = true;
            parts = [];
            size = 0;
          } else if (piece.length > 0) {
            parts.push(Buffer.from(piece));
            size += piece.length;
          }
        }
        if (newline === -1) break;
        yield flush()!;
        buffer = buffer.subarray(newline + 1);
      }
    }
  } catch (error) {
    if (size > 0 || overflow) yield flush()!;
    yield { error: error instanceof Error ? error.message : 'read failed' };
    return;
  }
  if (size > 0 || overflow) yield flush()!;
}

/** Lines of a log file, decompressing gzip (recognised by its magic bytes, not by the file name). */
export async function* readLogLines(path: string, limit = maxLineBytes): AsyncGenerator<LineEvent> {
  const gzip = await isGzip(path);
  const file = createReadStream(path, { highWaterMark: 64 * 1024 });
  const stream: Readable = gzip ? file.pipe(createGunzip()) : file;
  if (gzip) file.on('error', error => stream.destroy(error));
  try {
    yield* splitLines(stream, limit);
  } finally {
    stream.destroy();
    file.destroy();
  }
}
