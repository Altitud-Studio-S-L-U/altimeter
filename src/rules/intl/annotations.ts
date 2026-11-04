import type { EvidenceStore } from '../../core/evidence.ts';
import type { DocumentFacts, PageFacts, SiteFacts } from '../../core/facts.ts';
import type { ElementRef, LinkRef } from '../../parse/html.ts';
import { linksWithRel } from '../helpers.ts';

export type AnnotationSource = 'html' | 'rendered' | 'header' | 'sitemap';

/** One hreflang annotation as observed in the HTML, the rendered DOM, an HTTP Link header or a sitemap. */
export interface Annotation {
  readonly source: AnnotationSource;
  /** The hreflang value, trimmed. */
  readonly value: string;
  /** The href exactly as written. */
  readonly rawHref: string | undefined;
  /** The href resolved and without fragment, or undefined when it cannot be resolved. */
  readonly href: string | undefined;
  /** The URL that carries the annotation: the page's final URL, or the sitemap entry's loc. */
  readonly declaringUrl: string;
  /** The text observed: the link element's start tag, the header link-value or the sitemap attributes. */
  readonly excerpt: string;
  readonly line?: number;
  readonly inHead?: boolean;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly rel?: readonly string[];
  readonly sitemapUrl?: string;
}

/** Absolute form of a URL for comparisons: scheme and host lowercased by the URL parser, fragment removed. */
export function normalizeUrl(url: string | undefined, base?: string): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url.trim(), base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** The start tag of an element as it appears in the source. */
export function elementSource(html: string, element: ElementRef): string {
  if (element.offset < 0) return `<${element.tag} ${Object.entries(element.attrs).map(([name, value]) => `${name}="${value}"`).join(' ')}>`;
  const end = html.indexOf('>', element.offset);
  return html.slice(element.offset, end === -1 ? undefined : end + 1);
}

export interface LinkValue {
  readonly uri: string;
  /** Lowercase parameter names; values unquoted. */
  readonly params: Readonly<Record<string, string>>;
  readonly raw: string;
}

/**
 * Parses HTTP Link header values (RFC 8288). Several header lines are equivalent to one comma-joined value.
 * Commas inside the URI reference or a quoted string do not split link-values.
 */
export function parseLinkHeader(values: readonly string[]): { readonly links: LinkValue[]; readonly errors: string[] } {
  const links: LinkValue[] = [];
  const errors: string[] = [];
  for (const value of values) {
    for (const part of splitLinkValues(value)) {
      const raw = part.trim();
      if (raw === '') continue;
      const match = /^<([^>]*)>\s*(.*)$/su.exec(raw);
      if (!match) {
        errors.push(raw);
        continue;
      }
      const params: Record<string, string> = {};
      let ok = true;
      for (const param of splitOutsideQuotes(match[2]!, ';')) {
        const text = param.trim();
        if (text === '') continue;
        const pair = /^([!#$%&'*+.^_`|~0-9a-z-]+)\*?\s*(?:=\s*("(?:[^"\\]|\\.)*"|[^\s";,]+))?$/iu.exec(text);
        if (!pair) {
          ok = false;
          break;
        }
        const name = pair[1]!.toLowerCase();
        const unquoted = pair[2] === undefined ? '' : pair[2].startsWith('"') ? pair[2].slice(1, -1).replace(/\\(.)/gu, '$1') : pair[2];
        if (!(name in params)) params[name] = unquoted;
      }
      if (!ok) errors.push(raw);
      else links.push({ uri: match[1]!.trim(), params, raw });
    }
  }
  return { links, errors };
}

function splitLinkValues(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inUri = false;
  let inQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (inQuote) {
      current += char;
      if (char === '\\' && index + 1 < value.length) current += value[++index];
      else if (char === '"') inQuote = false;
      continue;
    }
    if (char === '<') inUri = true;
    else if (char === '>') inUri = false;
    else if (char === '"' && !inUri) inQuote = true;
    if (char === ',' && !inUri) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"') inQuote = !inQuote;
    if (char === '\\' && inQuote && index + 1 < value.length) {
      current += char + value[++index]!;
      continue;
    }
    if (char === separator && !inQuote) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

export function relTokens(rel: string | undefined): string[] {
  return (rel ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
}

/** A link element with an hreflang attribute, as an annotation. */
export function linkAnnotation(doc: DocumentFacts, link: LinkRef, base: string, source: 'html' | 'rendered'): Annotation {
  return {
    source,
    value: (link.attrs.hreflang ?? '').trim(),
    rawHref: link.attrs.href,
    href: normalizeUrl(link.attrs.href, base),
    declaringUrl: base,
    excerpt: elementSource(doc.html, link),
    ...(link.line > 0 ? { line: link.line } : {}),
    inHead: link.inHead,
    attrs: link.attrs,
    rel: link.rel,
  };
}

/** hreflang link elements of a document, wherever the parser placed them. */
export function documentAnnotations(doc: DocumentFacts | undefined, base: string, source: 'html' | 'rendered'): Annotation[] {
  if (!doc) return [];
  return linksWithRel(doc, 'alternate').filter(link => link.attrs.hreflang !== undefined).map(link => linkAnnotation(doc, link, base, source));
}

export function headerAnnotations(page: PageFacts): Annotation[] {
  const base = page.fetch.finalUrl;
  return parseLinkHeader(page.fetch.headers.link ?? []).links
    .filter(link => relTokens(link.params.rel).includes('alternate') && link.params.hreflang !== undefined)
    .map(link => ({
      source: 'header' as const,
      value: link.params.hreflang!.trim(),
      rawHref: link.uri,
      href: normalizeUrl(link.uri, base),
      declaringUrl: base,
      excerpt: link.raw,
      attrs: link.params,
      rel: relTokens(link.params.rel),
    }));
}

/** xhtml:link alternates of every sitemap entry whose loc is `url`. */
export function sitemapAnnotations(site: SiteFacts, url: string): Annotation[] {
  const results: Annotation[] = [];
  for (const sitemap of site.sitemaps) {
    for (const entry of sitemap.document?.urls ?? []) {
      if (normalizeUrl(entry.loc) !== url) continue;
      for (const alternate of entry.alternates) {
        results.push({
          source: 'sitemap',
          value: alternate.hreflang.trim(),
          rawHref: alternate.href,
          href: normalizeUrl(alternate.href),
          declaringUrl: url,
          excerpt: `hreflang="${alternate.hreflang}" href="${alternate.href}"`,
          line: entry.line,
          sitemapUrl: sitemap.url,
        });
      }
    }
  }
  return results;
}

export interface AnnotationOptions {
  /** Include the rendered DOM's link elements (default true). */
  readonly rendered?: boolean;
  readonly sitemap?: boolean;
}

/** Every hreflang annotation that concerns one page, from each source. */
export function pageAnnotations(page: PageFacts, site: SiteFacts, options: AnnotationOptions = {}): Annotation[] {
  const base = normalizeUrl(page.fetch.finalUrl) ?? page.fetch.finalUrl;
  const rendered = options.rendered !== false && page.rendered && page.rendered.result.error === undefined ? page.rendered : undefined;
  return [
    ...documentAnnotations(page.raw, base, 'html'),
    ...documentAnnotations(rendered, base, 'rendered'),
    ...headerAnnotations(page),
    ...(options.sitemap === false ? [] : sitemapAnnotations(site, base)),
  ];
}

/**
 * The annotations Google can read for a page: raw HTML, Link header and sitemap, plus the rendered DOM's links when
 * the raw HTML has none. Repeats of the same value and target across sources count once.
 */
export function effectiveAnnotations(page: PageFacts, site: SiteFacts): Annotation[] {
  const all = pageAnnotations(page, site);
  const hasRaw = all.some(entry => entry.source === 'html');
  const chosen = all.filter(entry => entry.source !== 'rendered' || !hasRaw);
  const seen = new Set<string>();
  return chosen.filter(entry => {
    const key = `${entry.value.toLowerCase()} ${entry.href ?? entry.rawHref ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sourceKind = { html: 'html', rendered: 'render', header: 'header', sitemap: 'sitemap' } as const;
const sourceName = { html: 'raw HTML', rendered: 'rendered DOM', header: 'HTTP Link header', sitemap: 'sitemap' } as const;

/** Records an annotation as evidence; `label` describes what is wrong or notable about it. */
export function annotationEvidence(evidence: EvidenceStore, annotation: Annotation, label: string): string {
  return evidence.add({
    kind: sourceKind[annotation.source],
    url: annotation.source === 'sitemap' ? annotation.sitemapUrl ?? annotation.declaringUrl : annotation.declaringUrl,
    label: `${label} (${sourceName[annotation.source]}${annotation.source === 'sitemap' ? ` entry for ${annotation.declaringUrl}` : ''})`,
    excerpt: annotation.excerpt,
    ...(annotation.line ? { line: annotation.line } : {}),
  });
}

export function describeSource(source: AnnotationSource): string {
  return sourceName[source];
}
