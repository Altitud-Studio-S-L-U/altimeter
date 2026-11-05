import { myths } from '../catalog/index.ts';
import type { Myth } from '../core/types.ts';

/**
 * Words that, shortly before a pattern in the same clause, turn it into a refutation ("do not add rel=next",
 * "there is no need to add a SearchAction"). Contractions split into two words, so "don't" yields "don" and "t".
 */
const negations = new Set([
  'not', 'never', 'no', 'nor', 'neither', 'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'shouldn', 'wouldn',
  'won', 'needn', 'cannot', 't', 'instead', 'rather', 'unnecessary', 'myth',
]);

/** How many words before a pattern are searched for a negation. */
const negationWindow = 4;

/** Sentence and clause breaks: terminal punctuation or a comma followed by a space, line breaks, dashes and parentheses. */
const clauseBreak = /[.!?;,]+(?=\s|$)|[\r\n]+|\s[-\u2013\u2014]+\s|[()[\]]/u;

function words(text: string): string[] {
  return text.normalize('NFKC').toLowerCase()
    .replace(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/gu, ' ')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Reduces text to lowercase words separated by single spaces, so that case, punctuation, quotes and line breaks do
 * not change a match: `Add rel="next"` and `add  rel=next` both become `add rel next`, and `15MB` becomes `15 mb`.
 */
export function normalizeMythText(text: string): string {
  return words(text).join(' ');
}

function clauses(text: string): string[][] {
  return text.split(clauseBreak).map(words).filter(clause => clause.length > 0);
}

function affirmedIn(clause: readonly string[], phrase: readonly string[]): boolean {
  for (let start = 0; start + phrase.length <= clause.length; start++) {
    if (!phrase.every((word, offset) => clause[start + offset] === word)) continue;
    if (!clause.slice(Math.max(0, start - negationWindow), start).some(word => negations.has(word))) return true;
  }
  return false;
}

function affirmed(parts: readonly string[][], phrase: readonly string[]): boolean {
  return phrase.length > 0 && parts.some(clause => affirmedIn(clause, phrase));
}

const compiled = myths.map(myth => ({ myth, phrases: myth.patterns.map(words) }));

/** Returns the patterns of `myth` that `text` repeats, for explaining a match. */
export function matchedPatterns(text: string, myth: Myth): string[] {
  const parts = clauses(text);
  return myth.patterns.filter(pattern => affirmed(parts, words(pattern)));
}

/**
 * Returns the catalog myths that `text` repeats, in catalog order.
 *
 * Matching is by phrase: a pattern matches when its words appear contiguously in one clause of the text, ignoring case,
 * whitespace and punctuation. Patterns are affirmative or imperative phrases that restate the myth ("target keyword
 * density", "add rel=next"), so text that only names the topic does not match. An occurrence preceded within a few
 * words by a negation in the same clause ("do not add rel=next", "there is no need to add a SearchAction") is a
 * refutation and does not count.
 *
 * The analyst output validation runs every note and proposal the model returns through this function before the
 * claim is accepted. A claim whose text matches a myth is dropped, never rephrased, and the report lists it among the
 * dropped claims with the reason `myth`.
 */
export function mythMatches(text: string): Myth[] {
  const parts = clauses(text);
  if (parts.length === 0) return [];
  return compiled.filter(entry => entry.phrases.some(phrase => affirmed(parts, phrase))).map(entry => entry.myth);
}
