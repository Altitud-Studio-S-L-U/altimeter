import type { PageFacts, SitemapFacts } from '../core/facts.ts';
import type { HttpClient } from '../fetch/http.ts';
import { parseSitemap } from '../fetch/sitemap.ts';

/** Sitemaps read per run: the first declared ones, and the first children their indexes list. */
const maxDeclaredSitemaps = 5;
const maxChildSitemaps = 10;

/**
 * The sitemaps a page links with rel="sitemap", resolved as the page's other links are: against its first
 * `<base href>`, else its final URL. A value that is not a valid http or https URL is skipped.
 */
export function linkedSitemaps(page: PageFacts): string[] {
  const parsed = page.raw?.parsed;
  if (!parsed) return [];
  let base = page.fetch.finalUrl;
  const baseHref = parsed.bases.find(element => element.attrs.href !== undefined)?.attrs.href;
  try {
    if (baseHref !== undefined) base = new URL(baseHref, page.fetch.finalUrl).href;
  } catch {}
  const urls: string[] = [];
  for (const link of parsed.links) {
    if (!link.rel.includes('sitemap') || !link.attrs.href) continue;
    try {
      const url = new URL(link.attrs.href, base);
      url.hash = '';
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href);
    } catch {}
  }
  return urls;
}

/** The sitemaps read, with warnings when the caps on declared and child sitemaps leave some unread. */
export async function collectSitemaps(client: HttpClient, origin: string, declared: string[]): Promise<{ sitemaps: SitemapFacts[]; warnings: string[] }> {
  const results: SitemapFacts[] = [];
  const queue: Array<{ url: string; source: SitemapFacts['source'] }> = declared.length > 0
    ? declared.slice(0, maxDeclaredSitemaps).map(url => ({ url, source: 'robots' as const }))
    : [{ url: new URL('/sitemap.xml', origin).href, source: 'default' as const }];
  const seen = new Set<string>();
  const listed = new Set<string>();
  let children = 0;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    const fetch = await client.fetch(next.url, { maxBytes: 50 * 1024 * 1024 + 1, timeoutMs: 30_000 });
    const document = fetch.status === 200 && !fetch.error ? parseSitemap(fetch.body) : undefined;
    results.push({ url: next.url, source: next.source, fetch, ...(document ? { document } : {}) });
    for (const child of document?.sitemaps ?? []) {
      listed.add(child.loc);
      if (children >= maxChildSitemaps) continue;
      children += 1;
      queue.push({ url: child.loc, source: 'index' });
    }
  }
  // Rules that compare pages or owner data with sitemap URLs would otherwise take part of the list for all of it.
  const warnings: string[] = [];
  if (declared.length > maxDeclaredSitemaps) warnings.push(`${declared.length} sitemaps are declared and only the first ${maxDeclaredSitemaps} were read, so checks that use sitemap URLs see only part of them.`);
  const unread = [...listed].filter(url => !seen.has(url)).length;
  const read = results.filter(entry => entry.source === 'index').length;
  if (unread > 0) warnings.push(`The sitemap indexes list ${read + unread} child sitemaps and only ${read} were read, so checks that use sitemap URLs see only part of them.`);
  return { sitemaps: results, warnings };
}
