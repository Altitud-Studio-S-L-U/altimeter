import { fold } from '../ai/text.ts';
import { brandPattern } from '../owner/gsc-analyses.ts';
import { cleanLine } from '../report/sanitize.ts';
import { withoutUrls } from './urls.ts';

/**
 * Brand mentions are found by string matching, never by asking a model: an answer mentions the brand when one of
 * the site's own names appears in it as whole words, ignoring case, accents and punctuation between the words.
 */

function words(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter(word => word !== '');
}

/**
 * Folded forms that count as a mention: each declared name with its words apart and joined, and the first label
 * of the host. A name made only of generic or short words, such as "Studio" or "AB", is not distinctive enough to
 * count; the same test decides which Search Console queries name the brand.
 */
export function brandAliases(names: readonly string[], hostLabel: string): string[] {
  const aliases = new Set<string>();
  for (const name of [...names, hostLabel]) {
    const parts = words(name);
    if (parts.length === 0 || brandPattern([name]) === undefined) continue;
    aliases.add(parts.join(' '));
    if (parts.length > 1) aliases.add(parts.join(''));
  }
  return [...aliases];
}

// A line that opens the closing list of sources, in the languages the reports support.
const sourcesHeading = /^[\s#*_>-]*(?:sources?|fuentes|fonts|referencias|refer[eè]ncies|references)\b/iu;

/** The answer without its closing list of sources, whose link titles repeat page names rather than mention them. */
export function answerBody(answer: string): string {
  const lines = answer.split('\n');
  for (let index = lines.length - 1; index > 0; index -= 1) {
    if (sourcesHeading.test(lines[index]!)) return lines.slice(0, index).join('\n');
  }
  return answer;
}

/** The sentence of the answer that first mentions the brand, cleaned and cut at 200 characters, or undefined. */
export function findMention(answer: string, aliases: readonly string[]): string | undefined {
  if (aliases.length === 0) return undefined;
  const body = withoutUrls(answerBody(answer));
  for (const sentence of body.split(/\n+|(?<=[.!?])\s+/u)) {
    const padded = ` ${words(sentence).join(' ')} `;
    if (aliases.some(alias => padded.includes(` ${alias} `))) return cleanLine(sentence, 200);
  }
  return undefined;
}
