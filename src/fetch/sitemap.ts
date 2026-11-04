import { gunzipSync } from 'node:zlib';
import { SaxesParser } from 'saxes';

/** Limits of the sitemaps.org protocol, which Google and Bing apply per file. */
export const sitemapLimits = { entries: 50_000, bytes: 50 * 1024 * 1024 } as const;

const ns = {
  sitemap: 'http://www.sitemaps.org/schemas/sitemap/0.9',
  xhtml: 'http://www.w3.org/1999/xhtml',
  image: 'http://www.google.com/schemas/sitemap-image/1.1',
  video: 'http://www.google.com/schemas/sitemap-video/1.1',
  news: 'http://www.google.com/schemas/sitemap-news/0.9',
} as const;

export interface SitemapAlternate {
  readonly hreflang: string;
  readonly href: string;
}

export interface SitemapUrl {
  readonly loc: string;
  readonly lastmod?: string;
  readonly changefreq?: string;
  readonly priority?: string;
  readonly alternates: readonly SitemapAlternate[];
  readonly images: number;
  readonly videos: number;
  readonly news: boolean;
  readonly line: number;
}

export interface SitemapReference {
  readonly loc: string;
  readonly lastmod?: string;
  readonly line: number;
}

export interface SitemapDocument {
  readonly kind: 'urlset' | 'sitemapindex' | 'unknown';
  /** Namespace of the root element; the protocol requires the sitemaps.org namespace. */
  readonly namespace: string | undefined;
  readonly urls: readonly SitemapUrl[];
  readonly sitemaps: readonly SitemapReference[];
  readonly errors: readonly { readonly line: number; readonly message: string }[];
  /** Uncompressed size in bytes. */
  readonly bytes: number;
  readonly gzipped: boolean;
  readonly overEntryLimit: boolean;
  readonly overByteLimit: boolean;
}

/** Decompresses a gzip body (by magic bytes, not by file name) without inflating past the protocol limit. */
export function decodeSitemapBody(body: Buffer): { readonly xml: Buffer; readonly gzipped: boolean; readonly error?: string } {
  if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) return { xml: body, gzipped: false };
  try {
    return { xml: gunzipSync(body, { maxOutputLength: sitemapLimits.bytes + 1 }), gzipped: true };
  } catch (error) {
    return { xml: Buffer.alloc(0), gzipped: true, error: error instanceof RangeError ? 'Uncompressed size exceeds 50 MiB' : 'Invalid gzip data' };
  }
}

export function parseSitemap(input: Buffer | string): SitemapDocument {
  const raw = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const decoded = decodeSitemapBody(raw);
  const errors: Array<{ line: number; message: string }> = decoded.error ? [{ line: 0, message: decoded.error }] : [];
  const urls: SitemapUrl[] = [];
  const sitemaps: SitemapReference[] = [];
  let kind: SitemapDocument['kind'] = 'unknown';
  let namespace: string | undefined;
  let depth = 0;
  let text = '';
  let entry: { loc?: string; lastmod?: string; changefreq?: string; priority?: string; alternates: SitemapAlternate[];
    images: number; videos: number; news: boolean; line: number } | undefined;

  const parser = new SaxesParser({ xmlns: true, position: true });
  parser.on('error', error => {
    errors.push({ line: parser.line, message: error.message.replace(/^[^:]*:\d+:\d+: /u, '') });
  });
  parser.on('doctype', () => {
    errors.push({ line: parser.line, message: 'Document type declarations are not allowed in sitemaps' });
  });
  parser.on('opentag', tag => {
    depth += 1;
    text = '';
    if (depth === 1) {
      namespace = tag.uri;
      kind = tag.local === 'urlset' ? 'urlset' : tag.local === 'sitemapindex' ? 'sitemapindex' : 'unknown';
      return;
    }
    if (depth === 2 && tag.uri === ns.sitemap && (tag.local === 'url' || tag.local === 'sitemap')) {
      entry = { alternates: [], images: 0, videos: 0, news: false, line: parser.line };
      return;
    }
    if (!entry) return;
    if (tag.uri === ns.xhtml && tag.local === 'link') {
      const attributes = tag.attributes as Record<string, { local: string; value: string }>;
      const value = (name: string) => Object.values(attributes).find(attr => attr.local === name)?.value;
      if (value('rel')?.toLowerCase() === 'alternate' && value('hreflang') && value('href')) {
        entry.alternates.push({ hreflang: value('hreflang')!, href: value('href')! });
      }
    } else if (tag.uri === ns.image && tag.local === 'image') entry.images += 1;
    else if (tag.uri === ns.video && tag.local === 'video') entry.videos += 1;
    else if (tag.uri === ns.news && tag.local === 'news') entry.news = true;
  });
  parser.on('text', value => {
    text += value;
  });
  parser.on('cdata', value => {
    text += value;
  });
  parser.on('closetag', tag => {
    if (entry && depth === 3 && tag.uri === ns.sitemap) {
      const value = text.trim();
      if (tag.local === 'loc') entry.loc = value;
      else if (tag.local === 'lastmod') entry.lastmod = value;
      else if (tag.local === 'changefreq') entry.changefreq = value;
      else if (tag.local === 'priority') entry.priority = value;
    }
    if (entry && depth === 2) {
      if (entry.loc === undefined || entry.loc === '') errors.push({ line: entry.line, message: `<${tag.local}> without <loc>` });
      else if (tag.local === 'sitemap') sitemaps.push({ loc: entry.loc, line: entry.line, ...(entry.lastmod ? { lastmod: entry.lastmod } : {}) });
      else urls.push({
        loc: entry.loc,
        alternates: entry.alternates,
        images: entry.images,
        videos: entry.videos,
        news: entry.news,
        line: entry.line,
        ...(entry.lastmod ? { lastmod: entry.lastmod } : {}),
        ...(entry.changefreq ? { changefreq: entry.changefreq } : {}),
        ...(entry.priority ? { priority: entry.priority } : {}),
      });
      entry = undefined;
    }
    depth -= 1;
    text = '';
  });

  try {
    parser.write(decoded.xml.toString('utf8').replace(/^﻿/u, '')).close();
  } catch (error) {
    errors.push({ line: parser.line, message: error instanceof Error ? error.message : 'Unreadable XML' });
  }
  return {
    kind,
    namespace,
    urls,
    sitemaps,
    errors,
    bytes: decoded.xml.length,
    gzipped: decoded.gzipped,
    overEntryLimit: urls.length + sitemaps.length > sitemapLimits.entries,
    overByteLimit: decoded.xml.length > sitemapLimits.bytes,
  };
}

/** W3C Datetime as the sitemap protocol requires: a date, optionally with minutes or seconds and a time zone. */
export function isW3cDatetime(value: string): boolean {
  if (!/^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/u.test(value)) return false;
  return !Number.isNaN(Date.parse(value.length <= 7 ? `${value}${value.length === 4 ? '-01' : ''}-01` : value));
}
