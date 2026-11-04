/** robots.txt parsing and matching per RFC 9309, with the precedence Google documents. */

/** Google parses at most 500 KiB; content after the limit is ignored. */
export const robotsByteLimit = 500 * 1024;

export interface RobotsRule {
  readonly type: 'allow' | 'disallow';
  readonly pattern: string;
  readonly line: number;
}

export interface RobotsGroup {
  /** Lowercase product tokens, or "*". */
  readonly userAgents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly line: number;
}

export interface RobotsLine {
  readonly line: number;
  readonly key: string;
  readonly value: string;
}

export interface RobotsFile {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly RobotsLine[];
  /** Fields Google does not support, such as crawl-delay or noindex. */
  readonly unsupported: readonly RobotsLine[];
  /** Misspelled keys that Google's parser still accepts, such as "dissallow". */
  readonly misspelled: readonly RobotsLine[];
  /** Allow or disallow lines that appear before any user-agent line; they apply to no crawler. */
  readonly orphanRules: readonly RobotsLine[];
  /** Lines without a key-value separator. */
  readonly invalid: readonly RobotsLine[];
  readonly bytes: number;
  /** True when the file exceeded the byte limit and the rest was ignored. */
  readonly truncated: boolean;
}

const canonicalKeys: Readonly<Record<string, 'user-agent' | 'allow' | 'disallow' | 'sitemap'>> = {
  'user-agent': 'user-agent',
  allow: 'allow',
  disallow: 'disallow',
  sitemap: 'sitemap',
};

// Typos accepted by Google's open-source robots.txt parser.
const misspellings: Readonly<Record<string, 'user-agent' | 'disallow'>> = {
  useragent: 'user-agent',
  'user agent': 'user-agent',
  dissallow: 'disallow',
  dissalow: 'disallow',
  disalow: 'disallow',
  diasllow: 'disallow',
  disallaw: 'disallow',
};

export function parseRobots(input: string | Uint8Array): RobotsFile {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const truncated = bytes.length > robotsByteLimit;
  const text = bytes.subarray(0, robotsByteLimit).toString('utf8').replace(/^﻿/u, '');
  const groups: Array<{ userAgents: string[]; rules: RobotsRule[]; line: number }> = [];
  const sitemaps: RobotsLine[] = [];
  const unsupported: RobotsLine[] = [];
  const misspelled: RobotsLine[] = [];
  const orphanRules: RobotsLine[] = [];
  const invalid: RobotsLine[] = [];
  let current: { userAgents: string[]; rules: RobotsRule[]; line: number } | undefined;
  let lastWasAgent = false;

  for (const [index, raw] of text.split(/\r\n|\r|\n/u).entries()) {
    const line = index + 1;
    const content = raw.replace(/#.*$/u, '').trim();
    if (content === '') continue;
    const separator = content.indexOf(':');
    if (separator === -1) {
      invalid.push({ line, key: '', value: content });
      continue;
    }
    const rawKey = content.slice(0, separator).trim().toLowerCase();
    const value = content.slice(separator + 1).trim();
    const typo = misspellings[rawKey];
    const key = canonicalKeys[rawKey] ?? typo;
    if (typo) misspelled.push({ line, key: rawKey, value });
    if (key === undefined) {
      unsupported.push({ line, key: rawKey, value });
      continue;
    }
    if (key === 'sitemap') {
      sitemaps.push({ line, key, value });
      continue;
    }
    if (key === 'user-agent') {
      if (!lastWasAgent || current === undefined) {
        current = { userAgents: [], rules: [], line };
        groups.push(current);
      }
      current.userAgents.push(productToken(value));
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === undefined) {
      orphanRules.push({ line, key, value });
      continue;
    }
    current.rules.push({ type: key, pattern: value, line });
  }
  return { groups, sitemaps, unsupported, misspelled, orphanRules, invalid, bytes: bytes.length, truncated };
}

/** Reduces a user-agent line value to the lowercase product token a crawler matches against. */
function productToken(value: string): string {
  if (value.startsWith('*')) return '*';
  return /^[A-Za-z_-]+/u.exec(value)?.[0].toLowerCase() ?? value.toLowerCase();
}

export interface SelectedGroup {
  /** The token whose groups were selected: one of the requested tokens, "*", or undefined when no group applies. */
  readonly matchedToken: string | undefined;
  readonly rules: readonly RobotsRule[];
}

/**
 * Selects the rules for a crawler. `tokens` lists product tokens from most to least specific, as Google
 * documents for its crawlers (for example ["googlebot-image", "googlebot"]); "*" is the fallback.
 * Groups that name the same token are combined, as RFC 9309 requires.
 */
export function selectGroup(file: RobotsFile, tokens: readonly string[]): SelectedGroup {
  for (const token of [...tokens.map(t => t.toLowerCase()), '*']) {
    const matching = file.groups.filter(group => group.userAgents.includes(token));
    if (matching.length > 0) return { matchedToken: token, rules: matching.flatMap(group => group.rules) };
  }
  return { matchedToken: undefined, rules: [] };
}

const unreserved = /^[A-Za-z0-9\-._~]$/u;

/** Normalizes percent-encoding so equivalent paths compare equal (RFC 9309 section 2.2.2). */
export function normalizeRobotsPath(path: string): string {
  const encoded = Array.from(Buffer.from(path, 'utf8'))
    .map(byte => (byte > 0x7f || byte < 0x21 ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte)))
    .join('');
  return encoded.replace(/%([0-9A-Fa-f]{2})/gu, (_match, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return unreserved.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`, 'u').test(path);
}

export interface RobotsDecision {
  readonly allowed: boolean;
  /** The rule that decided, or undefined when no rule matched and crawling is allowed by default. */
  readonly rule: RobotsRule | undefined;
  readonly matchedToken: string | undefined;
}

/**
 * Decides whether `pathAndQuery` may be crawled. The longest matching pattern wins; when an allow and a
 * disallow pattern are equally long, allow wins. An empty pattern never matches.
 */
export function isAllowed(file: RobotsFile, tokens: readonly string[], pathAndQuery: string): RobotsDecision {
  const { matchedToken, rules } = selectGroup(file, tokens);
  const path = normalizeRobotsPath(pathAndQuery === '' ? '/' : pathAndQuery);
  if (path === '/robots.txt') return { allowed: true, rule: undefined, matchedToken };
  let best: RobotsRule | undefined;
  let bestLength = -1;
  for (const rule of rules) {
    if (rule.pattern === '') continue;
    const pattern = normalizeRobotsPath(rule.pattern);
    if (!patternMatches(pattern, path)) continue;
    const length = pattern.length;
    if (length > bestLength || (length === bestLength && rule.type === 'allow' && best?.type === 'disallow')) {
      best = rule;
      bestLength = length;
    }
  }
  return { allowed: best?.type !== 'disallow', rule: best, matchedToken };
}

export type RobotsAvailability =
  | { readonly kind: 'parsed'; readonly file: RobotsFile }
  /** 4xx other than 429, or more than five redirects: crawlers act as if there were no restrictions. */
  | { readonly kind: 'unrestricted'; readonly status: number | undefined }
  /** 5xx, 429 or an unreachable server: Google treats the whole site as disallowed while it lasts. */
  | { readonly kind: 'unreachable'; readonly status: number | undefined };

/** Maps a robots.txt fetch outcome to how Google treats it. */
export function robotsAvailability(status: number | undefined, body: Uint8Array | undefined, tooManyRedirects = false): RobotsAvailability {
  if (tooManyRedirects) return { kind: 'unrestricted', status };
  if (status === undefined || status === 429 || status >= 500) return { kind: 'unreachable', status };
  if (status >= 400) return { kind: 'unrestricted', status };
  if (status >= 200 && status < 300) return { kind: 'parsed', file: parseRobots(body ?? new Uint8Array()) };
  return { kind: 'unrestricted', status };
}
