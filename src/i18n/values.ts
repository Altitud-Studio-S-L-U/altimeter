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

/** Values that are sentences, such as run warnings: each is translated as a whole, never as a list of items. */
export const proseParams: ReadonlySet<string> = new Set(['warning']);

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
    // Patterns that start with fixed text come first, so a prefix such as "Crawler activity: {warning}" is read before
    // a pattern that starts with a value; then the one with the most fixed text, so "text hidden by {method} inside
    // main" wins over "text hidden by {method}".
    const leading = (pattern: Pattern) => (pattern.literals[0] === '' ? 0 : 1);
    const fixed = (pattern: Pattern) => pattern.literals.join('').length;
    patterns = Object.keys(section).filter(key => key.includes('{')).map(compile).sort((a, b) => leading(b) - leading(a) || fixed(b) - fixed(a));
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

/** A language name or an entry of the catalog for the whole value. */
function translateExact(language: Language, name: string, value: string, ruleId: string | undefined): string | undefined {
  if (languageParams.has(name)) {
    const named = languageName(language, value);
    if (named !== undefined) return named;
  }
  for (const section of sections(language, name, ruleId)) {
    const exact = section[value];
    if (exact !== undefined) return exact;
  }
  return undefined;
}

/** A number as code wrote it into English text, which a translation writes again in its own language. */
const englishNumber = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
/** Parts that hold codes or names made of digits, which keep the digits as they are. */
const digitParts: ReadonlySet<string> = new Set(['file', 'id', 'line', 'name', 'status', 'version']);

/**
 * The first pattern of the catalog that matches the whole value, with each part translated by its own name, and
 * each part that is a number passed as a number, so the translation writes it its own way and can pick a plural.
 */
function translatePattern(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string | undefined {
  if (depth >= 4 || value.length > 2000) return undefined;
  for (const section of sections(language, name, ruleId)) {
    for (const pattern of patternsOf(section)) {
      if (!pattern.literals.every(literal => value.includes(literal))) continue;
      const match = pattern.regex.exec(value);
      if (!match) continue;
      const parts: Record<string, string | number> = {};
      pattern.names.forEach((part, index) => {
        const text = match[index + 1]!;
        parts[part] = englishNumber.test(text) && !digitParts.has(part) ? Number(text) : translate(language, part, text, ruleId, depth + 1);
      });
      return format(section[pattern.key]!, parts, language);
    }
  }
  return undefined;
}

/**
 * A list joined with "; " or ", ", item by item, or undefined when the value is one item or no item is known.
 * Items come before patterns, so a pattern cannot match across the items of a list.
 */
function translateItems(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string | undefined {
  for (const separator of ['; ', ', '] as const) {
    const items = splitList(value, separator);
    if (items.length < 2) continue;
    const translated = items.map(item => translateKnown(language, name, item, ruleId, depth) ?? item);
    return translated.some((item, index) => item !== items[index]) ? translated.join(separator) : undefined;
  }
  return undefined;
}

function translateKnown(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string | undefined {
  return translateExact(language, name, value, ruleId)
    ?? (proseParams.has(name) ? undefined : translateItems(language, name, value, ruleId, depth))
    ?? translatePattern(language, name, value, ruleId, depth);
}

function translate(language: Language, name: string, value: string, ruleId: string | undefined, depth: number): string {
  const exact = translateExact(language, name, value, ruleId);
  if (exact !== undefined) return exact;
  const list = listParams.has(name) || (ruleId !== undefined && listParams.has(`${ruleId}/${name}`));
  const more = list ? englishMore.exec(value) : null;
  const known = languageParams.has(name) || sections(language, name, ruleId).length > 0;
  if (!more && !known) return value;
  const head = more ? more[1]! : value;
  const items = known ? translateKnown(language, name, head, ruleId, depth) ?? head : head;
  return more ? format(ui(language).moreItems, { items, count: Number(more[2]!) }, language) : items;
}

/** One value of parameter `name` with the English words code wrote into it translated to `language`. */
export function localizeValue(language: Language, name: string, value: string, ruleId?: string): string {
  return language === 'en' ? value : translate(language, name, value, ruleId, 0);
}

/** Message or label values with the English words code wrote into them translated to `language`; data stays as is. */
export function localizeParams(language: Language, params: Params, ruleId?: string): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'number' ? value : localizeValue(language, name, value, ruleId)]));
}

/** Whether a value of parameter `name` is a whole word or phrase of the catalog, or a language name, rather than data. */
export function isCatalogWord(name: string, value: string): boolean {
  return valueCatalogs.en[name]?.[value] !== undefined || (languageParams.has(name) && codesByName.has(value));
}
