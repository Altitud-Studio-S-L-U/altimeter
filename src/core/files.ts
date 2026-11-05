import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';

export type FileProblem = 'missing' | 'not-regular' | 'too-large';

/**
 * Reads a regular file of at most `maxBytes`, never through a symbolic link. The file is opened first and its handle
 * compared with the path, so it cannot be swapped for another one between the check and the read.
 */
export async function readRegularFile(path: string, maxBytes: number): Promise<{ readonly text: string } | { readonly problem: FileProblem }> {
  let handle: FileHandle;
  try {
    // O_NOFOLLOW does not exist on Windows; the comparison with lstat below covers links there.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return { problem: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'not-regular' };
  }
  try {
    const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || named.isSymbolicLink() || opened.ino !== named.ino || opened.dev !== named.dev) return { problem: 'not-regular' };
    if (opened.size > maxBytes) return { problem: 'too-large' };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return { problem: 'too-large' };
    }
    return { text: Buffer.concat(chunks).toString('utf8') };
  } finally {
    await handle.close();
  }
}
