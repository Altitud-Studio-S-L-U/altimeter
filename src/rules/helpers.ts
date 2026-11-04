import type { DocumentFacts, PageFacts } from '../core/facts.ts';
import type { HeaderMap } from '../fetch/http.ts';
import { baseUrl, type ElementRef, type LinkRef } from '../parse/html.ts';

/** The document a rule should read: the rendered DOM when it exists and `prefer` allows, else the raw HTML. */
export function pageDocument(page: PageFacts, prefer: 'raw' | 'rendered' = 'rendered'): DocumentFacts | undefined {
  if (prefer === 'rendered' && page.rendered && page.rendered.result.error === undefined) return page.rendered;
  return page.raw;
}

/** The URL relative references in `doc` resolve against: its base element when it has one, else `url`. */
export function documentBase(doc: DocumentFacts | undefined, url: string): string {
  return doc ? baseUrl(doc.parsed, url) : url;
}

export function absoluteUrl(href: string | undefined, base: string): string | undefined {
  if (href === undefined) return undefined;
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return undefined;
  }
}

export function linksWithRel(doc: DocumentFacts | undefined, rel: string): LinkRef[] {
  return doc?.parsed.links.filter(link => link.rel.includes(rel)) ?? [];
}

export function metaNamed(doc: DocumentFacts | undefined, name: string): ElementRef[] {
  const wanted = name.toLowerCase();
  return doc?.parsed.metas.filter(meta => (meta.attrs.name ?? '').toLowerCase() === wanted) ?? [];
}

export function metaProperty(doc: DocumentFacts | undefined, property: string): ElementRef[] {
  const wanted = property.toLowerCase();
  return doc?.parsed.metas.filter(meta => (meta.attrs.property ?? '').toLowerCase() === wanted) ?? [];
}

export interface HreflangLink {
  readonly hreflang: string;
  readonly href: string | undefined;
  readonly link: LinkRef;
}

/** `<link rel="alternate" hreflang>` elements, with href resolved against `base`. */
export function hreflangLinks(doc: DocumentFacts | undefined, base: string): HreflangLink[] {
  return linksWithRel(doc, 'alternate')
    .filter(link => link.attrs.hreflang !== undefined)
    .map(link => ({ hreflang: link.attrs.hreflang!.trim(), href: absoluteUrl(link.attrs.href, base), link }));
}

export interface RobotsDirectives {
  readonly source: 'meta' | 'header';
  /** "all" for the robots meta name or an unprefixed header, otherwise the lowercase crawler name. */
  readonly agent: string;
  /** Lowercase directives; values keep their argument, e.g. `max-snippet:50`. */
  readonly directives: readonly string[];
  readonly raw: string;
  readonly line?: number;
  readonly inHead?: boolean;
}

const knownDirectives = /^(all|none|noindex|nofollow|nosnippet|noarchive|nocache|notranslate|noimageindex|indexifembedded|index|follow|max-snippet|max-image-preview|max-video-preview|unavailable_after|noodp|noydir)\b/u;

/** Splits a directive list, keeping the date of unavailable_after (which contains commas) intact. */
export function splitDirectives(value: string): string[] {
  const parts = value.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    const previous = result.at(-1);
    if (previous?.startsWith('unavailable_after') && !knownDirectives.test(part)) result[result.length - 1] = `${previous}, ${part}`;
    else result.push(part.replace(/\s*:\s*/u, ':'));
  }
  return result;
}

/** Robots directives from meta elements (anywhere in the document) and X-Robots-Tag headers. */
export function robotsDirectives(headers: HeaderMap, doc: DocumentFacts | undefined): RobotsDirectives[] {
  const results: RobotsDirectives[] = [];
  for (const meta of doc?.parsed.metas ?? []) {
    const name = (meta.attrs.name ?? '').trim().toLowerCase();
    if (name === '' || meta.attrs.content === undefined) continue;
    if (name !== 'robots' && !/^[a-z0-9_-]*bot[a-z0-9_-]*$|^googlebot-news$/u.test(name)) continue;
    results.push({ source: 'meta', agent: name === 'robots' ? 'all' : name, directives: splitDirectives(meta.attrs.content), raw: meta.attrs.content, line: meta.line, inHead: meta.inHead });
  }
  for (const header of headers['x-robots-tag'] ?? []) {
    const prefixed = /^\s*([a-z0-9_-]+)\s*:\s*(.*)$/iu.exec(header);
    const agent = prefixed && !knownDirectives.test(prefixed[1]!.toLowerCase()) ? prefixed[1]!.toLowerCase() : 'all';
    const value = agent === 'all' ? header : prefixed![2]!;
    results.push({ source: 'header', agent, directives: splitDirectives(value), raw: header });
  }
  return results;
}

/** The directives that apply to one crawler: the generic ones plus those addressed to it by name. */
export function directivesFor(all: readonly RobotsDirectives[], agent = 'googlebot'): Set<string> {
  const applicable = new Set<string>();
  for (const entry of all) {
    if (entry.agent !== 'all' && entry.agent !== agent) continue;
    for (const directive of entry.directives) {
      if (directive === 'none') {
        applicable.add('noindex');
        applicable.add('nofollow');
      }
      applicable.add(directive);
    }
  }
  return applicable;
}

export function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).hostname.replace(/^www\./u, '') === new URL(b).hostname.replace(/^www\./u, '');
  } catch {
    return false;
  }
}

/** Joins a list for a message, e.g. ["a", "b", "c"] -> "a, b and 1 more" when max is 2. */
/**
 * Whether text starts like an SVG document: an optional XML declaration, comments and an SVG doctype, then an svg
 * element. Each part is skipped by searching for its end, so no input can make the check backtrack.
 */
export function startsLikeSvg(text: string): boolean {
  let rest = text.replace(/^\uFEFF/u, '').trimStart().toLowerCase();
  if (rest.startsWith('<?xml')) {
    const end = rest.indexOf('>');
    if (end < 0) return false;
    rest = rest.slice(end + 1).trimStart();
  }
  for (;;) {
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->', 4);
      if (end < 0) return false;
      rest = rest.slice(end + 3).trimStart();
    } else if (rest.startsWith('<!doctype svg')) {
      const end = rest.indexOf('>');
      if (end < 0) return false;
      rest = rest.slice(end + 1).trimStart();
    } else {
      break;
    }
  }
  return /^<svg[\s>]/u.test(rest);
}

export function summarizeList(values: readonly string[], max = 3): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')} and ${values.length - max} more`;
}
