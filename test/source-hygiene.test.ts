import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : files(join(directory, entry.name));
    return /\.(ts|mjs|json|md|yml)$/u.test(entry.name) ? [join(directory, entry.name)] : [];
  });
}

/** Characters that render as nothing, look like a plain space or reorder text, which can hide what source code does. */
function invisible(codePoint: number): boolean {
  return (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    || (codePoint !== 0x20 && /\p{Zs}/u.test(String.fromCodePoint(codePoint)))
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || (codePoint >= 0x300 && codePoint <= 0x36f)
    || codePoint === 0x61c || codePoint === 0xa0
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || codePoint === 0x2028 || codePoint === 0x2029
    || (codePoint >= 0x2060 && codePoint <= 0x2064)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
    || codePoint === 0xfeff;
}

test('sources contain no invisible, control or bidirectional characters (write them as escapes)', () => {
  const problems: string[] = [];
  for (const directory of ['src', 'test', 'scripts', 'docs', '.github']) {
    let list: string[];
    try {
      list = files(join(root, directory));
    } catch {
      continue;
    }
    for (const file of list) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const character of line) {
          const codePoint = character.codePointAt(0)!;
          if (invisible(codePoint)) problems.push(`${relative(root, file)}:${index + 1} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
        }
      });
    }
  }
  assert.deepEqual(problems, []);
});
