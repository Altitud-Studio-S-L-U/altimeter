import { languageNames } from '../analyze/language.ts';
import caValues from './ca/values.json' with { type: 'json' };
import enValues from './en/values.json' with { type: 'json' };
import esValues from './es/values.json' with { type: 'json' };
import { format } from './format.ts';
import type { Language } from './messages.ts';
import { ui } from './ui.ts';

/**
 * English words and phrases that code writes into the values of messages and evidence labels, by parameter name,
 * with their translations. A key with `{name}` parts is a pattern: each part is translated in turn as a value of
 * the parameter it names. A section named `<rule-id>/<parameter>` applies to that rule before `<parameter>` does.
 * Values that are data (URLs, numbers, text from the site, ids) never have an entry.
 */
export type ValueCatalog = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const valueCatalogs: Readonly<Record<Language, ValueCatalog>> = { en: enValues, es: esValues, ca: caValues };

/**
 * Parameters that can hold a list from summarizeList, whose "and N more" ending is translated: a name, or
 * `<rule-id>/<name>` where other rules use the name for a single value. test/i18n-values.test.ts keeps it complete.
 */
export const listParams: ReadonlySet<string> = new Set([
  'agents', 'assistants', 'canonicalLanguage', 'canonicals', 'causes', 'crawlers', 'declared', 'declaredBy', 'examples', 'fields', 'files', 'fonts',
  'hosts', 'hrefs', 'items', 'kinds', 'language', 'languages', 'lines', 'missing', 'names', 'networks', 'operators', 'origins', 'pages', 'pairs',
  'problems', 'reasons', 'regions', 'replacement', 'requests', 'resources', 'routes', 'schemes', 'scripts', 'sitemaps', 'sources', 'tags',
  'targets', 'tokens', 'urls', 'values', 'where',
  'crawl-canonical-chains/path', 'intl-hreflang-target-not-200/status', 'intl-og-locale/value',
]);

/** Parameters that hold English language names from src/analyze/language.ts, translated with Intl.DisplayNames. */
export const languageParams: ReadonlySet<string> = new Set([
  'canonicalLanguage', 'declared', 'detected', 'expected', 'language', 'languages', 'other', 'primary', 'secondary',
]);

type Params = Readonly<Record<string, string | number>>;

interface Pattern {
  readonly key: string;
  readonly literals: readonly string[];
  readonly names: readonly string[];
  readonly regex: RegExp;
}

const patternCache = new WeakMap<object, readonly Pattern[]>();

function compile(key: string): Pattern {
  const pieces = key.split(/\{([a-zA-Z][a-zA-Z0-9]*)\}/u);
  const literals = pieces.filter((_, index) => index % 2 === 0);
  const names = pieces.filter((_, index) => index % 2 === 1);
  const source = pieces.map((piece, index) => (index % 2 === 1 ? '(.+?)' : piece.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))).join('');
  return { key, literals, names, regex: new RegExp(`^${source}$`, 'su') };
}

function patternsOf(section: Readonly<Record<string, string>>): readonly Pattern[] {
  let patterns = patternCache.get(section);
  if (!patterns) {
    // The pattern with the most fixed text is tried first, so "text hidden by {method} inside main" wins over "text hidden by {method}".
    const fixed = (pattern: Pattern) => pattern.literals.join('').length;
    patterns = Object.keys(section).filter(key => key.includes('{')).map(compile).sort((a, b) => fixed(b) - fixed(a));
    patternCache.set(section, patterns);
  }
  return patterns;
}

/** The English ending of a shortened list, "a, b and 3 more", as summarizeList and `moreItems` write it. */
const englishMore = /^(.+) and (\d+) more$/su;

/** Splits a list at `separator` (", " or "; ") outside parentheses, brackets and quotes. */
export function splitList(value: string, separator: ', ' | '; ' = ', '): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') quoted = !quoted;
    else if (!quoted && (character === '(' || character === '[')) depth += 1;
    else if (!quoted && (character === ')' || character === ']')) depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && character === separator[0] && value[index + 1] === ' ') {
      items.push(value.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  items.push(value.slice(start));
  return items;
}

const displayNames = new Map<Language, Intl.DisplayNames>();
const codesByName = new Map(Object.entries(languageNames).map(([code, name]) => [name, code]));
/** Names the reports already use where they differ from CLDR's, such as castellà in the Catalan probe report. */
const preferredNames: Readonly<Partial<Record<Language, Readonly<Record<string, string>>>>> = { ca: { es: 'castellà' } };

function languageName(language: Language, value: string): string | undefined {
  const code = codesByName.get(value);
  if (code === undefined) return undefined;
  const preferred = preferredNames[language]?.[code];
  if (preferred !== undefined) return preferred;
  let names = displayNames.get(language);
  if (!names) {
    names = new Intl.DisplayNames([language], { type: 'language', fallback: 'none' });
    displayNames.set(language, names);
  }
  return names.of(code);
}

function sections(language: Language, name: string, ruleId: string | undefined): Readonly<Record<string, string>>[] {
  const catalog = valueCatalogs[language];
  return [ruleId === undefined ? undefined : catalog[`${ruleId}/${name}`], catalog[name]].filter((section): section is Readonly<Record<string, string>> => section !== undefined);
}

function translateWhole(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string | undefined {
  if (languageParams.has(name)) {
    const named = languageName(language, value);
    if (named !== undefined) return named;
  }
  for (const section of sections(language, name, ruleId)) {
    const exact = section[value];
    if (exact !== undefined) return exact;
    if (depth >= 4 || value.length > 2000) continue;
    for (const pattern of patternsOf(section)) {
      if (!pattern.literals.every(literal => value.includes(literal))) continue;
      const match = pattern.regex.exec(value);
      // A part that spans list items means the pattern matched across a list, which is translated item by item.
      if (!match || match.slice(1).some(part => splitList(part).length > 1 || splitList(part, '; ').length > 1)) continue;
      const parts: Record<string, string> = {};
      pattern.names.forEach((part, index) => {
        parts[part] = translate(language, part, match[index + 1]!, ruleId, depth + 1);
      });
      return format(section[pattern.key]!, parts);
    }
  }
  return undefined;
}

/** A list joined with "; " or ", ", each item translated where the catalog knows it as a whole. */
function translateItems(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string {
  const groups = splitList(value, '; ');
  if (groups.length > 1) return groups.map(group => translateWhole(language, name, group, ruleId, depth) ?? translateItems(language, name, group, ruleId, depth)).join('; ');
  return splitList(value).map(item => translateWhole(language, name, item, ruleId, depth) ?? item).join(', ');
}

function translate(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string {
  const whole = translateWhole(language, name, value, ruleId, depth);
  if (whole !== undefined) return whole;
  const list = listParams.has(name) || (ruleId !== undefined && listParams.has(`${ruleId}/${name}`));
  const more = list ? englishMore.exec(value) : null;
  const known = languageParams.has(name) || sections(language, name, ruleId).length > 0;
  if (!more && !known) return value;
  const head = more ? more[1]! : value;
  const items = known ? translateItems(language, name, head, ruleId, depth) : head;
  return more ? format(ui(language).moreItems, { items, count: more[2]! }) : items;
}

/** One value of parameter `name` with the English words code wrote into it translated to `language`. */
export function localizeValue(language: Language, name: string, value: string, ruleId?: string): string {
  return language === 'en' ? value : translate(language, name, value, ruleId, 0);
}

/** Message or label values with the English words code wrote into them translated to `language`; data stays as is. */
export function localizeParams(language: Language, params: Params, ruleId?: string): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'number' ? value : localizeValue(language, name, value, ruleId)]));
}
