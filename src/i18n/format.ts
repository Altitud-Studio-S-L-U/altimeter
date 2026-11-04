import type { Language } from './messages.ts';

export type TemplateParams = Readonly<Record<string, string | number>>;

/**
 * How `{name, number, <style>}` writes a number: `percent` takes a fraction (0.2 is 20 %), and an ICU skeleton
 * after `::` combines the stem `percent` with a precision such as `.0` (exactly one decimal) or `.##` (up to two).
 */
interface NumberStyle {
  readonly percent: boolean;
  readonly minimumFractionDigits?: number;
  readonly maximumFractionDigits?: number;
  /** The style as the template writes it, normalized, so a translation can be compared with English. */
  readonly key: string;
}

type Argument =
  | { readonly kind: 'value'; readonly name: string; readonly style?: NumberStyle; readonly source: string }
  | { readonly kind: 'plural'; readonly name: string; readonly branches: ReadonlyMap<string, readonly Piece[]>; readonly source: string };

type Piece = string | Argument | { readonly kind: 'count' };

interface Parsed {
  readonly pieces: readonly Piece[];
  readonly problems: readonly string[];
}

const pluralCategories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
/** Plural arguments inside the branches of others; the catalogs nest at most two. */
const maxNesting = 8;
const isLetter = (character: string | undefined) => character !== undefined && /^[a-zA-Z]$/u.test(character);
const isDigit = (character: string | undefined) => character !== undefined && /^[0-9]$/u.test(character);
const isSpace = (character: string | undefined) => character !== undefined && /^\s$/u.test(character);

function numberStyle(text: string): NumberStyle | undefined {
  if (text === 'percent') return { percent: true, key: 'percent' };
  if (!text.startsWith('::')) return undefined;
  let percent = false;
  let precision: { readonly min: number; readonly max: number; readonly stem: string } | undefined;
  for (const stem of text.slice(2).trim().split(/\s+/u)) {
    const digits = /^\.(0*)(#*)$/u.exec(stem);
    if (stem === 'percent' && !percent) percent = true;
    else if (digits && stem.length > 1 && !precision) precision = { min: digits[1]!.length, max: digits[1]!.length + digits[2]!.length, stem };
    else return undefined;
  }
  return {
    percent,
    ...(precision ? { minimumFractionDigits: precision.min, maximumFractionDigits: precision.max } : {}),
    key: [percent ? 'percent' : '', precision?.stem ?? ''].filter(Boolean).join(' '),
  };
}

/**
 * Reads a template: `{name}` for a value, `{name, number, <style>}` for a formatted number and
 * `{name, plural, one {...} other {...}}` for a count, whose branches hold text, values and `#`, the count itself.
 * `other` is required, `=0` style branches match a count exactly, and any other brace is plain text. A malformed
 * argument stays as text and is listed as a problem. A library caller can pass any text as a template, so the parser
 * uses no regular expression that backtracks, reads each brace once and stops reading plural arguments nested deeper
 * than maxNesting.
 */
class Parser {
  readonly text: string;
  index = 0;
  readonly problems: string[] = [];
  /** Each brace read as an argument, by its index, so that no brace is read twice whatever encloses it. */
  readonly read = new Map<number, { readonly argument: Argument | undefined; readonly end: number }>();
  depth = 0;

  constructor(text: string) {
    this.text = text;
  }

  pieces(inBranch: boolean): Piece[] {
    const pieces: Piece[] = [];
    let text = '';
    const flush = () => {
      if (text !== '') pieces.push(text);
      text = '';
    };
    while (this.index < this.text.length) {
      const character = this.text[this.index]!;
      if (inBranch && character === '}') break;
      if (inBranch && character === '#') {
        flush();
        pieces.push({ kind: 'count' });
        this.index += 1;
        continue;
      }
      const argument = character === '{' ? this.argumentAt() : undefined;
      if (argument) {
        flush();
        pieces.push(argument);
        continue;
      }
      text += character;
      this.index += 1;
    }
    flush();
    return pieces;
  }

  /** The index of the first character at or after `index` that is not white space. */
  skipSpace(index: number): number {
    let next = index;
    while (isSpace(this.text[next])) next += 1;
    return next;
  }

  /** The word at `index`: a letter followed by letters, and by digits too when `digits` is set. */
  word(index: number, digits: boolean): string | undefined {
    if (!isLetter(this.text[index])) return undefined;
    let end = index + 1;
    while (isLetter(this.text[end]) || (digits && isDigit(this.text[end]))) end += 1;
    return this.text.slice(index, end);
  }

  /** A plural branch selector at `index`, `=N` or a plural category, and the index after its opening brace. */
  selector(index: number): { readonly key: string; readonly end: number } | undefined {
    let end = index;
    if (this.text[index] === '=') {
      end += 1;
      while (isDigit(this.text[end])) end += 1;
      if (end === index + 1) return undefined;
    } else {
      const category = this.word(index, false);
      if (category === undefined || !pluralCategories.has(category)) return undefined;
      end += category.length;
    }
    const open = this.skipSpace(end);
    return this.text[open] === '{' ? { key: this.text.slice(index, end), end: open + 1 } : undefined;
  }

  /** The argument whose brace is at the current index, read once: a malformed one stays text everywhere it is reached. */
  argumentAt(): Argument | undefined {
    const start = this.index;
    const known = this.read.get(start);
    if (known) {
      if (known.argument) this.index = known.end;
      return known.argument;
    }
    const argument = this.argument();
    this.read.set(start, { argument, end: this.index });
    return argument;
  }

  argument(): Argument | undefined {
    const start = this.index;
    const name = this.word(start + 1, true);
    if (name === undefined) return undefined;
    let index = start + 1 + name.length;
    if (this.text[index] === '}') {
      this.index = index + 1;
      return { kind: 'value', name, source: this.text.slice(start, this.index) };
    }
    index = this.skipSpace(index);
    if (this.text[index] !== ',') return undefined;
    index = this.skipSpace(index + 1);
    const type = this.word(index, false);
    if (type === undefined) return undefined;
    index = this.skipSpace(index + type.length);
    const after = this.text[index];
    if (after !== ',' && after !== '}') return undefined;
    index += 1;
    if (type === 'number') {
      if (after === '}') {
        this.index = index;
        return { kind: 'value', name, source: this.text.slice(start, index) };
      }
      let close = index;
      while (close < this.text.length && this.text[close] !== '{' && this.text[close] !== '}') close += 1;
      const style = this.text[close] === '}' ? numberStyle(this.text.slice(index, close).trim()) : undefined;
      if (!style) return this.malformed(start, `{${name}, number, ...} has an unknown style`);
      this.index = close + 1;
      return { kind: 'value', name, style, source: this.text.slice(start, this.index) };
    }
    if (type !== 'plural') return this.malformed(start, `{${name}, ${type}} is not a known argument type`);
    if (after !== ',') return this.malformed(start, `{${name}, plural} has no branches`);
    if (this.depth >= maxNesting) return this.malformed(start, `{${name}, plural, ...} is nested more than ${maxNesting} deep`);
    this.index = index;
    const branches = new Map<string, readonly Piece[]>();
    for (;;) {
      const next = this.skipSpace(this.index);
      if (this.text[next] === '}') {
        this.index = next + 1;
        break;
      }
      const selector = this.selector(next);
      if (!selector) return this.malformed(start, `{${name}, plural, ...} has a malformed branch`);
      this.index = selector.end;
      this.depth += 1;
      const branch = this.pieces(true);
      this.depth -= 1;
      if (this.text[this.index] !== '}') return this.malformed(start, `{${name}, plural, ...} has an unclosed branch`);
      this.index += 1;
      if (branches.has(selector.key)) return this.malformed(start, `{${name}, plural, ...} repeats its ${selector.key} branch`);
      branches.set(selector.key, branch);
    }
    if (!branches.has('other')) return this.malformed(start, `{${name}, plural, ...} has no other branch`);
    return { kind: 'plural', name, branches, source: this.text.slice(start, this.index) };
  }

  malformed(start: number, problem: string): undefined {
    this.problems.push(problem);
    this.index = start;
    return undefined;
  }
}

const parsedTemplates = new Map<string, Parsed>();

function parse(template: string): Parsed {
  let parsed = parsedTemplates.get(template);
  if (!parsed) {
    const parser = new Parser(template);
    parsed = { pieces: parser.pieces(false), problems: parser.problems };
    if (parsedTemplates.size >= 5000) parsedTemplates.clear();
    parsedTemplates.set(template, parsed);
  }
  return parsed;
}

function* argumentsOf(pieces: readonly Piece[]): Generator<Argument> {
  for (const piece of pieces) {
    if (typeof piece === 'string' || piece.kind === 'count') continue;
    yield piece;
    if (piece.kind === 'plural') for (const branch of piece.branches.values()) yield* argumentsOf(branch);
  }
}

/** The names of the values a template fills in, sorted, each once. */
export function placeholders(template: string): string[] {
  return [...new Set([...argumentsOf(parse(template).pieces)].map(piece => piece.name))].sort();
}

/**
 * What a template does with its values: each name, with its style when it is a formatted number. A translation gives
 * the same list as the English template, so every value reaches the reader written the same way; whether a count
 * also picks a plural form is up to each language.
 */
export function argumentSignature(template: string): string[] {
  return [...new Set([...argumentsOf(parse(template).pieces)].map(piece => (piece.kind === 'value' && piece.style ? `${piece.name}:${piece.style.key}` : piece.name)))].sort();
}

/** Syntax problems of a template, and plural branches for forms that `language` does not have. */
export function templateProblems(template: string, language?: Language): string[] {
  const parsed = parse(template);
  const problems = [...parsed.problems];
  if (language === undefined) return problems;
  const forms = new Set<string>(pluralRules(language).resolvedOptions().pluralCategories);
  for (const piece of argumentsOf(parsed.pieces)) {
    if (piece.kind !== 'plural') continue;
    for (const selector of piece.branches.keys()) {
      if (pluralCategories.has(selector) && !forms.has(selector)) problems.push(`{${piece.name}, plural, ...} has a ${selector} branch, which ${language} does not use`);
    }
  }
  return problems;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRulesByLanguage = new Map<Language, Intl.PluralRules>();

function pluralRules(language: Language): Intl.PluralRules {
  let rules = pluralRulesByLanguage.get(language);
  if (!rules) {
    rules = new Intl.PluralRules(language);
    pluralRulesByLanguage.set(language, rules);
  }
  return rules;
}

function numberWith(value: number, language: Language, style: NumberStyle | undefined): string {
  const key = `${language} ${style?.key ?? ''}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(language, {
      useGrouping: 'min2',
      ...(style?.percent ? { style: 'percent' } : {}),
      ...(style?.minimumFractionDigits === undefined ? {} : { minimumFractionDigits: style.minimumFractionDigits }),
      ...(style?.maximumFractionDigits === undefined ? {} : { maximumFractionDigits: style.maximumFractionDigits }),
    });
    numberFormats.set(key, formatter);
  }
  return formatter.format(value);
}

/**
 * A number as `language` writes it, in a style of `{name, number, <style>}` such as `percent` or `::.0`. Four-digit
 * numbers take no group separator in any language, and Spanish and Catalan write a decimal comma and a non-breaking
 * space before the percent sign, as Intl.NumberFormat does.
 */
export function formatNumber(value: number, language: Language = 'en', style?: string): string {
  const parsed = style === undefined ? undefined : numberStyle(style);
  if (style !== undefined && !parsed) throw new Error(`Unknown number style ${style}`);
  return numberWith(value, language, parsed);
}

/** A count given as a number or as the digits code wrote into a value; NaN for anything else. */
function countOf(value: string | number): number {
  if (typeof value === 'number') return value;
  return /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : Number.NaN;
}

interface Count {
  readonly value: string | number;
  readonly number: number;
}

function render(pieces: readonly Piece[], params: TemplateParams, language: Language, count: Count | undefined): string {
  let text = '';
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      text += piece;
    } else if (piece.kind === 'count') {
      text += count === undefined ? '#' : Number.isNaN(count.number) ? String(count.value) : numberWith(count.number, language, undefined);
    } else {
      const value = params[piece.name];
      if (value === undefined) {
        text += piece.source;
      } else if (piece.kind === 'value') {
        text += typeof value === 'number' ? numberWith(value, language, piece.style) : value;
      } else {
        const number = countOf(value);
        const form = Number.isNaN(number) ? 'other' : pluralRules(language).select(number);
        const branch = piece.branches.get(`=${number}`) ?? piece.branches.get(form) ?? piece.branches.get('other')!;
        text += render(branch, params, language, { value, number });
      }
    }
  }
  return text;
}

/**
 * Fills a template in `language`: numbers are written as that language writes them, and a plural argument takes the
 * branch for its count. Values are inserted as plain text; escaping for HTML or Markdown is the renderer's job.
 * A missing value leaves its argument visible rather than inventing text.
 */
export function format(template: string, params: TemplateParams = {}, language: Language = 'en'): string {
  return render(parse(template).pieces, params, language, undefined);
}
