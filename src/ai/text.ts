import { cleanText } from '../report/sanitize.ts';

/**
 * Text comparison for model quotes and proposals. Models and sites write the same text with different
 * typography, so both sides are normalised the same way before comparing: NFC, curly quotes to straight ones,
 * dashes to '-', every kind of space to a plain space, the ellipsis character to '...', and the Catalan
 * geminate l·l, which sites write with U+00B7, U+2027 or a full stop, to one form.
 */

const singleQuotes = [0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x02bc, 0x00b4, 0x2039, 0x203a, 0xff07];
const doubleQuotes = [0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb, 0xff02];
const dashes = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xfe58, 0xfe63, 0xff0d];
const spaces = [0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000];
const softHyphen = 0x00ad;
const ellipsis = 0x2026;

export const middleDot = String.fromCodePoint(0x00b7);
const geminateDots = new Set([middleDot, String.fromCodePoint(0x2027), '.']);

const replacements = new Map<number, string>([
  ...singleQuotes.map(point => [point, "'"] as const),
  ...doubleQuotes.map(point => [point, '"'] as const),
  ...dashes.map(point => [point, '-'] as const),
  ...spaces.map(point => [point, ' '] as const),
  [softHyphen, ''],
  [ellipsis, '...'],
]);

function catalanGeminates(text: string): string {
  const characters = [...text];
  for (let index = 1; index < characters.length - 1; index += 1) {
    if (geminateDots.has(characters[index]!) && /^[lL]$/u.test(characters[index - 1]!) && /^[lL]$/u.test(characters[index + 1]!)) characters[index] = middleDot;
  }
  return characters.join('');
}

/** Normalises text for comparison; case is kept, because a claim can be about capitalisation. */
export function normalizeText(text: string): string {
  const cleaned = cleanText(text, Number.MAX_SAFE_INTEGER).normalize('NFC');
  let mapped = '';
  for (const character of cleaned) mapped += replacements.get(character.codePointAt(0)!) ?? character;
  return catalanGeminates(mapped).replace(/\s+/gu, ' ').trim();
}

/** Normalised, without diacritics and lower case: for facts, brands and duplicates, where case carries no claim. */
export function fold(text: string): string {
  return normalizeText(text).normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

export function wordCount(text: string): number {
  return text.split(' ').filter(word => /[\p{L}\p{N}]/u.test(word)).length;
}

const ellipsisMarker = /\s*(?:\[\.{3}\]|\(\.{3}\)|\.{3,})\s*/u;

/** A quote split at its ellipses into the passages that must appear, in order, in the cited evidence. */
export function quoteSegments(quote: string): string[] {
  return normalizeText(quote).split(ellipsisMarker).map(segment => segment.trim()).filter(segment => segment !== '');
}

export type QuoteCheck = 'ok' | 'quote-too-short' | 'quote-not-found';

const longEnough = (text: string, words: number, characters: number) => wordCount(text) >= words || [...text].length >= characters;

/**
 * Whether a quote appears in a source text. The whole quote needs at least 3 words or 15 characters, and each
 * passage between ellipses at least 2 words or 8 characters, so a few common words cannot match by chance.
 */
export function checkQuote(quote: string, source: string): QuoteCheck {
  const segments = quoteSegments(quote);
  if (segments.length === 0 || !longEnough(segments.join(' '), 3, 15) || segments.some(segment => !longEnough(segment, 2, 8))) return 'quote-too-short';
  const haystack = normalizeText(source);
  let position = 0;
  for (const segment of segments) {
    const index = haystack.indexOf(segment, position);
    if (index === -1) return 'quote-not-found';
    position = index + segment.length;
  }
  return 'ok';
}

const phonePattern = /(?:\+|00)?\d[\d ()./-]{6,}\d/gu;
const numberPattern = /\d+(?:[.,]\d+)*/gu;
const emailPattern = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
export const urlPattern = /https?:\/\/[^\s"'<>()]+/gu;

/** Superlatives and comparative claims in English, Spanish and Catalan, folded (no accents, lower case). */
const superlatives = [
  'best', 'top', 'leading', 'number one', '#1', 'no. 1', 'cheapest', 'largest', 'biggest', 'fastest', 'greatest', 'finest',
  'unbeatable', 'ultimate', 'award-winning', 'award winning', 'world-class', 'world class', 'only', 'unique',
  'mejor', 'mejores', 'lider', 'lideres', 'numero uno', 'numero 1', 'mas barato', 'mas barata', 'inmejorable', 'insuperable', 'unico', 'unica',
  'millor', 'millors', 'numero u', 'mes barat', 'mes barata', 'imbatible', 'unic',
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const superlativePatterns = superlatives.map(term => ({ term, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}])`, 'u') }));

function canonicalNumber(token: string): string {
  const plain = /^\d{1,3}(?:[.,]\d{3})+$/u.test(token) ? token.replace(/[.,]/gu, '') : token.replace(',', '.');
  // 09 and 9, or 4.80 and 4.8, are the same fact.
  return /^\d+(?:\.\d+)?$/u.test(plain) && plain.length <= 15 ? String(Number(plain)) : plain;
}

/** ISO dates and times count by their year, which is what a page usually shows in some other format. */
const isoDateTime = /\b(\d{4})-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gu;

const digits = (text: string) => text.replace(/\D/gu, '');

/** Facts a corpus must contain for a proposal to repeat them: numbers, years, ratings, phones, emails and superlatives. */
export interface FactIndex {
  readonly text: string;
  readonly numbers: ReadonlySet<string>;
  readonly phones: readonly string[];
}

export function factIndex(corpus: string): FactIndex {
  const text = fold(corpus);
  return {
    text,
    numbers: new Set([...text.matchAll(numberPattern)].map(match => canonicalNumber(match[0]))),
    phones: [...text.matchAll(phonePattern)].map(match => digits(match[0])).filter(entry => entry.length >= 7),
  };
}

/** The facts in `text` that the index does not contain, as they were written. */
export function unsupportedFacts(text: string, index: FactIndex): string[] {
  const folded = fold(text.replace(urlPattern, ' ')).replace(isoDateTime, '$1');
  const missing: string[] = [];
  let rest = folded;
  for (const match of folded.matchAll(phonePattern)) {
    const number = digits(match[0]);
    if (number.length < 7) continue;
    rest = rest.replace(match[0], ' ');
    const known = index.phones.some(phone => phone === number || (phone.endsWith(number) || number.endsWith(phone)) && Math.min(phone.length, number.length) >= 7);
    if (!known) missing.push(match[0]);
  }
  for (const match of rest.matchAll(emailPattern)) if (!index.text.includes(match[0])) missing.push(match[0]);
  const withoutEmails = rest.replace(emailPattern, ' ');
  for (const match of withoutEmails.matchAll(numberPattern)) if (!index.numbers.has(canonicalNumber(match[0]))) missing.push(match[0]);
  for (const { term, pattern } of superlativePatterns) if (pattern.test(withoutEmails) && !pattern.test(index.text)) missing.push(term);
  return [...new Set(missing)];
}

/** Display text from the model or the site: control, bidirectional and zero-width characters removed, one line, bounded. */
export function cleanDisplay(text: string, maxLength: number): string {
  return cleanText(text, Number.MAX_SAFE_INTEGER).replace(/\s+/gu, ' ').trim().slice(0, maxLength);
}
