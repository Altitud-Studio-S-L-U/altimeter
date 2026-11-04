import { domainToUnicode } from 'node:url';
import { cleanText } from '../report/sanitize.ts';
import { registrableDomain } from '../rules/content/common.ts';

/**
 * URLs in engine output are untrusted: answers and search results can carry other schemes, credentials, tracking
 * parameters, look-alike hosts or invisible characters. Only URLs that pass a strict parse are read, and the host
 * is always kept in its ASCII (punycode) form, which cannot pass for another domain.
 */

/** Longer candidates are not read. */
export const maxUrlLength = 2048;
/** At most this many URLs are read from one answer. */
export const maxUrlsPerText = 50;

// http and https only. Whitespace, quotes, angle brackets, backticks, braces, square brackets, pipes, backslashes,
// carets and control or format characters end a URL; parentheses may belong to one and are balanced below.
const candidatePattern = /https?:\/\/[^\s<>"'`[\]{}|\\^\p{Cc}\p{Cf}]+/giu;

const trackingParameter = /^(?:utm_\w+|gclid|dclid|gbraid|wbraid|fbclid|msclkid|yclid|mc_cid|mc_eid|igshid|srsltid|_ga|_gl)$/iu;

/** Removes punctuation that ends a sentence or closes Markdown around a URL, and a closing parenthesis it did not open. */
function trimCandidate(candidate: string): string {
  let text = candidate;
  for (;;) {
    const trimmed = text.replace(/[.,;:!?*_~]+$/u, '');
    const opens = (trimmed.match(/\(/gu) ?? []).length;
    const closes = (trimmed.match(/\)/gu) ?? []).length;
    const balanced = trimmed.endsWith(')') && closes > opens ? trimmed.slice(0, -1) : trimmed;
    if (balanced === text) return text;
    text = balanced;
  }
}

/** An http or https URL without credentials whose host is a dotted name or an IPv4 address, or undefined. */
export function parseUrl(candidate: string): URL | undefined {
  if (candidate === '' || candidate.length > maxUrlLength) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return undefined;
  const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(host)) return undefined;
  if (host !== url.hostname) url.hostname = host;
  return url;
}

/** The form a URL is shown and stored in: lower-case ASCII host, no fragment and no tracking parameters. */
export function canonicalUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  const tracking = [...new Set(copy.searchParams.keys())].filter(name => trackingParameter.test(name));
  for (const name of tracking) copy.searchParams.delete(name);
  return copy.href;
}

/**
 * How two URLs are compared: the host without www., either scheme, no trailing slash and the query without
 * tracking parameters, in a stable order. A citation of http://www.example.com/a/ matches a result for
 * https://example.com/a.
 */
export function urlKey(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return url;
  const host = parsed.hostname.replace(/^www\./u, '');
  const port = parsed.port === '' ? '' : `:${parsed.port}`;
  const path = parsed.pathname.replace(/\/+$/u, '');
  const query = [...parsed.searchParams]
    .filter(([name]) => !trackingParameter.test(name))
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  return `${host}${port}${path}${query.length === 0 ? '' : `?${new URLSearchParams(query).toString()}`}`;
}

/** Canonical URLs from a list of untrusted strings, without duplicates, in their original order. */
export function canonicalList(values: readonly string[], limit = maxUrlsPerText): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const value of values) {
    const url = parseUrl(value.trim());
    if (!url) continue;
    const canonical = canonicalUrl(url);
    const key = urlKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(canonical);
    if (found.length >= limit) break;
  }
  return found;
}

/** The URLs written in a text, such as Markdown links and bare URLs, cleaned and canonical. */
export function urlsInText(text: string, limit = maxUrlsPerText): string[] {
  const candidates = [...cleanText(text, 200_000).matchAll(candidatePattern)].map(match => trimCandidate(match[0]));
  return canonicalList(candidates, limit);
}

/** The text with every URL replaced by a space, so a name inside an address is not read as a mention. */
export function withoutUrls(text: string): string {
  return text.replace(candidatePattern, ' ');
}

/** The registrable domain of a URL, approximated as the rule helpers do, or undefined for anything unparseable. */
export function domainOf(url: string): string | undefined {
  const parsed = parseUrl(url);
  return parsed ? registrableDomain(parsed.href) : undefined;
}

/** True when the URL belongs to the site: the same registrable domain, so subdomains count and look-alikes do not. */
export function onSite(url: string, domain: string): boolean {
  return domainOf(url) === domain;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** The ways a text can name the site: its registrable domain and its host, in ASCII and in Unicode. */
export function domainForms(site: { readonly host: string; readonly domain: string }): string[] {
  const forms = new Set<string>();
  for (const name of [site.domain, site.host]) {
    if (name === '') continue;
    forms.add(name.toLowerCase());
    const unicode = domainToUnicode(name);
    if (unicode !== '') forms.add(unicode.toLowerCase());
  }
  return [...forms];
}

/** True when the text names one of the forms as a whole name, so art.com is found in www.art.com but not in smart.com. */
export function namesDomain(text: string, forms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return forms.some(form => new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegExp(form)}(?![\\p{L}\\p{N}-])`, 'u').test(lower));
}
