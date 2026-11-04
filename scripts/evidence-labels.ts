import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholders } from '../src/i18n/format.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogPath = join(root, 'src', 'i18n', 'en', 'evidence.json');

/** One `evidenceLabel(...)` call: its template and, when the call spells them out, the names of the values it passes. */
export interface LabelUse {
  readonly template: string;
  readonly file: string;
  readonly line: number;
  readonly params?: readonly string[];
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

/** The end of the string literal that starts at `start`, and its value, or undefined when it holds `${`. */
function stringLiteral(text: string, start: number): { end: number; value: string } | undefined {
  const quote = text[start]!;
  let value = '';
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '\\') {
      const next = text[index + 1] ?? '';
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      index += 1;
    } else if (character === quote) {
      return { end: index + 1, value };
    } else if (quote === '`' && character === '$' && text[index + 1] === '{') {
      return undefined;
    } else {
      value += character;
    }
  }
  return undefined;
}

/** Skips a comment, string or template literal at `index`, returning the index after it, or `index` when none starts there. */
function skip(text: string, index: number): number {
  if (text.startsWith('//', index)) {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }
  if (text.startsWith('/*', index)) {
    const end = text.indexOf('*/', index + 2);
    return end < 0 ? text.length : end + 2;
  }
  const quote = text[index];
  if (quote !== '\'' && quote !== '"' && quote !== '`') return index;
  for (let cursor = index + 1; cursor < text.length; cursor += 1) {
    if (text[cursor] === '\\') cursor += 1;
    else if (text[cursor] === quote) return cursor + 1;
    else if (quote === '`' && text[cursor] === '$' && text[cursor + 1] === '{') cursor = balanced(text, cursor + 1) - 1;
  }
  return text.length;
}

/** The index after the bracket that closes the one at `open`, skipping strings and comments. */
function balanced(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length;) {
    const after = skip(text, index);
    if (after !== index) {
      index = after;
      continue;
    }
    const character = text[index]!;
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/** Top-level keys of an object literal, or undefined when a spread or computed key hides them. */
function objectKeys(text: string, open: number, close: number): string[] | undefined {
  const keys: string[] = [];
  let index = open + 1;
  while (index < close - 1) {
    while (/[\s,]/u.test(text[index] ?? '')) index += 1;
    if (index >= close - 1) break;
    if (text.startsWith('...', index) || text[index] === '[') return undefined;
    const key = /^(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))/u.exec(text.slice(index));
    if (!key) return undefined;
    keys.push(key[1] ?? key[2] ?? key[3]!);
    index += key[0].length;
    while (/\s/u.test(text[index] ?? '')) index += 1;
    if (text[index] !== ':') continue;
    index += 1;
    // Skip the value up to the next comma at this depth.
    while (index < close - 1 && text[index] !== ',') {
      const after = skip(text, index);
      if (after !== index) index = after;
      else if ('([{'.includes(text[index]!)) index = balanced(text, index);
      else index += 1;
    }
  }
  return keys;
}

const call = /\bevidenceLabel\s*\(/gu;

/** Every evidence label template in `src`, with the problems a reader of the catalog would hit. */
export async function sourceLabels(): Promise<{ uses: LabelUse[]; problems: string[] }> {
  const uses: LabelUse[] = [];
  const problems: string[] = [];
  for (const path of (await sourceFiles(join(root, 'src'))).sort()) {
    const text = await readFile(path, 'utf8');
    const file = relative(root, path).replace(/\\/gu, '/');
    // Comments and literals are blanked out first, so a call named in them is not read as a label.
    let code = '';
    for (let index = 0; index < text.length;) {
      const after = skip(text, index);
      if (after === index) {
        code += text[index];
        index += 1;
      } else {
        // One space per code unit, so the blanked text keeps the offsets of the source.
        code += text.slice(index, after).replace(/[^\n]/gu, character => ('\'"`'.includes(character) ? character : ' '.repeat(character.length)));
        index = after;
      }
    }
    for (const match of code.matchAll(call)) {
      const before = code.slice(Math.max(0, match.index - 10), match.index);
      if (/(?:function|\.)\s*$/u.test(before)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      let index = match.index + match[0].length;
      while (/\s/u.test(text[index] ?? '')) index += 1;
      const literal = '\'"`'.includes(text[index] ?? '') ? stringLiteral(text, index) : undefined;
      if (!literal) {
        problems.push(`${file}:${line}: the template of evidenceLabel must be a string literal`);
        continue;
      }
      index = literal.end;
      while (/\s/u.test(text[index] ?? '')) index += 1;
      let params: string[] | undefined = [];
      if (text[index] === ',') {
        index += 1;
        while (/\s/u.test(text[index] ?? '')) index += 1;
        params = text[index] === '{' ? objectKeys(text, index, balanced(text, index)) : undefined;
      }
      uses.push({ template: literal.value, file, line, ...(params ? { params } : {}) });
      if (literal.value.trim() !== literal.value || literal.value === '') problems.push(`${file}:${line}: "${literal.value}" is empty or has surrounding whitespace`);
      if (params) {
        const wanted = [...new Set(placeholders(literal.value))].sort();
        if (JSON.stringify(wanted) !== JSON.stringify([...new Set(params)].sort())) {
          problems.push(`${file}:${line}: "${literal.value}" takes {${wanted.join('}, {')}} but is given ${params.join(', ') || 'no values'}`);
        }
      }
    }
  }
  return { uses, problems };
}

/** The English catalog: every template once, sorted, each standing for itself. */
export async function renderEnglishLabels(): Promise<string> {
  const { uses } = await sourceLabels();
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const templates = [...new Set(uses.map(use => use.template))].sort((a, b) => order(a.toLowerCase(), b.toLowerCase()) || order(a, b));
  return `${JSON.stringify(Object.fromEntries(templates.map(template => [template, template])), null, 2)}\n`;
}

export async function englishLabelsInSync(): Promise<boolean> {
  try {
    return (await readFile(catalogPath, 'utf8')) === await renderEnglishLabels();
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { problems } = await sourceLabels();
  if (problems.length > 0) throw new Error(`Fix these evidence labels first:\n${problems.join('\n')}`);
  await writeFile(catalogPath, await renderEnglishLabels(), 'utf8');
}
